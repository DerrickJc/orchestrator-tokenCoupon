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
export type PlanningProfile = "backend_crud" | "documentation" | "script" | "existing_project" | "general";
export type PlanningDecisionStatus = "confirmed" | "repository" | "defaulted" | "pending";
export type PlanningDecisionId = "language_runtime" | "web_framework" | "database" | "documentation" | "testing" | "business_rules" |
  "document_scope" | "audience" | "source_of_truth" | "acceptance" | "inputs_outputs" | "side_effects" |
  "change_scope" | "compatibility" | "validation" | "scope";
export interface PlanningDecision {
  decisionId: PlanningDecisionId;
  value: string;
  status: PlanningDecisionStatus;
  rationale: string;
  requirementId?: string;
  sourceMessageId?: string;
  quote?: string;
  evidence?: { path: string; sha256: string };
  authorizationQuote?: string;
  question?: string;
}
export interface PlanningAssessment {
  profile: PlanningProfile;
  classification: { rationale: string; sourceMessageId: string; quote: string };
  decisions: PlanningDecision[];
}
export type ConfirmationAnswerMode = "accept_proposal" | "delegate_choice" | "provide_value";
export interface ConfirmationQuestion {
  questionId: string;
  displayIndex: number;
  text: string;
  decisionIds: PlanningDecisionId[];
  answerMode: ConfirmationAnswerMode;
}
export interface ConfirmationProposalSet {
  schemaVersion: 1;
  proposalId: string;
  revision: number;
  hash: string;
  sourceMessageId: string;
  questions: ConfirmationQuestion[];
  candidates: Array<{ decisionId: PlanningDecisionId; value: string; concrete: boolean }>;
  createdAt: string;
}
export interface ConfirmationEvent {
  schemaVersion: 1;
  eventId: string;
  sourceMessageId: string;
  sourceText: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  questionId: string;
  decisionIds: PlanningDecisionId[];
  action: "accept" | "delegate" | "reject" | "provide_value" | "revoke";
  quote: string;
  preference?: string;
  values?: Array<{ decisionId: PlanningDecisionId; value: string }>;
  createdAt: string;
}
export interface ConfirmationState {
  schemaVersion: 1;
  activeProposal: ConfirmationProposalSet | null;
  events: ConfirmationEvent[];
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
  /** Optional on legacy reservations; new reservations freeze execution isolation before Session creation. */
  isolation?: { mode: "shared" } | { mode: "git-worktree"; verificationTaskId: string; setupHash: string | null };
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
  /** Effective structured implementation decisions for the current conversation. */
  planningAssessment?: PlanningAssessment;
  /** Versioned question bindings and committed user confirmation events. */
  confirmationState?: ConfirmationState;
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
  questionBindings?: Array<Omit<ConfirmationQuestion, "text"> & { text?: string }>;
  plan?: PlanDefinition;
  requirementsUpdate?: RequirementsUpdate;
  planningAssessment?: PlanningAssessment;
}

export type PlannerEvent = { type: string; payload: Record<string, unknown> };

export interface PlannerInput {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  executionDefaults: ExecutionConfig;
  currentDraft?: PlannerDraft;
  repairMessage?: string;
  repositoryNotice?: string;
  requirements?: RequirementsState;
  planningAssessment?: PlanningAssessment;
  confirmationState?: ConfirmationState;
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
  /** Pure review validation reused by the model adapter during bounded repairs. */
  validateReviewReply?: (value: unknown) => unknown;
}

export interface PlanReviewInput {
  requirements: string[];
  plan: PlanDefinition;
  executionDefaults: ExecutionConfig;
  requirementItems?: Requirement[];
  planningAssessment?: PlanningAssessment;
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
