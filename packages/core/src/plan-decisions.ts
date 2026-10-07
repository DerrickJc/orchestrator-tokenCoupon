import type { PlanDefinition, SelectedDecision } from "./plan.js";
import { decisionValueHash } from "./plan.js";
import type { PlanningAssessment } from "./planner-types.js";
import type { ConfirmationState } from "./planner-types.js";
import { latestDecisionConfirmation } from "./confirmation.js";
import { expectExactKeys, expectObject, InputValidationError } from "./validation.js";

/** The model owns task structure; core owns decision versions, hashes and refs. */
export function plannerPlanStructure(value: unknown): unknown {
  const plan = expectObject(value, "plan");
  if (plan.schemaVersion !== 2) return value;
  expectExactKeys(plan, ["schemaVersion", "id", "title", "tasks", "decisionContext"], "plan");
  if (!Array.isArray(plan.tasks)) throw new InputValidationError("plan.tasks", "必须是数组");
  const { decisionContext: _context, ...structure } = plan;
  return { ...structure, schemaVersion: 1, tasks: plan.tasks.map((value, index) => {
    const entry = expectObject(value, `plan.tasks[${index}]`);
    expectExactKeys(entry, ["task", "dependsOn", "status", "decisionRefs"], `plan.tasks[${index}]`);
    const { decisionRefs: _refs, ...task } = entry;
    return task;
  }) };
}

export function bindPlanDecisions(plan: PlanDefinition, assessment: PlanningAssessment, previous?: PlanDefinition, confirmationState?: ConfirmationState): PlanDefinition {
  const previousDecisions = new Map(previous?.decisionContext?.decisions.map((item) => [item.decisionId, item]));
  const decisions: SelectedDecision[] = assessment.decisions.filter(({ status }) => status !== "pending").map((item) => {
    const valueHash = decisionValueHash(item.decisionId, item.value);
    const old = previousDecisions.get(item.decisionId);
    const event = latestDecisionConfirmation(confirmationState, item.decisionId);
    const confirmedEvent = event && event.sourceMessageId === item.sourceMessageId && ["accept", "delegate", "provide_value"].includes(event.action) ? event : undefined;
    const preference = confirmedEvent?.preference;
    const confirmation = confirmedEvent ? { action: confirmedEvent.action as "accept" | "delegate" | "provide_value", proposalId: confirmedEvent.proposalId,
      proposalRevision: confirmedEvent.proposalRevision, questionId: confirmedEvent.questionId, sourceMessageId: confirmedEvent.sourceMessageId, quote: confirmedEvent.quote, decisionIds: [...confirmedEvent.decisionIds] } : undefined;
    const sameConfirmation = JSON.stringify(old?.confirmation) === JSON.stringify(confirmation);
    const revision = old ? old.revision + (old.valueHash === valueHash && old.status === item.status && old.preference === preference && sameConfirmation ? 0 : 1) : 1;
    return {
      decisionId: item.decisionId,
      revision,
      value: item.value,
      valueHash,
      status: item.status as SelectedDecision["status"],
      rationale: item.rationale,
      ...(item.requirementId ? { requirementId: item.requirementId } : {}),
      ...(item.sourceMessageId ? { sourceMessageId: item.sourceMessageId } : {}),
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.authorizationQuote ? { authorizationQuote: item.authorizationQuote } : {}),
      ...(item.evidence ? { evidence: { ...item.evidence } } : {}),
      ...(preference ? { preference } : {}),
      ...(confirmation ? { confirmation } : {}),
    };
  });
  const ids = decisions.map(({ decisionId }) => decisionId);
  return {
    schemaVersion: 2,
    id: plan.id,
    title: plan.title,
    tasks: plan.tasks.map((entry) => ({
      ...entry,
      decisionRefs: decisions.map(({ decisionId, revision, valueHash }) => ({ decisionId, revision, valueHash })),
    })),
    decisionContext: { schemaVersion: 1, decisions, globalDecisionIds: ids },
  };
}
