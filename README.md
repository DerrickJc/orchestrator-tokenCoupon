# orchestrator-tokenCoupon

面向 coding agent 的多 agent 任务编排平台，目标是把用户目标转成有序计划，支持大模型规划并由 coding agent 执行。

项目已逐步扩展为包含计划管理、并行执行、worktree 隔离、会话恢复、Runner 交互与本机 Web 工作台的本地编排工具。

Electron 桌面预览已具备本机后台启动、托盘、目录选择与通知桥接；Windows NSIS 预览构建、包内 daemon 与真实 Electron GUI 生命周期已通过原生 CI。人工安装升级和真实 Runner 仍待验收，详见[实施与验收状态](docs/WINDOWS_DESKTOP_REQUIREMENTS_AND_TECHNICAL_PLAN.md)。

### 桌面预览构建

在目标系统本机执行 `npm ci`。构建桌面资源需另备该系统/架构的官方 Node **22.12.0** 可执行文件；该运行时会随包携带。Windows PowerShell：

```powershell
$env:TOKEN_COUPON_BUNDLED_NODE = "C:\release-tools\node-v22.12.0-win-x64\node.exe"
npm run desktop:package    # 生成可直接启动的桌面目录
npm run desktop:installer  # 生成当前用户的 Windows NSIS 预览安装包
```

默认输出到 `.token-coupon/builds/` 下的独立目录。自定义输出路径时，先构建再直接调用脚本，以保留 PowerShell 下的参数名和带空格路径：

```powershell
npm run build
node scripts/package-desktop.mjs --mode installer --output "C:\release-output\Token Coupon Preview"
```

`--mode dir` 生成解包目录；在直接调用脚本时可追加 `--electron-dist "C:\release-tools\electron"`，复用同版本的官方 Electron 解压目录。每次构建会启动最终包内的 daemon 完成离线 smoke，并生成 `desktop-build.json`；输出目录必须是新的专用目录，已存在目录不会被覆盖。安装包为未签名预览，默认不申请管理员权限、不自动发布或安装后启动，卸载保留用户数据和工作区。Windows 安装、升级和真实 Runner 仍需对应平台验收。

原生 Windows 当前禁用快捷隧道，页面显示限制原因，后台也会在下载或启动组件前拒绝该操作。本机 Agent 入口保留；网页 MCP 可使用已在外部配置的固定 HTTPS 网关，或使用 Linux／WSL 后台的快捷连接。固定 HTTPS 的原生 Windows 网页联调仍待验收；公网代理只能转发 MCP/OAuth 网关，不能发布本机控制台。

## 环境

- Node.js 22.12 或更高版本
- npm 10 或更高版本

## 安装和使用

```bash
npm install
npm run build
npm run cli -- plan show --file examples/plan.json
npm run cli -- task show --file examples/task.mock.json
npm run cli -- task run --file examples/task.mock.json
```

`task run` 默认使用启动 CLI 时的当前目录作为 workspace。在项目根目录运行时，任务生成的文件保存在项目内，执行记录写入项目的 `.token-coupon/runs/<attemptId>/`，其中包含任务快照、实际 prompt、Attempt 快照和 JSONL 事件。也可以用 `--workspace <目录>` 指定其他已存在的目录。成功返回 `0`，执行失败返回 `1`，输入或配置错误返回 `2`，超时返回 `124`，Ctrl+C 取消返回 `130`。

Mock 可用 `--mock-scenario` 演示失败路径，例如 `missing-marker`、`marker-nonzero`、`hang` 和 `spawn-child`。真实 Runner 示例需要本机已安装并登录 Claude Code；在项目根目录执行：

```bash
npm run cli -- task run --file examples/task.claude.json --accept-edits
```

`--accept-edits` 是单次显式选项，只对 Claude Code 本次工作目录启用 `acceptEdits` 模式，不影响其他运行。它批准工作目录内的文件编辑，但不会自动批准任意 Bash 命令；需要运行特定测试命令时，可在演示目录配置精确的本地允许规则。不要改用跳过全部权限提示的模式。运行前检查工作目录和最终 prompt；完成后检查生成文件与执行记录。

输入校验或文件读取失败时 CLI 返回退出码 `2`。`plan show` 和 `task show` 只读取 JSON 并打印内容，不启动 Runner。

### CLI 与 Web／桌面共用后台

已有后台运行时，显式使用 `daemon` 子命令连接同一实例。默认查找用户目录中的 `.token-coupon/daemon`，自定义后台可设置 `TOKEN_COUPON_DAEMON_HOME` 或附加 `--data-dir`。身份核验或连接失败会退出，不另起 Runner；原有直接执行命令保持原有模式。

```bash
node packages/cli/dist/main.js daemon status
node packages/cli/dist/main.js daemon workspaces
node packages/cli/dist/main.js daemon planning list --workspace-id <workspaceId>
node packages/cli/dist/main.js daemon planning show --workspace-id <workspaceId> --planning-id <planningId>
node packages/cli/dist/main.js daemon planning run --workspace-id <workspaceId> --planning-id <planningId> --isolation git-worktree --verification-task <taskId> --max-parallel 2
node packages/cli/dist/main.js daemon pending
node packages/cli/dist/main.js daemon job show --id <jobId>
```

运行仍要求有效审查和批准。写命令返回 Job 表示请求已接收，最终状态用 `job show` 核实；退出 CLI 后任务继续由后台处理。响应中断时先查看计划与回执，不能把命令退出当作任务失败。工具审批可使用 `daemon interaction respond --workspace-id <ID> --request <requestId> --decision allow-once`；拒绝用 `deny`，模型问题或 MCP 表单使用 `--reply-file` 提交带 `kind` 的结构化回答，也可在 Web／桌面处理。完整命令见 `daemon --help`。新建/修订计划、事件跟随和恢复诊断当前继续使用原入口，不会静默转为旧 CLI 直接执行。

### 手工计划与 Session（Phase 2）

手工计划可以按依赖顺序串行执行。Session 快照和各次 Attempt 日志保存在当前 workspace 的 `.token-coupon/` 中；在项目根目录执行时，产物也留在项目目录下：

```bash
# 完整离线演示
npm run cli -- plan run --file examples/plan.phase2.mock.json

# 查看 Session 状态。plan run 输出 Session UUID
npm run cli -- session show --id <sessionId>

# 在第二个任务制造一次失败，再重试它并继续最后的验证任务
npm run cli -- plan run --file examples/plan.phase2.mock.json \
  --mock-task-scenario add-greeting-tests=missing-marker
npm run cli -- session retry --id <sessionId> --task add-greeting-tests \
  --mock-task-scenario add-greeting-tests=success
npm run cli -- session resume --id <sessionId>

# 真实 Claude Code 演示；各任务依次修改当前项目目录
npm run cli -- plan run --file examples/plan.phase2.claude.json --accept-edits
```

失败任务不会自动重试。先显式 `session retry`，再用 `session resume` 运行剩余任务。Mock 场景只控制选定任务的执行路径，不加入任务 JSON。完整状态边界和调用关系见[Phase 2 实现指南](docs/PHASE_2_IMPLEMENTATION_GUIDE.md)，搭建和验收计划见[Phase 2 方案](docs/PHASE_2_PLAN.md)。

Phase 1 的代码模块关系见[Phase 1 实现指南](docs/PHASE_1_IMPLEMENTATION_GUIDE.md)。

开发命令：

```bash
npm run typecheck
npm test
```

`npm test` 会构建 workspace 并运行 Vitest 测试。
