# Phase 2 实现指南：手工计划和 Session

状态：实现已完成，更新日期：2026-10-03。

本指南解释 Phase 2 的核心功能和代码关系。逐文件说明测试和样例没有帮助理解执行流程，因此只说明它们覆盖的行为。设计边界及逐步验收见[Phase 2 搭建方案](PHASE_2_PLAN.md)。

## 1. 主流程

```text
CLI 读取计划并校验
  → 校验执行选项、获取 workspace 锁
  → SessionStore 保存原始计划和初始 Session 快照
  → PlanStore 选择依赖已成功的第一个任务
  → 保存 running 状态和预分配的 attemptId
  → TaskOrchestrator 组装前置结果，调用 executeTask
  → Runner 执行；RunRecorder 保存实际 prompt、输出和 Attempt
  → executeTask 判定；TaskOrchestrator 保存 handoff 和任务终态
  → 状态落盘完成后才调度下一个任务
```

Phase 2 没有改变单任务成功规则。只有 Phase 1 的 executeTask 判定 succeeded，计划层才会发布前置结果。进程返回码、完成标记和执行记录继续由 Phase 1 的 verdict 判断。

## 2. 状态所有权和功能边界

| 功能块 | 状态或职责 | 设计原因 |
| --- | --- | --- |
| CLI | 参数、信号、终端输出 | 不保存另一份任务状态，也不直接操作运行快照 |
| PlanStore | 任务状态、依赖就绪、Attempt 引用和结果 | 把状态转移与调度步骤分开，避免重复维护状态 |
| TaskOrchestrator | 单线程任务选择、上下文组装、executeTask 调用 | 保证同一时刻只有一个 Runner 修改 workspace |
| SessionStore | Session 文件、Attempt 引用校验、锁和原子替换 | 处理持久化细节，不决定接下来执行哪个任务 |
| Session 快照 | 计划级状态和运行历史索引 | 让 CLI 退出后仍能查看、重试或继续 |
| Attempt | 一次 Runner 调用及其实际证据 | 沿用 Phase 1，保留每次尝试独立目录 |

`SessionSnapshot` 和 `TaskResult` 类型在 [session-types.ts](../packages/core/src/session-types.ts)。`PlanStore` 的 `nextRunnable()` 找出依赖全部成功的首个任务；`beginAttempt()` 生成 running 状态和 Attempt 引用；`finishAttempt()` 保存终态并重新计算 blocked 任务，见 [plan-store.ts](../packages/core/src/plan-store.ts)。

`SessionStore` 负责目录、文件和 workspace 锁，见 [session-store.ts](../packages/core/src/session-store.ts)。它不运行 Runner。`TaskOrchestrator` 把 PlanStore、SessionStore 与 `executeTask()` 接起来，见 [task-orchestrator.ts](../packages/core/src/task-orchestrator.ts)。

## 3. 依赖校验与确定性调度

[validate-plan.ts](../packages/core/src/validate-plan.ts) 保留 Phase 0 对字段、重复任务、缺失依赖和重复依赖的校验，并新增自依赖和环检测。空计划仍可用 `plan show` 查看；`runPlan()` 在创建 Session 前拒绝执行空计划。

运行顺序由依赖和输入数组共同决定：依赖未成功的任务不能启动；多个任务都可运行时，按计划数组顺序选择。每次只挑一项并等待该次 Attempt 记录完成，随后才做下一次选择，所以当前并发数固定为 1。

任一任务失败后，调度立即停止。依赖该任务的后继任务成为 blocked；没有执行的独立任务仍为 planned。用户先对失败任务执行显式 retry，成功后 blocked 任务重新变为 planned，再用 resume 接着执行。

## 4. 保存身份、运行和结果

每项任务启动前，TaskOrchestrator 先生成 UUID attemptId，使用 `PlanStore.beginAttempt()` 构造新快照，再调用 SessionStore 保存。保存失败时不会启动 Runner。Phase 1 的 `executeTask()` 新增可选 `attemptId`，使单任务执行目录与计划中已保存的预约身份一致；独立的 `task run` 不传该值时仍由 executeTask 生成 UUID。

一项任务的执行包含三个记录层次：

| 文件 | 用途 |
| --- | --- |
| `sessions/<sessionId>/plan.json` | 用户提交的原始计划，创建后不修改 |
| `sessions/<sessionId>/session.json` | 最新任务状态、Attempt 历史、Session 状态和结果摘要 |
| `runs/<attemptId>/` | Phase 1 的实际任务、prompt、JSONL 输出事件、Attempt；Phase 2 成功后另有 `handoff.json` |

实际路径为 `<workspace>/.token-coupon/`。plan.json 保持原始 prompt；runs 中的 task.json 和 prompt.txt 是交给 Runner 的实际输入，可以包含前置任务上下文。

每个 JSON 快照写入同目录临时文件，再通过 `rename` 替换目标文件。Session revision 随成功写入递增。工作目录锁用 `wx` 创建，只允许一个计划进程同时调度；释放时检查随机 token，避免误删其他进程的锁。

## 5. 前置任务结果如何传递

Claude 适配器将最终 result 事件中的文本作为 `RunnerOutput.finalText`。Mock Runner 没有专门 finalText 时，TaskOrchestrator 从 `agentText` 流中构造后备摘要。摘要只在 Attempt 成功后写入 handoff.json 和 SessionSnapshot；失败任务不会成为可依赖结果。

交接只包含直接依赖的成功任务，且摘要有 UTF-8 字节上限：每项最多 8 KiB，拼入 prompt 的依赖结果总计最多 24 KiB。超长内容按完整 Unicode 字符截断并保留 `truncated` 标志。没有可用回复文本时，仍保存结果状态和 Attempt 路径，不编造修改或测试结论。

新 prompt 由任务原始要求、分隔后的直接依赖摘要及 Phase 1 自动添加的完成标记组成。完整 Runner 日志保留在 Attempt 目录，不整段复制到后续任务 prompt。

## 6. 恢复、重试和失败边界

`session show` 只读 Session 快照。`session resume` 获取 workspace 锁后，如果发现旧快照中有 running 任务，会检查关联的 attempt.json 和 handoff.json：只有 Attempt 成功且 handoff 完整匹配，才能恢复为 succeeded；否则标记 interrupted 并停止自动调度。

显式 retry 只接受 failed、timed_out、cancelled 或 interrupted 任务，要求所有依赖已成功；它创建新的 Attempt ID 和完成标记，保留旧记录。retry 只执行所选任务，不自动运行后续任务；用户再调用 resume。成功任务不能直接 retry，以免破坏下游已有结果。retry 的 CLI 退出码只反映本次目标任务；即使 Session 中另有未解决任务，retry 成功仍返回 0，并在快照中保留整份 Session 的失败状态。

workspace 锁限制同一代码目录的并发计划执行。进程异常退出可能留下锁；实现不会仅凭锁所有者进程不存在就删锁，因为 Runner 的子进程可能还活着。用户需要确认旧执行已停止后再清理锁。Phase 5 再设计完整自动恢复。

## 7. CLI 命令

```bash
# 创建 Session 并按依赖串行运行
node packages/cli/dist/main.js plan run --file examples/plan.phase2.mock.json

# 查看本次运行；Session ID 来自 plan run 输出
node packages/cli/dist/main.js session show --id <sessionId>

# 只重试一个失败任务，再运行尚未完成任务
node packages/cli/dist/main.js session retry --id <sessionId> --task add-greeting-tests \
  --mock-task-scenario add-greeting-tests=success
node packages/cli/dist/main.js session resume --id <sessionId>

# Claude Code 计划逐项运行；生成文件留在当前 workspace
node packages/cli/dist/main.js plan run --file examples/plan.phase2.claude.json --accept-edits
```

`--mock-task-scenario <taskId>=<scenario>` 是显式的演示和故障注入选项，不进入 plan schema，也不会作为后续 resume/retry 的默认配置。只允许指向 Mock 任务。

完整的失败路径可这样演示：先在 plan run 时将 `add-greeting-tests` 设为 `missing-marker`，再用 `session show` 检查失败及 blocked 状态；retry 时将同一任务改为 `success`，最后 resume 执行验证任务。验证文件见 [plan.phase2.mock.json](../examples/plan.phase2.mock.json) 和 [plan.phase2.claude.json](../examples/plan.phase2.claude.json)。

## 8. 验证

```bash
npm run typecheck
npm test
```

核心覆盖包括依赖环、失败后停止和阻塞、成功任务跳过、显式重试产生新 Attempt、重新加载 Session、最终验证任务拿到前置摘要、workspace 锁互斥，以及 CLI 从 plan run 走到 retry/resume。默认测试通过 Mock fixture，不调用 Claude 模型。
