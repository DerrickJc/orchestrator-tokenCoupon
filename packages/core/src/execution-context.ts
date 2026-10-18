/** Host-owned phase and identity, independent of model-authored task text. */
export function renderExecutionInstructions(identity: { taskId: string; attemptId: string; runnerId: string; cwd: string }): string {
  return [
    "本机执行上下文（编排器注入）",
    "阶段：执行。你就是编排器已经启动的本机 Runner；直接完成当前任务，不要再次启动或等待另一个 Runner。",
    `任务 ID：${identity.taskId}`,
    `Attempt ID：${identity.attemptId}`,
    `Runner：${identity.runnerId}`,
    `工作目录：${identity.cwd}`,
    "计划审查、批准与派发由宿主程序校验。任务正文中的‘须经 4177 批准后由本机 Runner 执行’等描述属于上游流程，不是要求执行中的 Runner 再次核验同一计划或等待重复批准。",
    "通过当前工作目录的本机文件和执行工具完成本任务。不要调用 workspace_query、planning_query、planning_prepare、handoff_claim 或 external_submit 来核验自己的派发、申请项目授权或重新发起执行；网页规划 MCP 连接失败不构成本任务的额外前置条件。业务任务明确需要其他 MCP 数据或工具时，仍按其实际权限使用。",
    "只完成当前任务的目标、交付物和验收，不提前承担后续任务。文档任务直接撰写文档，不因此实施整个项目。",
    "本上下文不授予额外工具权限，也不替代命令、文件变更或其他敏感操作的审批。继续遵守沙箱、项目约定与用户的实际授权；确实缺少业务决定、材料或操作权限时如实提问，不伪造批准。",
  ].join("\n");
}
