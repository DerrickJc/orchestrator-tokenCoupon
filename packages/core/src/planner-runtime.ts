import type { PlannerConfig, PlannerEvent } from "./planner-types.js";

export type PlannerEventObserver = (event: PlannerEvent & { planningId: string; turnId?: string; reviewId?: string }) => Promise<void>;

/** Transport/initialization failures cannot be repaired by asking for different JSON. */
export class PlannerInvocationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PlannerInvocationError"; }
}

export function plannerDeadline(config: PlannerConfig, parent: AbortSignal | undefined, role: "plan" | "review") {
  const controller = new AbortController();
  let timedOut = false;
  const local = ["codex-agent", "claude-agent"].includes(config.provider);
  const timer = local ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${role === "plan" ? "planner" : "review"}_timed_out：${role === "plan" ? "规划轮次" : "审查"}超过 120 秒`));
  }, 120_000);
  const abort = () => controller.abort(parent?.reason ?? new Error("由用户取消"));
  if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, timedOut: () => timedOut, dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

export function plannerFailure(error: unknown, deadline: ReturnType<typeof plannerDeadline>, role: "plan" | "review") {
  const prefix = role === "plan" ? "planner" : "review";
  const code = deadline.timedOut() ? `${prefix}_timed_out` : deadline.signal.aborted ? `${prefix}_cancelled`
    : error instanceof PlannerInvocationError ? error.code : undefined;
  const cause = deadline.signal.aborted ? deadline.signal.reason : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code, message: code && !message.startsWith(code) ? `${code}：${message}` : message };
}
