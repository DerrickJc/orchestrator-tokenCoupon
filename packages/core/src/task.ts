export type ExecutionMode = "non_interactive";

export interface ExecutionConfig {
  runnerId: string;
  modelId?: string;
  mode: ExecutionMode;
  /** Deprecated historical field. It is preserved in old plans but never limits an Attempt. */
  timeoutMs?: number;
}

export interface TaskDefinition {
  schemaVersion: 1;
  id: string;
  title: string;
  prompt: string;
  execution: ExecutionConfig;
}
