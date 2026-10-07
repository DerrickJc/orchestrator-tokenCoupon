import type { PlanDefinition } from "./plan.js";
import type { PlannerReply, RequirementsUpdate } from "./planner-types.js";

/** Recoverable output errors are distinct from network, cancellation and budget errors. */
export class PlannerReplyValidationError extends Error {
  constructor(readonly code: "planner_invalid_json" | "planner_invalid_reply" | "planner_requirements_invalid" | "planner_plan_invalid" | "planner_readiness_invalid", message: string) {
    super(message);
    this.name = "PlannerReplyValidationError";
  }
}

export function parsePlannerJson(content: string): unknown {
  try { return JSON.parse(content) as unknown; }
  catch (error) {
    // Do not expose response text (or credentials accidentally echoed in it).
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    const end = scanRootObject(content)?.end;
    const misplaced = end === undefined ? undefined : /^\s*,\s*"(requirementsUpdate|planningAssessment)"\s*:/.exec(content.slice(end + 1))?.[1];
    throw new PlannerReplyValidationError("planner_invalid_json", "模型回复不是合法 JSON" + (position ? `（位置 ${position}）` : "") +
      (misplaced ? `；根对象在 ${misplaced} 前提前关闭，请移除该字段前多余的右花括号并保留最后的根对象结束符` : "；必须只返回一个完整对象，requirementsUpdate 必须位于对象内部"));
  }
}

/** Recover only the observed extra root brace, without rewriting any business data. */
export function decodePlannerJson(content: string): { value: unknown; repair?: { code: "premature_root_close"; offset: number; field: string } } {
  try { return { value: parsePlannerJson(content) }; }
  catch (error) {
    const root = scanRootObject(content);
    const field = root && /^\s*,\s*"(requirementsUpdate|planningAssessment)"\s*:/.exec(content.slice(root.end + 1))?.[1];
    if (!root || !field) throw error;
    const candidate = content.slice(0, root.end) + content.slice(root.end + 1);
    let value: unknown;
    try { value = JSON.parse(candidate) as unknown; } catch { throw error; }
    const corrected = scanRootObject(candidate);
    const allowed = new Set(["kind", "message", "questions", "plan", "requirementsUpdate", "planningAssessment"]);
    if (!corrected || new Set(corrected.keys).size !== corrected.keys.length || corrected.keys.some((key) => !allowed.has(key))) throw error;
    return { value, repair: { code: "premature_root_close", offset: root.end, field } };
  }
}

/** Scan structural characters outside JSON strings; JSON.parse remains the syntax authority. */
function scanRootObject(content: string): { end: number; keys: string[] } | undefined {
  const start = content.search(/\S/);
  if (content[start] !== "{") return undefined;
  let depth = 0;
  const keys: string[] = [];
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      const beginning = index;
      for (index += 1; index < content.length; index += 1) {
        if (content[index] === "\\") { index += 1; continue; }
        if (content[index] === '"') break;
      }
      if (index >= content.length) return undefined;
      if (depth === 1 && /^\s*:/.test(content.slice(index + 1))) {
        try { keys.push(JSON.parse(content.slice(beginning, index + 1)) as string); } catch { return undefined; }
      }
    } else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return char === "}" ? { end: index, keys } : undefined;
    }
  }
  return undefined;
}

export function parsePlannerReply(value: unknown, requireUpdate = false, requireAssessment = false): PlannerReply {
  const fail = (message: string): never => { throw new PlannerReplyValidationError("planner_invalid_reply", message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Planner 回复必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (raw.kind === undefined) return fail("Planner 缺少 kind 字段；必须显式设置 kind 为 clarification 或 draft");
  if (raw.kind !== "clarification" && raw.kind !== "draft") return fail("Planner kind 只能是 clarification 或 draft");
  if (raw.kind === "clarification" && "plan" in raw) return fail("clarification 不能包含 plan；需要草案时设置 kind=draft 并移除 questions");
  if (raw.kind === "draft" && "questions" in raw) return fail("draft 不能包含 questions；仍需澄清时设置 kind=clarification 并移除 plan");
  if (raw.kind === "draft" && raw.plan === undefined) return fail("draft 缺少 plan 字段");
  const allowed = ["kind", "message", "requirementsUpdate", "planningAssessment", raw.kind === "draft" ? "plan" : "questions",
    ...(raw.kind === "clarification" ? ["questionBindings"] : [])];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return fail("Planner 回复包含未知字段；顶层只能包含 " + allowed.join(", "));
  if (typeof raw.message !== "string" || !raw.message.trim()) return fail("Planner message 必须是非空文本");
  if (Buffer.byteLength(raw.message, "utf8") > 16 * 1024) return fail("Planner message 超过 16 KiB");
  if (requireUpdate && raw.requirementsUpdate === undefined) throw new PlannerReplyValidationError("planner_requirements_invalid", "Planner 必须返回 requirementsUpdate 以整理当前需求；该字段必须在主 JSON 对象内部");
  if (requireAssessment && raw.planningAssessment === undefined) throw new PlannerReplyValidationError("planner_readiness_invalid", "Planner 必须返回 planningAssessment，说明规划类型、关键决策及其来源");
  const update = raw.requirementsUpdate;
  if (update !== undefined && (!update || typeof update !== "object" || Array.isArray(update))) throw new PlannerReplyValidationError("planner_requirements_invalid", "requirementsUpdate 必须是对象");
  const metadata = { ...(update === undefined ? {} : { requirementsUpdate: update as RequirementsUpdate }),
    ...(raw.planningAssessment === undefined ? {} : { planningAssessment: raw.planningAssessment as NonNullable<PlannerReply["planningAssessment"]> }) };
  if (raw.kind === "clarification") {
    if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 3 ||
        raw.questions.some((question) => typeof question !== "string" || !question.trim() || Buffer.byteLength(question, "utf8") > 2048)) return fail("clarification 必须包含 1 到 3 个具体问题，每个问题不超过 2048 字节");
    let questionBindings: PlannerReply["questionBindings"];
    if (raw.questionBindings !== undefined) {
      if (!Array.isArray(raw.questionBindings) || raw.questionBindings.length !== raw.questions.length) return fail("questionBindings 必须逐项关联全部澄清问题");
      questionBindings = raw.questionBindings.map((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`questionBindings[${index}] 必须是对象`);
        const binding = value as Record<string, unknown>;
        if (Object.keys(binding).some((key) => !["questionId", "displayIndex", "decisionIds", "answerMode"].includes(key)) ||
            typeof binding.questionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(binding.questionId) ||
            binding.displayIndex !== index + 1 || !Array.isArray(binding.decisionIds) || binding.decisionIds.length < 1 ||
            binding.decisionIds.some((id) => typeof id !== "string") ||
            !["accept_proposal", "delegate_choice", "provide_value"].includes(String(binding.answerMode))) return fail(`questionBindings[${index}] 字段无效`);
        return { questionId: binding.questionId, displayIndex: binding.displayIndex as number, decisionIds: binding.decisionIds as NonNullable<PlannerReply["questionBindings"]>[number]["decisionIds"], answerMode: binding.answerMode as NonNullable<PlannerReply["questionBindings"]>[number]["answerMode"] };
      });
    }
    return { kind: "clarification", message: raw.message, questions: raw.questions as string[], ...(questionBindings ? { questionBindings } : {}), ...metadata };
  }
  return { kind: "draft", message: raw.message, plan: raw.plan as PlanDefinition, ...metadata };
}
