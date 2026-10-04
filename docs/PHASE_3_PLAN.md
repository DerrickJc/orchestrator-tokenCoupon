# 阶段 3 搭建方案：只读 Planner、持续规划对话与计划批准

状态：代码实现和离线验收已完成。更新日期：2026-10-04。真实 API 与 Claude Code 演示因当前未配置 `TOKEN_COUPON_PLANNER_API_KEY` 尚未执行；详见[阶段 3 实现指南](PHASE_3_IMPLEMENTATION_GUIDE.md)。

本方案记录实施目标和验收边界；部分接口示意是设计草图，实际可用命令与实现以实现指南为准。

本方案对应 [roadmap](../roadmap.md) 的阶段 3，前置交付为[阶段 2 方案](PHASE_2_PLAN.md)和[阶段 2 实现指南](PHASE_2_IMPLEMENTATION_GUIDE.md)。本阶段让用户从自然语言需求得到计划，持续补充约束、编辑任务，并在明确批准后复用现有串行执行能力。

## 1. 交付目标和实现选择

```text
用户需求
  → Planner 通过受限文件工具调研仓库
  → 提出澄清问题；用户可退出 CLI 后重新回复
  → 生成并校验计划草案
  → 用户查看、编辑、批准具体草案版本
  → 创建执行 Session，复用 Phase 2 的 runPlan()
  → 查看结果、重试和继续执行
```

本阶段采用 **API Planner + core 提供的只读仓库工具**。先实现 MockPlanner 和一个 DeepSeek Chat Completions 适配器，使用 Node 内置 `fetch`，不新增独立服务。Claude Code 继续作为执行 Runner；规划模型与执行模型分别配置。

选择 API Planner 的原因是：应用可以明确控制模型获得的工具、文件范围、调用次数和对话历史；无需让 Claude Code 的 `acceptEdits` 权限模式承担只读调研，也不需要依赖 Claude 私有聊天会话恢复。若以后加入 ClaudeCodePlanner，遵循同一个 Planner 接口另行适配。

| 本阶段实现 | 后续阶段实现 |
| --- | --- |
| 仓库目录查看、文本读取和文本搜索 | shell、测试执行、文件修改等执行工具 |
| 持久化需求、澄清回复、计划版本和批准记录 | 终端聊天界面、daemon、TUI |
| 结构校验、有限纠错、用户导入修改后的计划 | 无上限自动修复、模型自动批准 |
| 一个真实 API 适配器和离线 MockPlanner | 多 Provider 注册表、动态模型路由 |
| 批准后创建一个 Phase 2 执行 Session | worktree、Git 整合、并行任务 |
| 有明确上限的历史和调研上下文 | 自动对话压缩、分叉、token 优化收益评估 |

持续对话首先表现为 `planner reply`：每次命令执行一轮，应用加载之前的对话后再次请求模型。CLI 不需要一直保持运行，模型服务也不负责保存本项目的对话。

## 2. 当前基础与兼容边界

Phase 2 已提交实现，完整测试为 5 个测试文件、34 个用例通过，类型检查通过。Mock 三任务计划已成功。Claude 演示生成了代码和测试，独立 Node 测试 2/2 通过；但其验证任务被 Claude Bash 权限拦截，执行 Session 仍为 failed。Planner 接入不能把该失败记录改成成功。

| 当前核心代码 | Phase 3 如何使用 |
| --- | --- |
| [plan.ts](../packages/core/src/plan.ts)、[task.ts](../packages/core/src/task.ts) | 草案仍使用 schemaVersion 1，任务初始状态仍为 planned |
| [validate-plan.ts](../packages/core/src/validate-plan.ts) | 校验用户编辑或模型生成的计划，包括任务 ID、依赖存在性、自依赖和环 |
| [task-orchestrator.ts](../packages/core/src/task-orchestrator.ts) | 批准后调用 runPlan；保留串行调度、依赖交接和失败即停止 |
| [session-store.ts](../packages/core/src/session-store.ts) | 继续负责执行 Session、快照和 workspace 执行锁 |
| [execute-task.ts](../packages/core/src/execute-task.ts) | 仅用于真正执行任务；Planner 轮次不创建任务 Attempt |
| [main.ts](../packages/cli/src/main.ts) | 保留 plan/task/session 命令，增加 planner 命令组 |

手工 `plan run --file` 仍是用户显式提供并执行计划的入口。新 `planner run` 必须检查规划批准记录；生成草案、回复问题或导入文件都不会自动启动任务。

## 3. 核心功能块及关联

```text
CLI planner 命令
  ↓
PlannerConversation：一轮对话、草案版本、批准和执行交接
  ├─ PlannerStore：对话快照、草案和轮次记录
  ├─ Planner：Mock 或 DeepSeek API 适配
  │    └─ RepositoryReader：只读 list/read/search
  ├─ parsePlan + ExecutionPolicy：计划与执行配置校验
  └─ 批准检查 → runPlan() → SessionStore / PlanStore / Runner
```

| 功能块 | 职责和设计原因 |
| --- | --- |
| Planner | 接收历史、需求和可用只读工具，返回澄清或草案；不管理执行任务状态 |
| PlannerConversation | 组织一轮请求、有限修正、草案提交、批准失效和执行入口；让 CLI 不承担业务状态 |
| RepositoryReader | 对工具参数、读取范围和输出大小做确定性检查；模型生成参数后由应用决定是否读取 |
| PlannerStore | 保存规划对话和不可变草案；不调度 Runner，也不修改执行 Session |
| ExecutionPolicy | 限定草案可用的 Runner、模型能力、模式和超时；把 CLI 内现有能力检查提取为可复用函数 |
| PlanStore | 沿用 Phase 2，只管理已经开始执行的任务状态，不增加对话消息 |
| TaskOrchestrator | 接收批准后的 PlanDefinition，创建 Session 并串行执行，不参与需求澄清 |
| SessionStore | 保存执行事实；规划失败不制造 failed 执行 Session |

建议文件按职责建立 `planner.ts`、`planner-conversation.ts`、`planner-store.ts`、`repository-reader.ts` 和 `planners/`。运行配置检查可以用小型公共函数，不提前引入 Phase 6 的完整 RunnerRegistry。

拟议接口示意：

```ts
type PlannerReply =
  | { kind: "clarification"; message: string; questions: string[] }
  | { kind: "draft"; message: string; plan: PlanDefinition };

interface Planner {
  readonly id: "mock" | "deepseek";
  generate(input: PlannerInput, context: PlannerContext): Promise<unknown>;
}

interface PlannerContext {
  signal: AbortSignal;
  repository: RepositoryReader;
  record: (event: PlannerEvent) => Promise<void>;
}
```

接口返回 unknown 是为了强制调用方校验外部回复。Planner 的成功证据是完整回复、合法结构和有效草案，不使用任务完成标记，也不继承 Runner 的进程退出判定规则。

## 4. 只读调研和 API 边界

### 4.1 仓库工具

仅提供以下三个工具，工具名和参数由应用固定定义：

| 工具 | 输入 | 输出及限制 |
| --- | --- | --- |
| repo_list | 相对目录、分页游标 | 排序后的目录项；每页最多 200 项，单轮遍历最多 5,000 项 |
| repo_read | 相对文件路径、起始行、行数 | 带行号的 UTF-8 文本；最多 200 行、16 KiB，截断须显式标注 |
| repo_search | 相对目录、普通字符串、分页游标 | 最多 100 处匹配；按字面字符串搜索，最多扫描 1,000 个文件，每个最多 256 KiB |

RepositoryReader 使用文件 API 实现，不把模型参数拼到 shell 命令里。不提供 Bash、Write、Edit、包安装、Git 修改、执行测试、任意 URL 请求或第三方 MCP 工具。

读取范围限制在 workspace 的真实路径内。拒绝绝对路径、目录穿越、路径组件中的符号链接、非普通文件和二进制内容；读取前重新校验路径。默认排除 `.git/`、`.token-coupon/`、`node_modules/`、构建产物、演示产物，以及 `.env`、私钥和本机配置目录。单个文件超过 1 MiB 时返回 file_too_large；其余文件通过有界分块读取返回所选片段，不先整份加载再截断。每次读取定位行号时最多扫描 256 KiB，超过上限返回范围受限说明。

`.gitignore` 是 Git 跟踪规则，不直接决定 Planner 的读取权限。项目内被忽略的 docs 和 roadmap 仍可作为明确选择的文本上下文；本机秘密和运行记录不能通过“文件被显式指定”取消排除。

这里的只读是应用提供的能力边界：模型无法调用写入函数，调研不会启动可执行仓库脚本。应用自身仍写入 `.token-coupon/planners/` 记录。这不等于操作系统沙箱，也不承诺抵抗其他进程同时恶意替换文件；正常外部编辑通过上下文哈希检查发现。

### 4.2 调研范围和预算

先向模型提供需求、Runner 默认配置、目录入口和已有草案，按需读取相关源码与文档。不自动把整个仓库或所有旧日志放进请求。文件内容和工具结果是调研数据，不能更改工具白名单、批准状态或执行入口。

初始建议上限如下，实施时写为集中配置并测试边界：

| 项目 | 默认上限 |
| --- | --- |
| 单条用户输入 | 8 KiB UTF-8 |
| 单轮工具输出总量 | 64 KiB UTF-8，截断保持完整字符 |
| 单轮本地文件读取总量 | 8 MiB，包含搜索和完整文件哈希计算 |
| 单次发送的消息内容总量 | 256 KiB UTF-8；预算不等同于 token 数 |
| 单轮调研请求 | 最多 5 次，每个回复最多 4 个工具调用 |
| 单轮 API 请求总数 | 最多 8 次：调研、最终输出和最多 2 次纠错共用预算 |
| 单轮总超时 | 120 秒，包含 HTTP、工具执行和纠错 |
| 单次 HTTP 响应 / 最终正文 | 最多 1 MiB / 64 KiB |

工具调用参数错误返回结构化工具错误，仍消耗预算。达到调研上限后停止提供工具，要求模型基于已获得的信息澄清或生成草案，不继续无限探索。历史过长时明确返回 context_budget_exceeded，保留记录并提示缩小范围或创建新规划；本阶段不静默丢弃早期用户约束。

### 4.3 首个真实适配器与模型配置

DeepSeek 适配器先使用非流式 Chat Completions：调研阶段提交工具定义，应用接回工具请求、校验并执行读取，再把工具结果发回；最终输出阶段禁用工具，要求输出 JSON。官方接口定义了消息历史、函数工具和 JSON 输出，但 JSON 输出不替代本项目的结构与依赖校验，见 [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。

初版关闭思考模式，以简化工具消息回放；不把思考文本当成用户回复或草案。协议相关选项由 DeepSeek 适配器管理，不假定任意兼容网关都支持相同参数。

拟新增以下独立配置，API Key 只从运行时环境读取：

```text
TOKEN_COUPON_PLANNER_BASE_URL   # 默认为官方 HTTPS API 根地址；可显式配置网关
TOKEN_COUPON_PLANNER_API_KEY    # 不保存到对话、草案、日志或命令输出
TOKEN_COUPON_PLANNER_MODEL      # 必填，使用目标服务真实接受的 modelId
```

Planner 不自动继承 ANTHROPIC_MODEL，也不把 Claude 的别名或 `[1m]` 后缀原样移植到 API。模型可用性须通过目标服务的实际响应确认；未知模型、鉴权失败和不支持的协议参数直接报告，不悄悄换模型。配置快照记录 provider、model 和不含凭证的 endpoint，创建后固定；重新打开使用该快照，环境中的默认模型变化不覆盖它。更换模型或 endpoint 时新建规划，API Key 可通过运行时环境更新。

TaskDefinition.execution.modelId 决定后续 Runner 使用的模型，和 Planner 模型是两个字段。用户在规划开始时指定执行 Runner 和可选任务模型，应用将可用配置传给模型；首版所有任务使用本次选择的 Runner，模型不能自行扩大可用 Runner 范围。Mock 任务不能携带 modelId，任务超时和 mode 也继续受执行能力检查约束。

## 5. 对话、草案和批准的数据设计

### 5.1 三种身份

| 身份 | 含义 | 与已有对象的关系 |
| --- | --- | --- |
| planningId | 一次需求规划及其后续对话，使用 UUID | 可以在尚无可执行计划时存在 |
| turnId | 一次用户输入的规划调用，使用 UUID | 不是执行 Attempt；重试产生新 turnId 并关联原用户消息 |
| sessionId | 批准后开始执行时产生的 UUID | 沿用 Phase 2；与 planningId 显式关联 |

Conversation revision 是持久化快照版本；draftRevision 是有效计划版本。工具事件或请求状态写入不应让用户看到的计划版本无故增加。

### 5.2 对话快照与草案

拟采用的核心快照如下；时间、错误及预算统计在实现时补充：

```ts
interface PlannerConversationSnapshot {
  schemaVersion: 1;
  planningId: string;
  workspace: string;
  revision: number;
  status: "collecting" | "draft_ready" | "approved" | "execution_created";
  plannerConfig: PlannerConfigWithoutSecrets;
  executionDefaults: ExecutionConfig;
  messages: ConversationMessage[];
  turns: PlannerTurnRef[];
  activeTurnId: string | null;
  draftRevision: number | null;
  approval: PlanApproval | null;
  execution: ExecutionReference | null;
}

interface PlanApproval {
  approvalId: string;
  draftRevision: number;
  planHash: string;
  approvedAt: string;
}
```

草案保存已通过 parsePlan 的 PlanDefinition、生成说明、来源（模型或用户导入），以及调研上下文清单。清单至少包括实际读取文件的相对路径和完整内容哈希，用于显示调研范围并检测变化；哈希通过分块读取计算，计入本地读取预算，无法取得完整哈希时不发布该文件内容为有效调研结果。后续轮次沿用仍有效的证据；发现变更时需重新读取受影响内容，不能仅更新哈希而假装已重新调研。计划哈希基于校验后的稳定序列化结果计算，不对原始 JSON 的缩进做哈希。

每个有效草案版本不可变。导入内容没有语义变化时不新增版本；任何有效计划内容变化都建立新版本。对话快照只引用最后成功提交的草案，失败回复不会覆盖它。新用户输入、执行默认配置变化或草案替换都使旧批准失效；旧草案可以继续查看，但需重新规划或批准。

### 5.3 轮次状态和重新打开

PlannerTurn 使用 running、succeeded、failed、cancelled、timed_out、interrupted。轮次失败与计划状态分开：HTTP 超时不制造失败任务，也不丢失上次有效草案。

用户输入在请求模型前保存并分配 messageId。显式 `planner retry` 只重试最后一个未完成用户输入，产生新 turnId，复用 messageId，避免在历史中重复追加用户要求。一个 planningId 同时只允许一轮请求或编辑操作。

`planner show` 只读取最后完整快照。修改命令发现旧 activeTurnId 时，先将无法确认完成的轮次标为 interrupted；不自动续发 HTTP 请求、不自动采纳零散工具日志中的草案。已保存但尚未被快照引用的回复留作诊断，用户通过 retry 重新完成该轮。

## 6. 从请求到批准，再交给执行

### 6.1 一轮规划流程

1. 获取规划记录锁，校验 workspace、模型配置、输入和历史预算。
2. 获取已有 workspace 共享锁，避免本项目同时执行任务修改调研目录；锁失败时不请求模型。
3. 保存用户输入、新 turnId、running 状态和批准失效结果，成功后才发出 HTTP 请求。
4. 根据已完成的用户/助手历史和当前草案构造请求，进行有预算的只读工具循环。
5. 工具调查结束后，要求返回一个完整 PlannerReply JSON；记录实际请求和结果。
6. 校验 envelope；draft 分支调用 parsePlan、非空计划检查和 ExecutionPolicy。
7. 若结构或依赖无效，仅把可定位错误反馈给模型，最多修正 2 次；不自动补任务、删依赖或换 Runner。
8. 写入轮次终态和不可变草案，最后原子提交对话快照；提交成功后才向 CLI 宣布草案可用。
9. 释放自己持有的锁。取消、超时、网络错误或保存失败时保留最后可靠快照，禁止执行计划。

最终回复只接受一个 JSON 对象，不从任意说明文本中搜索“看起来像计划”的片段。clarification 必须有非空 message 和 1—3 个问题，且不能夹带 plan；draft 必须有完整 plan，不能同时宣称仍有待回答的阻塞问题。

计划结构合法不等于任务拆分合理。CLI 展示任务目标、prompt、依赖、Runner、模型和超时；是否满足需求、验证命令是否合适由用户审阅。Planner 提示词要求任务有具体交付和验证要求，演示中包含最终验证任务，不新设自动成功的验证角色。

### 6.2 有限修正与异常

结构错误、自依赖、环、未知 Runner 或非法模型能力可以进入有限修正。HTTP 鉴权失败、未知 API 模型、取消、超时、响应过大、日志保存失败不进入模型纠错；不把“服务不可用”伪装成“计划不合法”。网络请求本阶段不自动重试，避免不明确的重复调用与费用，保留显式 retry。

Ctrl+C 通过同一 AbortSignal 传给 fetch 和 RepositoryReader；请求被取消后禁止提交迟到回复为有效草案。每次提交检查 turnId 和期望 revision，以免旧请求覆盖新状态。

### 6.3 批准与执行交接

`planner approve --id <planningId> --revision <draftRevision>` 校验当前草案、配置和所读文件哈希，保存针对该版本的批准。批准只保存用户决定，不调用模型、不启动 Runner。读取过的文件发生变化时返回 workspace_changed，要求下一轮重新调研并审阅；哈希清单不代表整个仓库的 Git 快照，也不能检测所有未读文件变化。

`planner run` 在规划锁下重新检查批准和计划哈希，再把同一份校验后的计划交给 runPlan。在 runPlan 获取 workspace 锁之后、创建 Session 之前，再检查批准和调研文件哈希，避免检查通过后另一个本项目执行者修改文件。执行 Session 的 plan.json 保存该批准版本；不用模型“再整理一次”计划，也不复制规划轮次为任务 Attempt。

为处理创建 Session 与保存关联之间的中断，需要在启动任务前建立身份：

```text
预分配 executionSessionId
  → 对话保存 execution={sessionId, approvalId, draftRevision, state:"reserved"}
  → runPlan 使用该 sessionId 创建并保存初始 Session
  → 执行任务；对话随后保存 state:"created"
```

拟为 runPlan 新增可选 sessionId 和 beforeCreateSession 校验回调：前者由 SessionStore 校验 UUID 并以独占方式创建目录；后者在 workspace 锁内、创建 Session 前执行，失败时不创建执行记录。省略两项时保持原行为。重复 `planner run` 若已关联 Session，则显示 Session ID 并提示使用 session show/resume/retry，不再创建另一份执行。reserved 状态下若初始 Session 已存在，核对计划哈希后补齐关联；只有确认目录和 Session 均未创建时，才允许复用预约 ID 重新尝试创建。目录存在但初始化不完整时报告错误，保留现场，不自动删除后重新创建。

执行 Session 创建后，本阶段冻结该规划记录的回复、编辑和重新批准入口，避免修改运行中计划；后续需求另建规划。任务失败、取消和恢复仍使用 Phase 2 的 Session 命令，规划批准不授权无限重复新建执行。

### 6.4 持久化与锁

```text
<workspace>/.token-coupon/
  workspace.lock                    # 规划调研与任务执行互斥
  planners/<planningId>/
    conversation.json               # 消息、状态、草案/批准/执行关联
    conversation.lock               # 同一规划记录只允许一个修改者
    drafts/<draftRevision>.json       # 不可变的已校验草案与调研清单
    turns/<turnId>/
      turn.json                      # 轮次状态、错误、输入身份、预算
      events.jsonl                   # 只读工具及处理事件
      calls/<n>.request.json         # 请求正文，不保存鉴权头
      calls/<n>.response.json        # API 回复，限制大小并过滤凭证
  sessions/<sessionId>/              # 原有执行 Session
  runs/<attemptId>/                  # 原有执行 Attempt
```

规划记录使用 UUID 目录，不用模型提供的 planId 或文件路径决定记录位置。加载时重新计算记录路径、校验引用和 workspace，不能任意读取快照里的外部路径。

同目录临时文件加 rename 提交 JSON，草案和轮次先写好，再提交引用它们的对话快照。初始化失败的目录不作为有效规划；不从不完整 JSONL 重建业务状态。日志无法保存时停止轮次，不在记录缺失的情况下声称草案已可靠保存。

复用 Phase 2 的 workspace 锁；如需提取公共 WorkspaceLock，兼容旧锁记录并保留所有权 token 检查。不要另建一把与任务执行互不识别的规划 workspace 锁。统一按“规划锁 → workspace 锁”获取；planner run 持有规划锁并让 runPlan 获取 workspace 锁，不能在外层重复获取同一 workspace 锁造成死锁。异常退出留下的锁不凭 PID 缺失自动删除；确认旧执行停止后才可人工清理，沿用 Phase 2 的保守恢复边界。

## 7. 拟新增 CLI 和演示流程

以下命令可在当前实现中使用。Mock 默认直接生成草案；`--mock-clarify` 用于离线演示首轮澄清。

```bash
# 离线规划：MockPlanner 提出问题，任务后续用 MockRunner 执行
node packages/cli/dist/main.js planner start \
  --planner mock --runner mock \
  --request "为 greet 增加空字符串行为和测试" \
  --workspace demo-workspace/phase3 --mock-clarify

# 退出后重新读取记录、补充要求；ID 来自 start 输出
node packages/cli/dist/main.js planner show --id <planningId> \
  --workspace demo-workspace/phase3
node packages/cli/dist/main.js planner reply --id <planningId> \
  --message "空字符串返回 Hello, !；用 node:test 验证" \
  --workspace demo-workspace/phase3

# 把当前草案导出到本地文件，用户编辑后再导入
node packages/cli/dist/main.js planner export --id <planningId> \
  --file demo-workspace/phase3/review-plan.json \
  --workspace demo-workspace/phase3
node packages/cli/dist/main.js planner replace --id <planningId> \
  --file demo-workspace/phase3/review-plan.json \
  --workspace demo-workspace/phase3

# 用户明确批准当前草案版本；版本号来自 show/replace
node packages/cli/dist/main.js planner approve --id <planningId> --revision 2 \
  --workspace demo-workspace/phase3
node packages/cli/dist/main.js planner run --id <planningId> \
  --workspace demo-workspace/phase3
```

目录由用户或演示脚本提前创建，保持当前 CLI “workspace 必须存在”的规则。记录和演示文件继续放在当前项目目录下，`.token-coupon/` 和 `demo-workspace/` 保持忽略。

| 命令 | 行为 |
| --- | --- |
| planner start | 创建记录，保存需求和配置，执行第一轮调研/澄清 |
| planner reply | 加载历史，保存新用户输入，执行一轮并使旧批准失效 |
| planner retry | 显式重试最后失败、超时、取消或中断的用户输入 |
| planner show | 展示对话、草案版本、调研范围、批准和执行关联；完全只读 |
| planner export | 只导出当前合法 PlanDefinition，防止意外覆盖已有目标文件 |
| planner replace | 校验用户编辑的计划，提交新版本并使旧批准失效；不请求模型 |
| planner approve | 要求具体 draftRevision，保存批准；旧版本和存在活动轮次时拒绝 |
| planner run | 检查批准、配置和上下文，创建一次执行 Session 并调用 runPlan |

真实规划使用 `--planner deepseek --runner claude-code`，从独立 Planner 环境配置获取 API 模型；`--task-model` 指定执行模型。`--accept-edits` 仅用于 planner run 中的 Claude 执行 Runner，不能用于规划调研，也不代表批准任意 Bash 命令。

默认非流式打印“调研中、等待回答、草案可审阅、已批准、执行 Session 已创建”等状态。有效澄清回复返回 0；用户参数/文件输入错误返回 2；运行失败返回 1；超时返回 124；取消返回 130。planner run 复用执行命令的退出规则。

## 8. 实施顺序、测试与完成标准

### 8.1 分步实施

| 步骤 | 交付 | 可独立验证的结果 |
| --- | --- | --- |
| 3A：规划契约与读取能力 | 已完成：Planner 契约、受限读取工具和预算 | 路径越界、符号链接、秘密目录、超限读取被拒绝 |
| 3B：对话保存与 MockPlanner | 已完成：轮次、历史快照和离线适配器 | 新 CLI 进程可重开、继续回复和重试 |
| 3C：真实 API 与校验 | 已完成：DeepSeek 工具往返、JSON 校验和有限纠错 | HTTP fixture 覆盖工具请求、响应、错误和凭证脱敏 |
| 3D：草案编辑与批准 | 已完成：不可变版本、导入导出、哈希与批准门禁 | 修改产生新版本；批准绑定具体版本；未批准不能执行 |
| 3E：执行 Session 交接 | 已完成：预留 sessionId 并复用 runPlan | 重复 run 返回原 Session，不创建第二次执行 |
| 3F：CLI、演示和说明 | 已完成：planner 命令、离线端到端演示和实现指南 | 离线走通“需求—澄清—重开—编辑—批准—执行”；真实服务演示待凭证配置 |

不在本次计划编写时增加生产代码。实施后新增 `docs/PHASE_3_IMPLEMENTATION_GUIDE.md`，说明核心代码、功能块关系与设计原因；遵循此前文档要求，不逐条详细介绍测试、样例和所有文档文件。

### 8.2 核心验收场景

默认测试完全离线：使用 MockPlanner 和 HTTP fixture，不调用真实模型。既有 34 项测试继续通过，新增用例围绕行为而非复述实现。

| 场景 | 必须验证的行为 |
| --- | --- |
| 只读调研 | 文件内容和源码清单在规划前后相同；越界/符号链接/不支持工具无读取或执行副作用 |
| 受限调研循环 | 工具数量、输出大小、HTTP 数量和总超时生效；取消后不采纳迟到回复 |
| 对话重新打开 | 新 CLI 命令加载已完成历史和草案；不要求原进程或模型服务保留聊天会话 |
| 结构与依赖纠错 | 无效 JSON、自依赖、环、非法 Runner 受限修正；耗尽后返回错误且保留旧草案 |
| 不可变草案 | 用户修改建立新版本，原版本可查看；无效导入不覆盖当前版本 |
| 批准边界 | 未批准、旧版本、哈希不符、已读文件变化、活动轮次、批准后又回复均阻止执行 |
| 持久化失败 | 用户输入预约失败不请求模型；草案/快照写入失败不宣布新版本可用 |
| 并发与中断 | 同规划记录不能同时 reply/replace/run；workspace 执行与调研互斥；旧轮次标为 interrupted |
| 执行身份交接 | Session 初始快照保存前不启动任务；关联写入中断后找到原 Session，重复 run 不产生新执行 |
| 回归兼容 | plan/task/session 命令、已有 Session 格式及 Mock/Claude Runner 的语义保持兼容 |

离线演示必须在 `demo-workspace/phase3` 走通澄清、重开对话、用户编辑、拒绝未批准执行、批准具体版本、创建 Mock 执行 Session、查询结果。检查导出计划内容与执行 Session plan.json 一致，而不只检查命令退出码。

真实演示用一个明确配置的 API 模型生成小型计划，确认 Planner 未改源码，再由用户批准后交给 Claude Code 执行。单独核对实际代码和测试输出；出现模型不支持或 Runner 命令待审批时，如实保留失败记录和原因，不用 Mock 成功代替真实成功。Phase 3 完成报告分列“离线验收”和“真实服务演示”的状态。

实现后运行 `npm run typecheck` 和 `npm test`。保持 Vitest 仅收集 `packages/**/*.test.ts`，演示目录的 Node 测试独立执行，避免再次混入项目测试。

## 9. Commit 建议

沿用当前 `feat: ...` 英文标题。以下为建议，不表示已经实施或创建提交。

| 步骤 | 建议 commit 标题 | 建议 comment/body |
| --- | --- | --- |
| 3A | `feat: add planner contracts and read-only repository tools` | 定义规划回复和受限读取能力，限制路径、内容大小和调研预算。 |
| 3B | `feat: persist planner conversations and draft revisions` | 保存需求、规划轮次和不可变草案；支持重新打开及显式重试。 |
| 3C | `feat: generate validated plans with a bounded API planner` | 接入一个真实模型 API，处理只读工具往返、有限纠错和失败记录。 |
| 3D | `feat: review and approve versioned plan drafts` | 支持用户导入编辑后的计划，批准绑定具体版本和哈希，修改使批准失效。 |
| 3E | `feat: execute approved planner drafts through sessions` | 为批准计划预约执行身份，复用 Phase 2，防止重复创建执行 Session。 |
| 3F | `feat: add planner CLI conversations and end-to-end demos` | 增加规划 CLI，补齐离线验收、真实演示与独立阶段说明。 |

阶段整体完成后的简单提交 comment：

```text
feat: complete phase 3 read-only planning and plan approval
```

仅提交本次方案文档时可使用：

```text
docs: add phase 3 planner implementation plan
```
