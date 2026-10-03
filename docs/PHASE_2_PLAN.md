# 阶段 2 搭建方案：手工计划、串行调度与 Session 保存

状态：Phase 2 实现代码与 CLI 流程已完成；Mock 测试通过，更新日期：2026-10-03。真实 Claude Code 多任务演示尚未执行。

本方案对应 [roadmap](../roadmap.md) 的阶段 2。前置交付见 [阶段 0 方案](PHASE_0_PLAN.md)、[阶段 1 方案](PHASE_1_PLAN.md)和[阶段 1 实现说明](PHASE_1_IMPLEMENTATION_GUIDE.md)。本阶段复用单任务执行闭环，让用户用一份手工计划执行多个相关任务，重新打开执行状态，并显式重试失败任务。
代码可参考Ordewell（https://github.com/ordewell/ordewell）
## 1. 交付目标和范围

用户在项目目录提供计划 JSON，CLI 校验依赖，创建 Session，按依赖顺序逐个执行任务。前置任务成功后，后续任务获得其结果摘要及记录位置；遇到失败、超时或取消时停止启动新任务。重新打开 Session 可以查看结果、重试指定任务并继续剩余计划。

```text
手工计划 JSON
    ↓
结构、依赖图、Runner 和工作目录校验
    ↓
创建 Session，保存原始计划和初始状态
    ↓
选择依赖已成功的任务，保存新 Attempt 身份
    ↓
组装前置结果 → executeTask → 保存交接结果和任务终态
    ↓
继续下一个任务，或停止并保留 Session
    ↓
最终验证任务完成 → Session succeeded
```

| 本阶段实现 | 后续阶段实现 |
| --- | --- |
| 手工计划、依赖图校验、确定性的串行调度 | 模型生成计划、规划对话 |
| PlanStore 管理任务状态，Session 保存计划及 Attempt 引用 | 运行期间修改计划、并发任务 |
| 查看 Session、显式重试、跳过成功任务继续执行 | 自动重试、自动修复、完整崩溃恢复 |
| 同一工作目录内依次执行，传递有上限的前置摘要 | worktree 隔离、Git 整合和回滚 |
| 复用 Mock 与 Claude Code，增加计划级 CLI | 多工具注册表、daemon、TUI |
| 文件化的执行状态和任务结果 | Claude 聊天会话恢复、用户持续对话 |

Session 表示本项目的计划执行会话，不等于 Claude Code 的模型会话。本阶段仍使用非交互 Runner。多个任务可使用同一种 Runner；串行调度也不表示多个 agent 同时运行。

## 2. 当前基础与必要扩展

以下是当前代码事实，不是本阶段已经完成的功能：

| 当前入口 | 已有能力 | 本阶段需要补充 |
| --- | --- | --- |
| [plan.ts](../packages/core/src/plan.ts) | PlanDefinition 包含任务、依赖和初始 planned 状态 | 单独定义 Session 运行状态，保留输入计划格式 |
| [validate-plan.ts](../packages/core/src/validate-plan.ts) | 校验字段、任务 ID、重复依赖及依赖存在性 | 拒绝自依赖和依赖环；执行入口拒绝空计划 |
| [execute-task.ts](../packages/core/src/execute-task.ts) | 创建 Attempt，运行 Runner，记录并判定结果 | 支持调用方预分配 Attempt ID，便于启动前建立持久化关联 |
| [runner.ts](../packages/core/src/runner.ts) | 输出、启动通知、取消信号和进程结果契约 | 提供可选的归一化最终回复文本，用于结果交接 |
| [run-recorder.ts](../packages/core/src/run-recorder.ts) | 保存单次任务、prompt、事件和 Attempt 快照 | 保留目录布局；Session 引用已有记录 |
| [main.ts](../packages/cli/src/main.ts) | plan/task show、task run、工作目录和权限选项 | 增加 plan run、session show/resume/retry |

阶段 1 的 Attempt 仍由 executeTask 管理，完成协议和 verdict 继续复用。计划层不能根据退出码或模型口头描述再次判成功，也不能把失败 Attempt 改写成成功。

## 3. 数据和状态设计

### 3.1 输入计划保持兼容

继续使用 schemaVersion 为 1 的 PlanDefinition：计划条目包含 `task`、`dependsOn`、`status: "planned"`。输入 JSON 不写入运行状态，保存后的运行快照也不交给 parsePlan 解析。

图校验应满足：任务 ID 唯一；依赖存在且不重复；不能依赖自己；依赖图无环。错误信息包含任务 ID 和可定位的依赖路径。数组顺序不是执行顺序，依赖决定启动条件；多个任务同时满足条件时，按输入数组顺序选择。

parsePlan 保留已有合法输入的读取能力，补充自依赖和环检查。`plan show` 可以展示空计划，但 `plan run` 在创建 Session 前拒绝空计划。加载 Session 时，分别校验输入计划和运行快照。

### 3.2 新增 Session 和任务运行快照

以下为拟采用的核心结构；实现时补充时间、原因和运行时校验，不将它视为现有 API：

```ts
type TaskStatus =
  | "planned" | "running" | "succeeded"
  | "failed" | "cancelled" | "timed_out"
  | "blocked" | "interrupted";

type SessionStatus =
  | "ready" | "running" | "succeeded"
  | "failed" | "cancelled" | "interrupted";

interface TaskState {
  taskId: string;
  status: TaskStatus;
  activeAttemptId: string | null;
  attempts: Array<{
    attemptId: string;
    artifactDir: string;
    outcome: "pending" | "recorded" | "record_missing";
  }>;
  result: TaskResult | null;
  reasonCode: string | null;
}

interface SessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  workspace: string;
  revision: number;
  status: SessionStatus;
  tasks: TaskState[];
  createdAt: string;
  updatedAt: string;
}
```

Session ID 使用工具生成的 UUID，不使用用户输入的 planId 作为目录名。Attempt 引用中的路径必须与 Session 工作目录及 Attempt ID 对应，读取时重新计算并校验，不能任意读取快照中指定的外部路径。运行时可用 Map 按 taskId 查找；快照使用数组，避免任务 ID 被直接用作文件路径或普通对象的特殊属性。

`outcome` 表示关联记录是否完整，不复制 Attempt 的全部状态。Attempt 的退出码、完成标记和进程事实仍以 runs 目录中的记录为准。任务的最新总体状态、有效结果和 Attempt 历史由 PlanStore 管理。

### 3.3 状态与启动规则

| 状态 | 含义 | 后续操作 |
| --- | --- | --- |
| planned | 尚未执行，可能仍在等待依赖 | 依赖全部 succeeded 时可调度 |
| running | 已持久化本次执行预约，正在启动或执行 | 等待当前 Attempt 结束 |
| succeeded | Attempt 成功、交接结果完整且任务状态已保存 | 后续 resume 跳过 |
| failed / timed_out / cancelled | 本次任务执行未成功 | 满足依赖后可显式重试 |
| blocked | 某个直接或间接依赖未成功且已落入失败终态 | 依赖恢复后重新计算为 planned |
| interrupted | Session 留下了无法完整确认的执行 | 查看记录、确认旧执行停止后显式处理 |

`running` 在启动子进程前保存，用于建立执行身份；真实启动时间仍由 Attempt.startedAt 表示。blocked 是由依赖状态计算并保存的结果，不能作为重试入口，也不产生 Attempt。

任务发生失败时，标记受影响的后继任务为 blocked，其余未执行任务保留 planned，但本轮停止调度。阶段 2 不提供“失败后继续独立分支”的配置。

Session 全部任务成功才为 succeeded；任务失败或超时使 Session 为 failed，用户取消使其为 cancelled。存在未确认执行时为 interrupted。重试成功且仍有待执行任务时为 ready；仍有未解决失败时保持 failed。

## 4. 功能块及调用关系

```text
CLI：解析参数、绑定 Ctrl+C、展示状态
  ↓
Session：加载/创建、保存快照、协调单写入者
  ├─ PlanStore：任务状态、依赖就绪、Attempt 历史、结果
  └─ TaskOrchestrator：选择任务、组装上下文、调用 executeTask
       ↓
executeTask：单次 Attempt、日志、停止、完成判定
       ↓
Runner：Mock 或 Claude Code 的外部执行协议
```

| 功能块 | 职责和设计原因 |
| --- | --- |
| PlanStore | 统一实现任务状态转移和依赖计算，调度器不维护另一套任务状态 |
| TaskOrchestrator | 每次只选择一个任务；前一次执行、清理和保存完成后再继续 |
| Session | 连接内存状态和持久化记录，控制创建、重新打开、保存和结束 |
| SessionStore | 校验快照、串行写入、临时文件加 rename；不负责调度 |
| 上下文组装模块 | 从成功依赖中生成有限输入，保持原始计划不变 |
| executeTask / Runner | 沿用阶段 1 的执行边界，编排器不解析 Claude CLI 私有事件 |

实现时可采用 `plan-store.ts`、`task-orchestrator.ts`、`session.ts`、`session-store.ts`、`task-context.ts` 等文件。短小逻辑可合并，先按职责划分，不为每个模块建立基类。测试与示例围绕功能块组织，文档不逐条解释所有文件。

### 4.1 串行调度流程

1. 校验完整计划及各任务的执行能力；不支持的 Runner、mode 或模型配置在执行任何任务前报错。
2. 获取工作目录执行锁，创建或加载 Session；新 Session 保存原始计划快照。
3. 从 planned 任务中选择直接依赖全部 succeeded 的第一项；同一时刻最多有一个 running 任务。
4. 生成新 attemptId，将任务 running 状态、activeAttemptId 和 Attempt 引用一起保存。
5. 组装有效任务提示词，调用 executeTask，并使用预分配的 attemptId。
6. 等待 executeTask 完成，包括进程清理与执行记录写入；成功时保存交接结果。
7. 将任务终态、结果引用和 Session 状态保存成功后，再启动下一项。
8. 失败、超时、取消或保存错误时停止调度。所有任务成功后保存 Session succeeded 并释放锁。

executeTask 拟新增可选参数 `attemptId?: string`。省略时保留阶段 1 的自动生成行为；提供时校验为 UUID，防止目录穿越。完成 token 仍由 executeTask 每次重新随机生成，不使用 taskId 或 sessionId 代替。

预约状态保存失败时禁止启动 Runner；单任务记录创建失败时，当前任务记为 failed，使用基础设施原因码，Attempt 引用标明 record_missing，不伪造退出码或完成证据。若连 Session 终态都无法保存，CLI 返回失败并报告最后可靠快照位置。

### 4.2 取消边界

CLI 的 AbortController 传给 TaskOrchestrator，再传给当前 executeTask。收到取消后，当前任务按阶段 1 规则停止；调度器等待清理完成并保存结果，随后释放锁。两任务之间收到取消时，不创建下一次 Attempt，未执行任务仍为 planned。

若取消到达时前一任务已经结算成功，保留其成功结果，只停止后续调度。不会在同一次 run 调用内吞掉取消并重新启动任务。

## 5. 前置结果传递与最终验证

### 5.1 保存可交接的结果

阶段 1 的 ExecuteTaskResult 只有 Attempt 和记录目录，尚无统一最终回复。本阶段为 RunnerOutput 增加可选的 `finalText`：Claude 适配器从最终 result 事件提取它，其他 Runner 可不提供。该字段表示回复文本，不表示任务成功；只有 executeTask 的最终结果为 succeeded 时才能发布为有效依赖结果。

编排器通过输出回调收集 `finalText`；没有最终回复时，使用有上限的 agentText 累积文本作为后备，并标明来源。不收集 stderr、原始 JSON、工具输出或工具调用参数作为交接正文。移除本次完成标记，避免把协议文本当成任务成果；优先使用最终回复，避免同时拼接流式文本和其重复的最终结果。

拟保存的 TaskResult 包含 taskId、attemptId、状态、summary、summarySource、truncated 和 artifactDir。每项摘要最多 8 KiB UTF-8 字节，总交接正文最多 24 KiB；截断须保留完整字符，并明确注明内容省略。无可用回复时传递任务状态和记录位置，不编造修改清单或测试通过说明。

这只是确定性的文本整理，不额外调用模型生成摘要。记录输入字节数，暂不声称节省了多少 token。

### 5.2 如何传给后续任务

按 dependsOn 顺序，仅交接直接前置任务的最新有效成功结果，包括任务 ID、Attempt ID、摘要和记录位置。共享工作目录中的代码文件自然保留；摘要用于说明已完成内容和验证情况，不复制整个仓库或所有祖先日志。

有效提示词由以下三部分组成：

```text
当前任务的原始 prompt

前置任务结果（明确分隔，作为执行上下文）
  - taskId / attemptId
  - 成功状态、摘要、是否截断
  - 记录位置

executeTask 追加的本次完成协议
```

不修改原始 PlanDefinition。实际交给 executeTask 的任务副本包含组装后的 prompt，阶段 1 的 task.json 和 prompt.txt 因而记录真实输入；Session 的 plan.json 保留用户原始计划。前置文本不能自行更改 Runner 配置、完成协议或任务状态。

### 5.3 最终验证任务

演示计划至少包括两个实现任务和一个最终验证任务。最终验证任务依赖全部实现分支的末端任务，检查组合后的文件并实际执行测试。验证任务也是普通任务，复用相同完成协议，不增加特殊的“自动成功”规则。

普通计划格式不新增验证角色字段；本阶段在示例和验收中明确该任务。Session succeeded 表示计划内各任务满足执行协议，不独立证明代码正确；真实演示还需检查测试输出和生成文件。

## 6. 文件布局、重新打开与写入边界

### 6.1 默认全部保存在项目内

继续使用当前 CLI 的默认规则：工作目录为启动 CLI 时的当前目录。用户在项目根目录运行时，生成代码及以下记录均保存在项目内；显式 `--workspace` 可以指定其他已存在目录。

```text
<workspace>/
  .token-coupon/
    workspace.lock
    sessions/<sessionId>/
      plan.json          # 原始计划快照，创建后不修改
      session.json       # 任务状态、结果引用和 Session 状态
    runs/<attemptId>/
      task.json
      prompt.txt
      events.jsonl
      attempt.json
      handoff.json       # 本阶段新增的成功交接结果
```

使用单个 session.json 保存关联状态，避免任务状态和 Session 状态分别写入产生不一致。handoff.json 写入成功后再让 Session 引用它。新 Session 创建时先写 plan.json，最后写初始 session.json；初始化失败的目录不能当成有效 Session。

`.token-coupon/` 已被 Git 忽略，不要求为运行记录增加新的忽略规则。文档和 examples 当前也在忽略规则内，开发时可读取与修改；需要纳入提交时需明确检查是否已跟踪。

### 6.2 保存与单写入者

同一工作目录内计划共享代码文件，因此即使 sessionId 不同，也不允许两个计划同时执行。使用工作目录级排他锁；已有执行者时返回 session_busy，不仅依赖内存中的 running 判断。读命令可以读取最后完整快照，不获取执行锁、不改写状态。

写入锁记录所有者 PID、sessionId 和随机所有权 token；释放前检查 token，防止删除其他执行者的锁。快照写入使用同目录临时文件和 rename，并按 revision 串行保存。原子替换用于避免读到半份 JSON，本阶段不承诺断电级持久性。

Session 保存失败后不继续调度，内存中的新状态不能宣称已持久化。支持的正常结束和 Ctrl+C 路径必须在 finally 中释放自己持有的锁。不存在 worktree 隔离时，同一目录内的外部手工修改仍需由用户协调。

### 6.3 重新打开与中断处理

`session show` 读取最后保存的快照、Attempt 历史及原因；它不启动 Runner，也不因为看见 running 就推断原执行已死亡。

`session resume` 获取执行锁后重新校验数据。对 running/pending 记录，先检查对应 attempt.json 和 handoff.json：完整且匹配的终态可以同步回 PlanStore；Attempt 缺失、仍非终态或成功交接结果缺失时，报告 interrupted/recovery_required，禁止自动重跑。失败 Attempt 没有 handoff.json 是正常情况。

崩溃后的旧锁不能因“所有者 PID 已消失”就直接删除：Claude 子进程可能仍在运行，PID 也可能复用。第一版保留现场，报告锁和执行记录位置；用户确认旧执行已停止并完成锁清理后，才允许显式重试。本阶段不设计自动清理未知遗留进程的命令，完整自动恢复留到阶段 5。

恢复不会修改历史 Attempt 的成功或失败事实；interrupted 描述计划层无法完成确认。计划快照版本不支持、文件损坏或引用不匹配时明确报错，不静默创建新 Session，也不从 JSONL 猜测成功。

## 7. CLI 和重试语义

以下命令对应已实现接口。已有 task show/run、plan show 和默认当前目录行为保持兼容：

```bash
# 在项目根目录运行，默认输出到项目内
node packages/cli/dist/main.js plan run --file examples/plan.mock.json

# 打印 Session 状态、任务依赖、Attempt 历史和记录位置
node packages/cli/dist/main.js session show --id <sessionId>

# 继续同一 Session，跳过成功任务
node packages/cli/dist/main.js session resume --id <sessionId>

# 只重试指定任务；成功后另行 resume 剩余计划
node packages/cli/dist/main.js session retry --id <sessionId> --task <taskId>

# 真实计划的单次权限选项
node packages/cli/dist/main.js plan run --file examples/plan.claude.json --accept-edits
```

各命令可通过 `--workspace` 指定工作目录；打开已有 Session 时必须与其保存的 workspace 匹配，不能因当前目录改变而把它迁移到另一目录。CLI 在启动前展示工作目录和 Session ID，输出时附任务 ID，结束时显示任务统计与失败原因。

阶段 2 的计划级 `--accept-edits` 只作用于本次调用中的 Claude 任务；混合计划中的 Mock 任务不使用该选项。没有 Claude 任务时拒绝它。权限模式不持久化成下一次 resume/retry 的默认批准，必要时由用户再次显式传入；该选项也不自动批准测试 Bash 命令。

`--mock-scenario` 保留单任务原语义。计划级离线演示拟增加显式选项 `--mock-task-scenario <taskId>=<scenario>`，仅对指定 Mock 任务生效；允许为不同任务多次指定，拒绝未知任务、重复映射、未知场景和 Claude 任务。该选项适用于 plan run、session resume/retry，场景记录在执行日志中，但不作为后续调用的默认值，也不加入生产任务 schema。retry 时可显式改为 success，避免按任务 ID 隐藏选择失败场景。

### 7.1 重试规则

- 仅允许重试 failed、timed_out、cancelled 或经确认可处理的 interrupted 任务；依赖必须全部 succeeded。
- running、planned、blocked 和 succeeded 不作为 retry 目标。重跑成功任务会影响下游有效性，本阶段不开放。
- 重试产生新的 attemptId、完成 token 和记录目录，保留原 Attempt 引用及记录。
- retry 只执行指定任务。成功后重算后继 blocked 状态，不顺带执行整个计划；用户用 resume 继续。
- resume 不自动重试失败任务；存在未解决失败或未确认执行时，列出任务并返回失败。
- 重试不回滚代码。先前失败可能已修改文件，任务说明和演示应能处理已有文件。

### 7.2 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | run/resume 全部完成；retry 的指定任务成功；show 成功 |
| 1 | 执行失败、状态保存失败、执行锁冲突或需要恢复处理 |
| 2 | 参数、计划图、快照格式、工作目录或能力配置错误 |
| 124 | 当前执行因任务超时停止 |
| 130 | 用户取消本次调用 |

打印的 Attempt 退出码仍是 Runner 进程退出码，不能代替上表的 CLI 退出码。retry 返回 0 只表示目标任务成功，必须同时打印 Session 是否仍有未完成任务。

## 8. 推荐实现顺序和验收

| 步骤 | 实现内容 | 可独立验收的结果 |
| --- | --- | --- |
| 2A：计划与状态 | 图校验、PlanStore、任务和 Session 状态契约 | 拒绝环；按依赖选择任务；输入定义和运行状态分离 |
| 2B：Session 保存 | 版本化快照、UUID 引用、工作目录锁、Attempt 预分配 | 启动前持久化身份；重复打开状态一致；竞争执行被拒绝 |
| 2C：串行执行 | TaskOrchestrator、取消传递、终态保存后继续 | 最大并发为 1；失败停止；成功任务不重复执行 |
| 2D：结果交接 | finalText、有限摘要、handoff.json、上下文组装 | 后续输入包含正确前置结果，无完整日志或重复回复 |
| 2E：继续与重试 | Session 加载、终态核对、显式 retry/resume | 保留历史 Attempt；失败任务可重试；未确认执行不自动启动 |
| 2F：CLI 和演示 | plan run、session 命令、离线及真实示例、独立说明 | 用户能完成计划、关闭后查看、重试并继续验证 |

先完成 Mock 计划闭环和离线边界测试，再执行真实 Claude 演示。实现后另写 `PHASE_2_IMPLEMENTATION_GUIDE.md`，解释核心功能块、代码调用关系、设计原因和关键语法，不追加到前一阶段说明。

### 8.1 必须覆盖的测试

| 场景 | 预期 |
| --- | --- |
| 缺失依赖、重复 ID、自依赖、二节点及多节点环、执行空计划 | 执行前拒绝，不启动任何 Runner |
| 任务数组顺序与依赖相反；多个任务同时就绪 | 依赖优先，同等就绪按原数组顺序；结果可复现 |
| 线性、分支及汇合计划 | 最大活动执行数为 1；最终验证等待所有实现分支 |
| 启动前 Session 保存失败或 Attempt 记录创建失败 | 不启动相应 Runner；失败记录不伪造成功 |
| 前置任务失败、超时、取消 | 后继 blocked，本轮不再启动任何任务 |
| 两任务之间取消 | 已成功任务保留；下一任务无新增 Attempt |
| 原有完成标记、非零退出码和清理规则 | 仍由 executeTask 判定；计划层不覆盖结果 |
| 最终回复与流式文本重复、缺少 finalText | 优先最终回复；后备摘要有界且标明来源 |
| 多字节摘要截断、多个依赖超过总预算 | UTF-8 完整；正文满足预算，记录 ID 和截断信息可见 |
| 重试成功、重试失败、不允许的目标状态 | 新 Attempt 和 token；历史保留；非法重试不启动 |
| 重新打开成功 Session，resume 未完成 Session | 成功任务跳过，不创建重复执行 |
| Attempt 已落终态、Session 尚未更新 | 完整记录可核对；缺失交接结果不自动发布成功 |
| 记录缺失、快照损坏、未知版本、UUID 或路径引用不匹配 | 明确失败；不猜测成功，不读任意外部路径 |
| 同目录不同 Session 竞争执行、旧锁状态不明 | 单写入者；未知旧执行保留现场 |
| CLI show、错误参数、实际进程退出码 | 只读命令不启动 Runner；退出码和输出含义一致 |

既有阶段 0/1 测试必须继续通过。默认测试不调用模型，不依赖 Claude 账号、网络或远端额度；子进程用 Mock 或可控 fixture 验证。

### 8.2 演示和完成门槛

离线示例准备一个成功计划和一个受控失败流程：先完成前置任务，通过 `--mock-task-scenario <第二项ID>=missing-marker` 让第二项第一次失败；重新打开查看后重试第二项并显式选择 success，再 resume 完成最终验证。断言前置任务只执行一次、失败任务有两个 Attempt、验证任务收到重试后的成功结果。Mock 的成功不用于声称真实代码测试通过。

真实示例在项目内的 `demo-workspace/phase2/` 执行，入口显式指定该目录，生成问候函数、补充测试，再执行最终验证。该演示子目录在实现时加入忽略规则，执行记录仍放在它自己的 `.token-coupon/` 下。需要的测试命令按用户配置获得权限，不以绕过全部权限的方式完成演示。

阶段完成须同时满足：

- build、typecheck、已有测试和新增边界测试通过。
- CLI 展示完整成功计划、失败停止、重新打开、显式重试和继续执行。
- 原始计划不被改写，成功任务不重复启动，旧 Attempt 不被覆盖。
- 前置上下文和实际 prompt 可从运行记录复查，交接大小限制有验证。
- Ctrl+C 等待当前执行清理完成；保存失败后不启动后续任务。
- 真实演示生成文件和测试输出可核对；权限拒绝或模型调用失败不计为通过。
- 独立阶段说明与示例命令一致，明确当前支持范围和恢复限制。

## 9. Commit 建议

建议按实现步骤提交，标题沿用已有的 `feat: ...` 英文格式。以下仅是建议，不表示功能已经实现或提交已经创建。

| 步骤 | 建议 commit 标题 | 建议 comment/body |
| --- | --- | --- |
| 2A | `feat: add plan graph validation and task state management` | 校验依赖图；分离计划输入和运行状态，由 PlanStore 管任务转移与就绪条件。 |
| 2B | `feat: persist sessions and task attempt references` | 保存 Session 和 Attempt 关联；启动前记录执行身份；限制同工作目录的执行者。 |
| 2C | `feat: execute manual plans in dependency order` | 复用 executeTask 串行调度，失败或取消后停止启动，状态落盘后继续。 |
| 2D | `feat: pass bounded task results to dependent tasks` | 保存归一化回复和交接摘要，将成功前置结果加入后续实际 prompt。 |
| 2E | `feat: reopen sessions and retry failed tasks` | 校验持久化状态，跳过成功任务，显式重试并保留历史执行记录。 |
| 2F | `feat: add plan execution and session CLI commands` | 增加计划执行与 Session 操作，补齐离线验收、真实演示和独立阶段说明。 |

阶段整体完成后的简单提交 comment：

```text
feat: complete phase 2 manual plan execution and session persistence
```
