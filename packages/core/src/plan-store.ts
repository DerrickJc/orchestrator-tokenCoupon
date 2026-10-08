import type { PlannedTask } from "./plan.js";
import type { SessionSnapshot, SessionTaskState, TaskResult } from "./session-types.js";

export class PlanStore {
  private readonly taskById: Map<string, PlannedTask>;

  constructor(readonly plan: import("./plan.js").PlanDefinition, readonly snapshot: SessionSnapshot) {
    this.taskById = new Map(plan.tasks.map((entry) => [entry.task.id, entry]));
    if (snapshot.tasks.length !== plan.tasks.length || snapshot.tasks.some((state) => !this.taskById.has(state.taskId))) {
      throw new Error("Session 任务状态与原始计划不匹配");
    }
  }

  nextRunnable(states = this.snapshot.tasks): PlannedTask | undefined {
    const stateById = new Map(states.map((state) => [state.taskId, state]));
    return this.plan.tasks.find((entry) => {
      const state = stateById.get(entry.task.id);
      return state?.status === "planned" && entry.dependsOn.every((id) => stateById.get(id)?.status === "succeeded");
    });
  }

  nextRunnableBatch(limit: number, states = this.snapshot.tasks, excludedTaskIds: ReadonlySet<string> = new Set()): PlannedTask[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("并发上限必须是正整数");
    const stateById = new Map(states.map((state) => [state.taskId, state]));
    return this.plan.tasks.filter((entry) => {
      const state = stateById.get(entry.task.id);
      return !excludedTaskIds.has(entry.task.id) && state?.status === "planned" &&
        entry.dependsOn.every((id) => stateById.get(id)?.status === "succeeded");
    }).slice(0, limit);
  }

  beginAttempt(taskId: string, attemptId: string, artifactDir: string, allowRetry = false): SessionTaskState[] {
    const entry = this.taskById.get(taskId);
    const current = this.snapshot.tasks.find((state) => state.taskId === taskId);
    if (!entry || !current) throw new Error(`Session 中不存在任务：${taskId}`);
    if (current.status !== "planned" && !(allowRetry && ["failed", "timed_out", "cancelled", "interrupted"].includes(current.status))) {
      throw new Error(`任务 ${taskId} 当前状态 ${current.status} 不允许启动`);
    }
    const stateById = new Map(this.snapshot.tasks.map((state) => [state.taskId, state]));
    if (!entry.dependsOn.every((id) => stateById.get(id)?.status === "succeeded")) {
      throw new Error(`任务 ${taskId} 的前置依赖尚未成功`);
    }
    return this.snapshot.tasks.map((state) => state.taskId === taskId ? {
      ...state,
      status: "running" as const,
      activeAttemptId: attemptId,
      attempts: [...state.attempts, { attemptId, artifactDir, outcome: "pending" as const }],
      result: null,
      reasonCode: null,
    } : state);
  }

  finishAttempt(taskId: string, attemptId: string, status: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted" | "blocked", reasonCode: string | null, result: TaskResult | null, states = this.snapshot.tasks): SessionTaskState[] {
    const current = states.find((state) => state.taskId === taskId);
    if (!current || current.status !== "running" || current.activeAttemptId !== attemptId) {
      throw new Error(`Attempt ${attemptId} 不是任务 ${taskId} 的当前执行`);
    }
    const updated = states.map((state) => state.taskId === taskId ? {
      ...state,
      status,
      activeAttemptId: null,
      attempts: state.attempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, outcome: "recorded" as const } : attempt),
      result,
      reasonCode,
    } : state);
    return this.recalculateBlocked(updated);
  }

  recalculateDependencies(states: SessionTaskState[]): SessionTaskState[] { return this.recalculateBlocked(states); }

  private recalculateBlocked(states: SessionTaskState[]): SessionTaskState[] {
    const failedStates = new Set(["failed", "timed_out", "cancelled", "interrupted", "blocked"]);
    let result = states;
    for (let pass = 0; pass <= states.length; pass += 1) {
      const stateById = new Map(result.map((state) => [state.taskId, state]));
      const next = result.map((state) => {
        if (state.status !== "planned" && state.status !== "blocked") return state;
        const dependencies = this.taskById.get(state.taskId)?.dependsOn ?? [];
        if (dependencies.some((id) => failedStates.has(stateById.get(id)?.status ?? ""))) {
          return { ...state, status: "blocked" as const, activeAttemptId: null, reasonCode: "dependency_not_succeeded" };
        }
        if (state.status === "blocked") {
          return { ...state, status: "planned" as const, reasonCode: null };
        }
        return state;
      });
      if (next.every((state, index) => state === result[index])) return next;
      result = next;
    }
    return result;
  }
}

export function initialTaskStates(plan: import("./plan.js").PlanDefinition): SessionTaskState[] {
  return plan.tasks.map(({ task }) => ({ taskId: task.id, status: "planned", activeAttemptId: null, attempts: [], result: null, reasonCode: null }));
}

export function sessionStatusFor(states: SessionTaskState[], fallback: SessionSnapshot["status"] = "ready"): SessionSnapshot["status"] {
  if (states.some((state) => state.status === "running")) return "running";
  if (states.some((state) => state.status === "interrupted")) return "interrupted";
  if (states.some((state) => ["failed", "timed_out", "blocked"].includes(state.status))) return "failed";
  if (states.some((state) => state.status === "cancelled")) return "cancelled";
  if (states.length > 0 && states.every((state) => state.status === "succeeded")) return "succeeded";
  if (fallback === "interrupted") return "interrupted";
  return "ready";
}
