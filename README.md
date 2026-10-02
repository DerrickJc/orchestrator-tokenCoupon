# orchestrator-tokenCoupon

面向 coding agent 的多 agent 任务编排平台，目标是把用户目标转成有序计划，支持大模型规划并由 coding agent 执行。

一个逐步搭建的本地任务编排工具。当前阶段提供 TypeScript/npm workspace 骨架，以及手工任务与计划的读取、校验和展示；尚未执行任务。

## 环境

- Node.js 22.12 或更高版本
- npm 10 或更高版本

## 安装和使用

```bash
npm install
npm run build
npm run cli -- plan show --file examples/plan.json
npm run cli -- task show --file examples/task.mock.json
```

输入校验或文件读取失败时 CLI 返回退出码 `2`。`plan show` 和 `task show` 只读取 JSON 并打印内容，不启动 Runner。

代码文件和模块关系见[实现指南](docs/IMPLEMENTATION_GUIDE.md)。

开发命令：

```bash
npm run typecheck
npm test
```

`npm test` 会构建 workspace 并运行 Vitest 测试。
