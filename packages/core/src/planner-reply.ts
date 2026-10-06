import type { PlanDefinition } from "./plan.js";
import type { PlannerReply, RequirementsUpdate } from "./planner-types.js";

/** Recoverable output errors are distinct from network, cancellation and budget errors. */
export class PlannerReplyValidationError extends Error {
  constructor(readonly code: "planner_invalid_json" | "planner_invalid_reply" | "planner_requirements_invalid" | "planner_plan_invalid", message: string) {
    super(message);
    this.name = "PlannerReplyValidationError";
  }
}

export function parsePlannerJson(content: string): unknown {
  try { return JSON.parse(content) as unknown; }
  catch (error) {
    // Do not expose response text (or credentials accidentally echoed in it).
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    throw new PlannerReplyValidationError("planner_invalid_json", "模型回复不是合法 JSON" + (position ? `（位置 ${position}）` : "") + "；必须只返回一个完整对象，requirementsUpdate 必须位于对象内部");
  }
}

export function parsePlannerReply(value: unknown, requireUpdate = false): PlannerReply {
  const fail = (message: string): never => { throw new PlannerReplyValidationError("planner_invalid_reply", message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Planner 回复必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (typeof raw.message !== "string" || !raw.message.trim()) return fail("Planner message 必须是非空文本");
  if (Buffer.byteLength(raw.message, "utf8") > 16 * 1024) return fail("Planner message 超过 16 KiB");
  if (requireUpdate && raw.requirementsUpdate === undefined) throw new PlannerReplyValidationError("planner_requirements_invalid", "Planner 必须返回 requirementsUpdate 以整理当前需求；该字段必须在主 JSON 对象内部");
  const update = raw.requirementsUpdate;
  if (update !== undefined && (!update || typeof update !== "object" || Array.isArray(update))) throw new PlannerReplyValidationError("planner_requirements_invalid", "requirementsUpdate 必须是对象");
  const metadata = update === undefined ? {} : { requirementsUpdate: update as RequirementsUpdate };
  if (raw.kind === "clarification") {
    if (Object.keys(raw).some((key) => !["kind", "message", "questions", "requirementsUpdate"].includes(key)) || !Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 3 ||
        raw.questions.some((question) => typeof question !== "string" || !question.trim() || Buffer.byteLength(question, "utf8") > 2048)) return fail("clarification 必须包含 1 到 3 个具体问题，且不能附带 plan 或其他字段");
    return { kind: "clarification", message: raw.message, questions: raw.questions as string[], ...metadata };
  }
  if (raw.kind === "draft" && Object.keys(raw).every((key) => ["kind", "message", "plan", "requirementsUpdate"].includes(key)) && raw.plan !== undefined) {
    return { kind: "draft", message: raw.message, plan: raw.plan as PlanDefinition, ...metadata };
  }
  return fail("Planner kind 必须是 clarification 或 draft，字段不能混用");
}
