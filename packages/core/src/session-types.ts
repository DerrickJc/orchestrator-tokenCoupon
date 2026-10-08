import type { PlanDefinition } from "./plan.js";

export type SessionTaskStatus = "planned" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "blocked" | "interrupted";
export type SessionStatus = "ready" | "running" | "pausing" | "paused" | "succeeded" | "failed" | "cancelled" | "interrupted" | "blocked";
export type SchedulerState = "idle" | "dispatching" | "draining" | "paused" | "failed" | "blocked" | "cancelled";
export type SessionControlKind = "pause" | "cancel";

export interface SessionControlState {
  requestId: string | null;
  kind: SessionControlKind | null;
  requestedAt: string | null;
  acknowledgedAt: string | null;
}

export interface SessionControlRequest extends SessionControlState {
  sessionId: string;
  executionId: string;
  requestId: string;
  kind: SessionControlKind;
  requestedAt: string;
}

export interface SessionSchedulerEvent {
  sequence: number;
  sessionId: string;
  executionId: string;
  event: string;
  occurredAt: string;
  taskId?: string;
  attemptId?: string;
  waveId?: string;
  reasonCode?: string;
}

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
  status: "creating" | "ready" | "committing" | "committed" | "merging" | "landed" | "no_changes" | "conflicted" | "failed" | "cancelled" | "blocked";
  taskCommit: string | null;
  changedFiles: string[];
  reasonCode: string | null;
  waveId?: string;
  executionId?: string;
  preIntegrationHead?: string | null;
  integrationCommit?: string | null;
  postIntegrationHead?: string | null;
  mergeParents?: string[];
  conflictPaths?: string[];
  recoveryStage?: "task_committed" | "merge_started" | "merge_applied" | "journal_saved";
}

export interface GitIsolationJournal {
  schemaVersion: 1 | 2;
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
  schemaVersion: 1 | 2 | 3;
  sessionId: string;
  workspace: string;
  revision: number;
  status: SessionStatus;
  planId: string;
  planTitle: string;
  tasks: SessionTaskState[];
  /** Version 1 records predate execution isolation and always behave as shared. */
  isolation?: SessionIsolation;
  /** Phase 5 fields are required on schema v3; absent legacy values mean serial execution. */
  maxParallel?: number;
  planDigest?: string;
  executionId?: string;
  schedulerState?: SchedulerState;
  waveId?: string | null;
  activeAttemptIds?: string[];
  controlState?: SessionControlState;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  plan: PlanDefinition;
  snapshot: SessionSnapshot;
  isolationJournal?: GitIsolationJournal;
}
