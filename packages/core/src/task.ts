export type ExecutionMode = "non_interactive" | "managed";
export type RequiredRunnerCapability = "userInput" | "toolApproval";

export interface ExecutionConfig {
  runnerId: string;
  modelId?: string;
  mode: ExecutionMode;
  /** Optional capabilities the task needs from this Runner; omitted in legacy plans. */
  requiredCapabilities?: RequiredRunnerCapability[];
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
