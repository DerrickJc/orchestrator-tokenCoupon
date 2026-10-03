import type { PlanDefinition, PlannedTask } from "./plan.js";
import { parseTask } from "./validate-task.js";
import {
  expectExactKeys,
  expectNonEmptyString,
  expectObject,
  expectSchemaVersion,
  InputValidationError,
} from "./validation.js";

export function parsePlan(value: unknown): PlanDefinition {
  const plan = expectObject(value, "plan");
  expectExactKeys(plan, ["schemaVersion", "id", "title", "tasks"], "plan");
  expectSchemaVersion(plan, "plan");

  if (!Array.isArray(plan.tasks)) {
    throw new InputValidationError("plan.tasks", "必须是数组");
  }

  const planId = expectNonEmptyString(plan.id, "plan.id");
  const title = expectNonEmptyString(plan.title, "plan.title");
  const tasks: PlannedTask[] = [];
  const taskIds = new Set<string>();

  for (const [index, rawEntry] of plan.tasks.entries()) {
    const path = `plan.tasks[${index}]`;
    const entry = expectObject(rawEntry, path);
    expectExactKeys(entry, ["task", "dependsOn", "status"], path);

    const task = parseTask(entry.task, `${path}.task`);
    if (taskIds.has(task.id)) {
      throw new InputValidationError(`${path}.task.id`, `任务 ID 重复：${task.id}`);
    }
    taskIds.add(task.id);

    if (!Array.isArray(entry.dependsOn)) {
      throw new InputValidationError(`${path}.dependsOn`, "必须是字符串数组");
    }

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of entry.dependsOn.entries()) {
      const dependencyId = expectNonEmptyString(
        dependency,
        `${path}.dependsOn[${dependencyIndex}]`,
      );
      if (dependencies.has(dependencyId)) {
        throw new InputValidationError(
          `${path}.dependsOn[${dependencyIndex}]`,
          `依赖重复：${dependencyId}`,
        );
      }
      dependencies.add(dependencyId);
      dependsOn.push(dependencyId);
    }

    if (entry.status !== "planned") {
      throw new InputValidationError(`${path}.status`, "阶段 0 只支持 planned 状态");
    }

    tasks.push({ task, dependsOn, status: "planned" });
  }

  for (const [index, plannedTask] of tasks.entries()) {
    for (const dependencyId of plannedTask.dependsOn) {
      if (!taskIds.has(dependencyId)) {
        throw new InputValidationError(
          `plan.tasks[${index}].dependsOn`,
          `找不到依赖任务：${dependencyId}`,
        );
      }
    }
    if (plannedTask.dependsOn.includes(plannedTask.task.id)) {
      throw new InputValidationError(`plan.tasks[${index}].dependsOn`, `任务不能依赖自身：${plannedTask.task.id}`);
    }
  }

  const byId = new Map(tasks.map((entry) => [entry.task.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string, path: string[]) => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      const cycle = [...path.slice(cycleStart), taskId].join(" -> ");
      throw new InputValidationError("plan.tasks", `依赖关系存在循环：${cycle}`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) visit(dependencyId, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const entry of tasks) visit(entry.task.id, []);

  return { schemaVersion: 1, id: planId, title, tasks };
}
