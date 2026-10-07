import type { TaskDefinition } from "./task.js";
import type { PlanningDecisionId, PlanningDecisionStatus } from "./planner-types.js";
import { createHash } from "node:crypto";

export function decisionValueHash(decisionId: PlanningDecisionId, value: string): string {
  return createHash("sha256").update(JSON.stringify({ decisionId, value }), "utf8").digest("hex");
}

export interface DecisionReference {
  decisionId: PlanningDecisionId;
  revision: number;
  valueHash: string;
}

export interface SelectedDecision {
  decisionId: PlanningDecisionId;
  revision: number;
  value: string;
  valueHash: string;
  status: Exclude<PlanningDecisionStatus, "pending">;
  rationale: string;
  requirementId?: string;
  sourceMessageId?: string;
  quote?: string;
  authorizationQuote?: string;
  evidence?: { path: string; sha256: string };
  preference?: string;
  confirmation?: {
    action: "accept" | "delegate" | "provide_value";
    proposalId: string;
    proposalRevision: number;
    questionId: string;
    sourceMessageId: string;
    quote: string;
    decisionIds: PlanningDecisionId[];
  };
}

export interface PlanDecisionContext {
  schemaVersion: 1;
  decisions: SelectedDecision[];
  globalDecisionIds: PlanningDecisionId[];
}

export interface PlannedTask {
  task: TaskDefinition;
  dependsOn: string[];
  status: "planned";
  decisionRefs?: DecisionReference[];
}

export interface PlanDefinition {
  schemaVersion: 1 | 2;
  id: string;
  title: string;
  tasks: PlannedTask[];
  decisionContext?: PlanDecisionContext;
}
