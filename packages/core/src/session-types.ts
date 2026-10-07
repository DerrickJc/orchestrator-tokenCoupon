import type { PlanDefinition } from "./plan.js";

export type SessionTaskStatus = "planned" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "blocked" | "interrupted";
export type SessionStatus = "ready" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export type SessionIsolation =
  | { mode: "shared" }
  | {
      mode: "git-worktree";
      status: "initializing" | "ready" | "blocked";
      repositoryRoot: string;
      gitCommonDir: string;
      baseCommit: string;
      sourceBranch: string | null;
      integrationBranch: string;
      integrationWorktree: string;
      verificationTaskId: string;
      setupHash: string | null;
    };

export interface GitIsolationAttempt {
  attemptId: string;
  taskId: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  status: "creating" | "ready" | "committing" | "committed" | "landed" | "no_changes" | "failed" | "blocked";
  taskCommit: string | null;
  changedFiles: string[];
  reasonCode: string | null;
}

export interface GitIsolationJournal {
  schemaVersion: 1;
  sessionId: string;
  status: "initializing" | "ready" | "blocked";
  integrationHead: string;
  attempts: GitIsolationAttempt[];
  updatedAt: string;
}

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
  schemaVersion: 1 | 2;
  sessionId: string;
  workspace: string;
  revision: number;
  status: SessionStatus;
  planId: string;
  planTitle: string;
  tasks: SessionTaskState[];
  /** Version 1 records predate execution isolation and always behave as shared. */
  isolation?: SessionIsolation;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  plan: PlanDefinition;
  snapshot: SessionSnapshot;
  isolationJournal?: GitIsolationJournal;
}
