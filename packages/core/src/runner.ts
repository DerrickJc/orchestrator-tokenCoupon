import type { ExecutionConfig, TaskDefinition } from "./task.js";

export interface RunnerInput {
  attemptId: string;
  cwd: string;
  task: TaskDefinition;
  execution: ExecutionConfig;
  prompt: string;
  completionMarker: string;
}

export interface RunnerOutput {
  stream: "stdout" | "stderr";
  text: string;
  /** Text extracted by the adapter as agent response text, never stderr or raw JSON. */
  agentText?: string;
  /** Optional user-facing text; unset defaults to agentText, empty suppresses display. */
  displayText?: string;
  structuredEvent?: unknown;
}

export interface ProcessResult {
  started: boolean;
  exitCode: number | null;
  signal: string | null;
  startError?: { code: string | null; message: string };
  executionError?: string;
  terminationError?: string;
}

export interface RunnerContext {
  signal: AbortSignal;
  onStarted: () => void;
  onOutput: (output: RunnerOutput) => void;
}

export interface Runner {
  readonly id: string;
  readonly supportsModel: boolean;
  checkAvailable(): Promise<void>;
  run(input: RunnerInput, context: RunnerContext): Promise<ProcessResult>;
}
