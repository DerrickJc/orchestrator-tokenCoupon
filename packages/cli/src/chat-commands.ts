export interface ChatCommand { name: string; usage: string; description: string; example: string; group: string; initial?: boolean; }
const rows: Array<[string, string, string, string, string, boolean?]> = [
  ["help", "/help", "查看指令帮助", "/help", "输入与确认", true],
  ["input", "/input", "进入显式多行输入；/send 提交，/cancel 放弃", "/input", "输入与确认", true],
  ["request-file", "/request-file <路径>", "整体读取多行需求文件", "/request-file ./request.txt", "输入与确认", true],
  ["confirm", "/confirm all|编号[,编号]", "接受当前具体提案", "/confirm 1,2", "输入与确认"],
  ["delegate", "/delegate 编号[,编号]", "委托 Planner 选择对应决策", "/delegate 2", "输入与确认"],
  ["reject", "/reject 编号[,编号]", "拒绝对应提案", "/reject 1", "输入与确认"],
  ["revoke", "/revoke all|decisionId[,decisionId]", "撤回决策确认或授权", "/revoke language_runtime", "输入与确认"],
  ["plan", "/plan [taskId]", "查看规划或任务正文与依赖；taskId 从 /plan 获取", "/plan implement", "草案与审查"],
  ["edit", "/edit", "用 EDITOR/VISUAL 指定的编辑器修改草案", "/edit", "草案与审查"],
  ["check", "/check", "本地检查草案结构", "/check", "草案与审查"],
  ["diff", "/diff [fromRevision] [toRevision]", "比较草案版本，默认当前版与上一版", "/diff 1 2", "草案与审查"],
  ["review", "/review | /review show [reviewId]", "审查并逐项选择修订；show 查看已有报告", "/review show", "草案与审查"],
  ["revise", "/revise [说明]", "按说明和审查上下文生成新草案", "/revise 补充真实 HTTP 回归测试", "草案与审查"],
  ["approve", "/approve", "检查适用审查后批准当前草案；保留问题不等于豁免", "/approve", "草案与审查"],
  ["history", "/history", "查看原始对话", "/history", "需求追溯"],
  ["requirements", "/requirements [refresh]", "查看有效需求；refresh 整理尚未分类输入", "/requirements refresh", "需求追溯"],
  ["trace", "/trace <requirementId> [revision]", "查看需求版本与来源；ID 从 /requirements 获取", "/trace R-runtime 1", "需求追溯"],
  ["run", "/run [执行参数]", "执行已批准计划；--isolation git-worktree 隔离；--max-parallel 1-8 并发；--verification-task 指定验证任务；--setup-file 读取准备配置；--runner-profile 读取 Runner 配置", "/run --isolation git-worktree --max-parallel 2 --verification-task verify", "执行与恢复"],
  ["status", "/status", "查看保存状态与 owner/锁的当前诊断", "/status", "执行与恢复"],
  ["recover", "/recover [--confirm-stopped]", "预检中断执行；确认原生进程停止后恢复，恢复不启动任务", "/recover", "执行与恢复"],
  ["resume", "/resume [--setup-file <路径>]", "继续关联 Session；setup-file 提供原准备配置", "/resume", "执行与恢复"],
  ["retry", "/retry <taskId> [--setup-file <路径>]", "重试任务，创建新 Attempt；taskId 从 /plan 获取", "/retry implement", "执行与恢复"],
  ["logs", "/logs [--task <taskId>] [--attempt <attemptId>] [--follow] [--raw]", "查看关键日志；follow 跟随，Ctrl-C 退出会话", "/logs --task implement --follow", "执行与恢复"],
  ["pending", "/pending", "查看待审批/待回答请求及 requestId", "/pending", "交互与交付"],
  ["respond", "/respond <requestId> allow-once|deny", "回复工具审批；requestId 从 /pending 获取", "/respond <requestId> allow-once", "交互与交付"],
  ["answer", "/answer <requestId> <答案.json>", "从文件回复 Runner 问题", "/answer <requestId> ./answers.json", "交互与交付"],
  ["delivery", "/delivery", "查看交付与 Git 信息", "/delivery", "交互与交付"],
  ["land", "/land <taskId>", "人工完成 Git 整合后继续落地流程", "/land implement", "交互与交付"],
  ["cleanup", "/cleanup", "清理满足条件的 Session worktree", "/cleanup", "交互与交付"],
  ["exit", "/exit（别名 /quit）", "退出常驻对话；Ctrl-C 也可退出并取消当前操作", "/exit", "交互与交付", true],
];
export const CHAT_COMMANDS: ChatCommand[] = rows.map(([name, usage, description, example, group, initial]) => ({ name, usage, description, example, group, ...(initial ? { initial } : {}) }));
export function commandCandidates(text: string, initial = false): ChatCommand[] {
  if (!/^\/[a-z-]*$/.test(text)) return [];
  return CHAT_COMMANDS.filter((c) => (!initial || c.initial) && c.name.startsWith(text.slice(1))).slice(0, 6);
}
export function formatChatHelp(initial = false): string {
  const commands = CHAT_COMMANDS.filter((c) => !initial || c.initial);
  return ["自然语言：输入需求或补充内容，Enter 提交；粘贴多行后仍需 Enter。Alt+Enter 换行；/input 为兼容回退。", "单行指令支持粘贴，按 Enter 执行；多行粘贴作为正文。↑/↓ 回看当前 CLI 会话最近 100 条输入，回看后可编辑，Enter 才提交。", "ID 示例是占位内容，需替换为当前会话 ID。草案操作需有草案，执行操作需有关联 Session。", ...[...new Set(commands.map((c) => c.group))].flatMap((group) => ["", group, ...commands.filter((c) => c.group === group).map((c) => `\n${c.usage}\n  功能：${c.description}\n  示例：${c.example}`)]), "", "多行模式：/send 提交，/cancel 放弃；正文中的独立控制词用 \\/send、\\/cancel 转义。"].join("\n");
}
