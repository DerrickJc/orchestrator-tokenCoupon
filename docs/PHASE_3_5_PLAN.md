# 阶段 3.5 实施方案：草案校验与审查、常驻 CLI 对话和计划差异

状态：核心实现、离线演示、实现指南和全量测试已完成；真实 DeepSeek 规划与审查冒烟测试通过，任务执行使用 Mock Runner，未运行真实 Claude Code。审查批准策略与触发时机已由用户确认。更新日期：2026-10-05。

本方案补充 [Phase 3](PHASE_3_PLAN.md)，安排在 [roadmap](../roadmap.md) 的 Phase 4 隔离与交付之前。单独维护本方案；实施后新增 `PHASE_3_5_IMPLEMENTATION_GUIDE.md`，不向此前阶段的实现指南追加说明。

2026-10-05 的审查循环缺陷及补充实施见 [Phase 3.5 Bugfix 方案](PHASE_3_5_BUGFIX_PLAN.md)：有效需求与原始历史分离、来源追溯、报告驱动修订、带差异的复审及问题身份追踪。

## 1. 问题、目标和范围

目前用户通过 `start/reply/show/export/replace/approve/run` 操作规划。`replace` 已校验输入结构、任务依赖图和执行配置，但不能识别自然语言任务之间的方案矛盾。用户还需要反复复制 planningId、区分 Conversation revision 与 draftRevision，并人工比较修改。

本阶段交付以下闭环：

```text
启动或重新打开规划对话
  → 输入需求、持续补充约束
  → 生成或编辑草案
  → 自动本地校验，展示新旧差异
  → 用户触发模型审查，阅读问题与建议
  → 修改或记录对严重问题的豁免
  → 确认具体版本与哈希，批准
  → 显式执行，查看任务结果
```

模型审查由用户手动触发；批准前必须存在与当前草案匹配的有效报告。

| 本阶段交付 | 延续既有能力或后续阶段处理 |
| --- | --- |
| 可独立使用的本地草案校验与结构化错误报告 | 实际代码正确性由执行后的类型检查和测试验证 |
| 只读模型审查、问题报告、版本与证据绑定 | 自动改写并批准计划、无限自动纠错 |
| 常驻终端对话、规划记录选择、编辑器调用 | daemon、全屏 TUI、VS Code 扩展留给 Phase 7 |
| 按任务展示新增、删除、依赖、prompt 与优先顺序变化 | Git 代码 diff、worktree 和整合留给 Phase 4 |
| CLI 自动携带当前身份，core 校验批准对象 | 执行中修改计划、并行调度留给后续阶段 |

审查是对计划的意见，不是测试结果。即使报告没有问题，也不能宣布业务代码已验证或已交付。

## 2. 已确认决策与设计约定

以下两项已由用户确认：

| 编号 | 决策 | 实施影响 |
| --- | --- | --- |
| D1 | 批准前必须完成有效审查；严重问题需修订或显式豁免并记录 | 单轮命令与 chat 使用同一门禁；缺少或过期报告会提示原因并拒绝批准 |
| D2 | 用户执行 `/review` 时审查 | 新草案自动做本地校验和差异展示，不自动调用模型；也可通过单轮 `planner review` 手动触发 |

D1 与 D2 独立：要求批准前审查，不等于每次保存立即调用模型。结构错误始终拒绝发布；模型审查失败不能被记录成有效审查。

其余设计采用以下约定；实现中若出现改变范围或使用流程的新取舍，再与用户讨论：

- 阶段名称为 Phase 3.5，保留 Phase 4 的原有范围。
- 使用普通终端提示符和 `node:readline`，不新增界面框架；CLI 仍直接调用 core。
- 审查使用当前 Conversation 已保存的 DeepSeek 配置和只读仓库工具，另设 Mock 审查器做离线验收，不增加第二个模型服务。
- 新入口不自动批准、不自动执行；输入自然语言只触发规划，斜杠命令负责操作。
- 模型报告先保存为意见；应用建议通过用户编辑或补充需求产生新草案，不在审查过程中静默改写 Plan。
- 继续使用 PlanDefinition schemaVersion 1，不在本阶段强制引入框架、数据库或验收命令等新的 Plan 字段。
- 执行期间显示输出并允许取消；本阶段不承诺一边执行一边聊天或后台执行。

用户确认的是 D1/D2；其余约定是本实施方案的工程设计，不表示用户逐项选择过这些实现细节。

## 3. 现有代码与扩展位置

| 当前代码 | 已有职责 | 本阶段扩展 |
| --- | --- | --- |
| [validate-plan.ts](../packages/core/src/validate-plan.ts)、[validate-task.ts](../packages/core/src/validate-task.ts) | 严格输入结构、ID 和 DAG 校验 | 复用校验逻辑，返回可定位的诊断，不维护第二套 DAG 规则 |
| [planner-conversation.ts](../packages/core/src/planner-conversation.ts) | 对话、草案替换、批准、执行交接 | 复用执行策略，加入期望版本检查及审查批准门禁 |
| [planner-store.ts](../packages/core/src/planner-store.ts) | 不可变草案、快照、规划锁 | 保存审查报告、操作记录、引用及记录列表 |
| [planner-types.ts](../packages/core/src/planner-types.ts) | 规划消息、草案、批准与读取证据 | 增加审查契约与版本化元数据 |
| [repository-reader.ts](../packages/core/src/repository-reader.ts) | 受限读取、证据采集与复核 | 供审查复用，不开放 shell 或执行能力 |
| [planners/deepseek-planner.ts](../packages/core/src/planners/deepseek-planner.ts) | API、工具往返、预算和凭证处理 | 提取必要的共享 API 调用能力，保留规划与审查不同的输出契约 |
| [planner-cli.ts](../packages/cli/src/planner-cli.ts) | 单轮命令、参数与输出 | 新增 check/review/diff/list/chat 入口，旧命令继续可用 |
| [task-orchestrator.ts](../packages/core/src/task-orchestrator.ts)、[session-store.ts](../packages/core/src/session-store.ts) | 执行、取消、恢复与状态保存 | 继续复用；聊天界面不另建执行状态机 |

新增核心模块为 `plan-check.ts`、`plan-diff.ts`、`plan-review.ts`、`review-store.ts`。本次把 chat loop 保留在 `planner-cli.ts`，共用 CLI 的 Runner 组装、取消信号和输出函数；没有再拆出只包装当前命令的 `planner-chat.ts`。不要为了复用一段 HTTP 代码提前引入多 Provider 注册系统。

```text
planner CLI / planner chat
  ├─ checkPlan → 原有结构校验与执行策略
  ├─ diffPlans → 纯函数比较两份合法 Plan
  ├─ reviewPlannerDraft → ReviewStore + Reviewer + RepositoryReader
  └─ PlannerConversation → 草案替换、批准和 runPlan
```

## 4. 草案本地校验

### 4.1 入口与诊断

提供两种检查方式：

```bash
# 校验当前草案，并核对 Conversation 的执行配置
node packages/cli/dist/main.js planner check --id <planningId>

# 编辑文件导入前校验；给定 id 时同时检查该对话的执行策略
node packages/cli/dist/main.js planner check --file <plan.json> --id <planningId>
```

仅指定 `--file` 时，检查 Plan 结构与 DAG，并明确显示“未核对特定规划记录的执行配置”。`check` 不导入文件、不创建新草案、不调用模型、不更新批准。

拟议诊断契约：

```ts
interface PlanDiagnostic {
  code: string;
  severity: "error" | "warning";
  path: string;
  taskIds: string[];
  message: string;
}

interface PlanCheckResult {
  valid: boolean;
  planHash?: string;
  executionPolicyChecked: boolean;
  diagnostics: PlanDiagnostic[];
}
```

最低交付包括 JSON 解析错误、未知或缺失字段、重复 ID、依赖不存在、重复依赖、自依赖、循环、初始状态错误、任务数量和体积限制、执行配置不匹配。复用原有解析器，不能为“收集多个错误”放宽合法输入的判定；第一版允许先返回首个准确错误，多个独立诊断作为后续增强。

提取共享执行策略时，以字段语义比较配置，不让 JSON 对象字段排列影响合法性；未知字段仍由严格结构校验拒绝。

### 4.2 自动检查与能力边界

- 模型生成与 `replace` 继续在发布前校验；`/edit` 保存后执行同一流程。
- 本地错误直接拒绝发布，当前草案和批准保持原样，编辑文件保留供修正。
- DAG 无环只能证明可以调度，不能推断自然语言中的实际前置条件。
- “实现使用 Express、测试使用 Fastify”“测试只依赖文档而未依赖实现”等问题进入模型审查，不用关键词匹配冒充可靠语义检查。
- `approve/run` 保留加载校验、哈希和证据检查。历史 check 成功不能替代操作当下的检查。

## 5. 模型审查

### 5.1 输入与输出

新增 Reviewer 契约，输入包含当前有效需求和待澄清项、当前合法 Plan、执行配置、必要的只读仓库信息。Bugfix 后原始对话只用于来源追溯，不能直接把全部历史用户消息视作需求。复审同时携带上一轮成功报告和计划差异，不注入所有旧完整计划或 API 日志。

```ts
interface PlanReviewFinding {
  findingId: string;
  severity: "error" | "warning" | "info";
  category: "requirements" | "dependency" | "technology" | "contract" | "testing";
  taskIds: string[];
  description: string;
  basis: string;
  suggestion: string;
}
```

应用验证 JSON、字段、大小与任务引用，并分配或校验唯一 findingId。问题只能引用当前已存在任务；缺失任务用空 taskIds 和明确需求依据表达。报告至少包含需求覆盖、隐含依赖、框架与存储一致性、上下游输入输出、测试安排和最终验证覆盖。

示例：

```text
F1 / error / dependency
任务：write-tests、crud-service
问题：测试需要导入 CRUD 服务，但 write-tests 只依赖 design-docs。
依据：write-tests 的任务要求包含服务层测试；现有依赖不能保证服务已生成。
建议：增加对 crud-service 的依赖。
```

报告不使用“测试已通过”等执行结论。严重程度是审查意见，存在误报；已确认的 D1 因此保留显式豁免。

### 5.2 操作身份、日志与预算

审查操作独立生成 reviewId，不伪装成用户消息、规划 Turn 或执行 Attempt；成功审查不创建草案版本，也不改写 Conversation 的需求历史。

复用 Phase 3 的读取边界和预算：总超时 120 秒、最多 8 次 API 请求、20 次仓库工具调用，单回复最多 4 个工具调用；历史输入预算 256 KiB，最终报告最多 64 KiB、100 个问题。结构修正最多两次且计入总预算，模型/API 错误、取消和预算耗尽不得无限重试。

审查开始前写入运行记录；逐条写 events 和必要的调用日志；完成后再发布可引用的报告。失败、取消、超时、中断保留诊断记录，但不成为有效审查。发布失败不得声称审查成功。

```text
.token-coupon/planners/<planningId>/
├── conversation.json
├── drafts/<revision>.json
├── reviews/<reviewId>/
│   ├── review.json       # 身份、状态、绑定信息、成功报告或失败原因
│   ├── events.jsonl     # 过程事件
│   └── calls/           # 调试模式下的完整请求、响应
└── edits/<editId>/plan.json
```

审查摘要不重复保存完整 Plan，使用版本与哈希引用。原始 API 内容放在独立调用日志，默认报告能读懂问题和依据；完整请求日志仅在显式调试模式保存。既有 Phase 3 日志不在本阶段批量迁移或删除。

### 5.3 审查新鲜度与仓库证据

成功报告保存以下绑定：

- `planningId`、`draftRevision`、`planHash`。
- `requirementsHash`：对有效需求及待澄清项的稳定编号、版本、内容、状态和来源计算哈希；不包含操作命令、噪声或旧模型回复。
- `reviewerConfigHash`：审查模型配置、提示词版本与相关策略的哈希，排除凭证。
- `context`：该草案的读取证据与本次审查新增证据的合并结果。
- 起止时间、结果摘要、问题列表和可校验的 `reportHash`。

审查前复核已有草案证据；若已有依据变化，要求重新调研和生成草案，不能只更新哈希来掩盖旧计划失效。审查完成前再复核本次全部证据。批准和首次执行时复核报告绑定与证据。

新草案、需求变化、审查配置变化或相关文件变化，使报告对当前批准失效；旧报告保留为历史。哈希清单覆盖实际调研文件，不表示已锁定或检查整个仓库。

### 5.4 批准策略与兼容

所有 `planner approve/run` 与 chat 操作统一执行已确认的 D1，不提供跳过审查的可选模式：

| 策略 | approve | 首次 run |
| --- | --- | --- |
| 必须审查 | 必须选择当前有效的成功报告；error 问题全部修订或显式豁免 | 核对批准引用的同一报告、豁免、计划与证据；不得自动选择另一份报告 |

无有效报告时拒绝批准，提示先审查或重审；API 失败不能替代成功报告。此前报告若仍满足全部新鲜度条件，失败的重审不会使其自动失效。warning/info 默认展示；error 的豁免记录 findingId、原因、时间和报告身份。豁免只针对成功报告内的语义问题，不能豁免结构错误、无效图、哈希失败或缺少有效审查。

拟增加批准参数 `--review-id`、`--waive-findings <F1,F2>` 与 `--waiver-reason <原因>`；chat 自动携带报告身份，仅在需要豁免时询问用户。发布新的成功审查时清除旧批准，要求针对新报告重新确认；失败的重审只留下操作记录，不覆盖此前有效报告。不能在保留旧批准身份的同时偷偷换入新报告。

实现保持 Conversation `schemaVersion: 1`，以可选 `latestReviewId` 保存当前报告引用；读取 Phase 3 的快照时，缺少该字段会按 `null` 处理，无需批量迁移。新的批准记录保存 reviewId、reportHash 与豁免。PlanDefinition 及 Phase 2 Session 格式继续保持版本 1。旧的未执行批准没有报告绑定，不能通过新的批准与执行门禁，需要完成审查后重新批准。

这一策略明确改变旧规划记录的批准行为：尚未执行且没有有效报告的旧批准，需要审查并重新批准；不能把旧批准视为已审查。已创建 Session 的重复 planner run 仍只展示原结果，不追溯重写执行事实。已关联执行 Session 的规划只查看历史报告，不在本阶段发起新审查或改写原批准。

## 6. 计划差异展示

提供只读命令：

```bash
node packages/cli/dist/main.js planner diff --id <planningId> --from 1 --to 2
```

省略 `--to` 时使用当前草案；省略 `--from` 时比较前一版本。只有初始草案时显示“首次生成，无前一版本”，不伪造变化。显式请求不存在的版本返回可理解的错误。

比较以 task.id 匹配，输出：

| 变化 | 显示方式 |
| --- | --- |
| Plan ID、标题 | 原值与新值 |
| 任务新增、删除 | Task ID、标题和必要摘要 |
| 标题、prompt、execution 改动 | 字段前后值；prompt 使用逐行差异 |
| dependsOn 改动 | 新增和移除的依赖，按集合比较 |
| tasks 数组排序变化 | 单独显示；当前串行调度中会影响多个可运行任务的选择顺序 |

Task ID 改名显示为删除与新增，不用模型猜测身份。对象字段排列、JSON 缩进和依赖数组单纯换序不产生语义噪声。超长 prompt 可摘要展示并标注截断，`--full` 查看完整差异。JSON 输出用统一 `--json` 供脚本消费。

差异展示调用纯函数，不调模型、不更新记录，也不改变现有 Plan 的哈希算法。成功的 `/edit` 和规划补充生成新版本后自动展示差异；内容未变时不创建重复版本。

## 7. 常驻 CLI 对话

### 7.1 启动、重开与规划记录选择

拟议入口：

```bash
# 新需求：未指定 request 时由提示符收集
node packages/cli/dist/main.js planner chat --planner deepseek --runner claude-code

# 重新打开已有规划
node packages/cli/dist/main.js planner chat --id <planningId>

# 查看当前 workspace 的规划记录，按序号选择后进入
node packages/cli/dist/main.js planner list
node packages/cli/dist/main.js planner chat
```

workspace 默认当前目录；新规划的模型和执行配置沿用现有参数与环境配置。重开已有记录以保存配置为准，不能通过 chat 参数静默切换 Runner 或模型。不提供“默认选最近一条并执行”的行为。

list 显示短 ID、标题、更新时间、草案版本和状态；仅在显示时缩短 ID，内部使用完整 UUID。损坏记录标为不可读并继续列出其余记录，不因为一条损坏快照使列表完全失败。

首次需求真正提交时才创建 Conversation；仅打开帮助或退出不制造空规划。chat 在终端可用，非 TTY 输入提示使用单轮命令；测试通过可注入的输入输出验证控制逻辑。

### 7.2 对话与操作

自然语言输入调用已有 start/reply 流程。斜杠命令拟为：

| 命令 | 行为 |
| --- | --- |
| `/help` | 查看命令和当前操作提示 |
| `/history` | 按需查看用户需求与模型说明；不重复打印历史完整 Plan |
| `/plan [taskId]` | 计划摘要或指定任务详情；明确标记当前草案 |
| `/edit` | 导出当前草案到专用编辑目录，调用编辑器；退出后校验并导入 |
| `/check` | 查看当前本地校验结果 |
| `/diff [from] [to]` | 比较草案版本，默认前一版与当前版 |
| `/review` | 显式发起本轮审查或重审 |
| `/review show [reviewId]` | 查看当前或历史审查，并展示是否过期 |
| `/approve` | 展示批准对象和审查意见，确认后批准准确版本 |
| `/run` | 显式执行当前已批准计划；不隐式批准 |
| `/status` | 查看规划及已关联 Session 的状态 |
| `/retry <taskId>`、`/resume` | 对已关联 Session 复用已有重试、继续能力 |
| `/exit` | 关闭界面，保留持久化记录 |

支持单行输入；多行需求通过 `/request-file <路径>` 读取 UTF-8 文本提交，保留现有需求大小限制。不要将斜杠命令存成模型需求，避免污染 requirementsHash。未识别的命令给出帮助，不自动当成 shell 执行。

提示符展示短 ID、draftRevision、批准与审查状态；历史对话单独按需查看，默认不反复打印旧完整计划。实现后 `/approve` 仍展示 `draft-N` 与哈希摘要，让用户知道批准对象。

### 7.3 编辑器、旧版本和取消

- `/edit` 记录导出时的期望 draftRevision 与 planHash。编辑器退出时，若另一个进程已改草案，拒绝覆盖并保留文件，提示比较与重新导入。
- 编辑文件始终是纯 PlanDefinition；错误保留在编辑文件中，不直接改内部 drafts 文件。
- 编辑器由显式配置或 VISUAL/EDITOR 选择，将可执行文件和参数解析为数组，用 `spawn` 且 `shell: false`；不把路径、文件内容或环境字符串拼成 shell 命令。不支持的参数表达式给出配置提示。
- chat 不为整个会话一直持有 conversation.lock。每次变更由 core 获取锁；确认与批准之间检查期望版本、哈希及报告身份，不能只相信界面缓存。
- 模型调用或执行繁忙期间显示进度，普通新输入不排队成下一项隐式操作；只有取消控制可生效。空闲时 Ctrl+C 退出；繁忙时取消当前操作，保存结果后返回提示符；EOF 取消当前操作后退出。
- `/run` 前台执行，展示 Task ID 与输出。取消后展示真实的 Attempt/Session 状态，不把已生成文件撤销或把取消改成成功。
- 已关联执行 Session 的规划继续禁止替换；界面引导查看、重试、继续或新建规划。

## 8. 一致性、故障与日志边界

审查、替换、批准都使用 core 的规划锁和期望身份检查。review 持锁完成本次输入与报告发布，但不宣称可以阻止外部编辑器修改仓库；前后哈希复核负责发现相关文件变化。

保留现有 execution 预约与 Session 幂等交接；审查门禁放在 core 中，使单轮 CLI 与 chat 使用同一规则。不能只在聊天界面要求审查而让旧 approve/run 绕过。

门禁针对 Planner 草案批准和执行链路。既有 `plan run --file` 是用户显式提供手工计划的 Phase 2 入口，继续保留原有行为，不假装它具备 Planner 审查记录；如要让所有手工执行也必须审查，应另行确认范围。

草案发布后不会自动发起模型审查。用户手动审查失败时，仍保留当前草案并显示审查失败；不能把有效用户编辑回滚，也不能显示旧报告适用于新版本。

报告采用不可变成功内容或原子最终快照，引用只在完整写入后发布。审查失败不修改草案、不制造 Task Attempt；重新发起审查使用新的 reviewId，旧记录留存。恢复时识别运行中但失去 owner 的审查为 interrupted，要求显式重审，不采纳零散事件中的结论。沿用既有锁的保守恢复边界，不仅凭 PID 不存在自动删除遗留锁。

业务代码不被审查工具修改；调用 API 的日志不得包含授权头或 API Key。这里只收敛新增记录的重复内容，不顺带重构 Phase 3 的全部消息存储和压缩机制。

## 9. 实施顺序与验收

### 9.1 分步实施

| 步骤 | 交付 | 验证结果 |
| --- | --- | --- |
| 3.5A | 共享本地校验、check CLI、版本身份检查 | 导入前定位错误；无效输入不替换草案 |
| 3.5B | 纯函数 diff、历史草案读取、diff CLI | 稳定识别任务与依赖变化，忽略展示噪声 |
| 3.5C | 审查契约、MockReviewer、报告存储与新鲜度 | 离线产生意见；换版本、改需求和文件后报告失效 |
| 3.5D | DeepSeekReviewer、review CLI、必须审查的批准门禁与迁移 | API fixture 验证输出校验、只读工具、失败与批准绑定 |
| 3.5E | list/chat、编辑器、确认、取消和状态显示 | 一次启动完成多轮规划、编辑、审查与执行 |
| 3.5F | 端到端演示、回归和独立实现指南 | 可复现整个闭环，解释文件与核心代码关系 |

D1/D2 已确认，并已按上述顺序实施。实现结果和验证记录见[Phase 3.5 实现指南](PHASE_3_5_IMPLEMENTATION_GUIDE.md)。`npm run typecheck` 通过；授权环境中 `npm test` 的 6 个测试文件、50 项测试全部通过；`npm run demo:phase3.5` 完成两轮对话、无效循环拒绝、语义审查、草案修订、重审、批准、Session 执行和重复 run 检查。离线演示使用 Mock Reviewer 和进程内确定性 Runner。另于 2026-10-05 使用 `deepseek-flash` 完成真实规划、两次真实审查、草案修改和旧审查失效、批准绑定、Mock Session/Attempt 与重复 run 的冒烟测试；真实 Claude Code 执行未运行。

### 9.2 必须覆盖的行为

| 场景 | 验收要求 |
| --- | --- |
| 非法手工修改 | 缺失依赖、自依赖、循环、重复 ID、错误 execution 被拒绝；原快照、草案和批准不被覆盖 |
| 框架矛盾 | fixture 使用“Express 实现 + Fastify 测试”的计划，验证报告能定位任务、保留意见和建议；不声称离线 fixture 证明真实模型一定发现矛盾 |
| 隐含依赖遗漏 | 审查问题正确关联测试和实现任务；用户采纳后可在 diff 中看到依赖补齐 |
| 报告结构错误 | 无效任务引用、重复 findingId、超大内容、无效 JSON 不成为有效报告 |
| 新鲜度 | 修改计划或用户需求、改变审查配置、改动证据文件后，旧报告不满足新批准条件 |
| 审查策略 | 没有有效成功报告时阻止批准；error 必须修订或记录有效豁免；warning 展示；失败重审不覆盖仍有效的旧报告；生成与导入新草案不调用模型审查 |
| 版本确认竞态 | 显示或导出版本后另一进程更新草案或成功重审，批准拒绝旧草案或报告身份；编辑回传拒绝旧草案身份 |
| 差异 | 新增、删除、依赖集合、prompt、execution、任务优先顺序被正确显示；缩进和对象键顺序不产生噪声 |
| 常驻对话 | 同一进程收集两轮输入；退出后重开同一历史；命令不污染需求消息 |
| 编辑器 | 无效 JSON 可修正重试；无改动不增版本；编辑器失败不覆盖；特殊路径作为参数传递 |
| 取消与 EOF | 审查/规划/执行取消后记录真实状态；释放锁；繁忙输入不会触发迟到批准或执行 |
| 兼容与幂等 | 读取旧记录；按确认策略迁移批准；已关联 Session 重复 run 不启动第二次 Runner |

验收使用 Mock、可注入终端 I/O、受控编辑器子进程和 API fixture，验证行为而非复制实现。当前实现已运行 `npm run typecheck` 和 `npm test`，保持既有测试收集范围；真实 DeepSeek 规划/审查调用已通过独立冒烟测试，真实 Runner 的业务代码实现和测试结果未由该测试验证。

### 9.3 演示与完成标准

离线演示放在 `demo-workspace/phase3.5`：

1. chat 输入后端需求，再补充测试要求，得到草案。
2. 编辑出依赖环，检查拒绝导入；修复后产生新草案并展示 diff。
3. Mock 审查指出框架不一致与测试依赖遗漏；修改后旧报告过期。
4. 重审，修订或显式豁免严重问题，明确批准具体版本，再显式执行 Mock Runner。
5. 检查 Session plan.json 等于批准 Plan；报告、豁免和执行关联可以重新打开查看。
6. 再次 run 不重复执行，退出并重新进入 chat 后身份与状态一致。

真实演示单独配置当前服务可用的模型，对小型计划进行只读审查；单独报告真实审查与 Claude 执行状态。API 失败、等待权限或测试失败必须如实保留；Mock 验收不能替代真实质量结论。

完成报告列出已完成范围、D1/D2 决策、离线与真实演示结果、残留限制。实现指南聚焦核心代码、设计原因、模块关系和关键状态保存点，不逐项解释所有测试、示例和文档文件。

## 10. Commit 建议

沿用此前 `feat: ...` 英文提交标题。以下是实施建议，不表示已经创建提交。

| 步骤 | 建议 commit 标题 |
| --- | --- |
| 3.5A | `feat: add reusable draft checks and version guards` |
| 3.5B | `feat: display changes between planner draft revisions` |
| 3.5C | `feat: persist plan reviews bound to drafts and repository evidence` |
| 3.5D | `feat: require valid draft reviews before plan approval` |
| 3.5E | `feat: add persistent planner CLI conversations and draft editing` |
| 3.5F | `feat: complete planner review and interactive CLI demos` |

整体完成后的建议 comment：

```text
feat: complete phase 3.5 draft review and interactive planner CLI
```

仅提交本实施方案时：

```text
docs: add phase 3.5 planner review and CLI implementation plan
```
