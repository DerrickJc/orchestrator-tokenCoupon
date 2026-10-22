# orchestrator-tokenCoupon

面向 coding agent 的多 agent 任务编排平台，目标是把用户目标转成有序计划，支持大模型规划并由 coding agent 执行。

项目已逐步扩展为包含计划管理、并行执行、worktree 隔离、会话恢复、Runner 交互与本机 Web 工作台的本地编排工具。

Electron 桌面预览已具备本机后台启动、托盘、目录选择与通知桥接；Windows NSIS 预览构建、包内 daemon 与真实 Electron GUI 生命周期已通过原生 CI。人工安装升级和真实 Runner 仍待验收，详见[实施与验收状态](docs/WINDOWS_DESKTOP_REQUIREMENTS_AND_TECHNICAL_PLAN.md)。

### Windows 桌面预览安装

打开 [Releases](https://github.com/DerrickJc/orchestrator-tokenCoupon/releases)，选择最新的 **Windows preview / Pre-release**，在 Assets 中下载 `Token-Coupon-0.1.0-x64-preview-setup.exe`。直接运行安装器，完成后从开始菜单启动；应用携带 Node，无需下载源码或启动开发命令。`SHA256SUMS` 提供校验值，可在 PowerShell 执行 `Get-FileHash .\Token-Coupon-0.1.0-x64-preview-setup.exe -Algorithm SHA256` 核对。当前是未签名预览，干净 Windows 安装升级和真实业务验收仍待完成。

优先使用 Release 安装器直链；Actions 产物 ZIP 用于测试追溯，含报告和截图且只保留 7 天。预发布不占用 GitHub 的稳定版 `latest`，因此请使用上面的 Releases 页面而非 `/releases/latest`。

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

当前源码已支持原生 Windows 与 Linux／WSL 网页快捷连接，无需为 Windows 安装 WSL。连接中心选择“新建快捷连接”，确认按需获取官方 cloudflared，等待公网自检后复制 MCP 地址，在 ChatGPT／Claude 网页添加连接并发起授权；回到本机选择工作区与权限，再返回原网页完成登录。实际网页工具调用通过后才显示已验证；本机保存权限不代表网页完成登录。

常驻隧道可在业务后台重启后复用原地址；明确停止后重新创建、隧道进程退出或系统重启，地址仍可能变化。公网只开放 MCP/OAuth 网关。本机网络需要代理时，应让启动应用的进程继承可用的 `HTTP_PROXY`／`HTTPS_PROXY`；组件下载成功不代表公网自检通过。实现、验证边界和排查方法见[原生 Windows 快捷连接方案](docs/WINDOWS_DESKTOP_REQUIREMENTS_AND_TECHNICAL_PLAN.md#1398-原生-windows-网页快捷连接实施方案)。

已发布的 `desktop-preview-0.1.0-20261022-1` 安装器尚不包含此次快捷连接适配；需要使用本分支的新构建。新的安装器发布另行确认，不会修改已发布资产。

### Agent 工具按需使用

桌面安装包携带 Electron、独立 Node 和后台必需依赖，不预装 Codex／Claude Code 执行器。已有本机工具会自动复用；Claude 的执行与模型目录查询均绑定到同一已发现的 CLI，SDK 仅保留协议适配代码。

打开 **系统设置 → Agent 组件**，点击“重新检测”。缺少工具时可选择“按需安装”，核对官方包、固定版本和用户目录后确认；此入口需要可用的 npm，禁用包安装脚本，不执行全局安装或自动升级。没有 npm 时可复制官方手动安装说明，安装后重新检测。组件就绪后，点击“复制启动命令”，在终端启动工具并按提示完成登录；检测到程序不表示已登录或模型可用。此设置入口在桌面与 4177 中共用，安装和版本校验本身不调用模型。

可选组件默认保存在 `~/.token-coupon/agents/<runnerId>/current`，与应用和项目目录分离；可设置 `TOKEN_COUPON_AGENT_HOME` 指定绝对目录。工具发现顺序为显式路径、本机 PATH／已知用户安装目录、私有组件目录。需要指定其他安装时，使用 `TOKEN_COUPON_CODEX_EXECUTABLE` 或 `TOKEN_COUPON_CLAUDE_EXECUTABLE` 设置绝对路径。正常使用不会自动下载安装；取消或失败不会启用半成品，已有可用安装不会被覆盖。安装中可在组件卡片取消；后台安全停止也会核对组件安装是否仍在运行。

构建只复制后台依赖闭包及已构建网页，保留许可证，排除 Agent 本体、开发声明、源码映射和测试资源。Electron 只保留简体中文与英文资源。`desktop-build.json` 记录最终资源体积、安装器字节数和校验值；不含独立 Node 的后台资源预算为 40 MiB，重新打入 Agent 本体或超出预算会阻断构建。

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
