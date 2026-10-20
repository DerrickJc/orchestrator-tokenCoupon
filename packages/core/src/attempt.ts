import type { ExecutionConfig } from "./task.js";
import type { ProcessOwner } from "./owner-lock.js";
import type { ResolvedRunnerSpec, RunnerCleanupStatus, RunnerNativeOutcome, RunnerNativeError, RunnerModelSource } from "./runner.js";

export type AttemptStatus =
  | "created"
  | "running"
  | "succeeded"
  | "needs_input"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AttemptRecord {
  schemaVersion: 1;
  attemptId: string;
  taskId: string;
  status: AttemptStatus;
  cwd: string;
  runnerId: string;
  execution: ExecutionConfig;
  owner?: ProcessOwner & { hostname: string };
  /** Policy actually used by this new Attempt; legacy timeoutMs is informational only. */
  executionPolicy?: { mode: "idle_notice"; idleAfterMs: number };
  completionToken: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  transport?: "process" | "sdk" | "app-server";
  nativeOutcome?: RunnerNativeOutcome;
  cleanupStatus?: RunnerCleanupStatus;
  reportedModel?: string;
  reportedModelSource?: RunnerModelSource;
  nativeError?: RunnerNativeError;
  nativeThreadId?: string;
  nativeTurnId?: string;
  runnerSpec?: ResolvedRunnerSpec;
  markerSeen: boolean;
  /** Exact Attempt-scoped marker indicating the Runner stopped for user input. */
  needsInputSeen?: boolean;
  reasonCode: string | null;
  reason: string | null;
  artifactDir: string;
  inputBytes: number;
  outputBytes: number;
  /** Persisted when the idle state changes; ordinary output does not rewrite the snapshot. */
  lastActivityAt?: string;
  idleSince?: string;
}
