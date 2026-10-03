import type { ExecutionConfig } from "./task.js";

export type AttemptStatus =
  | "created"
  | "running"
  | "succeeded"
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
  completionToken: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  markerSeen: boolean;
  reasonCode: string | null;
  reason: string | null;
  artifactDir: string;
  inputBytes: number;
  outputBytes: number;
}
