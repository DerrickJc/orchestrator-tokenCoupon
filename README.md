# orchestrator-tokenCoupon

面向 coding agent 的多 agent 任务编排平台，目标是把用户目标转成有序计划，支持大模型规划并由 coding agent 执行。

一个逐步搭建的本地任务编排工具。当前支持单任务非交互执行、Mock Runner 和 Claude Code Runner，并记录每次 Attempt 的输入、输出与结果。计划调度、并行执行和会话恢复仍属于后续阶段。

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

代码文件和模块关系见[实现指南](docs/IMPLEMENTATION_GUIDE.md)。

开发命令：

```bash
npm run typecheck
npm test
```

`npm test` 会构建 workspace 并运行 Vitest 测试。
