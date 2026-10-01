# 第一阶段搭建方案：单任务执行闭环

状态：供修改的方案草案，尚未实现。整理日期：2026-10-01。

本方案沿用 [README](../README.md) 的阶段编号：阶段 1 是“跑通一个任务”。当前仓库只有路线文档，因此本阶段包含阶段 0 中必要的工程骨架。阶段 2 仍负责手工计划、依赖调度和会话恢复。

参考仓库：`/home/lzw/dev/ordewell`，本地提交 `36d0254`。参考其概念和失败处理经验，独立设计本项目的接口与实现；后续修改以本项目需求为准。

## 1. 本阶段要交付什么

用户提供一份任务描述和一个工作目录，CLI 启动 Runner，实时显示并记录输出，在执行结束后给出明确结果。失败时可以根据记录判断是启动失败、执行失败、缺少完成标记、超时还是取消。

最小流程：

```text
任务 JSON + 工作目录
        ↓
校验输入、创建 attemptId、生成本次完成标记
        ↓
保存任务与最终 prompt，启动 Runner
        ↓
实时输出、追加日志、收集完成证据
        ↓
进程结束并收齐输出
        ↓
统一判定、保存执行结果、CLI 返回退出码
```

完成后的演示包含两部分：不依赖模型账号的 Mock Runner 演示；一种真实 coding agent 在独立演示仓库完成小修改的演示。

### 范围约束

| 本阶段实现 | 后续阶段实现 |
| --- | --- |
| core、cli 两个包；CLI 直接调用 core | daemon、TUI、VS Code |
| 一次调用执行一个任务 | 任务列表、依赖图、串行及并行调度 |
| Mock Runner 与一种真实 Runner | Runner 注册表、插件、模型发现 |
| 非交互子进程、输出记录、结果判定 | 交互终端、审批应答、会话续聊 |
| 超时、Ctrl+C、资源清理 | 自动重试、暂停、断点恢复 |
| 单次执行记录可供检查 | Session 持久化、恢复与继续执行 |
| 在指定演示目录直接修改文件 | worktree、整合分支、代码交付 |

执行记录落盘是本阶段的诊断能力，不代表已经支持会话恢复。真实 Runner 修改指定工作目录；阶段 1 不自动提交、回滚或合并。

## 2. 技术和模块边界

沿用现有路线中的 TypeScript + npm workspaces。工程只做一种模块输出，优先 ESM；用 TypeScript 编译，测试使用 Vitest。依赖版本在实际搭建时确定并锁定，不复制原仓库整套依赖和发布配置。

```text
packages/
  core/src/
    task.ts                 # 任务输入与执行记录类型
    validate-task.ts        # JSON 输入的运行时校验
    execute-task.ts         # 单次执行生命周期及状态的唯一修改入口
    runner.ts               # Runner 契约、输出与结束证据
    runners/
      mock-runner.ts        # 确定性场景，启动本地 fixture 子进程
      agent-runner.ts       # 所选真实 agent 的适配器，选定后具体命名
    completion-marker.ts    # prompt 协议、流式标记检测
    verdict.ts              # 根据证据计算结果的纯函数
    run-recorder.ts         # 日志追加、快照写入与写入失败处理
    index.ts                # 对 CLI 暴露少量公共接口
  cli/src/
    main.ts                 # 参数、信号、输出、退出码；组装依赖
examples/
  task.mock.json
  task.agent.json
tests/fixtures/
  mock-process.mjs
docs/
  PHASE_1_PLAN.md
```

目录是职责说明，可以在实现时合并短小文件。第一版无需为每个模块建立基类或依赖注入容器。

边界约定：

- **core 管执行，cli 管交互。** core 不读取命令行参数，不调用 `process.exit()`，不写终端界面。
- **executeTask 管状态。** Runner 返回输出和进程事实；结果判定模块不修改状态。CLI 只显示 core 返回的状态。
- **Runner 管外部协议。** 可执行文件、启动参数、输出解析及进程停止留在适配器中，调度器无需了解某个 agent 的 CLI 参数。
- **记录模块管文件。** Runner 不自行建立另一套任务日志，判定模块不依赖日志文件解析。

阶段 2 引入 PlanStore 时，任务总体状态交给 PlanStore；executeTask 继续管理一次执行尝试，再由调用方提交结果。现在不提前实现完整 Session 或 TaskOrchestrator。

## 3. 任务定义和执行记录分开

### 3.1 用户提供的任务

示例任务格式是本项目的提案，不继承 Ordewell 的完整 Task 类型：

```json
{
  "schemaVersion": 1,
  "id": "demo-001",
  "title": "增加一个问候函数",
  "prompt": "新增 greet.mjs，导出 greet(name)，返回 Hello, name!。完成后说明修改内容和验证方式。",
  "execution": {
    "runnerId": "mock",
    "timeoutMs": 60000
  }
}
```

真实任务文件使用所选真实 Runner 的 ID。`modelId` 仅在真实适配器支持时允许指定；指定后必须实际传给 Runner。不支持的 Runner、模型参数或执行选项在启动前报错，不能静默忽略或替换。

工作目录通过 CLI 指定，与任务定义分开，方便把同一任务用于不同演示目录。解析为绝对路径并记录最终值。

输入校验至少覆盖：JSON 可解析、版本受支持、必填字符串非空、超时为正整数、工作目录存在且是目录、Runner 可用。未支持的字段报错，防止用户以为配置已经生效。第一版不加入尚未消费的依赖、子任务、审批模式等字段。

### 3.2 每次执行产生的 Attempt

| 字段 | 作用 |
| --- | --- |
| `schemaVersion`、`attemptId`、`taskId` | 记录版本；区分任务和本次执行 |
| `status` | `created / running / succeeded / failed / cancelled / timed_out` |
| `cwd`、`runnerId`、实际模型配置 | 说明真正在哪里、用什么配置执行 |
| `completionToken` | 本次随机生成的完成标记 |
| `createdAt / startedAt / finishedAt` | 分别记录创建、实际启动和结束时间；未发生的时间为空 |
| `exitCode`、`signal` | 进程结束事实；缺失时为空，不补成 0 |
| `markerSeen`、`reasonCode`、`reason` | 判定证据及可读解释 |
| `artifactDir`、`inputBytes`、`outputBytes` | 记录位置与实际输入输出规模 |

任务文件不被运行状态改写。重复运行同一任务产生新的 attemptId 和记录目录，保留旧结果；第一阶段不自动重试。

完成标记绑定 attemptId，而非长期绑定 taskId。即使后续允许重试，也不能沿用上次标记或接受上次进程的迟到输出。

## 4. Runner 和结果判定

### 4.1 最小 Runner 契约

接口表达的是一次非交互执行，而不是终端会话：

```ts
interface Runner {
  run(
    input: RunInput,
    context: {
      signal: AbortSignal;
      onOutput: (output: RunnerOutput) => void;
    },
  ): Promise<ProcessResult>;
}
```

`RunInput` 包含 attemptId、cwd、最终 prompt 和实际执行配置；`RunnerOutput` 区分 stdout、stderr，并标明可用于完成检测的 agent 文本；`ProcessResult` 包含启动错误、退出码、信号及停止结果。

`run()` 必须先建立输出捕获再启动执行。Promise 在进程结束、管道输出收齐后结算；启动失败也只有一次结算。输出回调在结算后不能继续修改本次状态。

适配器使用可执行文件和参数数组启动进程，默认关闭 shell；任务 prompt 不拼成 shell 命令。较大的 prompt 优先使用 Runner 支持的 stdin 或文件输入。具体参数在真实接入时通过所选工具的本机帮助和官方资料核实。

### 4.2 Mock Runner 先行

Mock Runner 启动本地脚本，走真实子进程、stdout/stderr 和停止路径，不直接返回一个虚构的成功对象。fixture 通过场景参数模拟：

- 正常输出、本次标记、退出码 0。
- 退出码 0，但无完成标记。
- 已输出标记，但退出码非 0。
- 标记分散在多个输出块，中文字符也可能跨块。
- 错误 attempt 的标记、stderr 中的标记、输出中引用标记。
- 持续运行直到超时，或接收取消；包含一个子进程清理场景。

### 4.3 完成标记协议

编排器在最终 prompt 中追加本次协议，例如：

```text
完成要求：执行任务并说明修改与验证结果。
仅在你认为任务完成时，在最终回复的独立一行输出本次完成标记。
本次标记为：<<<TOKEN_COUPON_DONE:{随机 token}>>>
```

检测器仅消费适配器认定的 agent 文本。结构化输出先解析后取回复文本，不能扫描整段原始 JSON；纯文本适配器只扫描 stdout 的独立完整标记行，不扫描输入 prompt、stderr 或诊断日志。

流式处理使用增量 UTF-8 解码，覆盖跨块标记、LF/CRLF 及末尾无换行的情况。保存日志采用流式追加；检测只保留有限的行缓冲，超长行丢弃检测资格但仍记录输出，避免无限缓存和反复扫描全量日志。

纯文本输出不能完全区分 agent 回复、工具输出及回显。独立行检测降低误判，但完成标记仍只是协议证据，不能证明代码正确；第一阶段的真实演示还要人工检查差异与验证结果。

### 4.4 本项目第一版的结果规则

**成功需要本次标记、退出码 0、无取消或超时、记录写入成功，且执行已经结束。** 收到标记时只设置 markerSeen，不提前释放资源或宣布成功。

| 执行事实 | 最终状态 | 原因 |
| --- | --- | --- |
| 有本次标记，退出码 0 | `succeeded` | 完成协议满足 |
| 无标记，退出码 0 | `failed` | `completion_marker_missing` |
| 退出码非 0，即使有标记 | `failed` | `process_exit_nonzero` |
| 启动失败 | `failed` | `runner_start_failed` |
| 超时触发并停止进程 | `timed_out` | `execution_timeout` |
| 用户取消并停止进程 | `cancelled` | `user_cancelled` |
| 日志或结果保存失败 | `failed` | `recording_failed`，CLI 明确报告不完整记录 |

取消和超时使用先被接受的停止原因；终态只提交一次。关闭时若有停止原因，不能被退出码 0 或此前标记改判为成功。终态已经提交后收到 Ctrl+C，不追溯修改结果。

超时覆盖启动和执行。取消向本次进程组发出终止请求，经过有限宽限期后强制停止；检查子进程清理，不能把“停止请求已发送”当作“停止已完成”。清理失败记录为执行基础设施失败，明确报告仍可能存活的进程。

首个实现和验收以当前 Linux 环境为准；原生 Windows 支持留到有实际需求时设计和验证。

## 5. CLI 与记录产物

以下命令是拟实现的使用方式，当前尚不可运行：

```bash
npm run build
npm run cli -- task run --file examples/task.mock.json --workspace /tmp/token-coupon-demo
npm run cli -- task run --file examples/task.agent.json --workspace /tmp/token-coupon-demo
```

CLI 实时展示输出，结束时打印任务 ID、attemptId、结果、原因、退出码、耗时和记录目录。首版只需要 `task run` 和帮助信息；查看记录可以直接打开文件。

退出码约定：`0` 成功；`1` 执行或记录失败；`2` 输入或配置错误；`124` 超时；`130` 用户取消。取消后的记录保存和进程清理完成，再退出 CLI。

拟定记录结构：

```text
<workspace>/.token-coupon/runs/<attemptId>/
  task.json          # 本次任务输入快照
  prompt.txt         # 实际发送的 prompt，包含本次完成协议
  attempt.json       # 启动前和结束后的执行快照
  events.jsonl       # 按收到顺序追加输出及生命周期事件
```

事件包含递增序号、时间戳、attemptId、事件类型和 payload；stdout/stderr 保留来源。序号只表示编排器收到事件的顺序，不声称还原不同管道的全局因果顺序。

开始前必须创建目录并保存输入；失败则不启动 Runner。运行中日志写入失败应请求停止，不能继续宣称执行记录完整。状态快照用同目录临时文件加重命名替换；落盘队列处理背压，设置有限队列上限，记录模块出错时由 CLI 输出错误及已保存目录。

强制杀死编排器或机器断电可能留下 running 快照和不完整日志。第一阶段如实保留这些记录，不扫描恢复、不自动重跑，也不根据陈旧 PID 杀进程。阶段 2 再定义中断记录的恢复语义。

日志目录加入演示仓库的忽略规则。记录任务和必要的实际启动配置，不转储完整环境变量、凭据或登录文件。输入输出内容本身可能包含敏感信息，日志保存范围在真实接入时确认。

tokenCoupon 方向先记录最终 prompt、输出、字节数和执行时间；Runner 未提供真实 token 用量时记为未知，不把字节数当 token，也不预设节省比例。

## 6. 推荐搭建顺序与验收

| 步骤 | 搭建内容 | 可独立验收的结果 |
| --- | --- | --- |
| 1A：骨架 | workspaces、core/cli、类型检查、构建、测试入口 | CLI 能读取任务并报告合法/非法输入；core 先于 cli 构建 |
| 1B：执行基础 | Task/Attempt、Runner 契约、Mock 子进程、输出事件 | 流式输出可见；启动失败和异常退出都能正常结算 |
| 1C：完成判定 | prompt 组装、流式检测、纯函数 verdict | 标记、退出码及跨块处理满足规则，收到标记不会提前成功 |
| 1D：记录与停止 | 执行目录、事件日志、快照、超时、Ctrl+C | 结果可追踪，失败保留记录，取消后没有遗留 fixture 进程 |
| 1E：真实接入 | 一种真实适配器、独立演示仓库、使用说明 | 完成小修改，人工检查文件差异和验证结果 |

先完成 1A—1D，再接真实 Runner，避免把账号、权限或网络问题与核心执行问题混在一起。真实 Runner 可以先按使用习惯选择；本机检测到 `claude` 与 `codex` 可执行文件，但尚未验证版本、登录状态和非交互能力。两者不同时接入，也不直接套用原仓库的自动授权参数。

### 必须覆盖的测试

| 场景 | 预期 |
| --- | --- |
| 标记 + 退出码 0 | 成功且只结算一次 |
| 退出码 0，无标记 | 失败，原因可辨认 |
| 标记 + 非 0 退出码 | 失败 |
| 标记跨块、中文跨块、末尾无换行 | 解码及检测正确 |
| 旧标记、stderr 标记、标记被引用于其他文字中 | 不通过 |
| 标记出现后进程继续运行 | 保持 running |
| 不存在的可执行文件 | 启动失败，CLI 不挂起 |
| 超时或 Ctrl+C，包括标记之后取消 | 不判成功，停止父子进程，保留记录 |
| 启动前记录写入失败 | 不启动 Runner |
| 运行中记录写入失败 | 停止执行，报告记录不完整 |
| error、close、停止回调发生竞争 | 终态唯一，无迟到状态修改 |
| 大量输出或超长单行 | 增量处理，无无限内存缓存 |

测试聚焦执行协议、进程生命周期和失败处理。Mock 子进程测试离线运行；真实演示手动执行，不放进默认测试，也不让默认检查消耗模型额度。

### 阶段完成门槛

- 构建、类型检查和上述关键测试通过。
- 通过 CLI 演示成功、缺少标记、异常退出、超时、取消五条路径。
- 每次执行产物可解释输入、真实配置、输出和判定结果。
- 一种真实 Runner 在可丢弃的独立仓库完成小任务；人工核对修改及验证结果。
- 使用说明写清已支持范围、失败原因、日志位置和取消行为。

Mock 闭环完成后可以先评审中间版本；真实接入和演示尚未完成时，第一阶段仍属于进行中。

## 7. 如何参考原仓库，如何独立优化

| 原仓库参考点 | 保留的经验 | 本项目第一阶段的取舍 |
| --- | --- | --- |
| `models/Task.ts` | 任务、执行身份、证据都需要明确字段 | 任务定义和 Attempt 分离，省去完整计划树与 UI 字段 |
| `interfaces/ITerminalRunner.ts`、`HeadlessRunner.ts` | 外部执行与核心流程分开 | 使用非交互 run 契约；暂不做终端 write、PTY、tmux |
| `VerdictEngine.ts` | 完成依据明确，支持跨块输出和迟到回调防护 | 等退出后判定，要求标记与退出码同时满足；记录写入也是成功条件 |
| `PlanStore.ts` | 状态只由一个模块拥有 | 本阶段由 executeTask 管 Attempt；阶段 2 由 PlanStore 管任务总体状态 |
| `utils/processTree.ts` | 取消不能遗留执行进程 | 针对 Linux 的进程组停止与实际子进程场景验收，独立实现 |
| `createSession.ts`、`TaskOrchestrator.ts` | 生命周期和调度需要清楚边界 | 等出现多任务调度与恢复需求后再引入 |

原仓库的完成标记即时通过规则服务于可保持打开的交互终端；本项目第一版选择非交互进程，因而采用不同的结算时机。这是执行场景的取舍，后续加入交互 Runner 时需重新设计，不能直接把第一版规则套过去。

不搬运原仓库的巨型 Task、Session、RunnerRegistry、自动审批开关、多 UI 事件或整套提示词。阅读上游代码用于理解边界与故障；本项目按验收要求重新实现。

## 8. 后续扩展与修改入口

| 后续需求 | 本阶段留下的接入点 | 到时再完成的能力 |
| --- | --- | --- |
| 手工计划、依赖调度 | executeTask 接收单任务并返回 Attempt | PlanStore、TaskOrchestrator、上下游结果传递 |
| 重试和恢复 | attemptId、版本化记录、输入快照 | 重试策略、孤立执行识别、恢复一致性 |
| Planner | 任务 JSON 的运行时校验 | 计划生成、对话、修改和审批 |
| worktree 隔离 | cwd 由调用方提供，Runner 不负责 Git | 工作目录准备、landing、审阅与合并 |
| 多 Runner | 小型 Runner 契约、适配器内的协议解析 | Registry、能力声明和统一结构化事件 |
| daemon/TUI | core 不依赖 CLI，执行事件可被消费 | 传输、后台持有、鉴权和界面 |
| tokenCoupon 优化 | 原始 prompt、输出和实际执行记录 | 上下文裁剪、真实用量采集、质量对照实验 |

可以随阶段评审调整的事项：真实 Runner 的选择、任务 JSON、完成协议、日志保留策略和包结构。修改这些选择时同步更新示例与验收要求；涉及持久化格式变化时递增 schemaVersion。

扩展时继续守住三个约束：用户指定配置真实决定执行行为；一次 Attempt 只有一个终态；成功判定所用证据能够在记录中追溯。后续阶段不必复制上游架构，也不必一次性实现本表中的所有能力。
