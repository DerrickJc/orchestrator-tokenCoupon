import type { ExecutionConfig } from "./task.js";
import type { PlanDefinition } from "./plan.js";
import type { RepositoryReader } from "./repository-reader.js";

export type ConversationMessage = { messageId: string; role: "user" | "assistant"; content: string };
export type MessageKind = "requirement" | "operation" | "noise";
export interface Requirement {
  requirementId: string;
  revision: number;
  text: string;
  status: "active" | "pending" | "withdrawn" | "superseded";
  sourceMessageIds: string[];
}
export interface RequirementsUpdate {
  messageDecisions: Array<{ messageId: string; kind: MessageKind; reason: string }>;
  changes: Array<{ requirementId: string; text: string; status: "active" | "pending" | "withdrawn"; sourceMessageIds: string[] }>;
}
export interface RequirementsState {
  revision: number;
  items: Requirement[];
  messageDecisions: RequirementsUpdate["messageDecisions"];
}
export type PlannerTurnStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";

export interface PlannerConfig {
  provider: "mock" | "deepseek";
  model: string;
  baseUrl: string;
}

export interface PlannerTurnRef {
  turnId: string;
  messageId: string;
  status: PlannerTurnStatus;
  artifactDir: string;
  reasonCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  operation?: boolean;
}

export interface RepositoryEvidence {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface PlannerDraft {
  schemaVersion: 1;
  planningId: string;
  draftRevision: number;
  plan: PlanDefinition;
  message: string;
  source: "model" | "user";
  context: RepositoryEvidence[];
  planHash: string;
  createdAt: string;
}

export interface PlanApproval {
  approvalId: string;
  draftRevision: number;
  planHash: string;
  approvedAt: string;
  reviewId?: string;
  reportHash?: string;
  waivedFindings?: Array<{ findingId: string; reason: string; waivedAt: string }>;
}

export type PlanReviewStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type PlanReviewSeverity = "error" | "warning" | "info";
export type PlanReviewCategory = "requirements" | "dependency" | "technology" | "contract" | "testing";

export interface PlanReviewFinding {
  findingId: string;
  severity: PlanReviewSeverity;
  category: PlanReviewCategory;
  taskIds: string[];
  description: string;
  basis: string;
  suggestion: string;
  /** Cross-report identity, assigned by core; F numbers remain report-local. */
  issueId?: string;
  priorFindingId?: string;
  requirementIds?: string[];
}

export interface ReviewResolution { findingId: string; issueId?: string; status: "resolved" | "unresolved"; basis: string }

export interface PlanReviewRecord {
  schemaVersion: 1;
  planningId: string;
  reviewId: string;
  status: PlanReviewStatus;
  draftRevision: number;
  planHash: string;
  requirementsHash: string;
  reviewerConfigHash: string;
  context: RepositoryEvidence[];
  findings: PlanReviewFinding[];
  summary: string;
  reportHash: string | null;
  reasonCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  previousReviewId?: string;
  resolutions?: ReviewResolution[];
}

export interface ExecutionReference {
  sessionId: string;
  approvalId: string;
  draftRevision: number;
  planHash: string;
  state: "reserved" | "created";
}

export interface PlannerConversationSnapshot {
  schemaVersion: 1;
  planningId: string;
  workspace: string;
  revision: number;
  status: "collecting" | "draft_ready" | "approved" | "execution_created";
  config: PlannerConfig;
  executionDefaults: ExecutionConfig;
  messages: ConversationMessage[];
  /** Missing on legacy snapshots until explicitly reconciled. */
  requirements?: RequirementsState;
  turns: PlannerTurnRef[];
  context: RepositoryEvidence[];
  activeTurnId: string | null;
  draftRevision: number | null;
  approval: PlanApproval | null;
  /** Optional for compatibility with Phase 3 snapshots created before review support. */
  latestReviewId?: string | null;
  execution: ExecutionReference | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerReply {
  kind: "clarification" | "draft";
  message: string;
  questions?: string[];
  plan?: PlanDefinition;
  requirementsUpdate?: RequirementsUpdate;
}

export type PlannerEvent = { type: string; payload: Record<string, unknown> };

export interface PlannerInput {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  executionDefaults: ExecutionConfig;
  currentDraft?: PlannerDraft;
  repairMessage?: string;
  repositoryNotice?: string;
  requirements?: RequirementsState;
  pendingMessages?: ConversationMessage[];
  operationMessageIds?: string[];
  reviewContext?: { review: PlanReviewRecord; current: boolean };
  historyIndex?: Array<{ messageId: string; role: "user" | "assistant"; turnStatuses: PlannerTurnStatus[] }>;
}

export interface PlannerContext {
  signal: AbortSignal;
  repository: RepositoryReader;
  consumeApiRequest(): number;
  consumeToolCall(): void;
  record(event: PlannerEvent): Promise<void>;
  readHistory?: (messageIds: string[]) => Promise<string>;
  /** Pure application validation; lets adapters keep an already valid response. */
  validateReply?: (value: unknown) => PlannerReply;
}

export interface PlanReviewInput {
  requirements: string[];
  plan: PlanDefinition;
  executionDefaults: ExecutionConfig;
  requirementItems?: Requirement[];
  previousReview?: PlanReviewRecord;
  planChanges?: import("./plan-diff.js").PlanChange[];
}

export interface PlanReviewer {
  review(input: PlanReviewInput, context: PlannerContext): Promise<unknown>;
}

export interface Planner {
  readonly id: "mock" | "deepseek";
  generate(input: PlannerInput, context: PlannerContext): Promise<unknown>;
}
