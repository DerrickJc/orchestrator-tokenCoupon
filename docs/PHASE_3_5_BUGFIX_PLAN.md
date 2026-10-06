# Phase 3.5 Bugfix：有效需求、审查修订闭环与来源追溯

状态：实施与验收完成。日期：2026-10-05。对应 [Phase 3.5](PHASE_3_5_PLAN.md)。

## 问题与证据

最近三轮审查显示：用户要求按报告修订时，Planner 没有收到 findings；乱码、取消轮次输入及修订指令被当成业务需求；复审没有上轮报告和计划差异，同一问题反复出现且严重程度变化。`F1` 只是报告内编号，不能用于跨报告识别问题。

## 实施范围与约定

1. 原始 `messages`、Turn 和 API 日志继续保留。新增版本化有效需求记录，区分 active、pending、superseded、withdrawn；记录稳定 requirementId、版本和 sourceMessageIds。语义整理与规划共用一次模型响应，不用关键词规则决定用户意图。
2. 规划输入使用有效需求、尚未整理的用户消息和最近澄清问题。旧消息不反复注入；取消或失败轮次不自动成为有效需求，可按需查询并由后续明确输入确认。旧记录通过 `/requirements refresh` 整理，未整理前拒绝审查和批准。歧义保存为 pending，批准前必须澄清。
3. 只读 `conversation_read` 根据消息 ID 读取相关原文，限制数量、输出大小和调用预算；不开放 `.token-coupon` 文件访问。`/requirements` 查看有效需求，`/trace <requirementId> [revision]` 通过来源 ID 定位原始消息、轮次状态和日志目录。
4. 新增 `/revise [说明]` 和单轮 `planner revise`，绑定当前有效报告、草案版本、哈希及完整 findings。普通补充对话也显式携带最近成功报告及其适用版本，防止“按照刚才 review”失去上下文；报告过期时清楚标识，不假称仍适用于当前草案。
5. 复审传入上一轮成功报告和 `diffPlans`。同一问题通过 priorFindingId 映射到稳定 issueId；每个旧问题必须明确标注 unresolved 或 resolved 并给出依据，新增问题生成新 issueId。不能只根据编号或文字相似度自动宣布问题解决。
6. 审查提示词明确：error 是确定的阻塞冲突，warning 是风险或证据不足，info 是可选改进；不把操作指令或一般最佳实践当成新增需求。空业务仓库是合法起点，当前草案由输入提供。最终 JSON 格式化保留已形成的审查结论。
7. requirementsHash 绑定有效需求版本与内容；仅操作/噪声分类不影响业务需求哈希。新审查策略使旧报告失效，批准与执行保留原有门禁。审查成功仍只表示生成报告，不代表实现和测试通过。

## 核心改动

| 模块 | 职责 |
| --- | --- |
| `requirements.ts` | 更新契约校验、需求版本与来源、有效输入和按需追溯 |
| `planner-types.ts` / `planner-store.ts` | 保存需求状态与不可变需求版本，兼容旧快照 |
| `planner-conversation.ts` | 发布需求更新、携带报告修订、限制上下文与读取预算 |
| `plan-review.ts` / `review-store.ts` | 需求绑定、报告与差异输入、问题跨轮映射与状态校验 |
| `deepseek-planner.ts` | 语义整理、来源读取工具、修订上下文、稳定审查规则 |
| `planner-cli.ts` | revise、requirements、trace 的单轮与常驻入口 |

## 主要命令使用方法

### 新建对话

在正常交互终端中执行，使用已填写的 `~/.config/token-coupon/planner.env` 加载模型和密钥：

```bash
cd /home/lzw/dev/orchestrator-tokenCoupon
npm run build
TOKEN_COUPON_NEW_WORKSPACE="$PWD/demo-workspace/phase3.5-new"
mkdir -p "$TOKEN_COUPON_NEW_WORKSPACE"

node --env-file="$HOME/.config/token-coupon/planner.env" \
  packages/cli/dist/main.js planner chat \
  --planner deepseek --runner claude-code \
  --workspace "$TOKEN_COUPON_NEW_WORKSPACE" --accept-edits
```

新建时不传 `--id`，也不传 `--request`，启动后在 `request>` 输入第一条需求。若该工作区已有规划，出现“输入序号打开规划，回车新建”时直接回车，创建独立 Conversation，不沿用旧对话。命令本身不会立即调用模型；提交第一条需求后才生成 planningId 并开始规划。

例如输入：

```text
使用 Node.js ESM 新增 greet.mjs，导出 greet(name)，返回 Hello, ${name}!。用 node:test 测试普通姓名和空字符串，不安装依赖；计划包含实现和最终验证两项任务，验证必须依赖实现。
```

若 Planner 提问，在 `planner>` 用自然语言回答；也可继续补充或替换业务需求。草案生成后逐条执行：

```text
/requirements
/plan
/review
```

新对话在每次成功规划时自动整理有效需求，通常不需要 `/requirements refresh`。核对需求和草案；审查有问题时使用下节的 `/revise` → `/diff` → `/review` 流程。符合要求后执行 `/approve`，核对确认内容并输入 `y`。批准只保存批准记录；要生成业务代码和运行任务，再执行：

```text
/run
/status
/exit
```

所有规划记录和执行产物保存在上述工作区的 `.token-coupon/` 下，业务文件也写入该工作区。仅验证规划、审查流程时，将 `--runner claude-code` 改为 `--runner mock` 并去掉 `--accept-edits`；Mock 不生成业务代码。`--accept-edits` 设置 Claude Code 的编辑权限，测试命令仍受其自身权限策略控制。

### 打开已有对话

在项目目录运行，替换 planningId 和 workspace 为你原来的规划记录：

```bash
cd /home/lzw/dev/orchestrator-tokenCoupon
npm run build
node --env-file="$HOME/.config/token-coupon/planner.env" \
  packages/cli/dist/main.js planner chat \
  --id <planningId> --workspace <workspace>
```

以下斜杠命令在 `planner>` 提示符中逐条输入。新业务约束直接用自然语言说明；修订审查问题使用 `/revise`。

### 查看有效需求和来源

```text
/requirements
/trace R-greet-api 1
```

`/requirements` 显示需求 ID、版本、状态和内容。`/trace <requirementId> [revision]` 显示来源原文、版本链、Turn 状态及日志目录；不指定版本时查看最新版本。上例 `R-greet-api` 是真实演示中的需求 ID，其他对话按 `/requirements` 的结果替换。

旧对话缺少有效需求记录时，先执行 `/requirements refresh`，再用 `/requirements` 核对整理结果。refresh 会调用模型，通常无需重复运行；有 pending 项时用自然语言回答澄清问题。

### 审查、修订和批准

```text
/review
/revise
/diff
/review
/approve
```

`/review` 调用模型审查当前草案；只读取最近报告使用 `/review show`。有问题时 `/revise` 携带当前有效报告进行修订，也可输入 `/revise 优先修复测试依赖，保留现有技术栈`。`/diff` 核对修改，再复审并批准。缺失或过期报告须先审查；存在 pending 需求时不能批准。没有待修订问题时可直接从 `/review` 进入 `/approve`。输入 `/exit` 退出，记录仍保留。

### 不进入常驻对话时

在项目目录执行，统一携带原 planningId 和 workspace：

```bash
node --env-file="$HOME/.config/token-coupon/planner.env" packages/cli/dist/main.js planner requirements --id <planningId> --workspace <workspace>
node --env-file="$HOME/.config/token-coupon/planner.env" packages/cli/dist/main.js planner trace --id <planningId> --workspace <workspace> --requirement R-greet-api --revision 1
node --env-file="$HOME/.config/token-coupon/planner.env" packages/cli/dist/main.js planner revise --id <planningId> --workspace <workspace>
```

旧记录整理在 `planner requirements` 后加 `--refresh`；审查使用 `planner review`。上述命令仅查看、规划和审查，不启动业务 Runner。

### 运行 Bugfix 演示

```bash
npm run demo:phase3.5-bugfix
node --env-file="$HOME/.config/token-coupon/planner.env" scripts/phase3.5-bugfix-demo.mjs --real
```

第一条使用 Mock，第二条调用真实 Planner/Reviewer。报告写入 `demo-workspace/phase3.5-bugfix/<mock或real>-<时间>/.token-coupon/bugfix-report.json`；两种演示均不执行业务 Runner。

## 验收

- MySQL → SQLite 的明确变更只保留 SQLite 为有效版本，原文及旧版本仍可追溯；含糊变更保留 pending。
- 噪声、操作和取消输入不污染审查；失败响应不发布部分需求更新；未知来源 ID 被拒绝。
- 修订请求实际包含对应报告，复审输入包含前一报告和计划差异；未处理旧问题不能被漏报成已解决。
- 相同问题保持 issueId，报告内 F 编号仍兼容原批准/豁免接口；缺失或过期报告不能通过显式 revise。
- 旧记录可恢复整理；只读来源查询有边界、预算和日志，不每轮携带全部历史。
- 类型检查、回归测试、离线 CLI 演示；配置可用时运行真实模型冒烟，不自动豁免错误，不运行真实业务 Runner。

## 建议 commit comment

`fix(phase3.5): 修复需求噪声与审查修订闭环，增加来源追溯`

主要使用场景与核心模块关联已补充到 `PHASE_3_5_IMPLEMENTATION_GUIDE.md`，验收结果如下。

## 验收结果

- 首轮 `npm run typecheck` 通过；全量回归 7 个文件、63 项测试通过。后续新对话修复的验收见下节。包含需求替换、噪声与操作、取消输入、未知来源、旧记录整理、pending 门禁、修订报告、问题身份与逐项解决、来源读取边界、失败修订重试、不可变版本完整性，以及常驻与单轮 CLI。
- `npm run demo:phase3.5-bugfix` 的 7 项离线检查通过；原 `phase3.5-demo.mjs` 的审查、批准、Session 与重复执行演示仍通过。
- 使用已配置 `deepseek-flash` 完成 7 项真实检查。明确 Hello → Hi 变更保留需求旧版本，噪声不改变 requirementsHash。注入 Python/FastAPI 技术栈冲突与缺失测试依赖后，真实审查发现 2 个 error；实际修订 API 请求包含完整报告，复审逐项标为 resolved，保留相同 issueId，最终批准成功。没有自动豁免，没有调用业务 Runner。
- 真实成功产物：`demo-workspace/phase3.5-bugfix/real-2026-10-05T15-40-18.987Z/.token-coupon/bugfix-report.json`。沙箱内网络失败的首次记录保留，在获准的沙箱外环境完成调用。最终版本再次读取该成功记录，需求版本校验、报告新鲜度与批准状态均正常。
- 兼容策略：旧对话原文与历史草案不删除、不批量改写；先 `/requirements refresh` 整理后再审查。已关联执行 Session 的记录仍只查阅，不重新解释已经发生的执行事实。

语义整理及问题是否解决仍是模型判断，用户应检查有效需求与计划差异；本次修复保证上下文和来源可核对，不承诺后续审查永远不会发现新问题。

## 2026-10-06 补充修复：新对话协议与格式修正

本轮按“全部新建 Conversation，不考虑旧记录迁移”的使用方式修复。保留已有兼容代码，但不迁移或重试此前报错的存量记录。

### 问题与实施

1. **统一输出协议**：澄清与草案的完整 JSON 示例都包含主对象内的 `requirementsUpdate`。禁止在对象后附加字段、代码围栏或说明；操作、噪声和业务需求有明确分类规则。新对话每轮自动整理本轮输入，正常成功的对话不需要手动 `/requirements refresh`。
2. **保留有效回复**：适配器调用 core 提供的纯校验回调，验证回复字段、需求来源和 Plan 依赖及执行配置。调研阶段已经返回完整有效结果时直接采用，避免再次生成而丢失字段。校验通过前不发布需求或草案。
3. **有界格式修正**：同一 Turn 保留模型与只读工具的消息记录，最多修正两次；修正只发送 JSON 请求，不提供工具，不重新调研。仍维持原来的 8 次 API、20 次工具限制。最多 4 轮调研加 3 次最终输出，即 7 次 API 请求；不通过增加预算掩盖问题。
4. **准确错误**：使用 `planner_invalid_json`、`planner_invalid_reply`、`planner_requirements_invalid`、`planner_plan_invalid` 区分语法、字段、需求来源和计划错误。非空与超过 16 KiB 的 message 分别诊断；HTTP、网络、取消及预算错误不当作格式错误重试。
5. **追溯与分类边界**：`messageDecisions` 只能包含待整理输入的 ID。`conversation_read` 返回 `classificationAllowed`，已整理、失败、取消的原文只能供追溯；看到历史原文不会获得重新分类授权。修订报告、整理需求等操作不产生业务约束；自然语言混合输入只提取明确业务变更。
6. **报告显示**：操作结果未携带报告时显示“本次未加载”；实际加载失败才显示原因；加载成功但哈希不匹配时显示“已过期”。通过 `/review show` 读取报告，避免误报文件损坏。

### 核心关联

- `planner-reply.ts`：共享 JSON/回复字段校验及可修正错误类型。
- `planner-conversation.ts`：组装待整理输入与纯校验回调、执行有界修正、成功后发布需求及草案、记录真实 reasonCode。
- `planners/deepseek-planner.ts`：完整提示词、同轮消息复用、有效候选直接返回、禁用工具的修正请求。
- `requirements.ts`：来源白名单校验和只读追溯标记。
- `planner-output.test.ts`：新对话的协议、修正次数、调研复用、取消来源和报告显示回归。

### 本轮验收

- `npm run typecheck` 通过；完整测试为 8 个文件、76 项通过，新增 13 项回归。进程执行相关旧测试在沙箱内受限，在获准的沙箱外运行完整测试通过。
- 新对话澄清 → 草案 → 显式修订流程保留需求版本，完整候选每轮仅需一次模型请求。
- 缺失字段和无效依赖可修正；错误 JSON、空/超大 message、未知来源 ID 有正确诊断；最多两次修正，不发布半成品；HTTP 401/429/500 不进行格式重试。
- 最多四轮调研后连续三次错误 JSON，共 7 次 API 请求；已读取的工具结果被复用，修正请求不再提供工具。
- 离线 Bugfix 演示 7 项通过；原 Phase 3.5 演示的审查、批准、Session 和重复运行流程通过。
- 真实 `deepseek-flash` 新对话演示 7 项通过：初始草案、需求变更和噪声处理各 1 次 API，审查修订轮次 2 次 API、2 次只读工具。两项 error 在复审中标记 resolved；复审仍有 2 项 info（其中 1 项延续前一问题身份），按现有门禁允许批准，没有豁免或业务 Runner 调用。
- 本轮真实产物：`demo-workspace/phase3.5-bugfix/real-2026-10-06T03-36-52.638Z/.token-coupon/bugfix-report.json`，planningId 为 `b3e900a7-afff-4c65-af84-844a3522c02a`。重新加载后状态为 approved，报告适用于当前草案。未修改旧 Conversation。
