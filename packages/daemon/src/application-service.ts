import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeWorkspacePath, workspaceEnvironment } from "./workspace-path.js";
import { workspaceGitStatus, prepareWorkspaceGit, previewGitCommit, commitWorkspaceGit, type GitCommitInput } from "./workspace-tools.js";
import { readAttemptInfo, readAttemptEvents } from "./attempt-observation.js";
import { readTaskResults } from "./task-results.js";
import { observeSession } from "./session-observation.js";
import { ExternalPlanningService } from "./external-planning.js";
import { ModelCatalog, discoverPlannerModels, type ModelCatalogResult } from "./model-catalog.js";
import { planningWorkflow } from "./planning-workflow.js";
import {
  PlannerStore, SessionStore, ReviewStore, approvePlannerDraft, createDefaultRunnerRegistry, createPlanReviewer, validateVerificationTask, ensureRuntimeMetadataIgnored,
  loadPlannerConversation, replyToPlanner, reviewPlannerDraft, runApprovedPlanner, startPlannerConversation, replacePlannerDraft, revisePlannerDraft,
  retryPlannerTurn, resumeSession, retrySession, diagnoseSession, recoverSession, readSessionModels, updateSessionModel, createSessionDelivery, formatSessionDelivery,
} from "@token-coupon/core";
import type {
  ExecutionConfig, PlanReviewRecord, RunnerInteractionOwner, RunnerInteractionReply, RunnerInteractionRequest,
  RunnerOutput, TaskDefinition, TaskRunnerFactory, TaskRunnerFactoryOptions,
} from "@token-coupon/core";

export interface WorkspaceEntry { workspaceId: string; path: string; label: string; addedAt: string; }
export interface JobRecord {
  jobId: string; workspaceId: string; kind: string; requestKey: string; requestHash: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted"; createdAt: string; updatedAt: string;
  result?: unknown; error?: string;
}
export interface PendingInteraction {
  requestId: string; workspaceId: string; planningId: string; owner: RunnerInteractionOwner;
  request: RunnerInteractionRequest; createdAt: string;
}
export interface DaemonEvent { epoch: string; sequence: number; type: string; workspaceId?: string; planningId?: string; sessionId?: string; taskId?: string; payload?: unknown; createdAt: string; }

interface ServiceOptions { dataDirectory?: string; createRunner?: TaskRunnerFactory; }

/** Owns background operations and adapts existing core services for local clients. */
export class ApplicationService {
  readonly epoch = randomUUID();
  readonly external: ExternalPlanningService;
  private readonly dataDirectory: string;
  private readonly workspacesPath: string;
  private readonly jobsDirectory: string;
  private readonly eventsPath: string;
  private readonly eventTail: DaemonEvent[] = [];
  private readonly subscribers = new Set<(event: DaemonEvent) => void>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobControllers = new Map<string, AbortController>();
  private readonly workers = new Set<Promise<void>>();
  private readonly taskControllers = new Map<string, { controller: AbortController; parent: AbortSignal }>();
  private readonly runnerFactory: TaskRunnerFactory;
  private readonly pendingInteractions = new Map<string, { value: PendingInteraction; resolve(reply: RunnerInteractionReply): void; signal: AbortSignal }>();
  private workspaces = new Map<string, WorkspaceEntry>();
  private eventSequence = 0;
  private readonly modelCatalog = new ModelCatalog();
  private plannerModelsCache: { expires: number; result: Promise<ModelCatalogResult> } | undefined;

  constructor(options: ServiceOptions = {}) {
    this.runnerFactory = options.createRunner ?? daemonRunnerFactory;
    this.dataDirectory = resolve(options.dataDirectory ?? process.env.TOKEN_COUPON_DAEMON_HOME ?? join(homedir(), ".token-coupon", "daemon"));
    this.workspacesPath = join(this.dataDirectory, "workspaces.json");
    this.jobsDirectory = join(this.dataDirectory, "jobs");
    this.eventsPath = join(this.dataDirectory, "events.jsonl");
    this.external = new ExternalPlanningService(this, this.dataDirectory);
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 });
    await this.external.initialize();
    try {
      const parsed = JSON.parse(await readFile(this.workspacesPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) this.workspaces = new Map(parsed.filter(isWorkspaceEntry).map((item) => [item.workspaceId, item]));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of await readdir(this.jobsDirectory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      try {
        const path = join(this.jobsDirectory, name);
        const job = JSON.parse(await readFile(path, "utf8")) as JobRecord;
        if (job.status === "running") {
          const interrupted = { ...job, status: "interrupted" as const, error: "daemon_restarted：服务重启后不会自动重放操作", updatedAt: new Date().toISOString() };
          await this.saveJob(interrupted);
          this.jobs.set(interrupted.jobId, interrupted);
        } else this.jobs.set(job.jobId, job);
      } catch { /* Keep the daemon available when one local operation record is damaged. */ }
    }
    try {
      const text = await readFile(this.eventsPath, "utf8");
      const lines = text.trimEnd().split("\n").filter(Boolean).slice(-1000);
      for (const line of lines) {
        const event = JSON.parse(line) as DaemonEvent;
        this.eventTail.push(event);
        this.eventSequence = Math.max(this.eventSequence, event.sequence);
      }
    } catch { /* An absent event stream is a normal first start. */ }
  }

  listWorkspaces(): WorkspaceEntry[] { return [...this.workspaces.values()].sort((a, b) => a.label.localeCompare(b.label)); }

  workspaceEnvironment() { return workspaceEnvironment(); }

  async addWorkspace(pathValue: string, labelValue?: string): Promise<WorkspaceEntry> {
    const normalizedPath = await normalizeWorkspacePath(pathValue);
    let path: string;
    try { path = await realpath(normalizedPath); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`workspace_path_invalid：目录不存在或在后台不可见：${normalizedPath}；Windows 盘符请检查是否已挂载到 WSL`);
      if (code === "EACCES" || code === "EPERM") throw new Error(`workspace_path_invalid：后台无权访问目录：${normalizedPath}`);
      throw error;
    }
    if (!(await stat(path)).isDirectory()) throw new Error("workspace_path_invalid：所选路径不是目录");
    await ensureRuntimeMetadataIgnored(path);
    const workspaceId = createHash("sha256").update(path).digest("hex").slice(0, 16);
    const label = (labelValue?.trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || path).slice(0, 80);
    const entry = { workspaceId, path, label, addedAt: this.workspaces.get(workspaceId)?.addedAt ?? new Date().toISOString() };
    this.workspaces.set(workspaceId, entry);
    await this.writeAtomic(this.workspacesPath, JSON.stringify(this.listWorkspaces(), null, 2) + "\n");
    await this.publish({ type: "workspace.registered", workspaceId, payload: { label } });
    return entry;
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    if (!this.workspaces.delete(workspaceId)) throw new Error("workspace_not_found：项目不存在");
    await this.writeAtomic(this.workspacesPath, JSON.stringify(this.listWorkspaces(), null, 2) + "\n");
  }

  async gitStatus(workspaceId: string) {
    const workspace = await this.getWorkspace(workspaceId);
    return workspaceGitStatus(workspace.path);
  }

  async gitPreview(workspaceId: string, mode: string, paths: string[]) {
    return JSON.parse(sanitizeOutput(JSON.stringify(await previewGitCommit((await this.getWorkspace(workspaceId)).path, mode, paths))));
  }

  async gitCommit(workspaceId: string, requestKey: string, input: GitCommitInput) {
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, "workspace.git.commit", requestKey, input, async () => {
      if ([...this.jobs.values()].some(job => job.workspaceId === workspaceId && job.status === "running" && job.requestKey !== requestKey)) throw new Error("workspace_busy：请等待此项目正在进行的操作完成");
      const release = await new SessionStore(workspace.path).acquireLock();
      try { return await commitWorkspaceGit(workspace.path, input); } finally { await release(); }
    });
  }

  async gitIdentity(workspaceId: string, requestKey: string, name: string, email: string) {
    if (!name.trim() || !email.trim() || /[\r\n\0]/.test(name + email)) throw new Error("git_identity_invalid");
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, "workspace.git.identity", requestKey, { name, email }, async () => {
      if ([...this.jobs.values()].some(job => job.workspaceId === workspaceId && job.status === "running" && job.requestKey !== requestKey)) throw new Error("workspace_busy");
      const release = await new SessionStore(workspace.path).acquireLock();
      try {
        const { runGit } = await import("@token-coupon/core");
        if (await realpath((await runGit(workspace.path, ["rev-parse", "--show-toplevel"])).stdout.trim()) !== workspace.path) throw new Error("git_root_required");
        await runGit(workspace.path, ["config", "--local", "user.name", name]);
        await runGit(workspace.path, ["config", "--local", "user.email", email]);
        return workspaceGitStatus(workspace.path);
      } finally { await release(); }
    });
  }

  async attemptEvents(workspaceId: string, planningId: string, attemptId: string, offset: number, fileId?: string) {
    const workspace = await this.getWorkspace(workspaceId);
    const snapshot = await new PlannerStore(workspace.path).load(planningId);
    if (!snapshot.execution) throw new Error("session_not_found");
    const record = await new SessionStore(workspace.path).load(snapshot.execution.sessionId);
    const task = record.snapshot.tasks.find(item => item.attempts.some(attempt => attempt.attemptId === attemptId));
    if (!task) throw new Error("attempt_not_found：此 Attempt 不属于当前计划");
    const page = await readAttemptEvents(workspace.path, attemptId, offset, fileId);
    const attempt = await readAttemptInfo(workspace.path, attemptId);
    const observation = await observeSession(workspace.path, record.snapshot);
    const observedStatus = task.activeAttemptId === attemptId ? observation.tasks.get(task.taskId) : undefined;
    return JSON.parse(sanitizeOutput(JSON.stringify({ ...page, attempt: { ...attempt, ...(observedStatus && ["created", "running"].includes(attempt.status) ? { savedStatus: attempt.status, status: observedStatus, reason: observation.health.message } : {}) }, taskId: task.taskId, sessionId: record.snapshot.sessionId })));
  }

  async taskResults(workspaceId: string, planningId: string, taskId: string, path?: string, offset = 0) {
    const workspace = await this.getWorkspace(workspaceId);
    const snapshot = await new PlannerStore(workspace.path).load(planningId);
    if (!snapshot.execution) throw new Error("session_not_found：此计划尚未执行");
    return readTaskResults(workspace.path, snapshot.execution.sessionId, taskId, path, offset);
  }

  async prepareGit(workspaceId: string, requestKey: string, action: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, "workspace.git.prepare", requestKey, { action }, async () => {
      if ([...this.jobs.values()].some(job => job.workspaceId === workspaceId && job.status === "running" && job.requestKey !== requestKey)) throw new Error("workspace_busy：此项目有正在运行的操作，请完成或停止后准备 Git");
      const release = await new SessionStore(workspace.path).acquireLock();
      try { return await prepareWorkspaceGit(workspace.path, action); }
      finally { await release(); }
    });
  }

  async runnerOptions(): Promise<unknown[]> {
    const registry = createDefaultRunnerRegistry();
    return Promise.all(registry.list().map(async (runner) => {
      const task: TaskDefinition = { schemaVersion: 1, id: "runner-check", title: "Runner availability check", prompt: "Check availability only.", execution: { runnerId: runner.id, mode: "managed" } };
      try {
        await registry.resolve(task).runner.checkAvailable();
        return { ...runner, available: true, defaultMode: "managed", modelOptions: [] };
      } catch (error) {
        return { ...runner, available: runner.id === "mock", error: safeError(error), defaultMode: "managed", modelOptions: [] };
      }
    }));
  }

  async runnerModels(runnerId: string, workspaceId?: string, refresh = false): Promise<ModelCatalogResult> {
    const cwd = workspaceId ? (await this.getWorkspace(workspaceId)).path : process.cwd();
    return this.modelCatalog.runner(runnerId, cwd, refresh);
  }

  plannerModels(refresh = false): Promise<ModelCatalogResult> {
    if (!refresh && this.plannerModelsCache && this.plannerModelsCache.expires > Date.now()) return this.plannerModelsCache.result;
    const result = discoverPlannerModels();
    this.plannerModelsCache = { expires: Date.now() + 60_000, result }; return result;
  }

  providerOptions(): unknown[] {
    return [
      { id: "web-mcp", label: "ChatGPT 网页 · MCP 交接", available: true, modelOptions: [], remoteClientVerified: false },
      { id: "claude-mcp", label: "Claude 网页 · MCP 交接", available: true, modelOptions: [], remoteClientVerified: false },
      { id: "chatgpt-mcp", label: "ChatGPT + MCP", available: true, connectionVerified: false, reason: "本地 MCP 已提供；规划/审查在 ChatGPT 中调用，账号连接需实际配置验证", capabilities: { plan: "external_submission", review: "external_submission", stream: "unsupported", cancel: "local_operation", usage: "unknown" } },
      { id: "chatgpt-web", label: "ChatGPT 网页", available: false, reason: "browser_bridge_not_connected：需要安装并连接浏览器桥接扩展；当前 WSL 环境没有可用浏览器会话", capabilities: { plan: "unverified", review: "unverified", stream: "unverified", cancel: "unverified", usage: "unverified" } },
      { id: "deepseek-api", label: "DeepSeek API（现有入口）", available: Boolean(process.env.TOKEN_COUPON_PLANNER_API_KEY), model: process.env.TOKEN_COUPON_PLANNER_MODEL ?? "deepseek-flash", capabilities: { plan: "supported", review: "supported", stream: "unsupported", cancel: "supported", usage: "reported" } },
      { id: "mock", label: "离线模拟（仅演示）", available: true, model: "mock", capabilities: { plan: "supported", review: "supported", stream: "unsupported", cancel: "supported", usage: "unsupported" } },
    ];
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceEntry> {
    const value = this.workspaces.get(workspaceId);
    if (!value) throw new Error("workspace_not_found：项目尚未登记");
    const actual = await realpath(value.path).catch(() => "");
    if (!actual || actual !== value.path) throw new Error("workspace_unavailable：项目目录已移动或不可访问");
    return value;
  }

  async listPlannings(workspaceId: string): Promise<unknown[]> {
    const workspace = await this.getWorkspace(workspaceId);
    const snapshots = await new PlannerStore(workspace.path).list();
    return Promise.all(snapshots.map((snapshot) => this.planningView(workspace, snapshot.planningId)));
  }

  async planningView(workspace: WorkspaceEntry, planningId: string): Promise<unknown> {
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    let session: unknown;
    if (loaded.snapshot.execution) {
      try {
        const record = await new SessionStore(workspace.path).load(loaded.snapshot.execution.sessionId);
        const observation = await observeSession(workspace.path, record.snapshot);
        session = { ...record.snapshot, models: await readSessionModels(workspace.path, record.snapshot.sessionId), savedStatus: record.snapshot.status, status: observation.status, health: observation.health, tasks: await Promise.all(record.snapshot.tasks.map(async task => {
          const latestId = task.activeAttemptId ?? task.attempts.at(-1)?.attemptId;
          const currentAttempt = latestId ? await readAttemptInfo(workspace.path, latestId).catch(() => null) : null;
          const definition = record.plan.tasks.find(entry => entry.task.id === task.taskId);
          const status = observation.tasks.get(task.taskId) ?? task.status;
          return { ...task, savedStatus: task.status, status, title: definition?.task.title, dependsOn: definition?.dependsOn, execution: definition?.task.execution,
            currentAttempt: currentAttempt && status !== task.status && ["created", "running"].includes(currentAttempt.status) ? { ...currentAttempt, savedStatus: currentAttempt.status, status, reason: observation.health.message } : currentAttempt };
        })) };
        session = JSON.parse(sanitizeOutput(JSON.stringify(session)));
      }
      catch (error) { session = { status: "unavailable", error: safeError(error) }; }
    }
    const review = loaded.review ? { reviewId: loaded.review.reviewId, draftRevision: loaded.review.draftRevision, status: loaded.review.status, summary: loaded.review.summary,
      findings: loaded.review.findings, resolutions: loaded.review.resolutions, current: !!loaded.reviewIsCurrent } : undefined;
    const handoffs = await this.external.queryHandoffs(workspace.workspaceId, planningId);
    const externalOperations = await this.external.list(workspace.workspaceId, planningId);
    const history = (await new ReviewStore(workspace.path).list(planningId)).filter(item => item.status === "succeeded" && item.reviewId !== review?.reviewId).slice(-3)
      .map(item => ({ reviewId: item.reviewId, draftRevision: item.draftRevision, summary: item.summary, findings: item.findings, current: false }));
    const approvalHistory = [...this.jobs.values()].filter(job => job.workspaceId === workspace.workspaceId && job.kind === "planning.approve" && job.status === "succeeded" && (job.result as { planningId?: string } | undefined)?.planningId === planningId)
      .slice(-3).map(job => ({ ...(job.result as { draftRevision: number }), recordedAt: job.updatedAt, historical: true }));
    const workflow = planningWorkflow({ revision: loaded.snapshot.revision, status: loaded.snapshot.status,
      ...(loaded.draft ? { draft: loaded.draft } : {}), approval: loaded.snapshot.approval,
      ...(review ? { review } : {}), ...(loaded.reviewReadError ? { reviewReadError: loaded.reviewReadError } : {}),
      ...(session ? { session: session as { status: string } } : {}), interactions: this.listInteractions(workspace.workspaceId, planningId),
      handoffs: handoffs as Parameters<typeof planningWorkflow>[0]["handoffs"], externalOperations: externalOperations as Parameters<typeof planningWorkflow>[0]["externalOperations"] });
    return {
      planningId: loaded.snapshot.planningId, status: loaded.snapshot.status, revision: loaded.snapshot.revision,
      workspace: { workspaceId: workspace.workspaceId, label: workspace.label },
      config: { provider: loaded.snapshot.config.provider, model: loaded.snapshot.config.model },
      executionDefaults: loaded.snapshot.executionDefaults, planningAssessment: loaded.snapshot.planningAssessment,
      requirements: loaded.snapshot.requirements, confirmationState: loaded.snapshot.confirmationState,
      messages: loaded.snapshot.messages.slice(-40), turns: loaded.snapshot.turns.slice(-20),
      draft: loaded.draft, draftChanged: loaded.draft ? loaded.draft.draftRevision : null,
      verificationTasks: loaded.draft?.plan.tasks.map(entry => {
        try { validateVerificationTask(loaded.draft!.plan, entry.task.id); return { taskId: entry.task.id, title: entry.task.title, valid: true }; }
        catch (error) { return { taskId: entry.task.id, title: entry.task.title, valid: false, reason: safeError(error) }; }
      }) ?? [],
      review, reviewReadError: loaded.reviewReadError, reviewHistory: history, approval: loaded.snapshot.approval, approvalHistory, workflow, execution: loaded.snapshot.execution, session,
      interactions: this.listInteractions(workspace.workspaceId, loaded.snapshot.planningId),
      title: loaded.draft?.plan.title ?? loaded.snapshot.messages.find((item) => item.role === "user")?.content.slice(0, 80),
      handoffs, externalOperations,
    };
  }

  listInteractions(workspaceId: string, planningId?: string): PendingInteraction[] {
    return [...this.pendingInteractions.values()].map(({ value }) => value)
      .filter((item) => item.workspaceId === workspaceId && (!planningId || item.planningId === planningId));
  }

  async submit(workspaceId: string, kind: string, requestKey: string, payload: unknown, action: (signal: AbortSignal) => Promise<unknown>): Promise<JobRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(requestKey)) throw new Error("idempotency_key_invalid：请为每次操作提供 UUID requestKey");
    const workspace = await this.getWorkspace(workspaceId);
    const requestHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const keyHash = createHash("sha256").update(`${workspaceId}:${requestKey}`).digest("hex");
    const idempotencyPath = join(this.dataDirectory, "idempotency", `${keyHash}.json`);
    try {
      const existing = JSON.parse(await readFile(idempotencyPath, "utf8")) as { jobId: string; requestHash: string };
      if (existing.requestHash !== requestHash) throw new Error("idempotency_conflict：相同 requestKey 已用于不同请求");
      const prior = this.jobs.get(existing.jobId) ?? JSON.parse(await readFile(join(this.jobsDirectory, `${existing.jobId}.json`), "utf8")) as JobRecord;
      return prior;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    const job: JobRecord = { jobId: randomUUID(), workspaceId, kind, requestKey, requestHash, status: "running", createdAt: now, updatedAt: now };
    await mkdir(dirname(idempotencyPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(idempotencyPath, JSON.stringify({ jobId: job.jobId, requestHash }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(idempotencyPath, "utf8")) as { jobId: string; requestHash: string };
      if (existing.requestHash !== requestHash) throw new Error("idempotency_conflict：同一个 requestKey 已用于不同请求");
      const concurrent = this.jobs.get(existing.jobId);
      if (concurrent) return concurrent;
      throw new Error("idempotency_in_progress：相同请求正在另一个请求处理中，请稍后查询");
    }
    this.jobs.set(job.jobId, job);
    await this.saveJob(job);
    await this.publish({ type: "job.started", workspaceId, payload: { jobId: job.jobId, kind } });
    const controller = new AbortController();
    this.jobControllers.set(job.jobId, controller);
    const worker = action(controller.signal).then(async (result) => {
      const done: JobRecord = { ...job, status: "succeeded", result: compactResult(result), updatedAt: new Date().toISOString() };
      await this.saveJob(done); this.jobs.set(job.jobId, done);
      await this.publish({ type: "job.succeeded", workspaceId, payload: { jobId: job.jobId, kind } }).catch(() => undefined);
    }).catch(async (error: unknown) => {
      const failed: JobRecord = { ...job, status: controller.signal.aborted ? "cancelled" : "failed", error: safeError(error), updatedAt: new Date().toISOString() };
      await this.saveJob(failed); this.jobs.set(job.jobId, failed);
      await this.publish({ type: controller.signal.aborted ? "job.cancelled" : "job.failed", workspaceId, payload: { jobId: job.jobId, kind, error: failed.error } }).catch(() => undefined);
    }).catch((error: unknown) => {
      this.jobs.set(job.jobId, { ...job, status: "interrupted", error: `job_persistence_failed：${safeError(error)}；请核对领域记录，不能确认操作失败后就重放`, updatedAt: new Date().toISOString() });
    }).finally(() => { this.jobControllers.delete(job.jobId); this.workers.delete(worker); for (const [id, task] of this.taskControllers) if (task.parent === controller.signal) this.taskControllers.delete(id); });
    this.workers.add(worker);
    return job;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.jobControllers.values()) controller.abort(new Error("daemon 正在停止，请保存诊断后恢复"));
    await Promise.allSettled([...this.workers]);
  }

  async getJob(jobId: string): Promise<JobRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("job_not_found：操作 ID 无效");
    const value = this.jobs.get(jobId);
    if (value) return value;
    const path = join(this.jobsDirectory, `${jobId}.json`);
    return JSON.parse(await readFile(path, "utf8")) as JobRecord;
  }

  async cancelJob(jobId: string, workspaceId: string): Promise<JobRecord> {
    const job = await this.getJob(jobId);
    if (job.workspaceId !== workspaceId) throw new Error("job_not_found：操作不属于当前项目");
    if (job.status !== "running") return job;
    const controller = this.jobControllers.get(jobId);
    if (!controller) throw new Error("job_owner_unavailable：当前服务未持有此操作，需查看工作区状态后恢复");
    controller.abort(new Error("由用户在控制台取消"));
    await this.publish({ type: "job.cancel_requested", workspaceId, payload: { jobId, kind: job.kind } });
    return job;
  }

  async startPlanning(workspaceId: string, requestKey: string, input: { request: string; provider: string; model?: string; executionDefaults: ExecutionConfig }): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    if (["chatgpt-mcp", "web-mcp", "claude-mcp"].includes(input.provider)) return this.external.prepare(workspaceId, requestKey, { role: "plan", message: input.request, coordinated: input.provider !== "chatgpt-mcp", target: input.provider === "claude-mcp" ? "claude" : "chatgpt", ...(input.model ? { model: input.model } : {}), executionDefaults: input.executionDefaults });
    if (input.provider === "chatgpt-web") throw new Error("browser_bridge_not_connected：ChatGPT 网页调用未通过真实浏览器验证，目前没有发送请求");
    const config = plannerConfig(input.provider, input.model);
    return this.submit(workspaceId, "planning.start", requestKey, input, async (signal) => {
      const result = await startPlannerConversation({ workspace: workspace.path, request: input.request, config, executionDefaults: input.executionDefaults, signal });
      await this.publish({ type: "planning.updated", workspaceId, planningId: result.snapshot.planningId, payload: { status: result.snapshot.status } });
      return { planningId: result.snapshot.planningId, status: result.snapshot.status };
    });
  }

  async reply(workspaceId: string, planningId: string, requestKey: string, message: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const snapshot = await new PlannerStore(workspace.path).load(planningId);
    if (["chatgpt-mcp", "web-mcp"].includes(snapshot.config.provider)) return this.external.prepare(workspaceId, requestKey, { role: "plan", planningId, message });
    return this.submit(workspaceId, "planning.reply", requestKey, { planningId, message }, async (signal) => {
      const result = await replyToPlanner({ planningId, workspace: workspace.path, message, signal });
      await this.publish({ type: "planning.updated", workspaceId, planningId, payload: { status: result.snapshot.status } });
      return { planningId, status: result.snapshot.status };
    });
  }

  async review(workspaceId: string, planningId: string, requestKey: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    if (["chatgpt-mcp", "web-mcp"].includes(loaded.snapshot.config.provider)) return this.external.prepare(workspaceId, requestKey, { role: "review", planningId });
    return this.submit(workspaceId, "planning.review", requestKey, { planningId, draftRevision: loaded.draft?.draftRevision, hash: loaded.draft?.planHash }, async (signal) => {
      const result = await reviewPlannerDraft({ planningId, workspace: workspace.path, reviewer: createPlanReviewer(loaded.snapshot.config), signal });
      await this.publish({ type: "review.completed", workspaceId, planningId, payload: { reviewId: result.review.reviewId, findings: result.review.findings.length } });
      return { planningId, reviewId: result.review.reviewId, findings: result.review.findings.length };
    });
  }

  async approve(workspaceId: string, planningId: string, requestKey: string, draftRevision: number, waivedFindingIds: string[] = [], waiverReason?: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, "planning.approve", requestKey, { planningId, draftRevision, waivedFindingIds, waiverReason }, async (signal) => {
      await this.assertNoPendingPlanning(workspaceId, planningId);
      const result = await approvePlannerDraft({ planningId, workspace: workspace.path, draftRevision, waivedFindingIds, ...(waiverReason ? { waiverReason } : {}), signal });
      await this.publish({ type: "planning.approved", workspaceId, planningId, payload: { draftRevision } });
      return { planningId, status: result.snapshot.status, draftRevision };
    });
  }

  async run(workspaceId: string, planningId: string, requestKey: string, input: { isolation: "git-worktree" | "shared"; maxParallel: number; verificationTaskId?: string }): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, "planning.run", requestKey, { planningId, ...input }, async (signal) => {
      await this.assertNoPendingPlanning(workspaceId, planningId);
      const result = await runApprovedPlanner({
        planningId, workspace: workspace.path, createRunner: this.runnerFactory, signal,
        taskSignal: (_taskId, attemptId) => this.ownedTaskSignal(attemptId, signal),
        ...(input.isolation === "git-worktree" ? { isolation: "git-worktree" as const, verificationTaskId: input.verificationTaskId } : {}),
        maxParallel: input.maxParallel,
        onOutput: (taskId, output, attemptId) => { void this.publish({ type: "runner.output", workspaceId, planningId, taskId, payload: { attemptId, stream: output.stream, text: sanitizeOutput(output.displayText ?? output.agentText ?? output.text).slice(0, 4096) } }); },
        onInteraction: (requestId, request, owner, signal) => this.waitForInteraction(workspaceId, planningId, requestId, request, owner, signal),
        onIdleState: (taskId, state) => { void this.publish({ type: "task.activity", workspaceId, planningId, taskId, payload: state }); },
      });
      await this.publish({ type: "execution.completed", workspaceId, planningId, ...(result.snapshot.execution?.sessionId ? { sessionId: result.snapshot.execution.sessionId } : {}), payload: { status: result.sessionStatus } });
      return { planningId, ...(result.snapshot.execution?.sessionId ? { sessionId: result.snapshot.execution.sessionId } : {}), status: result.sessionStatus };
    });
  }

  private async assertNoPendingPlanning(workspaceId: string, planningId: string): Promise<void> {
    const workspace = await this.getWorkspace(workspaceId);
    const snapshot = await new PlannerStore(workspace.path).load(planningId);
    const slots = await this.external.queryHandoffs(workspaceId, planningId) as Array<{ role: string; pendingInputs: number }>;
    const operations = await this.external.list(workspaceId, planningId) as Array<{ role: string; state: string; isCurrent: boolean; expectedRevision: number }>;
    if (slots.some(slot => slot.role === "plan" && slot.pendingInputs > 0) || operations.some(op => op.role === "plan" && op.isCurrent && op.expectedRevision === snapshot.revision && ["prepared", "submitting"].includes(op.state))) {
      throw new Error("pending_inputs_require_plan：有尚未完成的需求／修订；请先在网页提交并审查最新草案，再批准或执行。");
    }
  }

  async saveDraft(workspaceId: string, planningId: string, requestKey: string, input: { plan?: unknown; edits?: unknown; expectedDraftRevision: number; expectedPlanHash: string }): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, "planning.draft.save", requestKey, { planningId, ...input }, async () => {
      if (input.edits === undefined && input.plan === undefined) throw new Error("draft_edit_invalid：缺少字段补丁");
      if (input.plan !== undefined) {
        const current = await loadPlannerConversation(planningId, workspace.path);
        const plan = input.plan as Record<string, unknown> | null;
        if (current.draft && (!plan || Object.keys(plan).some(field => !["schemaVersion", "id", "title", "tasks", "decisionContext"].includes(field)) || ["id", "schemaVersion", "decisionContext"].some(field => !isDeepStrictEqual(plan[field], (current.draft!.plan as unknown as Record<string, unknown>)[field])))) {
          throw new Error("draft_readonly_field：计划标识与有效决策来源只读；技术方案变更请通过需求修订更新。高级编辑仅调整任务正文。");
        }
      }
      const result = await replacePlannerDraft({ planningId, workspace: workspace.path, ...(input.edits !== undefined ? { edits: input.edits } : { value: input.plan }), expectedDraftRevision: input.expectedDraftRevision, expectedPlanHash: input.expectedPlanHash });
      await this.publish({ type: "draft.saved", workspaceId, planningId, payload: { draftRevision: result.draft?.draftRevision, draftChanged: result.draftChanged } });
      return { planningId, draftRevision: result.draft?.draftRevision, draftChanged: result.draftChanged };
    });
  }

  async revise(workspaceId: string, planningId: string, requestKey: string, input: { message: string; reviewId: string; expectedPlanHash: string; expectedDraftRevision: number }): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const current = await loadPlannerConversation(planningId, workspace.path);
    if (["chatgpt-mcp", "web-mcp"].includes(current.snapshot.config.provider)) {
      if (current.draft?.planHash !== input.expectedPlanHash || current.draft.draftRevision !== input.expectedDraftRevision || current.review?.reviewId !== input.reviewId || !current.reviewIsCurrent) throw new Error("external_context_stale：修订引用的草案或审查已变化");
      return this.external.prepare(workspaceId, requestKey, { role: "plan", planningId, message: input.message, operation: true });
    }
    return this.submit(workspaceId, "planning.draft.revise", requestKey, { planningId, ...input }, async (signal) => {
      const result = await revisePlannerDraft({ planningId, workspace: workspace.path, message: input.message, reviewId: input.reviewId, expectedPlanHash: input.expectedPlanHash, expectedDraftRevision: input.expectedDraftRevision, signal });
      await this.publish({ type: "draft.revised", workspaceId, planningId, payload: { draftRevision: result.draft?.draftRevision } });
      return { planningId, draftRevision: result.draft?.draftRevision };
    });
  }

  async retryPlanning(workspaceId: string, planningId: string, requestKey: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    if (["chatgpt-mcp", "web-mcp"].includes((await new PlannerStore(workspace.path).load(planningId)).config.provider)) return this.external.prepare(workspaceId, requestKey, { role: "plan", planningId, retry: true });
    return this.submit(workspaceId, "planning.retry", requestKey, { planningId }, async (signal) => {
      const result = await retryPlannerTurn({ planningId, workspace: workspace.path, signal });
      await this.publish({ type: "planning.updated", workspaceId, planningId, payload: { status: result.snapshot.status, retried: true } });
      return { planningId, status: result.snapshot.status };
    });
  }

  private ownedTaskSignal(attemptId: string, parent: AbortSignal): AbortSignal {
    const existing = this.taskControllers.get(attemptId);
    if (existing) return existing.controller.signal;
    const controller = new AbortController(); this.taskControllers.set(attemptId, { controller, parent }); return controller.signal;
  }

  async changeTaskModel(workspaceId: string, planningId: string, requestKey: string, input: { taskId: string; modelId: string | null; expectedRevision: number; stopAndRetry: boolean; expectedAttemptId?: string }): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    return this.submit(workspaceId, input.stopAndRetry ? "session.model-switch" : "session.model-config", requestKey, { planningId, ...input }, async signal => {
      const planner = await new PlannerStore(workspace.path).load(planningId), sessionId = planner.execution?.sessionId;
      if (!sessionId) throw new Error("session_not_found：尚未创建执行 Session");
      const store = new SessionStore(workspace.path), record = await store.load(sessionId);
      const entry = record.plan.tasks.find(item => item.task.id === input.taskId), state = record.snapshot.tasks.find(item => item.taskId === input.taskId);
      if (!entry || !state) throw new Error("session_model_task_invalid");
      if (state.status === "succeeded") throw new Error("session_model_task_completed：已完成任务保持不变");
      if (input.modelId !== null) {
        const requested = { ...entry.task, execution: { ...entry.task.execution, modelId: input.modelId } };
        if (!this.runnerFactory(requested, { ...(record.snapshot.runnerProfile ? { runnerProfile: record.snapshot.runnerProfile } : {}) }).supportsModel) throw new Error("session_model_unsupported：此 Runner 不支持选择模型");
      }
      const active = state.activeAttemptId ? this.taskControllers.get(state.activeAttemptId) : undefined;
      if (input.stopAndRetry && (state.status !== "running" || state.activeAttemptId !== input.expectedAttemptId || !active)) throw new Error("session_model_owner_unavailable：目标 Attempt 已变化或不由当前服务执行，请重新检测；不会停止其他任务。");
      await updateSessionModel({ workspace: workspace.path, sessionId, taskId: input.taskId, modelId: input.modelId, expectedRevision: input.expectedRevision, requestKey });
      await this.publish({ type: "session.model.updated", workspaceId, planningId, taskId: input.taskId, payload: { modelId: input.modelId, effect: input.stopAndRetry ? "stop-and-retry" : "next-start" } });
      if (!input.stopAndRetry || !active) return { planningId, sessionId, taskId: input.taskId, status: "configured", effect: "下次启动或重试读取新模型；当前 Attempt 保持原模型。" };
      active.controller.abort(new Error("用户要求停止当前任务后更换模型重试"));
      await this.publish({ type: "task.model-switch.waiting", workspaceId, planningId, taskId: input.taskId, payload: { message: "已请求停止目标任务，等待 Runner 清理和当前调度批次释放工作区；其他任务继续。" } });
      // The original execution owns its locks until every in-flight task has settled.
      // Never retry concurrently with it, force-unlock, or cancel its parallel siblings.
      while ([...this.taskControllers.values()].some(item => item.parent === active.parent)) await delay(200, undefined, { signal });
      signal.throwIfAborted();
      const latest = await store.load(sessionId), target = latest.snapshot.tasks.find(task => task.taskId === input.taskId);
      if (target?.status === "succeeded") return { planningId, sessionId, taskId: input.taskId, status: "succeeded", effect: "停止前任务已完成，未重复执行。" };
      if (!target || !["failed", "cancelled", "timed_out", "interrupted"].includes(target.status) || target.attempts.at(-1)?.attemptId !== input.expectedAttemptId) throw new Error("session_model_target_changed：目标状态已变化，已保留模型配置，请人工核对后重试。");
      const stopped = await store.readAttempt(input.expectedAttemptId!) as { cleanupStatus?: string };
      if (stopped.cleanupStatus !== "completed") throw new Error("session_model_cleanup_unconfirmed：目标已结束，但 Runner 清理未确认完成；已保留新模型配置，请核验子进程后手工重试。");
      const policy = await readSessionModels(workspace.path, sessionId);
      if (policy.history.filter(change => change.taskId === input.taskId).at(-1)?.requestKey !== requestKey) throw new Error("session_models_changed：等待停止期间此任务的模型再次变更，未自动重试，请核对最新配置。");
      const result = await retrySession({ workspace: workspace.path, sessionId, taskId: input.taskId, createRunner: this.runnerFactory, signal,
        taskSignal: (_taskId, attemptId) => this.ownedTaskSignal(attemptId, signal),
        onOutput: (taskId, output, attemptId) => { void this.publish({ type: "runner.output", workspaceId, planningId, taskId, payload: { attemptId, stream: output.stream, text: sanitizeOutput(output.displayText ?? output.agentText ?? output.text).slice(0, 4096) } }); },
        onInteraction: (requestId, request, owner, interactionSignal) => this.waitForInteraction(workspaceId, planningId, requestId, request, owner, interactionSignal),
      });
      const task = result.snapshot.tasks.find(item => item.taskId === input.taskId);
      return { planningId, sessionId, taskId: input.taskId, status: task?.status, sessionStatus: result.snapshot.status, effect: "已用新模型创建重试 Attempt，旧记录与文件保留。" };
    });
  }

  async sessionDiagnosis(workspaceId: string, planningId: string): Promise<unknown> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    if (!loaded.snapshot.execution) throw new Error("session_not_found：规划尚未创建执行 Session");
    return diagnoseSession(workspace.path, loaded.snapshot.execution.sessionId);
  }

  async controlSession(workspaceId: string, planningId: string, requestKey: string, kind: "pause" | "cancel"): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    if (!loaded.snapshot.execution) throw new Error("session_not_found：规划尚未创建执行 Session");
    const sessionId = loaded.snapshot.execution.sessionId;
    return this.submit(workspaceId, `session.${kind}`, requestKey, { planningId, sessionId, kind }, async () => {
      await new SessionStore(workspace.path).requestControl(sessionId, kind);
      await this.publish({ type: kind === "pause" ? "session.paused" : "session.cancelled", workspaceId, planningId, payload: { sessionId } });
      return { planningId, sessionId, kind };
    });
  }

  async recover(workspaceId: string, planningId: string, requestKey: string, confirmedStopped: boolean): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    if (!loaded.snapshot.execution) throw new Error("session_not_found：规划尚未创建执行 Session");
    return this.submit(workspaceId, "session.recover", requestKey, { planningId, sessionId: loaded.snapshot.execution.sessionId, confirmedStopped }, async () => {
      const result = await recoverSession({ workspace: workspace.path, sessionId: loaded.snapshot.execution!.sessionId, confirmedStopped });
      await this.publish({ type: "session.recovered", workspaceId, planningId, payload: { recoveryId: result.recoveryId, recovered: result.recovered, diagnosis: result.diagnosis.state } });
      return result;
    });
  }

  async resume(workspaceId: string, planningId: string, requestKey: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    if (!loaded.snapshot.execution) throw new Error("session_not_found：规划尚未创建执行 Session");
    const sessionId = loaded.snapshot.execution.sessionId;
    return this.submit(workspaceId, "session.resume", requestKey, { planningId, sessionId }, async (signal) => {
      const result = await resumeSession({ sessionId, workspace: workspace.path, createRunner: this.runnerFactory, signal,
        taskSignal: (_taskId, attemptId) => this.ownedTaskSignal(attemptId, signal),
        onOutput: (taskId, output, attemptId) => { void this.publish({ type: "runner.output", workspaceId, planningId, taskId, payload: { attemptId, stream: output.stream, text: sanitizeOutput(output.displayText ?? output.agentText ?? output.text).slice(0, 4096) } }); },
        onInteraction: (requestId, request, owner, interactionSignal) => this.waitForInteraction(workspaceId, planningId, requestId, request, owner, interactionSignal),
        onIdleState: (taskId, state) => { void this.publish({ type: "task.activity", workspaceId, planningId, taskId, payload: state }); },
      });
      await this.publish({ type: "execution.completed", workspaceId, planningId, payload: { status: result.snapshot.status } });
      return { planningId, sessionId, status: result.snapshot.status };
    });
  }

  async retryTask(workspaceId: string, planningId: string, requestKey: string, taskId: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    if (!loaded.snapshot.execution) throw new Error("session_not_found：规划尚未创建执行 Session");
    const sessionId = loaded.snapshot.execution.sessionId;
    return this.submit(workspaceId, "session.retry", requestKey, { planningId, sessionId, taskId }, async (signal) => {
      const result = await retrySession({ sessionId, workspace: workspace.path, taskId, createRunner: this.runnerFactory, signal,
        taskSignal: (_taskId, attemptId) => this.ownedTaskSignal(attemptId, signal),
        onOutput: (id, output, attemptId) => { void this.publish({ type: "runner.output", workspaceId, planningId, taskId: id, payload: { attemptId, stream: output.stream, text: sanitizeOutput(output.displayText ?? output.agentText ?? output.text).slice(0, 4096) } }); },
        onInteraction: (requestId, request, owner, interactionSignal) => this.waitForInteraction(workspaceId, planningId, requestId, request, owner, interactionSignal),
      });
      return { planningId, sessionId, taskId, status: result.snapshot.status };
    });
  }

  async deliveryView(workspaceId: string, planningId: string): Promise<unknown> {
    const workspace = await this.getWorkspace(workspaceId), snapshot = await new PlannerStore(workspace.path).load(planningId);
    const sessionId = snapshot.execution?.sessionId;
    if (!sessionId) return { available: false, nextAction: "尚未创建执行 Session" };
    try {
      const report = JSON.parse(await readFile(join(workspace.path, ".token-coupon", "sessions", sessionId, "delivery.json"), "utf8")) as unknown;
      return { available: true, sessionId, report, historical: true, nextAction: "仅为已保存的交付证据；需要更新交付判断时由用户在本地重新生成" };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { available: false, sessionId, nextAction: "由用户在本地生成交付信息，网页不能触发生成或 Git 整合" }; throw error; }
  }

  async delivery(workspaceId: string, planningId: string, requestKey: string): Promise<JobRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    const loaded = await loadPlannerConversation(planningId, workspace.path);
    const sessionId = loaded.snapshot.execution?.sessionId;
    if (!sessionId) throw new Error("session_not_found：规划尚未创建执行 Session");
    return this.submit(workspaceId, "session.delivery", requestKey, { planningId, sessionId }, async () => {
      const store = new SessionStore(workspace.path); const record = await store.load(sessionId);
      const report = await createSessionDelivery(record, store);
      return { report, instructions: formatSessionDelivery(report, workspace.path) };
    });
  }

  async answerInteraction(workspaceId: string, requestId: string, reply: RunnerInteractionReply): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending || pending.value.workspaceId !== workspaceId) throw new Error("interaction_stale：该交互已结束或不属于当前项目");
    if (pending.signal.aborted) { this.pendingInteractions.delete(requestId); throw new Error("interaction_stale：对应 Attempt 已取消"); }
    if (reply.kind === "approval" && reply.guidance && !["codex", "claude-code"].includes(pending.value.owner.runnerId)) {
      throw new Error("interaction_guidance_unsupported：当前 Runner 暂不支持拒绝指导，请直接拒绝本次操作");
    }
    pending.resolve(reply);
    this.pendingInteractions.delete(requestId);
    await this.publish({ type: "interaction.resolved", workspaceId, planningId: pending.value.planningId, taskId: pending.value.owner.taskId, payload: { requestId } });
  }

  eventsAfter(sequence: number): DaemonEvent[] { return this.eventTail.filter((event) => event.sequence > sequence); }
  subscribe(listener: (event: DaemonEvent) => void): () => void { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }

  private async waitForInteraction(workspaceId: string, planningId: string, requestId: string, request: RunnerInteractionRequest, owner: RunnerInteractionOwner, signal: AbortSignal): Promise<RunnerInteractionReply> {
    if (this.pendingInteractions.has(requestId)) throw new Error("interaction_duplicate：交互请求 ID 重复");
    if (signal.aborted) throw signal.reason ?? new Error("interaction_cancelled");
    const safeRequest: RunnerInteractionRequest = {
      ...request, title: sanitizeOutput(request.title), summary: sanitizeOutput(request.summary),
      ...(request.operation?.command ? { operation: { ...request.operation, command: sanitizeOutput(request.operation.command) } } : {}),
      ...(request.questions ? { questions: request.questions.map((question) => ({ ...question, text: sanitizeOutput(question.text) })) } : {}),
    };
    const value: PendingInteraction = { requestId, workspaceId, planningId, owner, request: safeRequest, createdAt: new Date().toISOString() };
    await this.publish({ type: "interaction.requested", workspaceId, planningId, taskId: owner.taskId, payload: value });
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.pendingInteractions.delete(requestId); reject(signal.reason ?? new Error("interaction_cancelled")); };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingInteractions.set(requestId, { value, resolve: (reply) => { signal.removeEventListener("abort", onAbort); resolve(reply); }, signal });
    });
  }

  async publish(event: Omit<DaemonEvent, "epoch" | "sequence" | "createdAt">): Promise<void> {
    const value: DaemonEvent = { ...event, epoch: this.epoch, sequence: ++this.eventSequence, createdAt: new Date().toISOString() };
    this.eventTail.push(value);
    if (this.eventTail.length > 1000) this.eventTail.splice(0, this.eventTail.length - 1000);
    await appendFile(this.eventsPath, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
    if ((await stat(this.eventsPath)).size > 8 * 1024 * 1024) {
      const lines = (await readFile(this.eventsPath, "utf8")).trimEnd().split("\n").slice(-1200);
      await this.writeAtomic(this.eventsPath, lines.join("\n") + "\n");
    }
    for (const subscriber of this.subscribers) subscriber(value);
  }

  private async saveJob(job: JobRecord): Promise<void> { await this.writeAtomic(join(this.jobsDirectory, `${job.jobId}.json`), JSON.stringify(job, null, 2) + "\n"); }
  private async writeAtomic(path: string, data: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, path);
  }
}

export function plannerConfig(provider: string, model?: string) {
  if (provider === "mock") return { provider: "mock" as const, model: "mock", baseUrl: "mock://local" };
  if (provider !== "deepseek-api") throw new Error("planner_provider_invalid：当前 provider 不可用");
  if (!process.env.TOKEN_COUPON_PLANNER_API_KEY) throw new Error("planner_api_key_missing：请在启动 daemon 的环境中配置 TOKEN_COUPON_PLANNER_API_KEY");
  return { provider: "deepseek" as const, model: model?.trim() || process.env.TOKEN_COUPON_PLANNER_MODEL || "deepseek-flash", baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL || "https://api.deepseek.com/v1" };
}

const daemonRunnerFactory: TaskRunnerFactory = (task: TaskDefinition, options: TaskRunnerFactoryOptions) => {
  const registry = createDefaultRunnerRegistry();
  const resolution = registry.resolve(task, options.runnerProfile, options.runnerSettings ?? {});
  const adapter = resolution.runner;
  return {
    id: adapter.id, supportsModel: adapter.supportsModel, resolvedSpec: resolution.spec,
    checkAvailable: () => adapter.checkAvailable(),
    ...(adapter.diagnose ? { diagnose: (cwd: string) => adapter.diagnose!(cwd) } : {}),
    run: (input, context) => adapter.run(input, context),
  };
};

function isWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  return !!value && typeof value === "object" && typeof (value as WorkspaceEntry).workspaceId === "string" && typeof (value as WorkspaceEntry).path === "string" && typeof (value as WorkspaceEntry).label === "string";
}
function compactResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !["snapshot", "draft", "review", "messages", "context"].includes(key)));
}
function safeError(error: unknown): string { return sanitizeOutput(error instanceof Error ? error.message : String(error)).slice(0, 2048); }
export function sanitizeOutput(value: string): string {
  let text = value;
  for (const key of [process.env.TOKEN_COUPON_PLANNER_API_KEY, process.env.DEEPSEEK_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]) {
    if (key && key.length >= 8) text = text.replaceAll(key, "[已隐藏]" );
  }
  return text;
}
