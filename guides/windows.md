# Windows 桌面版

[返回项目首页](../README.md) · [Windows 安装](windows.md) · [浏览器启动](browser.md) · [MCP 连接](mcp.md)

## 下载与安装

[直接下载安装器（Windows x64）](https://github.com/DerrickJc/orchestrator-tokenCoupon/releases/download/desktop-preview-0.1.0-20261027-2/Token-Coupon-0.1.0-x64-preview-setup.exe) · [下载 SHA256SUMS](https://github.com/DerrickJc/orchestrator-tokenCoupon/releases/download/desktop-preview-0.1.0-20261027-2/SHA256SUMS)

公开预览版：`desktop-preview-0.1.0-20261027-2`。本版包含 Windows 普通后台启动 ACL 修复、快捷连接及工作区界面更新。构建版本、校验值与验证范围见[版本说明](https://github.com/DerrickJc/orchestrator-tokenCoupon/releases/tag/desktop-preview-0.1.0-20261027-2)。

1. 双击下载的 `Token-Coupon-0.1.0-x64-preview-setup.exe`，按向导选择安装位置。
2. 启动 **orchestrator-tokenCoupon**，在 **工作区与计划** 中打开项目文件夹。需要 Git worktree 时，预先安装 Git。
3. 在 **系统设置** 中检测 Agent、选择处理模式；使用网页规划时再完成 [MCP 连接](mcp.md)。
4. 按[规划与执行流程](workflow.md)创建计划、审查、批准并运行。

安装器包含 Electron、Node 和后台服务；使用桌面应用不需要先运行源码启动命令。当前为未签名预览版。Codex、Claude Code 按需安装或复用本机工具，登录单独完成。

## 准备执行 Agent

打开 **系统设置 → Agent 组件**，检测本机 Codex、Claude Code。已有安装可以复用；缺少时可使用按需安装入口，或按官方方式手工安装。

组件安装需要可用的 npm。完成后按界面提供的启动方式登录，再刷新检测。检测到程序不代表账号已经登录或所有模型都有权限。

网页模型在 ChatGPT／Claude 网页中选择；执行模型在本地控制台中选择。它们可以使用不同的服务和模型，不要求一致。

## 选择处理模式

首次初始化或 **系统设置** 中，可以统一设置，也可以分别设置规划、审查、修订、错误分析：

| 模式 | 适用方式 |
| --- | --- |
| 网页优先 | 本地准备 MCP 交接，你在 ChatGPT／Claude 网页发起调用；适合复用网页额度 |
| 指定 Agent 优先 | 本地直接调用所选 Codex／Claude Code 及模型；适合希望在本地完成整条流程的场景 |

选择网页优先不会在后台自动打开聊天或发送消息，也不会悄悄改为本地模型调用。

## 核对下载文件

在安装器所在目录打开 PowerShell：

```powershell
Get-FileHash .\Token-Coupon-0.1.0-x64-preview-setup.exe -Algorithm SHA256
```

将结果与下载的 `SHA256SUMS` 对比。
