# 浏览器工作台

[返回项目首页](../README.md) · [Windows 安装](windows.md) · [浏览器启动](browser.md) · [MCP 连接](mcp.md)

本入口是在你的电脑上运行后台，再用浏览器打开本地页面。项目文件与执行器仍位于本机。

## 从源码启动

源码运行需要 **Node.js 22.12+、npm 10+**。使用 Git worktree 时，还需安装 Git。

```bash
git clone https://github.com/DerrickJc/orchestrator-tokenCoupon.git
cd orchestrator-tokenCoupon
npm ci
npm run daemon -- --port 4177
```

在浏览器打开 **http://127.0.0.1:4177**，进入本地 Web 控制台。

只使用浏览器时，可以在 `npm ci` 前设置以下可选环境变量，省去 Electron 二进制下载：

```powershell
# Windows PowerShell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
```

```bash
# Linux / WSL
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
```

保持后台终端运行；已有桌面后台时可以复用它提供的本地地址。

## 首次使用

1. 在 **工作区与计划** 中打开项目目录。
2. 在 **系统设置 → Agent 组件** 中检测或按需安装 Codex、Claude Code，完成登录并选择模型。
3. 统一设置或按规划、审查、修订、错误分析分别设置“网页优先／指定 Agent 优先”。
4. 使用网页时按 [MCP 连接](mcp.md)授权，再按[规划与执行](workflow.md)开始工作；仅使用本机 Agent 可直接规划。

开发桌面壳、离线 Mock 和检查命令见[开发指南](development.md)。
