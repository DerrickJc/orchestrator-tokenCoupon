import type { ExecutionConfig, RequiredRunnerCapability, TaskDefinition } from "./task.js";

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
  /** Adapter-extracted final response, distinct from streamed deltas. */
  finalText?: string;
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
  /** Records semantic events and resolves only after they are durably queued. */
  recordEvent?: (event: RunnerEvent) => Promise<void>;
  /** Routes one active native prompt through the owner; unavailable in legacy runners. */
  requestInteraction?: (request: RunnerInteractionRequest, requestSignal?: AbortSignal) => Promise<RunnerInteractionResolution>;
  /** Raw process activity, called before adapters parse or filter chunks. */
  onActivity?: () => void;
}

export type RunnerEvent =
  | { type: "message.delta" | "message.completed"; messageId?: string; text: string; root: boolean }
  | { type: "tool.started" | "tool.completed"; toolId?: string; name: string; summary?: string; exitCode?: number | null }
  | { type: "command.completed"; toolId?: string; command?: string; cwd: string; exitCode: number | null; status: "succeeded" | "failed" | "unknown"; evidenceSource: string; outputSummary?: string }
  | { type: "runner.diagnostic"; severity: "info" | "warning" | "error"; code: string; message: string; nativeError?: RunnerNativeError; willRetry?: boolean; threadId?: string; turnId?: string }
  | { type: "runner.native.started"; threadId: string; turnId: string; reportedModel?: string; modelProvider?: string }
  | { type: "runner.native.finished"; outcome: "completed" | "failed" | "cancelled" | "incomplete" | "unknown"; reason?: string }
  | { type: "interaction.forwarded" | "interaction.resolved"; requestId: string; evidence?: string };

export interface RunnerInteractionRequest {
  kind: "approval" | "question";
  nativeRequestId?: string;
  title: string;
  summary: string;
  cwd?: string;
  operation?: { kind: "command" | "file-change" | "other"; command?: string; paths?: string[] };
  questions?: Array<{
    id: string;
    text: string;
    header?: string;
    options?: Array<{ id: string; label: string }>;
    multiple?: boolean;
    required?: boolean;
    allowFreeText?: boolean;
    secret?: boolean;
  }>;
  decisions?: Array<"allow-once" | "deny">;
}

export interface RunnerInteractionOwner {
  attemptId: string;
  taskId: string;
  runnerId: string;
  cwd: string;
}

export type RunnerInteractionReply =
  | { kind: "approval"; decision: "allow-once" | "deny" }
  | { kind: "question"; answers: Array<{ questionId: string; optionIds?: string[]; text?: string }> };

export type RunnerInteractionResolution = RunnerInteractionReply & { interactionId: string };

export type RunnerCapabilityState = "supported" | "unsupported" | "unverified";
export type RunnerCapabilityName = "structuredEvents" | "userInput" | "toolApproval" | "cancellation" | "reportedModel";

export interface RunnerCapabilities {
  structuredEvents: RunnerCapabilityState;
  userInput: RunnerCapabilityState;
  toolApproval: RunnerCapabilityState;
  cancellation: RunnerCapabilityState;
  reportedModel: RunnerCapabilityState;
}

export interface RunnerRegistration {
  id: string;
  adapterVersion: string;
  configurationVersion: number;
  supportedModes: readonly ExecutionConfig["mode"][];
  supportsModel: boolean;
  capabilities: Readonly<Record<ExecutionConfig["mode"], RunnerCapabilities>>;
  validateSettings(settings: Readonly<Record<string, unknown>>, version: number): Readonly<Record<string, unknown>>;
  create(settings: Readonly<Record<string, unknown>>, mode: ExecutionConfig["mode"]): Runner;
}

export interface RunnerProfile {
  schemaVersion: 1;
  runners: Readonly<Record<string, { configVersion: number; settings: Readonly<Record<string, unknown>> }>>;
}

export interface ResolvedRunnerSpec {
  runnerId: string;
  adapterVersion: string;
  configurationVersion: number;
  mode: ExecutionConfig["mode"];
  requestedModel?: string;
  settingsHash: string;
  requiredCapabilities: readonly RequiredRunnerCapability[];
  capabilities: RunnerCapabilities;
}

export type RunnerNativeOutcome = "completed" | "failed" | "cancelled" | "incomplete" | "unknown";
export type RunnerCleanupStatus = "completed" | "failed" | "unknown";

export interface RunnerNativeError { message: string; code?: string; details?: string; httpStatus?: number; }

export interface RunnerDiagnostics {
  version?: string;
  configurationSources: string[];
  authentication: "configured" | "missing" | "unknown";
  inference: "unverified";
}

/** Optional normalized facts let SDK and persistent-server adapters avoid inventing a process exit code. */
export interface RunnerResult extends ProcessResult {
  transport?: "process" | "sdk" | "app-server";
  nativeOutcome?: RunnerNativeOutcome;
  cleanupStatus?: RunnerCleanupStatus;
  reportedModel?: string;
  nativeError?: RunnerNativeError;
  nativeThreadId?: string;
  nativeTurnId?: string;
}

export interface Runner {
  readonly id: string;
  readonly supportsModel: boolean;
  /** Present when the adapter instance was created through RunnerRegistry. */
  readonly resolvedSpec?: ResolvedRunnerSpec;
  checkAvailable(): Promise<void>;
  /** Local metadata only: no login, token refresh or model inference. */
  diagnose?(cwd: string): Promise<RunnerDiagnostics>;
  run(input: RunnerInput, context: RunnerContext): Promise<RunnerResult>;
}
