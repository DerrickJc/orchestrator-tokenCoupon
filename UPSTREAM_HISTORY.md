# Ordewell 的关键演进与搭建启示

整理日期：2026-10-01。参考本地源码与 Git 历史，以及当日获取的上游默认分支提交记录。提交日期采用 Git 记录中的日期，不表示功能最早开始开发的时间。

本地分析基线为 `36d0254`；上游查询时最新提交为 `0707565`。涉及结构化传输等新增内容，下面明确作为上游进展列出。

## 1. 公开历史能说明什么

[首个提交 fe4296c](https://github.com/ordewell/ordewell/commit/fe4296cb7f159d11c964c5e64eb2a1c7cee70f7b)（2026-07-31）已经包含 core、CLI、VS Code、本地 daemon、开发驱动工具和多份 ADR。

因此，[搭建路线](README.md)是按当前模块依赖重新设计的学习顺序。下面的历史主要帮助理解：产品进入实际使用后，为什么需要调整状态归属、隔离方式和 Runner 交互。

## 2. 值得参考的提交

| 日期 | 提交与变化 | 对重建项目的启示 |
| --- | --- | --- |
| 08-07 | [e6c7fc1：计划修改时保留编排状态](https://github.com/ordewell/ordewell/commit/e6c7fc1515a8eb2b52f17560f06a845606807791) | 编辑计划时要保留已经发生的执行事实 |
| 08-13 | [9fa6511：Planner 在对话中查询和编辑任务](https://github.com/ordewell/ordewell/commit/9fa65117e05ab36838d552be803c914ef7a63ab4) | Planner 需要读取当前计划，并通过受控接口修改 |
| 08-20 | [db4dc59：将 grill-me/PRD 开关改为通用 skills](https://github.com/ordewell/ordewell/commit/db4dc592a3e0ca4078297d87c114933fb12d72c4) | 固定规划流程可以在需求明确后再抽象成 skills |
| 09-20 | [2c2d3e3：先写 worktree 隔离设计](https://github.com/ordewell/ordewell/commit/2c2d3e3360c92d762c736e8a625d0f8422b6218a) | 并行会影响工作目录、提交归属和失败恢复，先设计边界 |
| 09-25 | [c776d5d：规划与执行重构，加入隔离、输出读取、分叉和压缩](https://github.com/ordewell/ordewell/commit/c776d5d8eb8a6558696c629f2fcdcbca8a326f6f) | 执行闭环稳定后，才有条件扩展会话和上下文功能 |
| 09-25 | [264db21：多仓库工作空间](https://github.com/ordewell/ordewell/commit/264db219b81704bb8842a4e850987ccc91672f8b) | 先把单仓库隔离完成，再扩展仓库组与整合失败处理 |
| 09-26 | [5172f63：worktree 内包依赖指向自身代码](https://github.com/ordewell/ordewell/commit/5172f63eab639557ff01d0dd948efea0398f58c4) | Git 隔离后，还需要确认依赖和构建产物的来源 |
| 09-26 | [7e527ba：在任务自己的 worktree 中修复冲突](https://github.com/ordewell/ordewell/commit/7e527ba90730c44d1415be98dd28786fc4868ef5) | 修复属于任务的新尝试，不应长时间占用整合队列 |
| 09-27 | [ab63f56：共享对话展示结构](https://github.com/ordewell/ordewell/commit/ab63f56a9b6c1aee4417f83228d350d4a2f1dd8a) | 多界面应消费统一事件，避免各自解释一遍模型输出 |
| 09-28 | [245b10e：取消任务后保留 worktree](https://github.com/ordewell/ordewell/commit/245b10e297aa549a21e9cfabada6bbde07cda757) | 停止进程与丢弃工作是不同操作 |
| 09-28 | [f2583be：PlanStore 统一拥有任务状态](https://github.com/ordewell/ordewell/commit/f2583be7f43b6b1c02747135d4336f0eec95b613) | 调度、持久化和界面应读取同一份任务状态 |
| 09-28 | [d531c6b：精简 Session，集中组装依赖](https://github.com/ordewell/ordewell/commit/d531c6b54e08263c50de1df25a6e340d654dbf22) | Session 管生命周期，专门模块分别管理对话、整合和事件 |
| 09-29 | [96ab1d3：结构化 Runner 传输 ADR](https://github.com/ordewell/ordewell/commit/96ab1d3ad31fb42431c76f78bdeda8c760d233f1) | 在终端模式以外增加程序化协议，获得更清楚的交互状态 |
| 09-29 | [f22a0f2：Claude 任务适配与结构化会话](https://github.com/ordewell/ordewell/commit/f22a0f21b0ebf22580b785eb0bbaa85d5eeb5a40) | 先做一个 Runner 的完整参考实现，再扩展其他 Runner |
| 09-29 | [c401872：实时事件、按尝试保存任务日志](https://github.com/ordewell/ordewell/commit/c40187246daed9b88f0e471f6e3b829fd4a16afd) | 日志应随执行保留，界面重开后仍能重建过程 |
| 09-30 | [92d2415：发布 0.5.6](https://github.com/ordewell/ordewell/commit/92d2415f360a6621546b4529ed5d2e6e0ba379fb) | 本地分析基线之后，上游继续发布上述执行优化 |
| 10-01 | [97d8ece：接受 Planner shell 下的只读沙箱设计](https://github.com/ordewell/ordewell/commit/97d8eceef771e093c5f4c2cdfc746726c6cd9a13) | 策略审批与系统隔离是不同层次；接受设计不等于已完成实现 |

这些提交只能证明相应功能或修正在历史中出现，不能据此推断整个仓库由某个 skill 自动搭建。skills 是可参考的一项规划能力，重建执行闭环不依赖它。

## 3. 适合重建时采用的设计顺序

原项目后来才加入 worktree 隔离。ADR-0013 描述了此前多个 Runner 在同一工作目录相互覆盖的问题。重建时可以提前落实隔离，再打开并行。

原项目后来统一了 PlanStore 的状态归属。重建时从第一版计划管理就让它统一拥有任务状态，避免调度器、保存文件和界面形成多份可修改副本。

原项目先有终端交互，再增加结构化协议。重建时若所选 Runner 支持合适的协议，可以直接使用；多 Runner 兼容和丰富界面随后再做。

## 4. ADR 导读

| 设计主题 | 参考文档 | 先抓住的问题 |
| --- | --- | --- |
| 执行配置 | [ADR-0001](https://github.com/ordewell/ordewell/blob/main/docs/adr/0001-autonomous-mode-resolution.md) | 用户看到的计划是否真实决定执行模式 |
| 规划对话 | [ADR-0002](https://github.com/ordewell/ordewell/blob/main/docs/adr/0002-planner-as-conversation-loop.md) | 对话如何形成可执行计划 |
| 调研边界 | [ADR-0008](https://github.com/ordewell/ordewell/blob/main/docs/adr/0008-planner-exploration-envelope.md) | Planner 可以读取和执行什么 |
| 复用 agent 规划能力 | [ADR-0009](https://github.com/ordewell/ordewell/blob/main/docs/adr/0009-coding-agents-as-planners.md) | 如何利用已有 Runner 的规划协议 |
| 任务隔离 | [ADR-0013](https://github.com/ordewell/ordewell/blob/main/docs/adr/0013-worktree-isolation.md) | 每个任务的代码归属和交付位置是什么 |
| 多仓库 | [ADR-0014](https://github.com/ordewell/ordewell/blob/main/docs/adr/0014-multi-repo-workspaces.md) | 如何保持仓库布局并处理跨仓库失败 |
| 冲突修复 | [ADR-0015](https://github.com/ordewell/ordewell/blob/main/docs/adr/0015-conflict-repair.md) | 修复如何有界、可记录并由证据判定 |
| 环境准备 | [ADR-0016](https://github.com/ordewell/ordewell/blob/main/docs/adr/0016-per-workspace-environment.md) | Runner 的依赖和配置来自哪个工作空间 |
| 结构化执行 | [ADR-0018](https://github.com/ordewell/ordewell/blob/07075655cb011f1d5678c28372fa65cc3e172db5/docs/adr/0018-structured-runner-transport.md) | 如何获取输入等待、审批、日志与原生会话 |

按查询时的 ADR-0018，结构化传输是可选实验功能，默认仍为终端传输；任务连接器先支持 Claude Code，其他 Runner 会显示原因并回退到终端模式。未来将其作为默认方式是路线图方向，不是当前已覆盖全部 Runner 的能力。

## 5. 最值得复用的经验

先完成一个能够独立交付结果的执行闭环；随后解决状态一致性、代码隔离和结果整合；再扩展并行、Runner 和界面。遇到重复或复杂流程时，围绕一个清楚的概念提炼模块。

上游历史的价值是帮助提前发现这些边界，而不是要求第一版就复制所有包、配置和功能。
