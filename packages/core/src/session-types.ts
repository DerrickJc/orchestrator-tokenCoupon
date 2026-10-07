import type { PlanDefinition } from "./plan.js";

export type SessionTaskStatus = "planned" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "blocked" | "interrupted";
export type SessionStatus = "ready" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface TaskResult {
  taskId: string;
  attemptId: string;
  status: "succeeded";
  summary: string;
  summarySource: "final" | "stream" | "none";
  truncated: boolean;
  artifactDir: string;
}

export interface TaskAttemptRef {
  attemptId: string;
  artifactDir: string;
  outcome: "pending" | "recorded" | "record_missing";
  lastActivityAt?: string;
  idleSince?: string;
}

export interface SessionTaskState {
  taskId: string;
  status: SessionTaskStatus;
  activeAttemptId: string | null;
  attempts: TaskAttemptRef[];
  result: TaskResult | null;
  reasonCode: string | null;
}

export interface SessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  workspace: string;
  revision: number;
  status: SessionStatus;
  planId: string;
  planTitle: string;
  tasks: SessionTaskState[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  plan: PlanDefinition;
  snapshot: SessionSnapshot;
}
