export type ExecutionMode = "non_interactive";

export interface ExecutionConfig {
  runnerId: string;
  modelId?: string;
  mode: ExecutionMode;
  timeoutMs: number;
}

export interface TaskDefinition {
  schemaVersion: 1;
  id: string;
  title: string;
  prompt: string;
  execution: ExecutionConfig;
}
