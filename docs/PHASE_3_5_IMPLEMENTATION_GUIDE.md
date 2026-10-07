# Phase 3.5 实现指南：Planner 草案审查与常驻 CLI

本指南说明 Phase 3.5 的核心代码、数据流和设计原因。阶段范围与验收约定见[实施方案](PHASE_3_5_PLAN.md)，审查修订闭环的补充见 [Bugfix 方案](PHASE_3_5_BUGFIX_PLAN.md)。本阶段让 Planner 草案经过本地校验、显式语义审查和用户批准后才可交给 Session 执行；它没有把 Planner 审查当成业务代码测试。

## CLI 使用方法

### 启动对话并执行计划

先构建并创建演示工作区；模型配置使用已填写的 `~/.config/token-coupon/planner.env`。

```bash
cd /home/lzw/dev/orchestrator-tokenCoupon
npm run build
TOKEN_COUPON_DEMO_WORKSPACE="$PWD/demo-workspace/phase3.5-cli"
mkdir -p "$TOKEN_COUPON_DEMO_WORKSPACE"

node --env-file="$HOME/.config/token-coupon/planner.env" \
  packages/cli/dist/main.js planner chat \
  --planner deepseek --runner claude-code \
  --workspace "$TOKEN_COUPON_DEMO_WORKSPACE" --accept-edits
```

在提示符中逐条输入，等待每次操作完成：

```text
增加 greet.mjs，并用 node:test 覆盖普通姓名和空字符串；不安装依赖，计划包含最终验证任务。
/plan
/check
/review
/approve
```

确认批准时输入 `y`，然后执行：

```text
/run
/status
/exit
```

自然语言输入可继续补充需求。修改草案后必须重新 `/review`、`/approve`；审查有 error 时需修订或明确豁免并记录原因。`/run` 执行当前批准的计划，重复调用复用原 Session。

任务执行没有总时限。运行期间连续 60 秒没有进程输出时会显示一次 idle 提示；这只是活动状态提醒，不代表失败，也不会自动停止任务。新 Attempt 会记录 `executionPolicy: idle_notice`。旧 plan/task 中的 `timeoutMs` 作为历史字段保留但不再生效；新建任务不需要配置 timeout。用户仍可用 Ctrl+C 取消，退出码、完成标记和执行记录仍共同决定结果。

`chat` 在启动后收集需求，不传 `--request`，且需要交互终端。Claude Code 使用自身的认证与模型配置；`--accept-edits` 设置其文件编辑权限模式，测试命令仍受其权限策略控制。只验证规划和审查时，将 `--runner claude-code` 改为 `--runner mock` 并去掉 `--accept-edits`；Mock 不生成业务文件。

### 修改草案

在启动 chat 前配置编辑器：

```bash
export EDITOR='vim'
```

对话内输入 `/edit`，Vim 中使用 `:wq` 保存退出后自动导入、结构校验并显示差异；也可将 `EDITOR` 设为 `nano`。若已设置 `VISUAL`，优先使用它。也可直接输入自然语言要求 Planner 修订。修改后用 `/diff` 查看变化，再 `/review`、`/approve`。

审查有问题时，使用 `/revise` 将当前有效报告完整交给 Planner；它只修订草案，之后仍需重新审查：

```text
/review
/revise
/diff
/review
/approve
```

需要提出新的业务约束时直接输入自然语言。`/requirements` 查看模型整理的有效需求；`/trace <requirementId> [revision]` 查看来源消息、版本链和 Turn 日志目录。新建对话每次成功规划都会自动整理有效需求，无需额外 refresh。旧对话首次使用新审查流程，先运行 `/requirements refresh`，再检查整理结果；有 pending 需求时回答澄清问题后才能批准。单轮对应命令为 `planner revise --id <id>`、`planner requirements --id <id> [--refresh]`、`planner trace --id <id> --requirement <requirementId> [--revision <版本>]`。

### 续聊、恢复和重试

再次运行启动命令，会列出原工作区的已有规划，按序号选择即可续聊；回车表示新建。已知完整 planningId 时，也可直接打开：

```bash
node --env-file="$HOME/.config/token-coupon/planner.env" \
  packages/cli/dist/main.js planner chat \
  --id '<完整planningId>' \
  --workspace "$TOKEN_COUPON_DEMO_WORKSPACE" --accept-edits
```

重开时沿用已保存的模型和 Runner 配置，不再传 `--planner`、`--runner`。后续命令应使用原工作区；新终端需重新设置上述工作区变量。

已关联 Session 的规划只读，用 `/status` 查看状态，`/resume` 继续待执行任务，`/retry <taskId>` 重试失败任务。`/resume` 不会自动重试失败任务；需要新计划时退出并新建。

### 单次规划和更多指令

只提交一次需求、生成草案后退出进程：

```bash
node --env-file="$HOME/.config/token-coupon/planner.env" \
  packages/cli/dist/main.js planner start \
  --planner deepseek --runner claude-code \
  --request '增加问候函数，并补充测试与最终验证任务。' \
  --workspace "$TOKEN_COUPON_DEMO_WORKSPACE"
```

后续可用上面的 `chat --id` 继续。对话内更多操作查看 `/help`；导出/导入草案、单次审查批准、Task/Plan/Session 等命令查看：

```bash
node packages/cli/dist/main.js planner --help
node packages/cli/dist/main.js --help
```

业务文件与 `.token-coupon/` 记录均位于指定工作区。规划、审查、Session 和 Attempt 的记录布局见下文；任务结果以 Session/Attempt 状态为准，Runner 退出码 0 不等于任务成功。

## 端到端流程

```text
planner chat / start / reply
        │ 需求历史、当前草案、只读仓库证据
        ▼
Planner → checkPlan → PlannerStore 写入不可变 draft-N
        │                         └→ CLI 显示本地校验与 draft 差异
        ├─ 用户编辑/补充 → 新 draft-N+1，旧审查和批准失效
        └─ 用户 /review → Reviewer → ReviewStore 保存报告和事件
                                      │ plan / requirements / 配置 / 证据均匹配
                                      ▼
                      approvePlannerDraft → 绑定 reviewId、reportHash、豁免理由
                                      ▼
                    runApprovedPlanner → 创建/复用 Phase 2 Session
```

关键边界是“草案”“审查”“批准”“执行”分别持有自己的身份：`draftRevision + planHash` 标识计划内容，`reviewId + reportHash` 标识审查报告，`approvalId` 标识用户对这两者的批准，`sessionId` 标识实际执行。这样 CLI 不必依靠易过期的屏幕状态判断是否可以执行。

## 本地检查和差异

[plan-check.ts](../packages/core/src/plan-check.ts) 的 `checkPlan` 复用原有 `parsePlan`，所以 Plan 字段、任务 ID、依赖图等结构规则只有一个权威来源。它额外检查任务数、48 KiB 上限和规划记录中的执行默认值，并返回诊断、有效 Plan 与规范 SHA-256。它不判断任务描述在语义上是否互相矛盾；例如“Express 实现 + Fastify 测试”要交由审查。

[plan-diff.ts](../packages/core/src/plan-diff.ts) 按 `task.id` 对齐两个合法版本，比较标题、prompt、执行配置和依赖集合，并单独报告任务顺序变化。比较依赖时先排序、比较嵌套对象时按键名规范化，因此单纯调整 JSON 字段顺序或依赖数组顺序不会制造噪声。task ID 改名表现为删除旧任务和新增新任务，不猜测用户意图。

模型生成、自然语言补充、`replace` 与 `/edit` 都经 core 校验后才写入 `draft-N`。CLI 的 [printDraftUpdate](../packages/cli/src/planner-cli.ts) 在保存后再次显示校验结果；新版本存在前一版时，随即调用 `diffPlans` 显示差异。命令行 `planner check` 和 `planner diff` 也直接调用同一核心函数。[planner-cli.ts](../packages/cli/src/planner-cli.ts)

本地校验检查“计划能否作为合法输入执行”，不证明业务实现正确，也不替代 `/review`。单独用 `--file` 检查时没有某个 Conversation 的执行默认值，因此输出会注明未核对执行策略。

## 审查报告、新鲜度与批准门禁

[PlanReviewer](../packages/core/src/planner-types.ts) 是审查接口。输入由有序用户需求、当前合法 Plan 和执行默认值组成；它不接收可以运行 shell 或修改代码的工具。[DeepSeekPlanner.review](../packages/core/src/planners/deepseek-planner.ts) 复用现有 DeepSeek 配置和只读仓库工具；[MockPlanReviewer](../packages/core/src/planners/mock-planner.ts) 只用于无凭证的离线流程，使用简单规则识别缺失实现依赖和 Express/Fastify 冲突，不代表真实模型的审查质量。

[reviewPlannerDraft](../packages/core/src/plan-review.ts) 在规划锁内读取当前草案、核对已有仓库证据、分配新的 `reviewId`，再运行 Reviewer。报告必须是有界、可解析的结构化 JSON，finding 只能引用当前任务。成功发布前会再次核对所有证据；API 错误、取消、超时和中断单独保存状态，不能成为可批准报告。调用预算为 120 秒、8 次 API 请求、20 次只读工具调用。

[ReviewStore](../packages/core/src/review-store.ts) 为每轮审查保存独立目录：

```text
.token-coupon/planners/<planningId>/reviews/<reviewId>/
├── review.json       # 绑定哈希、结果、问题和状态
├── events.jsonl      # 审查生命周期事件
└── calls/            # 请求/响应排障记录；API Key 会被过滤
```

报告的新鲜度由四类依据共同决定：草案版本和 `planHash`、有效需求的 `requirementsHash`、模型/endpoint/审查提示版本的 `reviewerConfigHash`、仓库证据文件的 SHA-256。核心检查见 [loadCurrentPlanReview](../packages/core/src/plan-review.ts)。有效需求、草案、配置或证据变化时，旧报告不能批准当前草案；仅记录噪声或操作且计划未变，不改变有效需求哈希。

[approvePlannerDraft](../packages/core/src/planner-conversation.ts) 在 core 层强制 D1：没有当前成功报告就拒绝；每个 `error` finding 必须修订，或由用户传入对应 ID 与非空豁免理由。批准保存报告 ID 和哈希以及豁免记录。新草案会清除当前审查引用和旧批准；新成功审查会清除旧批准，要求用户重新确认。[runApprovedPlanner](../packages/core/src/planner-conversation.ts) 再次验证批准的草案与报告身份后才创建 Session，因此旧命令入口不能绕过审查。已有关联 Session 的重复 `run` 仍复用已记录的 Session，不会二次启动 Runner。

Conversation 仍是 schemaVersion 1；`latestReviewId` 和 `requirements` 为可选，以便读取旧快照。旧记录缺少有效需求状态时，需要先整理；旧审查提示版本的报告不再满足批准门禁。Session 与 Plan 的 schema 不变。

## 有效需求、修订与复审的关联

[requirements.ts](../packages/core/src/requirements.ts) 将有效需求与完整 `messages` 分开。模型在同一次规划响应中返回 `requirementsUpdate`，为尚未整理的输入分类，并提交需求增量。程序检查来源消息真实存在、变更引用本轮输入、操作/噪声不能新增、更新或撤回业务需求，并为同一 requirementId 增加版本。明确替换使旧版本标记 superseded；取消需求使用 withdrawn；歧义保留 pending，不能通过批准。语义分类仍由模型判断，用户可通过 `/requirements` 核对并补充纠正。

原文不被删除。常规规划只传有效需求、待整理输入和最近澄清问题；取消/失败输入保持未确认，后续明确确认才可采用。历史消息索引只含 ID 与轮次状态。只读 `conversation_read` 按 ID 返回相关原文，每次最多 8 条、16 KiB，本轮总计 64 KiB，计入已有工具预算。Reviewer 通过有效需求中的 sourceMessageIds 查询来源，避免开放 `.token-coupon` 目录。

`/trace` 的关联链是 `requirementId + revision → sourceMessageIds → messages → Turn 状态和 artifactDir`。`requirements/<revision>.json` 保存不可变状态与哈希；`conversation.json` 保存当前状态，成功 Turn 记录发布的需求版本和使用的 reviewId。失败调用不发布需求更新，已写入但未被快照引用的版本不会被后续操作覆盖。

[revisePlannerDraft](../packages/core/src/planner-conversation.ts) 在规划锁内确认当前有效报告，随后把完整 findings、报告身份及适用状态传给 Planner。普通修订对话也携带最近成功报告，过期报告明确标为参考。`/revise` 的输入被程序标记为操作；新的业务约束应通过普通对话提出。

[reviewPlannerDraft](../packages/core/src/plan-review.ts) 将上一轮报告和 `diffPlans` 结果一起提供给复审模型。每个旧问题必须提交 resolved/unresolved 及依据；unresolved 必须在本轮 findings 中通过 priorFindingId 继续报告。程序分配稳定 issueId，并验证旧问题处理记录完整且与 findings 一致。若模型漏项或输出不一致，[review-reply.ts](../packages/core/src/review-reply.ts) 返回具体诊断，例如“遗漏：F4”；`DeepSeekPlanner.review` 在同一个 reviewId 和预算内最多修正两次，不再开放只读工具，也不重新扩大审查。只有完整候选通过校验后才绑定 issueId 并保存成功报告。F1/F2 仍是本报告编号，用于原有批准/豁免接口；跨轮追踪使用 issueId。报告哈希覆盖问题、解决记录和上一轮报告引用。模型可以发现新问题，这些记录不构成正确性证明。

## 关键实施决策与澄清门禁

[planning-readiness.ts](../packages/core/src/planning-readiness.ts) 定义规划类型及其必需决策清单。`backend_crud` 需要记录语言/运行时、Web 框架、数据库、文档深度、测试方式和业务规则；纯文档、脚本、既有项目变更分别有适用清单，简单通用任务可归入 `general`。Planner 的 `planningAssessment` 为每项记录具体值、状态、理由和依据。

`confirmed` 必须指向有效需求和真实用户原文，`repository` 必须指向本轮读取且哈希匹配的文件，`defaulted` 必须有用户明确授权，`pending` 必须带待回答的问题。core 校验这些来源并要求每个必需项都存在；必需决策会同步到版本化 Requirements，使用 `R-decision-<decisionId>` 稳定 ID。仍待确认的版本显示为 pending，用户回答后同一 ID 会更新为 active，同时保留旧版本。必需决策仍 pending 时只能进入 collecting 澄清状态，不能保存可执行草案。`assertPlanningReady` 还会检查草案是否包含已经确认的具体选择。

门禁不只在首次生成时运行。手工草案导入、复审、批准和启动执行也会检查决策记录，避免通过 `/edit` 跳过澄清。新对话无需运行 `/requirements refresh`；用户回答后沿用同一需求与决策身份更新状态。它能拦截缺少结构记录、来源无效或决策未就绪的情形，但“这项选择是否真的影响实现”仍由模型判断，需在 `/requirements`、`/review` 中核对。

## 常驻 CLI 与编辑流程

`planner chat` 是单进程、多轮输入的终端界面，不是后台 daemon。入口 [runPlannerCli](../packages/cli/src/planner-cli.ts) 将命令分配到已有 core API；[runPlannerChat](../packages/cli/src/planner-cli.ts) 用 `node:readline` 保持提示循环。无 ID 时可以按目录中的记录选择旧对话，也可以输入新需求；有 ID 时继续沿用 Conversation 中保存的 Planner 和 Runner 配置。

自然语言输入调用 `startPlannerConversation` 或 `replyToPlanner`；斜杠命令分别读取/编辑草案、检查与比较版本、显式调用审查、批准或执行。chat 中通过 `/review` 显式触发审查，单次命令则使用 `planner review`；保存草案不会悄悄触发模型。`/approve` 展示具体版本和报告；遇到 error 时收集豁免 ID 和原因，然后还需要单独确认。`/run` 不能替用户批准计划。

`/edit` 把纯 Plan 导出到 `.token-coupon/planners/<planningId>/edits/<editId>/plan.json`，保存导出时的 revision 与哈希。编辑器通过 `spawn(executable, args, { shell: false })` 启动；回传时 core 再对照期望版本并验证 Plan，避免覆盖另一个进程已经写入的新草案。无效文件保留在编辑目录供修正。

启动编辑器前，CLI 暂停 readline 并退出 raw 输入模式，将终端输入交给编辑器；编辑器结束后在 `finally` 中恢复原模式和对话输入。这样鼠标事件转义序列不会被 readline 抢读并显示成 `32;57;30M` 等字符，编辑器启动失败或非零退出后也能继续对话。POSIX 伪终端回归测试覆盖这三种交接场景；修复后 `npm run typecheck` 通过，沙箱外全量回归的 6 个测试文件、53 项测试全部通过。

为验证多轮控制逻辑，[PlannerChatIO](../packages/cli/src/planner-cli.ts) 允许测试注入输入和输出流；真实命令仍默认使用 stdin/stdout。测试覆盖同进程两轮输入、EOF 清洁退出、编辑器路径含空格时安全调用，以及保存后本地检查和差异输出，见 [CLI 测试](../packages/cli/test/cli.test.ts)。

## 记录布局与模块关系

```text
.token-coupon/planners/<planningId>/
├── conversation.json       # 当前状态、消息、草案 revision、批准和审查指针
├── drafts/<revision>.json  # 不可变的 Plan 与 planHash
├── requirements/<revision>.json # 有效需求及来源的不可变版本
├── turns/<turnId>/         # 一次自然语言规划操作的事件与证据
├── reviews/<reviewId>/     # 独立语义审查记录
└── edits/<editId>/plan.json # 编辑器输入/输出文件

.token-coupon/sessions/<sessionId>/
├── plan.json               # 实际执行的 Plan 快照
└── ...                     # Phase 2 的任务状态与执行记录
```

| 文件 | 负责什么 | 与其他模块的连接 |
| --- | --- | --- |
| `plan-check.ts` | Plan 结构、执行策略、大小检查 | 生成、导入和 CLI 检查共用 |
| `plan-diff.ts` | 两个合法 Plan 的稳定比较 | chat 和 `planner diff` 共用 |
| `requirements.ts` | 需求更新校验、有效输入和按需来源读取 | Planner 发布需求；Reviewer 消费有效需求；CLI 提供 trace |
| `plan-review.ts` | 调用 Reviewer、证据新鲜度、报告发布 | 读 PlannerStore/RepositoryReader，写 ReviewStore |
| `review-store.ts` | 校验并持久化审查记录、事件和 API 调用 | `reviewId` 独立于 turn、attempt 和 session |
| `planner-conversation.ts` | 草案替换、批准、Session 交接 | 执行门禁的权威位置，不只依赖 CLI |
| `planner-cli.ts` | 参数、持续输入、差异呈现和明确确认 | 调用 core，不自建第二份状态机 |
| `planners/deepseek-planner.ts` | Planner/Reviewer 的模型协议适配 | 只读工具、受限请求预算和 JSON 输出 |

`attempt` 只记录单个任务 Runner 的一次执行，`turn` 记录 Planner 的一次自然语言规划调用，`review` 记录对某一草案的只读审查，`session` 管理一份计划的多任务执行状态。它们分开持久化，避免把“模型提出意见”写成“用户批准”或“任务已执行”。

## 运行离线演示和验证

```bash
npm run typecheck
npm test
npm run demo:phase3.5
npm run demo:phase3.5-bugfix
npm run demo:phase3.5-bugfix-2
npm run demo:phase3.5-bugfix-3
npm run demo:phase3.5-bugfix-4
npm run demo:phase3.5-bugfix-5
```

演示脚本 [phase3.5-demo.mjs](../scripts/phase3.5-demo.mjs) 使用 Mock Planner、Mock Reviewer 和进程内确定性 Runner。每次运行在 `demo-workspace/phase3.5/run-<时间>/` 建立独立工作区及 `demo-report.json`，不会清理之前的演示。报告包括初次问题、当前审查、批准和 Session 的 ID/状态；完整 review 与 session 文件可在 `.token-coupon/` 下检查。这个演示验证应用内状态流转，不代表真实 DeepSeek 审查，也没有调用 Claude Code。

当前设计仍要求用户判断模型的 error 是否修订或豁免；MockReviewer 的关键字规则只为离线复现固定示例。CLI 进程退出后历史和 Session 可从 workspace 重开，但运行中的 chat 本身不是常驻后台服务。

Bugfix 演示覆盖需求替换与来源追溯、噪声排除、注入技术/依赖冲突、携带报告修订、逐项复审和批准，以及 CLI 的 requirements/trace。产物位于 `demo-workspace/phase3.5-bugfix/<mock或real>-<时间>/.token-coupon/bugfix-report.json`。真实模型模式为 `node --env-file="$HOME/.config/token-coupon/planner.env" scripts/phase3.5-bugfix-demo.mjs --real`，需要凭证；该演示不执行业务 Runner，也不自动豁免 error。

2026-10-05 Bugfix 验收：类型检查通过，最终全量回归 7 个文件、63 项测试通过；离线与真实 DeepSeek 演示各 7 项检查通过。真实演示发现注入的 2 个 error，报告驱动修订后复审逐项 resolved，批准成功；成功报告在 `demo-workspace/phase3.5-bugfix/real-2026-10-05T15-40-18.987Z/.token-coupon/bugfix-report.json`。

Bugfix 2 离线演示 [phase3.5-bugfix-2-demo.mjs](../scripts/phase3.5-bugfix-2-demo.mjs) 用本地假 Runner 和假 API 响应覆盖三项变更：低于实际运行耗时的历史 timeout 不再停止 Attempt；排课 CRUD 的六项关键决策未确认时不发布草案；复审遗漏 F4 时同轮补齐 resolutions 且保留 issueId。运行 `npm run demo:phase3.5-bugfix-2`，产物写入 `demo-workspace/phase3.5-bugfix-2/offline-<时间>/bugfix-2-demo-report.json`。2026-10-06 类型检查通过，全量测试 8 个文件、80 项通过，三项离线检查全部通过；未发起真实模型调用。成功报告位于 `demo-workspace/phase3.5-bugfix-2/offline-2026-10-06T06-02-07.186Z/bugfix-2-demo-report.json`。

Bugfix 3 离线演示 [phase3.5-bugfix-3-demo.mjs](../scripts/phase3.5-bugfix-3-demo.mjs) 回归委托表达、默认提案上下文确认与有限 JSON 修正。运行 `npm run demo:phase3.5-bugfix-3`，报告位于 `demo-workspace/phase3.5-bugfix-3/offline-<时间>/bugfix-3-demo-report.json`。

Bugfix 4 将用户看到的问题、决策值及回答动作绑定为版本化确认记录。CLI 可使用 `/confirm all|编号[,编号]` 接受具体提案、`/delegate all|编号[,编号]` 委托对应选择、`/reject all|编号[,编号]` 拒绝提案；自然语言编号答复也会按当前提案的回答模式解析。对 `provide_value` 问题，用户可给出取值，也可明确说“授权由你决定”；这会成为限定在该问题决策范围内的委托。计划生成前可用 `/revoke all|decisionId[,decisionId]` 撤回已接受或已委托的决策，相关约束重新变为 pending，原批准随之失效。接受某些问题后，未回答项仍保持 pending，Planner 只应询问剩余事项。`Plan v2` 将所选值放入 `decisionContext`，每个任务通过 `decisionRefs` 引用它们；Runner 实际 prompt 会包含这些约束及可追溯偏好。v2 本地校验检查决策 ID、版本和哈希，Reviewer 再检查任务正文的语义是否符合选择，因此正文可自然改写，但不能与 SQLite、框架或业务规则冲突。尚无结构化决策记录的旧 v1 保留原审查提示和需求哈希版本；已有结构化决策的 v1 延续当前 v1 版本，v2 使用新的审查提示与哈希版本。

运行离线闭环：`npm run demo:phase3.5-bugfix-4`。演示先用 `/confirm 1` 接受技术提案，再按当前剩余问题编号委托业务与文档选择；随后检查确认快照、Plan v2 的完整引用、正文改写、Session 和每个 Runner prompt 中的决策约束。报告在 `demo-workspace/phase3.5-bugfix-4/offline-<时间>/bugfix-4-demo-report.json`，对话、计划和 Attempt 记录在该演示工作区的 `.token-coupon/` 下。配置 Planner 凭证后可运行 `node --env-file="$HOME/.config/token-coupon/planner.env" scripts/phase3.5-bugfix-4-demo.mjs --real`，在独立 workspace 验证真实模型的澄清及编号确认；真实模式只生成草案，不运行用户业务任务。

2026-10-07 验收：类型检查通过，全量回归 11 个文件、130 项测试通过；Bugfix 2、3、4 离线演示均通过。真实 `deepseek-flash` 冒烟取得 2 个结构化问题，用户按编号委托后生成 Plan v2 的 draft-1；没有批准或启动 Runner。离线报告位于 `demo-workspace/phase3.5-bugfix-4/offline-2026-10-07T03-43-22.983Z/bugfix-4-demo-report.json`，真实报告位于 `demo-workspace/phase3.5-bugfix-4/real-2026-10-07T03-42-13.844Z/bugfix-4-demo-report.json`。

Bugfix 5 修复草案修订时的决策镜像与内部字段衔接。模型生成和修订均输出 Plan v1 的任务结构；应用基于有效决策生成 Plan v2 的上下文、版本、哈希和任务引用。修订响应即使沿用 v2、遗漏上下文或复制旧哈希，也会先提取任务结构，再重建内部字段；未知字段、非法依赖和 Runner 不匹配仍会拒绝。用户手动导入 v2 的哈希和引用仍须完整有效。`R-decision-*` 在来源校验前同步，引用的消息必须是真实且已分类的业务输入；操作、噪声和未采用的失败输入不能借此变为有效约束。

运行 `npm run demo:phase3.5-bugfix-5` 重放 `phase3.5-new4` 最近失败轮次中的三份响应，覆盖修订、复审、批准、模拟 Runner 执行和持久化。真实修订与复审使用 `node --env-file="$HOME/.config/token-coupon/planner.env" scripts/phase3.5-bugfix-5-demo.mjs --real`。两种模式均使用独立副本，报告位于 `demo-workspace/phase3.5-bugfix-5/<offline或real>-<时间>/bugfix-5-demo-report.json`；Runner 始终为模拟，不执行排课业务项目。已有失败轮次可使用 `planner retry --id <planningId> --workspace <原工作区>` 重试，无需重复输入需求，也不会重复追加原始用户消息。原错误和失败轮次仍保留用于追溯。

2026-10-07 Bugfix 5 验收：类型检查通过，全量回归 12 个文件、143 项测试通过；Phase 3.5 及 Bugfix 1—4 离线演示通过。历史三份失败响应均以 2 次假 API 调用、2 次只读工具查询、0 次自动修正生成 draft-3；真实 DeepSeek 修订亦为 2 次 API 调用、0 次修正，复审逐项回应上轮三项问题，保留一项 warning 与一项 info，无 error。真实副本的 6 个任务通过模拟 Runner 完成状态流转；未调用真实 Claude Code 或 MySQL。报告位于 `demo-workspace/phase3.5-bugfix-5/real-2026-10-07T04-20-55.563Z/bugfix-5-demo-report.json`。

## 真实规划与审查调用测试

配置保存在工作区之外的 `~/.config/token-coupon/planner.env`，包含 `TOKEN_COUPON_PLANNER_API_KEY`、`TOKEN_COUPON_PLANNER_MODEL` 和 `TOKEN_COUPON_PLANNER_BASE_URL`。使用 Node 的 `--env-file` 在启动时加载，避免依赖终端与 Codex 子进程是否继承变量。文件权限设为 `600`，实际 Key 不写入项目或测试报告。

```bash
npm run build
node --env-file="$HOME/.config/token-coupon/planner.env" scripts/phase3.5-real-smoke.mjs
```

[phase3.5-real-smoke.mjs](../scripts/phase3.5-real-smoke.mjs) 是显式运行、需要凭证的冒烟测试，不纳入 `npm test`。它以两项问候函数任务验证真实模型生成、共享结构校验、无审查时拒绝批准、真实审查、修改 prompt 后的差异与旧审查失效、重新审查和批准绑定；随后使用真实子进程形式的 Mock Runner 检查 Session、两个 Attempt、重复 run 幂等性和 CLI `show/check/review` 读取。

2026-10-05 使用 `deepseek-flash`、`https://api.deepseek.com` 完成全部 9 项检查；两份真实审查报告均没有 findings，Mock Session 与两个 Attempt 均为 `succeeded`。成功工作区为 `demo-workspace/phase3.5-real/run-2026-10-05T09-00-00.675Z/`，报告位于其 `.token-coupon/smoke-report.json`。Conversation、草案和审查在 `.token-coupon/planners/`，Session 在 `.token-coupon/sessions/`，Attempt 在 `.token-coupon/runs/`。

可变测试报告与 CLI 输出放在 `.token-coupon/` 中，避免被仓库工具读取后，因下一次写入改变 SHA-256 而使审查依据过期。沙箱内初次网络请求失败后，在获准的沙箱外环境完成调用。测试保留失败记录，不把失败当成成功。这次真实调用验证的是 Planner/Reviewer 与流程集成；Mock Runner 不生成问候函数，也不实际执行其业务测试，真实 Claude Code 尚未验证。

### 规划回复校验与格式修正

`planner-conversation.ts` 把本轮输入、有效需求、草案及审查上下文交给适配器，并提供 `validateReply` 回调。`planner-reply.ts` 校验 JSON 和回复字段，core 继续检查需求来源、依赖关系与 execution 配置；这些检查不写状态。`deepseek-planner.ts` 调研时若收到完整有效 JSON 就直接返回，成功后 core 才保存需求快照、草案和 Turn。

回复格式、来源或计划校验失败时，同一 Turn 最多修正两次。适配器通过以 context 为键的 WeakMap 保留该 Turn 的模型和工具消息；修正请求复用调研结果，只允许 JSON 输出，不提供工具。新 Turn 使用新的 context，仍可进行调研。调用预算不增加，HTTP/网络、取消和预算错误不进入格式修正。

错误记录区分 `planner_invalid_json`（语法）、`planner_invalid_reply`（回复字段）、`planner_requirements_invalid`（需求字段或来源）和 `planner_plan_invalid`（计划结构或执行配置）。取消输入的来源读取结果带 `classificationAllowed: false`，不能因为读取过原文就将其加入待整理分类。查看规划时，报告未随本次结果加载会提示 `/review show`；真正的加载失败才报告读取错误。
