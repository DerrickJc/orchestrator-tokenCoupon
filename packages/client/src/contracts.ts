/** Browser-safe JSON contracts shared by the Web UI and future desktop host. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ApiRequestOptions = Omit<RequestInit, "headers"> & { headers?: HeadersInit };
export interface ApiTransport { api<T = unknown>(path: string, request?: ApiRequestOptions): Promise<T | null>; }

export type ExecutionModeDto = "managed" | "non_interactive";
export interface ExecutionConfigDto {
  runnerId: string; modelId?: string; mode: ExecutionModeDto;
  requiredCapabilities?: Array<"userInput" | "toolApproval">; timeoutMs?: number;
}
export interface TaskDefinitionDto {
  schemaVersion: 1 | 2; id: string; title: string; prompt: string; objective?: string; approach?: string;
  steps?: string[]; deliverables?: string[]; acceptanceCriteria?: string[]; constraints?: string[]; notes?: string;
  execution: ExecutionConfigDto;
}
export interface DecisionReferenceDto { decisionId: string; revision: number; valueHash: string; }
export interface PlannedTaskDto { task: TaskDefinitionDto; dependsOn: string[]; status: "planned"; decisionRefs?: DecisionReferenceDto[]; }
export interface SelectedDecisionDto {
  decisionId: string; revision: number; value: string; valueHash: string; status: string; rationale: string;
  requirementId?: string; sourceMessageId?: string; quote?: string; authorizationQuote?: string;
  evidence?: { path: string; sha256: string }; preference?: string;
  confirmation?: { action: "accept" | "delegate" | "provide_value"; proposalId: string; proposalRevision: number; questionId: string; sourceMessageId: string; quote: string; decisionIds: string[] };
}
export interface PlanDefinitionDto {
  schemaVersion: 1 | 2; id: string; title: string; tasks: PlannedTaskDto[];
  decisionContext?: { schemaVersion: 1; decisions: SelectedDecisionDto[]; globalDecisionIds: string[] };
}
export interface RepositoryEvidenceDto { path: string; sha256: string; sizeBytes: number; }
export interface PlannerConfigDto { provider: string; model: string; baseUrl: string; }
export interface PlanningProviderDto {
  id: string; label: string; available: boolean; model?: string; modelOptions?: ModelCatalogDto["models"]; runnerId?: string; reason?: string;
  connectionVerified?: boolean; remoteClientVerified?: boolean; capabilities?: Record<string, string>;
}
export interface RequirementDto { requirementId: string; revision: number; text: string; status: "active" | "pending" | "withdrawn" | "superseded"; sourceMessageIds: string[]; }
export interface RequirementsStateDto { revision: number; items: RequirementDto[]; messageDecisions: Array<{ messageId: string; kind: "requirement" | "operation" | "noise"; reason: string }>; }
export interface PlanningAssessmentDto {
  schemaVersion?: 2; profile: string; classification: { rationale: string; sourceMessageId: string; quote: string };
  decisions: Array<{ decisionId: string; value: string; status: string; rationale: string; requirementId?: string; sourceMessageId?: string; quote?: string; evidence?: { path: string; sha256: string }; authorizationQuote?: string; question?: string }>;
}
export interface ConfirmationStateDto {
  schemaVersion: 1;
  activeProposal: null | { schemaVersion: 1; proposalId: string; revision: number; hash: string; sourceMessageId: string; createdAt: string;
    questions: Array<{ questionId: string; displayIndex: number; text: string; decisionIds: string[]; answerMode: string; options?: Array<{ optionId: string; label: string; custom?: boolean; values?: Array<{ decisionId: string; value: string }> }> }>;
    candidates: Array<{ decisionId: string; value: string; concrete: boolean }> };
  events: Array<{ schemaVersion: 1; eventId: string; sourceMessageId: string; sourceText: string; proposalId: string; proposalRevision: number; proposalHash: string; questionId: string; optionId?: string; decisionIds: string[]; action: string; quote: string; preference?: string; values?: Array<{ decisionId: string; value: string }>; createdAt: string }>;
}
export interface ConversationMessageDto { messageId: string; role: "user" | "assistant"; content: string; }
export interface PlannerTurnDto { turnId: string; messageId: string; status: string; artifactDir: string; reasonCode: string | null; createdAt: string; finishedAt: string | null; operation?: boolean; }
export interface PlannerDraftDto { schemaVersion: 1; planningId: string; draftRevision: number; plan: PlanDefinitionDto; message: string; source: "model" | "user"; context: RepositoryEvidenceDto[]; planHash: string; createdAt: string; }
export interface PlanApprovalDto { approvalId: string; draftRevision: number; planHash: string; approvedAt: string; reviewId?: string; reportHash?: string; waivedFindings?: Array<{ findingId: string; reason: string; waivedAt: string }>; }
export interface ReviewFindingDto { findingId: string; severity: "error" | "warning" | "info"; category: string; taskIds: string[]; description: string; basis: string; suggestion: string; issueId?: string; priorFindingId?: string; requirementIds?: string[]; }
export interface ReviewResolutionDto { findingId: string; issueId?: string; status: "resolved" | "unresolved"; basis: string; }
export interface PlanningReviewDto {
  reviewId: string; draftRevision: number; status: string; summary: string; findings: ReviewFindingDto[]; resolutions?: ReviewResolutionDto[];
  reviewerConfig?: PlannerConfigDto; reviewerReportedModel?: string; current: boolean;
}
export interface WorkspaceDto { workspaceId: string; path: string; label: string; addedAt: string; }
export interface PlanningProgressDto {
  planningId: string; operationId: string; role: "plan" | "review"; stage: string; startedAt: string; updatedAt: string;
  lastActivityAt?: string; lastOutputAt?: string; runnerId?: string; configuredModel?: string; reportedModel?: string;
  requestId?: number; replyPreview?: string; rawPreview?: string; detail?: string; status?: string;
}
export interface JobDto {
  jobId: string; workspaceId: string; kind: string; requestKey: string; requestHash: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted"; createdAt: string; updatedAt: string;
  result?: unknown; error?: string; planningId?: string; progress?: PlanningProgressDto;
}
export interface DaemonEventDto { epoch: string; sequence: number; type: string; workspaceId?: string; planningId?: string; sessionId?: string; taskId?: string; payload?: Record<string, unknown>; createdAt: string; }
export interface SessionTaskDto {
  taskId: string; status: string; activeAttemptId: string | null;
  attempts: Array<{ attemptId: string; artifactDir: string; outcome: string; lastActivityAt?: string; idleSince?: string }>;
  result: { taskId: string; attemptId: string; status: "succeeded"; summary: string; summarySource: string; truncated: boolean; artifactDir: string } | null;
  reasonCode: string | null; savedStatus?: string; title?: string; dependsOn?: string[]; execution?: ExecutionConfigDto;
  currentAttempt?: AttemptSummaryDto | null;
}
export interface AttemptSummaryDto {
  attemptId: string; status: string; runnerId: string; execution: ExecutionConfigDto; reportedModel?: string; reportedModelSource?: string;
  startedAt: string | null; finishedAt: string | null; lastActivityAt?: string; reasonCode: string | null; reason: string | null;
  exitCode: number | null; nativeOutcome?: string; nativeError?: { message: string; code?: string; details?: string; httpStatus?: number };
  cleanupStatus?: string; activity?: string; lastReply?: string; savedStatus?: string;
}
export interface SessionViewDto {
  schemaVersion: 1 | 2 | 3; sessionId: string; workspace: string; revision: number;
  status: string; savedStatus: string; planId: string; planTitle: string;
  isolation?: { mode: "shared" } | { mode: "git-worktree"; status: "initializing" | "ready" | "blocked"; repositoryRoot: string; gitCommonDir: string; baseCommit: string; sourceBranch: string | null; integrationBranch: string; integrationWorktree: string; verificationTaskId: string; setupHash: string | null };
  maxParallel?: number; planDigest?: string; executionId?: string; schedulerState?: string; waveId?: string | null; activeAttemptIds?: string[];
  executionSelection?: { defaults?: { runnerId: string; modelId?: string }; tasks?: Array<{ taskId: string; runnerId: string; modelId?: string }> };
  executionSelectionHash?: string; controlState?: { requestId: string | null; kind: "pause" | "cancel" | null; requestedAt: string | null; acknowledgedAt: string | null };
  runnerProfile?: { schemaVersion: 1; runners: Record<string, { configVersion: number; settings: Record<string, unknown> }> }; runnerProfileHash?: string;
  createdAt: string; updatedAt: string;
  health: { state: string; checkedAt: string; recoveryRequired: boolean; message: string; attempts?: Array<{ taskId: string; attemptId: string; state: string; reason: string }> };
  tasks: SessionTaskDto[]; models: { schemaVersion: 1; sessionId: string; planDigest: string; revision: number; overrides: Record<string, { runnerId: string; modelId: string | null; updatedAt: string }>; history: Array<{ requestKey: string; taskId: string; modelId: string | null; at: string }> };
  pendingControl?: { sessionId: string; executionId: string; requestId: string; kind: "pause" | "cancel"; requestedAt: string; acknowledgedAt: string | null };
}
export interface PendingInteractionDto {
  requestId: string; workspaceId: string; planningId: string; createdAt: string;
  owner: { attemptId: string; taskId: string; runnerId: string; cwd: string };
  request: { kind: "approval" | "question" | "elicitation"; title: string; summary: string; cwd?: string; operation?: Record<string, unknown>; questions?: Array<Record<string, unknown>>; decisions?: Array<"allow-once" | "deny">; elicitation?: Record<string, unknown> };
}
/** Global index only; full prompts and approval payloads stay on the owning Plan. */
export interface PendingQueueItemDto {
  requestId: string; workspaceId: string; workspaceLabel: string; planningId: string;
  taskId: string; runnerId: string; kind: "approval" | "question" | "elicitation"; createdAt: string;
}
export interface PendingQueueDto {
  epoch: string; total: number; items: PendingQueueItemDto[]; nextOffset: number | null;
}
export interface PlanningTodoDto {
  workspaceId: string; workspaceLabel: string; planningId: string; title: string; revision: number;
  stage: string; label: string; tab: "overview" | "review" | "execution";
}
export interface PlanningTodoPageDto {
  epoch: string; items: PlanningTodoDto[]; scanned: number; nextCursor: string | null;
  warnings: Array<{ workspaceLabel: string; planningId?: string; message: string }>;
}
export interface PlanningWorkflowDto { stage: string; label: string; detail: string; operationId?: string; role?: string; options: string[]; approvalNotice: string | null; }
export interface HandoffSummaryDto { operationId: string; role?: string; pendingInputs?: number; owner?: { source?: string; expired: boolean } | null; [key: string]: unknown; }
export interface ExternalOperationSummaryDto {
  operationId: string; role: string; coordinated: boolean; isCurrent: boolean; state: string; planningId: string;
  expectedRevision: number; completedBy?: { grantId: string; clientId: string; source?: string; generation: number };
  message?: string; sourceMessageId?: string; diagnostic?: string; updatedAt: string;
  readBudget: { limitBytes: number; usedBytes: number; remainingBytes: number; maximumBytes: number };
}
export interface PlanningViewDto {
  planningId: string; status: "collecting" | "draft_ready" | "approved" | "execution_created"; revision: number; createdAt: string;
  localOperation?: JobDto; sourcePlanning?: { planningId: string; revision: number; draftRevision: number; planHash: string; sessionId?: string };
  workspace: { workspaceId: string; label: string }; config: Pick<PlannerConfigDto, "provider" | "model">; executionDefaults: ExecutionConfigDto;
  planningAssessment?: PlanningAssessmentDto; requirements?: RequirementsStateDto; confirmationState?: ConfirmationStateDto;
  messages: ConversationMessageDto[]; turns: PlannerTurnDto[]; draft?: PlannerDraftDto; draftChanged: number | null;
  verificationTasks: Array<{ taskId: string; title: string; valid: boolean; reason?: string }>;
  review?: PlanningReviewDto; reviewReadError?: string; reviewHistory: Array<{ reviewId: string; draftRevision: number; summary: string; findings: ReviewFindingDto[]; current: false }>;
  approval: PlanApprovalDto | null; approvalHistory: Array<{ draftRevision: number; recordedAt: string; historical: true }>;
  workflow: PlanningWorkflowDto; execution: { sessionId: string; approvalId: string; draftRevision: number; planHash: string; state: "reserved" | "created"; isolation?: { mode: "shared" } | { mode: "git-worktree"; verificationTaskId: string; setupHash: string | null } } | null;
  session?: SessionViewDto | { status: "unavailable"; error: string }; interactions: PendingInteractionDto[];
  title?: string; handoffs: HandoffSummaryDto[]; externalOperations: ExternalOperationSummaryDto[];
}
export interface AttemptEventPageDto {
  fileId: string; reset: boolean; events: Array<Record<string, unknown>>; cursor: number; hasMore: boolean; pendingPartial: boolean; malformed: number;
  attempt: AttemptSummaryDto; taskId: string; sessionId: string;
}
export type TaskResultsDto =
  | { taskId: string; attemptId?: string; source: "unrecorded"; files: []; total: 0; nextOffset: null; executionDirectory: string; message: string }
  | { taskId: string; attemptId: string; source: "git-isolation"; commit?: string | null; files: Array<{ path: string; absolutePath: string }>; total: number; nextOffset: number | null; executionDirectory: string; message: string }
  | { taskId: string; attemptId: string; source: "git-isolation"; commit?: string | null; file: { path: string; absolutePath: string; content?: string; truncated?: boolean; [key: string]: unknown }; message: string };
export interface SessionDiagnosisDto {
  sessionId: string; savedStatus: string; revision: number; isolation: string; maxParallel: number;
  state: "active" | "owner_exited" | "unknown" | "identity_conflict" | "idle";
  locks: Array<{ path: string; exists: boolean; state: string; reason: string; owner?: { pid: number; sessionId?: string | null } }>;
  attempts: Array<{ taskId: string; attemptId: string; status: string; owner: { state: string; reason: string } }>;
}
export interface SettingsDto {
  schemaVersion: 1; revision: number; initialized: boolean; mode: "unified" | "per-function";
  unified: { priority: "agent" | "web"; agent: { runnerId: "codex" | "claude-code"; modelId?: string }; webSource: "chatgpt" | "claude" };
  functions: Record<"planning" | "review" | "revision" | "diagnosis", SettingsDto["unified"]>;
}
export interface ModelCatalogDto { source: string; models: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>; customAllowed: boolean; error?: string; }
export interface RunnerOptionDto { id: string; adapterVersion: string; configurationVersion: number; supportedModes: ExecutionModeDto[]; capabilities: Record<string, Record<string, string>>; available: boolean; defaultMode?: ExecutionModeDto; modelOptions: ModelCatalogDto["models"]; error?: string; }

export interface RequestKeyDto { requestKey: string; }
export interface ExecutionSelectionDto {
  defaults?: { runnerId: string; modelId?: string };
  tasks?: Array<{ taskId: string; runnerId: string; modelId?: string }>;
}
export interface PlanningStartCommandDto extends RequestKeyDto { request: string; provider: string; model?: string; executionDefaults: ExecutionConfigDto; }
export interface PlanningReplyCommandDto extends RequestKeyDto { message: string; planner?: { mode?: string; model?: string }; }
export interface PlanningReviewCommandDto extends RequestKeyDto { reviewer?: { mode?: string; model?: string }; }
export interface PlanningApproveCommandDto extends RequestKeyDto { draftRevision: number; waivedFindingIds?: string[]; waiverReason?: string; }
export interface PlanningRunCommandDto extends RequestKeyDto {
  isolation: "git-worktree" | "shared"; maxParallel: number; verificationTaskId?: string;
  executionSelection?: ExecutionSelectionDto; expectedPlanHash?: string; expectedDraftRevision?: number;
}
export interface DraftTaskEditDto {
  taskId: string;
  fields: Partial<Pick<TaskDefinitionDto, "title" | "prompt" | "objective" | "approach" | "steps" | "deliverables" | "acceptanceCriteria" | "constraints" | "notes" | "execution">>;
}
export interface DraftEditsDto { title?: string; tasks?: DraftTaskEditDto[]; }
export type PlanningDraftSaveCommandDto = RequestKeyDto & { expectedDraftRevision: number; expectedPlanHash: string } &
  ({ edits: DraftEditsDto; plan?: never } | { plan: PlanDefinitionDto; edits?: never });
export interface PlanningReviseCommandDto extends RequestKeyDto {
  message: string; reviewId: string; expectedPlanHash: string; expectedDraftRevision: number; planner?: { mode?: string; model?: string };
}
export interface PlanningForkCommandDto extends RequestKeyDto { confirmed: true; expectedRevision: number; expectedPlanHash: string; message?: string; }
export interface PlanningHandoffCommandDto extends RequestKeyDto { role: "plan" | "review"; target: "chatgpt" | "claude" | "other" | "any"; reason?: string; }
export interface SessionModelChangeCommandDto extends RequestKeyDto {
  confirmed: true; stopAndRetry: boolean; taskId: string; modelId: string | null; expectedRevision: number; expectedAttemptId?: string;
}
export type InteractionReplyDto =
  | { kind: "approval"; decision: "allow-once" | "deny"; guidance?: string }
  | { kind: "question"; answers: Array<{ questionId: string; optionIds?: string[]; text?: string }>; guidance?: string }
  | { kind: "elicitation"; action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]>; guidance?: string };
export interface AddWorkspaceCommandDto { path: string; label?: string; }
export interface RenameWorkspaceCommandDto { label: string; }
export interface SettingsSaveCommandDto extends SettingsDto {}
export interface AttemptDiagnosisStartCommandDto extends RequestKeyDto { runnerId: "codex" | "claude-code"; modelId?: string; message?: string; }
export interface AttemptDiagnosisReplyCommandDto extends RequestKeyDto { message: string; runnerId?: "codex" | "claude-code"; modelId?: string; }
export interface AttemptEvidenceExportDto { absolutePath: string; evidenceHash: string; truncated: boolean; prompt: string; }
export interface ExternalBudgetExtendCommandDto { confirmed: true; }
export type NativePickerCommandDto = { kind: "directory"; workspaceId?: never } | { kind: "files"; workspaceId: string };
export interface NativePickerResultDto { cancelled: boolean; paths: string[]; }
export type RemoteScopeDto = "repository:read" | "planning:read" | "planning:write" | "session:read" | "session:control";
/** Redacted per-grant evidence; client names and local aliases are not authenticated webpage identities. */
export interface ConnectionCallDto {
  traceId: string; at: number; endpoint: string; stage: string; outcome: string;
  tool?: string; code?: string; clientId?: string; grantId?: string; authorizationKey?: string;
}
export interface McpConnectionReceiptDto {
  mcpUrl: string; buildId: string; clientFingerprint: string; traceId: string;
  alias?: string; aliasSource?: "local_user"; clientName: string; clientNameSource: "client_declared";
  usage: "web" | "diagnostic";
}
export interface RemoteClientStatusDto {
  grantId: string; clientId: string; clientFingerprint: string; name: string; clientName: string; alias?: string;
  nameSource: "local_alias" | "client_declared"; usage: "web" | "diagnostic";
  source: string; workspaceIds: string[]; mcpUrl: string; createdAt: number; expiresAt: number;
  status: "active" | "expired" | "revoked" | "address_changed";
  oauthState: "awaiting_token" | "token_issued";
  toolVerified: boolean; lastCall?: ConnectionCallDto; lastSuccess?: ConnectionCallDto;
}
export interface RemoteConnectionStatusDto {
  clients?: RemoteClientStatusDto[];
  gatewayTracing?: { enabled: true; lastRequestAt?: number; lastToolAt?: number };
  quickTunnel?: { available: boolean; reason?: string };
  configured: boolean; enabled: boolean; publicOrigin?: string; mcpUrl?: string; gateway: "stopped" | "running" | "error";
  gatewayAddress?: string; lastError?: string; pendingApprovals: number; validGrants: number; remoteClientVerified: boolean;
  pendingTokenExchanges?: number; mode?: "quick_tunnel" | "fixed_https"; transport?: string; busy?: boolean; workspaceId?: string; workspaceIds?: string[];
  scopes?: RemoteScopeDto[]; component?: { version: string; source: "existing" | "managed" }; connectionProcess?: { persistent: boolean; recovered: boolean };
  lastProbeAt?: number; nextProbeAt?: number; addressChanged?: boolean; previousMcpUrl?: string;
}
export type QuickConnectionCommandDto =
  | { consent: true; connectionOnly: true; scopes?: RemoteScopeDto[]; port?: number; workspaceId?: never; workspaceIds?: never }
  | { consent: true; workspaceId: string; workspaceIds?: string[]; scopes?: RemoteScopeDto[]; port?: number; connectionOnly?: never };
export interface ConfigureConnectionCommandDto { publicOrigin: string; port?: number; }
export interface RenameGrantCommandDto { alias: string; }
export interface UpdateGrantCommandDto { workspaceIds: string[]; source: "chatgpt" | "claude" | "other"; alias?: string; usage?: "web" | "diagnostic"; }
export interface DecideApprovalCommandDto {
  decision: "allow" | "deny"; workspaceId?: string; workspaceIds?: string[]; source?: "chatgpt" | "claude" | "other";
  scopes?: RemoteScopeDto[];
}
export interface GitStatusDto { state: string; message: string; repositoryRoot?: string; branch?: string; head?: string; trackedMetadataCount?: number; paths?: string[]; commands?: string[]; changes?: Array<{ path: string; code: string; staged: boolean; unstaged: boolean; runtime: boolean }>; }
export interface GitPreviewCommandDto { mode: "runtime" | "selected"; paths: string[]; }
export interface GitPreviewDto { mode: "runtime" | "selected"; paths: string[]; fingerprint: string; head: string; previews: Array<{ path: string; code: string; text: string; truncated: boolean }>; suggestedMessage: string; }
export interface GitCommitCommandDto extends RequestKeyDto { confirmed: true; mode: "runtime" | "selected"; paths: string[]; fingerprint: string; message: string; }
export interface GitIdentityCommandDto extends RequestKeyDto { confirmed: true; name: string; email: string; }

function pathId(value: string): string { return encodeURIComponent(value); }
async function readJson<T>(transport: ApiTransport, path: string): Promise<T> {
  const value = await transport.api<T>(path);
  if (value === null) throw new Error("daemon_response_empty：读取接口未返回 JSON 内容");
  return value;
}

/** Typed read facade; every operation delegates to the same versioned, no-replay transport. */
export function createDaemonApi(transport: ApiTransport) {
  return Object.freeze({
    health: () => readJson<DaemonHealthDto>(transport, "/api/v1/health"),
    planningProviders: () => readJson<PlanningProviderDto[]>(transport, "/api/v1/providers"),
    plannerModels: (refresh = false) => readJson<ModelCatalogDto>(transport, `/api/v1/providers/deepseek-api/models${refresh ? "?refresh=1" : ""}`),
    workspaces: () => readJson<WorkspaceDto[]>(transport, "/api/v1/workspaces"),
    plannings: (workspaceId: string) => readJson<PlanningViewDto[]>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/plannings`),
    planning: (workspaceId: string, planningId: string) => readJson<PlanningViewDto>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/plannings/${pathId(planningId)}`),
    planningEvents: (workspaceId: string, planningId: string) => readJson<{ events: DaemonEventDto[]; retainedWindow: boolean }>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/plannings/${pathId(planningId)}/events`),
    interactions: (workspaceId: string, planningId: string) => readJson<PendingInteractionDto[]>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/interactions/${pathId(planningId)}`),
    pendingQueue: (offset = 0) => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("pending_offset_invalid：分页位置无效");
      return readJson<PendingQueueDto>(transport, `/api/v1/pending?offset=${offset}`);
    },
    planningTodos: (cursor?: string) => readJson<PlanningTodoPageDto>(transport, `/api/v1/pending/plans${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    job: (jobId: string) => readJson<JobDto>(transport, `/api/v1/jobs/${pathId(jobId)}`),
    settings: () => readJson<SettingsDto>(transport, "/api/v1/settings"),
    remoteConnection: () => readJson<RemoteConnectionStatusDto>(transport, "/api/v1/remote-connection"),
    workspaceGit: (workspaceId: string) => readJson<GitStatusDto>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/git`),
    directories: (path?: string, offset = 0, query = "") => {
      const params = new URLSearchParams({ offset: String(offset), query }); if (path !== undefined) params.set("path", path);
      return readJson<{ path: string; parent: string | null; shortcuts: Array<{ label: string; path: string }>; query: string; totalMatches: number; entries: Array<{ name: string; path: string }>; nextOffset: number | null }>(transport, `/api/v1/directories?${params}`);
    },
    runners: () => readJson<RunnerOptionDto[]>(transport, "/api/v1/runners"),
    runnerModels: (runnerId: string, workspaceId?: string, refresh = false) => {
      const query = new URLSearchParams(); if (workspaceId) query.set("workspaceId", workspaceId); if (refresh) query.set("refresh", "1");
      return readJson<ModelCatalogDto>(transport, `/api/v1/runners/${pathId(runnerId)}/models${query.size ? `?${query}` : ""}`);
    },
    attemptEvents: (workspaceId: string, planningId: string, attemptId: string, offset = 0, fileId?: string) => {
      const query = new URLSearchParams({ offset: String(offset) }); if (fileId) query.set("fileId", fileId);
      return readJson<AttemptEventPageDto>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/plannings/${pathId(planningId)}/attempts/${pathId(attemptId)}/events?${query}`);
    },
    taskResults: (workspaceId: string, planningId: string, taskId: string, path?: string, offset = 0) => {
      const query = new URLSearchParams({ offset: String(offset) }); if (path !== undefined) query.set("path", path);
      return readJson<TaskResultsDto>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/plannings/${pathId(planningId)}/tasks/${pathId(taskId)}/files?${query}`);
    },
    sessionDiagnosis: (workspaceId: string, planningId: string) => readJson<SessionDiagnosisDto>(transport, `/api/v1/workspaces/${pathId(workspaceId)}/plannings/${pathId(planningId)}/session/diagnosis`),
  });
}
export type DaemonApi = ReturnType<typeof createDaemonApi>;

async function sendJson<T>(transport: ApiTransport, path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const value = await transport.api<T>(path, { method, body: JSON.stringify(body ?? {}) });
  if (value === null) throw new Error("daemon_response_empty：写入接口未返回 JSON 内容");
  return value;
}

/** Typed mutation facade. It deliberately delegates to the no-replay handshake-aware transport. */
export function createDaemonCommands(transport: ApiTransport) {
  const workspace = (id: string) => `/api/v1/workspaces/${pathId(id)}`;
  const planning = (workspaceId: string, planningId: string) => `${workspace(workspaceId)}/plannings/${pathId(planningId)}`;
  const postJob = <T extends RequestKeyDto>(path: string, body: T) => sendJson<JobDto>(transport, path, "POST", body);
  return Object.freeze({
    addWorkspace: (body: AddWorkspaceCommandDto) => sendJson<WorkspaceDto>(transport, "/api/v1/workspaces", "POST", body),
    renameWorkspace: (workspaceId: string, body: RenameWorkspaceCommandDto) => sendJson<WorkspaceDto>(transport, workspace(workspaceId), "PATCH", body),
    removeWorkspace: (workspaceId: string) => sendJson<{ removed: true }>(transport, workspace(workspaceId), "DELETE"),
    saveSettings: (body: SettingsSaveCommandDto) => sendJson<SettingsDto>(transport, "/api/v1/settings", "POST", body),
    startPlanning: (workspaceId: string, body: PlanningStartCommandDto) => postJob(`${workspace(workspaceId)}/plannings`, body),
    replyToPlanning: (workspaceId: string, planningId: string, body: PlanningReplyCommandDto) => postJob(`${planning(workspaceId, planningId)}/replies`, body),
    reviewPlanning: (workspaceId: string, planningId: string, body: PlanningReviewCommandDto) => postJob(`${planning(workspaceId, planningId)}/review`, body),
    retryPlanning: (workspaceId: string, planningId: string, body: RequestKeyDto) => postJob(`${planning(workspaceId, planningId)}/planner-retry`, body),
    approvePlanning: (workspaceId: string, planningId: string, body: PlanningApproveCommandDto) => postJob(`${planning(workspaceId, planningId)}/approve`, body),
    runPlanning: (workspaceId: string, planningId: string, body: PlanningRunCommandDto) => postJob(`${planning(workspaceId, planningId)}/run`, body),
    saveDraft: (workspaceId: string, planningId: string, body: PlanningDraftSaveCommandDto) => postJob(`${planning(workspaceId, planningId)}/draft`, body),
    revisePlanning: (workspaceId: string, planningId: string, body: PlanningReviseCommandDto) => postJob(`${planning(workspaceId, planningId)}/revise`, body),
    forkPlanning: (workspaceId: string, planningId: string, body: PlanningForkCommandDto) => postJob(`${planning(workspaceId, planningId)}/fork`, body),
    handoffPlanning: (workspaceId: string, planningId: string, body: PlanningHandoffCommandDto) => postJob(`${planning(workspaceId, planningId)}/handoff`, body),
    continueWebPlanning: (workspaceId: string, planningId: string, body: RequestKeyDto) => postJob(`${planning(workspaceId, planningId)}/web-continue`, body),
    retryTask: (workspaceId: string, planningId: string, body: RequestKeyDto & { taskId: string }) => postJob(`${planning(workspaceId, planningId)}/retry-task`, body),
    resumeSession: (workspaceId: string, planningId: string, body: RequestKeyDto) => postJob(`${planning(workspaceId, planningId)}/session/resume`, body),
    pauseSession: (workspaceId: string, planningId: string, body: RequestKeyDto) => postJob(`${planning(workspaceId, planningId)}/session/pause`, body),
    cancelSession: (workspaceId: string, planningId: string, body: RequestKeyDto) => postJob(`${planning(workspaceId, planningId)}/session/cancel`, body),
    recoverSession: (workspaceId: string, planningId: string, body: RequestKeyDto & { confirmedStopped: boolean }) => postJob(`${planning(workspaceId, planningId)}/session/recover`, body),
    changeTaskModel: (workspaceId: string, planningId: string, body: SessionModelChangeCommandDto) => postJob(`${planning(workspaceId, planningId)}/session/models`, body),
    deliverSession: (workspaceId: string, planningId: string, body: RequestKeyDto) => postJob(`${planning(workspaceId, planningId)}/session/delivery`, body),
    answerInteraction: (workspaceId: string, requestId: string, body: InteractionReplyDto) => sendJson<{ accepted: true }>(transport, `${workspace(workspaceId)}/interactions/${pathId(requestId)}`, "POST", body),
    analyzeAttempt: (workspaceId: string, planningId: string, attemptId: string, body: AttemptDiagnosisStartCommandDto) => postJob(`${planning(workspaceId, planningId)}/attempts/${pathId(attemptId)}/diagnostics`, body),
    replyToAttemptDiagnosis: (workspaceId: string, planningId: string, attemptId: string, diagnosticId: string, body: AttemptDiagnosisReplyCommandDto) => postJob(`${workspace(workspaceId)}/plannings/${pathId(planningId)}/attempts/${pathId(attemptId)}/diagnostics/${pathId(diagnosticId)}/replies`, body),
    exportAttemptEvidence: (workspaceId: string, planningId: string, attemptId: string) => sendJson<AttemptEvidenceExportDto>(transport, `${workspace(workspaceId)}/plannings/${pathId(planningId)}/attempts/${pathId(attemptId)}/diagnostics/export`, "POST"),
    chooseNativePath: (body: NativePickerCommandDto) => sendJson<NativePickerResultDto>(transport, "/api/v1/native-picker", "POST", body),
    cancelJob: (jobId: string, workspaceId: string) => sendJson<JobDto>(transport, `/api/v1/jobs/${pathId(jobId)}/cancel`, "POST", { workspaceId }),
    configureRemoteConnection: (body: ConfigureConnectionCommandDto) => sendJson<RemoteConnectionStatusDto>(transport, "/api/v1/remote-connection", "POST", body),
    startQuickConnection: (body: QuickConnectionCommandDto) => sendJson<RemoteConnectionStatusDto>(transport, "/api/v1/remote-connection/quick", "POST", body),
    testRemoteConnection: () => sendJson<RemoteConnectionStatusDto>(transport, "/api/v1/remote-connection/test", "POST"),
    stopRemoteConnection: () => sendJson<RemoteConnectionStatusDto>(transport, "/api/v1/remote-connection/stop", "POST"),
    renameGrant: (grantId: string, body: RenameGrantCommandDto) => sendJson<{ updated: true }>(transport, `/api/v1/remote-connection/grants/${pathId(grantId)}/name`, "POST", body),
    updateGrant: (grantId: string, body: UpdateGrantCommandDto) => sendJson<{ updated: true }>(transport, `/api/v1/remote-connection/grants/${pathId(grantId)}`, "POST", body),
    revokeGrant: (grantId: string) => sendJson<{ revoked: true }>(transport, `/api/v1/remote-connection/grants/${pathId(grantId)}/revoke`, "POST"),
    decideApproval: (requestId: string, body: DecideApprovalCommandDto) => sendJson<{ accepted: true }>(transport, `/api/v1/remote-connection/approvals/${pathId(requestId)}`, "POST", body),
    extendExternalReadBudget: (workspaceId: string, operationId: string, body: ExternalBudgetExtendCommandDto) => sendJson<Record<string, unknown>>(transport, `${workspace(workspaceId)}/external/${pathId(operationId)}/budget`, "POST", body),
    reconcileExternalOperation: (workspaceId: string, operationId: string) => sendJson<Record<string, unknown>>(transport, `${workspace(workspaceId)}/external/${pathId(operationId)}/reconcile`, "POST"),
    cancelExternalOperation: (workspaceId: string, operationId: string) => sendJson<Record<string, unknown>>(transport, `${workspace(workspaceId)}/external/${pathId(operationId)}/cancel`, "POST"),
    prepareGit: (workspaceId: string, body: RequestKeyDto & { confirmed: true; action: string }) => postJob(`${workspace(workspaceId)}/git`, body),
    previewGitCommit: (workspaceId: string, body: GitPreviewCommandDto) => sendJson<GitPreviewDto>(transport, `${workspace(workspaceId)}/git/preview`, "POST", body),
    commitGit: (workspaceId: string, body: GitCommitCommandDto) => postJob(`${workspace(workspaceId)}/git/commit`, body),
    setGitIdentity: (workspaceId: string, body: GitIdentityCommandDto) => postJob(`${workspace(workspaceId)}/git/identity`, body),
  });
}
export type DaemonCommands = ReturnType<typeof createDaemonCommands>;

export interface DaemonHealthDto {
  status: "ok"; epoch: string; instanceId: string; applicationVersion: string; buildId: string; protocol: { major: number; minor: number };
  profile: { id: string; kind: "native" | "wsl"; platform: string };
  capabilities: Record<string, number>; phase: string; host: string;
  workspaceEnvironment: { currentDirectory: string; platform: string; isWsl: boolean; home: string; distro?: string };
  nativePicker: Record<string, unknown>;
  mcp: { url: string; transport: string; localReady: boolean; chatgptVerified: boolean; tokenFile: string };
}
