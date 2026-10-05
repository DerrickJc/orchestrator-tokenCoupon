import type { PlanDefinition, PlannedTask } from "./plan.js";
import { parsePlan } from "./validate-plan.js";

export interface PlanChange {
  kind: "plan" | "task_added" | "task_removed" | "task_changed" | "task_order";
  taskId?: string;
  field: string;
  before?: unknown;
  after?: unknown;
}

export function diffPlans(beforeValue: unknown, afterValue: unknown): PlanChange[] {
  const before = parsePlan(beforeValue);
  const after = parsePlan(afterValue);
  const changes: PlanChange[] = [];
  if (before.id !== after.id) changes.push({ kind: "plan", field: "id", before: before.id, after: after.id });
  if (before.title !== after.title) changes.push({ kind: "plan", field: "title", before: before.title, after: after.title });

  const oldTasks = new Map(before.tasks.map((entry) => [entry.task.id, entry]));
  const newTasks = new Map(after.tasks.map((entry) => [entry.task.id, entry]));
  for (const entry of after.tasks) {
    const oldEntry = oldTasks.get(entry.task.id);
    if (!oldEntry) {
      changes.push({ kind: "task_added", taskId: entry.task.id, field: "task", after: compactEntry(entry) });
      continue;
    }
    compare(changes, entry.task.id, "title", oldEntry.task.title, entry.task.title);
    compare(changes, entry.task.id, "prompt", oldEntry.task.prompt, entry.task.prompt);
    compare(changes, entry.task.id, "execution", oldEntry.task.execution, entry.task.execution);
    const oldDependencies = [...oldEntry.dependsOn].sort();
    const newDependencies = [...entry.dependsOn].sort();
    compare(changes, entry.task.id, "dependsOn", oldDependencies, newDependencies);
  }
  for (const entry of before.tasks) {
    if (!newTasks.has(entry.task.id)) changes.push({ kind: "task_removed", taskId: entry.task.id, field: "task", before: compactEntry(entry) });
  }

  const oldOrder = before.tasks.map(({ task }) => task.id);
  const newOrder = after.tasks.map(({ task }) => task.id);
  if (!sameArray(oldOrder, newOrder)) changes.push({ kind: "task_order", field: "tasks", before: oldOrder, after: newOrder });
  return changes;
}

function compactEntry(entry: PlannedTask): unknown {
  return { title: entry.task.title, prompt: entry.task.prompt, execution: entry.task.execution, dependsOn: [...entry.dependsOn].sort() };
}

function compare(changes: PlanChange[], taskId: string, field: string, before: unknown, after: unknown): void {
  if (stable(before) !== stable(after)) changes.push({ kind: "task_changed", taskId, field, before, after });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameArray(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
