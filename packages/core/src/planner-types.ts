import type { ExecutionConfig } from "./task.js";
import type { PlanDefinition } from "./plan.js";
import type { RepositoryReader } from "./repository-reader.js";

export type ConversationMessage = { messageId: string; role: "user" | "assistant"; content: string };
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
  turns: PlannerTurnRef[];
  context: RepositoryEvidence[];
  activeTurnId: string | null;
  draftRevision: number | null;
  approval: PlanApproval | null;
  execution: ExecutionReference | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerReply {
  kind: "clarification" | "draft";
  message: string;
  questions?: string[];
  plan?: PlanDefinition;
}

export type PlannerEvent = { type: string; payload: Record<string, unknown> };

export interface PlannerInput {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  executionDefaults: ExecutionConfig;
  currentDraft?: PlannerDraft;
  repairMessage?: string;
  repositoryNotice?: string;
}

export interface PlannerContext {
  signal: AbortSignal;
  repository: RepositoryReader;
  consumeApiRequest(): number;
  consumeToolCall(): void;
  record(event: PlannerEvent): Promise<void>;
}

export interface Planner {
  readonly id: "mock" | "deepseek";
  generate(input: PlannerInput, context: PlannerContext): Promise<unknown>;
}
