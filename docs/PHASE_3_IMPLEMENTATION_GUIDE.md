# Phase 3 实现指南：只读规划、草案批准与执行交接

状态：代码实现和离线验收已完成。更新日期：2026-10-04。真实 DeepSeek API 与 Claude Code 联合演示尚未运行，因为当前环境没有配置 `TOKEN_COUPON_PLANNER_API_KEY`。

本指南解释 Phase 3 的核心流程和代码边界。测试、样例与设计文件不逐项展开；完整目标和限制见[Phase 3 搭建方案](PHASE_3_PLAN.md)。

## 1. 主流程

```text
planner start / reply
  → PlannerConversation 保存用户输入和 running turn
  → RepositoryReader 仅执行 repo_list / repo_read / repo_search
  → MockPlanner 或 DeepSeekPlanner 返回 clarification / draft
  → 结构、依赖、Runner 配置和读取证据校验
  → PlannerStore 保存轮次、对话快照和不可变 draft-N
  → 用户导出编辑并 replace，或直接审阅
  → approve 将批准绑定到 draftRevision + planHash
  → planner run 预约 sessionId，再调用 Phase 2 runPlan()
  → SessionStore 保存唯一执行 Session
```

规划对话和任务执行是两种生命周期。澄清、API 失败和重试只产生 Planner turn；只有用户批准当前草案后才创建执行 Session。Planner 不会执行仓库代码，也不会因为模型声称计划完成而跳过批准。

## 2. 功能块之间如何协作

| 功能块 | 负责什么 | 这样设计的原因 |
| --- | --- | --- |
| `planner-cli.ts` | 解析 `planner start/reply/show/export/replace/approve/run`，输出状态并处理中断信号 | CLI 是操作入口，不直接维护快照或调用 Runner |
| `planner-conversation.ts` | 串接每轮对话、有限格式纠错、草案提交、批准检查和 Session 交接 | 将业务状态与终端参数分开；规划失败不伪装成执行失败 |
| `PlannerStore` | 原子保存 conversation、turn、provider 请求记录和 `drafts/<revision>.json` | 对话可跨 CLI 进程恢复；草案版本不可覆盖，快照只引用已提交版本 |
| `MockPlanner` / `DeepSeekPlanner` | 提供离线规划或真实 API 规划 | 两种适配器遵循同一 Planner 契约，默认测试不依赖网络 |
| `RepositoryReader` | 校验工具参数和路径，执行有界文件读取、搜索与哈希 | 模型只能请求固定的只读能力；文件 I/O 限制由本地代码执行 |
| 计划校验与执行策略 | 使用 `parsePlan()` 检查计划结构、依赖图和任务配置 | 外部模型输出视为不可信输入；Planner 不能扩大可用 Runner、模型或超时 |
| `TaskOrchestrator` / `SessionStore` | 在批准后运行已有 Phase 2 调度并记录执行事实 | 不重复实现调度；Planner 状态不会混进 PlanStore 或 Session 快照 |

主要类型和服务从 [core index](../packages/core/src/index.ts) 导出。规划记录位于 `<workspace>/.token-coupon/planners/<planningId>/`；执行记录仍由 Phase 2 保存到 `<workspace>/.token-coupon/sessions/<sessionId>/`，任务 Attempt 沿用 `.token-coupon/runs/`。

## 3. 对话、草案与持久化身份

[planner-types.ts](../packages/core/src/planner-types.ts) 区分三个 ID：`planningId` 表示一段可持续规划的对话；`turnId` 表示一次模型请求；`sessionId` 表示获批后的任务执行。重新打开规划只需读取 `conversation.json`，不需要原 CLI 进程或模型服务保存聊天状态。

[PlannerConversationSnapshot](../packages/core/src/planner-types.ts) 保存用户和助手消息、轮次引用、已读文件证据、当前草案版本、批准和执行引用。每轮请求开始前先持久化用户输入和 running turn；网络或校验失败后保留失败原因及之前有效草案。显式 retry 会创建新 turn 并复用原用户消息身份。

草案写入 `drafts/1.json`、`drafts/2.json` 等独立文件。计划使用稳定序列化计算 SHA-256；批准同时记录版本号和哈希。用户编辑通过 `planner export` / `planner replace` 导入，内容变化后生成新版本并清除旧批准。无变化的替换不会制造重复版本。

## 4. 只读仓库调研和 API 适配

[RepositoryReader](../packages/core/src/repository-reader.ts) 只注册 `repo_list`、`repo_read`、`repo_search`。路径必须在 workspace 内；拒绝目录穿越、符号链接、二进制文件和秘密配置路径。读取文件上限为 1 MiB，单次 `repo_read` 的文本输出最多 16 KiB，搜索只按普通字符串匹配。工具输出与单轮读取另有累计预算。完整文件哈希作为调研证据保存，所以显示给模型的局部片段仍能关联到文件的具体版本。

审批和执行前会重新计算证据哈希。如果调研文件改变，草案不能被批准或启动；Planner 必须重新读取变更路径，不能只更新哈希。`.gitignore` 不参与权限判断，忽略的文档也可由 Planner 调研；秘密目录由读取器单独拒绝。

[DeepSeekPlanner](../packages/core/src/planners/deepseek-planner.ts) 使用非流式 Chat Completions：先请求模型选择只读工具，应用执行工具并回传结果，再要求最终 JSON。调研轮数、单次工具数、总 API 请求数、HTTP 响应体和整个规划轮次都有上限。API Key 只从运行时环境读取；保存的请求记录不含 Authorization，错误文本也会隐藏 Key。最终 JSON 仍经过本项目校验，最多进行两次有限格式修正。

API 模型和执行 Runner 的模型分开配置。`TOKEN_COUPON_PLANNER_MODEL` 只决定规划模型；`--task-model` 只决定后续 Claude Code Runner 使用的模型。未配置 Key 时，真实适配器明确报错，不替换成其他模型。

## 5. 批准和 Phase 2 执行交接

`approvePlannerDraft()` 只接受当前草案版本，先校验哈希和读取证据，再保存批准身份。`runApprovedPlanner()` 再检查一次批准、草案和文件证据，随后在规划快照里预留 `sessionId`。该 ID 被传给 `runPlan()`，Session 初始快照写入之前会执行最终门禁检查。

执行 Session 和规划快照分别保存。若 CLI 中断，下一次 `planner run` 根据已预留的 Session ID 找回原执行；已创建的 Session 只展示原结果，不会二次启动 Runner。Phase 2 的 Session retry/resume 仍由 `session retry` 和 `session resume` 负责。

相关连接点在 [runPlan()](../packages/core/src/task-orchestrator.ts) 和 [SessionStore](../packages/core/src/session-store.ts)：`runPlan()` 可接收预留 ID 和 Session 创建前校验回调；SessionStore 使用该 ID 创建目录。普通 Phase 2 调用不传预留 ID 时继续沿用原有自动生成方式。

## 6. CLI 使用与产物检查

```bash
# 在当前 workspace 发起离线规划，并模拟一次澄清
node packages/cli/dist/main.js planner start --planner mock --runner mock \
  --request "增加问候函数，并补充测试" --mock-clarify

# 查看持久化对话；--id 使用 start 输出的 planningId
node packages/cli/dist/main.js planner show --id <planningId>
node packages/cli/dist/main.js planner reply --id <planningId> \
  --message "需要，同时覆盖空字符串。"

# 导出、编辑并导入新版本
node packages/cli/dist/main.js planner export --id <planningId> --file demo-workspace/phase3/edited-plan.json
node packages/cli/dist/main.js planner replace --id <planningId> --file demo-workspace/phase3/edited-plan.json

# 先确认未批准会被阻止，再批准当前版本并运行
node packages/cli/dist/main.js planner run --id <planningId>
node packages/cli/dist/main.js planner approve --id <planningId> --revision <draftRevision>
node packages/cli/dist/main.js planner run --id <planningId>
```

`--mock-clarify` 只用于 Mock 演示首轮澄清。Mock Runner 用来验证状态、批准门禁、Session 身份与文件落盘，不会真的实现计划中描述的源码。执行后比较导入计划和 `.token-coupon/sessions/<sessionId>/plan.json`，可确认获批的正是用户编辑的版本。

真实 API 演示需先在本机设置 `TOKEN_COUPON_PLANNER_API_KEY` 和服务实际支持的 `TOKEN_COUPON_PLANNER_MODEL`，再以 `--planner deepseek --runner claude-code` 开始。该演示可能触发模型 API 费用和 Claude Code 工具审批；本轮没有 API Key，因此只完成 DeepSeek HTTP fixture 的离线协议验收，未声称真实服务或 Claude 执行成功。

## 7. 验收结果

```bash
npm run typecheck
npm test
```

`npm run typecheck` 通过；`npm test` 通过 6 个测试文件、43 个用例。测试使用本地临时 workspace、Mock Runner 和可控 HTTP fixture，覆盖只读路径及输出预算、内容哈希变化、重新加载、有限 API 工具往返、Key 脱敏、批准失效、版本编辑、未批准门禁及重复运行只关联一个 Session。

离线 CLI 演示保存在 `demo-workspace/phase3`：planningId 为 `78b51944-f2e5-4308-9b4e-5cc6a1cab29a`，Session ID 为 `94b1369c-6c9c-454a-b936-c9a2c536ba02`，最终状态 `succeeded`。导入计划 `edited-plan.json` 与 Session 的 `plan.json` 内容完全一致；未批准运行被拒绝且没有创建 Session。沙箱内首次 Mock Runner 子进程没有向父进程提供 stdout，完成标记校验据实将尝试记为 failed；随后通过显式 `session retry` 和 `session resume` 恢复成功，原失败 Attempt 仍保留在 runs 目录中。
