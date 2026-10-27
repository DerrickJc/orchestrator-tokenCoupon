# 开发、离线演示与数据目录

[返回项目首页](../README.md) · [Windows 安装](windows.md) · [浏览器启动](browser.md) · [MCP 连接](mcp.md)

## 源码启动桌面窗口

先在本机源码目录完成 `npm ci`，再运行：

```bash
npm run desktop
```

Windows 桌面窗口需要在原生 Windows 终端中启动。若此前设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，需先补齐对应平台的 Electron。

## 不连接模型，先试运行

可以先用 Mock 验证计划执行流程，不需要模型账号，也不消耗模型额度：

```bash
npm run build
node packages/cli/dist/main.js plan run --file examples/plan.phase2.mock.json --workspace .
```

这是编排模拟，不代表真实 Agent 已生成代码或完成业务测试。正式体验时建议选择独立项目目录。

## 数据与访问边界

- 项目执行记录保存在工作区的 `.token-coupon/`，包括计划、Session、Attempt、日志和隔离执行目录；不应提交到业务仓库。
- 后台注册、授权和配置默认保存在用户目录的 `~/.token-coupon/daemon`；可以通过 `TOKEN_COUPON_DAEMON_HOME` 指定独立目录。
- MCP 通过 HTTPS、OAuth 和工作区权限限制访问；本地 API 与桌面 IPC 另有身份和来源校验。
- 全局切换处理方式不会替你批准计划或工具调用。网页模式无需为了连接而填写模型 API Key；可选 API 规划入口则使用独立配置。

## 开发与项目结构

```text
packages/
  core/       计划校验、Runner 协议、任务调度、执行持久化与 worktree
  daemon/     本地 API、MCP/OAuth、网页交接与后台服务
  web/        本地工作台、任务看板、审批与恢复界面
  desktop/    Electron 桌面壳、原生目录选择与通知
  cli/        命令行入口和后台操作
  client/     共享 API、协议及后台身份核验客户端
scripts/      演示、验证与桌面打包工具
examples/     可复现的计划示例
```

```bash
npm run typecheck
npm test
```

`npm test` 会先构建再运行测试。Windows 桌面包须在原生 Windows 构建；打包时还需提供指定版本的随包 Node，具体参数见 `scripts/package-desktop.mjs`。Codex、Claude Code 执行器按需使用，不作为桌面安装包的必需内置二进制。
