import type { PlanDefinition } from "./plan.js";
import type { TaskDefinition } from "./task.js";

export interface AgentSelection { runnerId: string; modelId?: string; }
export interface ExecutionSelection {
  defaults?: AgentSelection;
  tasks?: Array<AgentSelection & { taskId: string }>;
}

/** Only Runner/model may change at launch; task content and execution capabilities stay approved. */
export function parseExecutionSelection(value: unknown, plan?: PlanDefinition): ExecutionSelection {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("execution_selection_invalid：运行模型配置必须是对象");
    return input as Record<string, unknown>;
  };
  const choice = (input: unknown, task = false): AgentSelection & { taskId?: string } => {
    const raw = object(input);
    if (Object.keys(raw).some(key => !["runnerId", "modelId", ...(task ? ["taskId"] : [])].includes(key)) ||
        typeof raw.runnerId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.runnerId) ||
        raw.modelId !== undefined && (typeof raw.modelId !== "string" || !raw.modelId.trim() || raw.modelId.length > 120 || /[\x00-\x1f\x7f]/.test(raw.modelId))) {
      throw new Error("execution_selection_invalid：仅允许设置有效的 Runner 和模型");
    }
    if (task && (typeof raw.taskId !== "string" || !raw.taskId || raw.taskId.length > 64 || plan && !plan.tasks.some(entry => entry.task.id === raw.taskId))) throw new Error("execution_selection_task_invalid：运行配置引用了未知任务");
    return { runnerId: raw.runnerId, ...(raw.modelId === undefined ? {} : { modelId: (raw.modelId as string).trim() }), ...(task ? { taskId: raw.taskId as string } : {}) };
  };
  const raw = object(value);
  if (Object.keys(raw).some(key => !["defaults", "tasks"].includes(key)) || raw.tasks !== undefined && (!Array.isArray(raw.tasks) || raw.tasks.length > 1000)) throw new Error("execution_selection_invalid：运行模型配置字段无效");
  const defaults = raw.defaults === undefined ? undefined : choice(raw.defaults);
  const tasks = raw.tasks === undefined ? [] : (raw.tasks as unknown[]).map(item => choice(item, true) as AgentSelection & { taskId: string }).sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (new Set(tasks.map(item => item.taskId)).size !== tasks.length) throw new Error("execution_selection_task_invalid：任务配置不能重复");
  return { ...(defaults ? { defaults } : {}), ...(tasks.length ? { tasks } : {}) };
}

export function taskWithExecutionSelection(task: TaskDefinition, selection?: ExecutionSelection): TaskDefinition {
  const choice = selection?.tasks?.find(item => item.taskId === task.id) ?? selection?.defaults;
  if (!choice) return task;
  const execution = { ...task.execution, runnerId: choice.runnerId };
  if (choice.modelId) execution.modelId = choice.modelId; else delete execution.modelId;
  return { ...task, execution };
}
