# README 界面素材

2026-10-26 使用当前 Web 构建、独立临时后台与离线 Mock Runner 截图：

- `workspaces.png`：工作区选择。
- `structured-plan.png`：目标、方案、步骤、交付物、验收与约束。
- `execution-board.png`：执行汇总、四任务依赖与完成状态。

临时目录以 `/projects/greeting-demo` 占位；没有使用个人业务项目、网页账号或授权数据。该演示按共享工作区串行完成，不代表真实 Agent 的代码交付、业务测试或并发性能验收。素材仅用于解释界面。

更新时请使用独立演示配置，不直接截图个人工作区、密钥、OAuth 信息或真实公网连接地址。

## 协作机制图

`collaboration.svg` 为本项目原创 SVG，分为网页模型、本地编排、Coding Agent 三个区域。实线表示任务与数据，虚线表示执行反馈。详细交互时序保存在 `guides/collaboration.md`。

## 网页 MCP 连接图

首页预留 `mcp-connection-placeholder.svg` 占位。添加你自己的图片时：

1. 将截图或拼图保存为 `assets/readme/mcp-connection.png`。
2. 将根目录 README“网页 MCP 连接示例”中的图片替换为：

   ```markdown
   ![网页 MCP 连接与授权示例](assets/readme/mcp-connection.png)
   ```

占位 SVG 可以随后删除。截图请遮住密钥、授权码、账号与不宜公开的项目路径；图片中的临时公网地址不作为可复用连接提供。
