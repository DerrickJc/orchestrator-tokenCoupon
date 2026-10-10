import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parsePlan } from "./validate-plan.js";
import type { ExecutionConfig } from "./task.js";
import type { PlannerConversationSnapshot, PlannerDraft, PlannerEvent, PlannerTurnRef, RepositoryEvidence, RequirementsState } from "./planner-types.js";
import { validateRequirementsState } from "./requirements.js";
import { parsePlanningAssessment, validatePlanningAssessment } from "./planning-readiness.js";
import { validateConfirmationState } from "./confirmation.js";
import type { ConfirmationEvent, ConfirmationProposalSet } from "./planner-types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const RECORD_LIMIT = 4 * 1024 * 1024;

export class PlannerLockError extends Error {
  constructor(message: string) { super(message); this.name = "PlannerLockError"; }
}

export class PlannerStore {
  readonly workspace: string;
  private readonly root: string;

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
    this.root = join(this.workspace, ".token-coupon", "planners");
  }

  async create(snapshot: PlannerConversationSnapshot): Promise<void> {
    validateSnapshot(snapshot, this.workspace);
    await mkdir(this.root, { recursive: true });
    const directory = this.directory(snapshot.planningId);
    await mkdir(directory, { recursive: false });
    await mkdir(join(directory, "drafts"), { recursive: true });
    await mkdir(join(directory, "turns"), { recursive: true });
    await this.writeSnapshot(snapshot);
  }

  async load(planningId: string): Promise<PlannerConversationSnapshot> {
    this.validateId(planningId);
    const raw = await readJson(join(this.directory(planningId), "conversation.json"));
    const snapshot = validateSnapshot(raw, this.workspace);
    if (snapshot.planningId !== planningId) throw new Error("Planner 记录 ID 与目录不匹配");
    if (snapshot.confirmationState) {
      for (const event of snapshot.confirmationState.events) {
        const archived = await readJson(this.confirmationEventPath(planningId, event.eventId));
        if (canonicalHash(archived) !== canonicalHash(event)) throw new Error("确认事件存档与当前确认状态不匹配");
      }
      const proposal = snapshot.confirmationState.activeProposal;
      if (proposal) {
        const archived = await readJson(this.proposalPath(planningId, proposal.proposalId, proposal.revision));
        if (canonicalHash(archived) !== canonicalHash(proposal)) throw new Error("当前确认提案与不可变提案版本不匹配");
      }
    }
    if (snapshot.requirements && snapshot.requirements.revision > 0) {
      const archive = await readJson(join(this.directory(planningId), "requirements", `${snapshot.requirements.revision}.json`)) as { planningId: string; state: RequirementsState; stateHash: string };
      if (archive.planningId !== planningId || archive.stateHash !== canonicalHash(archive.state) || archive.stateHash !== canonicalHash(snapshot.requirements)) throw new Error("当前需求状态与不可变需求版本不匹配");
    }
    if (snapshot.draftRevision !== null) {
      const draft = await this.loadDraft(planningId, snapshot.draftRevision);
      if (snapshot.approval && (snapshot.approval.draftRevision !== draft.draftRevision || snapshot.approval.planHash !== draft.planHash)) {
        throw new Error("Planner 批准记录与当前草案不匹配");
      }
    } else if (snapshot.approval) throw new Error("Planner 未引用草案但保存了批准");
    if (snapshot.execution && (!snapshot.approval || snapshot.execution.approvalId !== snapshot.approval.approvalId ||
        snapshot.execution.draftRevision !== snapshot.approval.draftRevision || snapshot.execution.planHash !== snapshot.approval.planHash)) {
      throw new Error("Planner execution 与批准版本不匹配");
    }
    if (snapshot.status === "execution_created" && snapshot.execution?.state !== "created") throw new Error("Planner execution_created 状态缺少已创建 Session");
    return snapshot;
  }

  async list(): Promise<PlannerConversationSnapshot[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const snapshots: PlannerConversationSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      try { snapshots.push(await this.load(entry.name)); }
      catch { /* One corrupt planner record should not hide other records. */ }
    }
    return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(snapshot: PlannerConversationSnapshot): Promise<void> {
    const current = await this.load(snapshot.planningId);
    if (snapshot.revision !== current.revision + 1) throw new Error("Planner 快照 revision 冲突");
    validateSnapshot(snapshot, this.workspace);
    await this.writeSnapshot(snapshot);
  }

  async writeDraft(draft: PlannerDraft): Promise<void> {
    validateDraft(draft);
    const path = this.draftPath(draft.planningId, draft.draftRevision);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, JSON.stringify(draft, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.loadDraft(draft.planningId, draft.draftRevision);
      if (existing.planHash !== draft.planHash) throw new Error("草案版本不可覆盖");
    }
  }

  async writeRequirements(planningId: string, state: RequirementsState): Promise<void> {
    this.validateId(planningId);
    const path = join(this.directory(planningId), "requirements", `${state.revision}.json`);
    await mkdir(dirname(path), { recursive: true });
    const value = { planningId, state, stateHash: canonicalHash(state) };
    try { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readJson(path) as typeof value;
      if (existing.stateHash !== value.stateHash || canonicalHash(existing.state) !== value.stateHash) throw new Error("需求版本不可覆盖");
    }
  }

  async writeConfirmationProposal(planningId: string, proposal: ConfirmationProposalSet): Promise<void> {
    this.validateId(planningId);
    const path = this.proposalPath(planningId, proposal.proposalId, proposal.revision);
    await mkdir(dirname(path), { recursive: true });
    const contents = JSON.stringify(proposal, null, 2) + "\n";
    try { await writeFile(path, contents, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readJson(path);
      if (canonicalHash(current) !== canonicalHash(proposal)) throw new Error("确认提案版本不可覆盖");
    }
  }

  async writeConfirmationEvent(planningId: string, event: ConfirmationEvent): Promise<void> {
    this.validateId(planningId); this.validateId(event.eventId);
    const path = this.confirmationEventPath(planningId, event.eventId);
    await mkdir(dirname(path), { recursive: true });
    const contents = JSON.stringify(event, null, 2) + "\n";
    try { await writeFile(path, contents, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readJson(path);
      if (canonicalHash(current) !== canonicalHash(event)) throw new Error("确认事件不可覆盖");
    }
  }

  async nextRequirementsRevision(planningId: string, minimum: number): Promise<number> {
    this.validateId(planningId);
    const names = await readdir(join(this.directory(planningId), "requirements")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const revisions = names.filter((name) => /^[1-9][0-9]*\.json$/.test(name)).map((name) => Number(name.slice(0, -5)));
    const next = revisions.reduce((next, revision) => Math.max(next, revision + 1), minimum);
    if (!Number.isSafeInteger(next)) throw new Error("需求版本超限");
    return next;
  }

  async loadDraft(planningId: string, revision: number): Promise<PlannerDraft> {
    this.validateId(planningId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("draftRevision 无效");
    const draft = validateDraft(await readJson(this.draftPath(planningId, revision)));
    if (draft.planningId !== planningId || draft.draftRevision !== revision) throw new Error("草案身份与路径不匹配");
    return draft;
  }

  async writeTurn(turn: PlannerTurnRef, value: unknown): Promise<void> {
    this.validateId(turn.turnId);
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    this.validateId(typeof raw.planningId === "string" ? raw.planningId : "");
    const directory = join(this.directory(raw.planningId as string), "turns", turn.turnId);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, "turn.json"), JSON.stringify(value, null, 2) + "\n");
  }

  async appendEvent(planningId: string, turnId: string, event: PlannerEvent): Promise<void> {
    this.validateId(planningId);
    this.validateId(turnId);
    const directory = join(this.directory(planningId), "turns", turnId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "events.jsonl");
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    const existing = await stat(path).catch(() => undefined);
    if ((existing?.size ?? 0) + Buffer.byteLength(line, "utf8") > 1024 * 1024) throw new Error("Planner 事件记录超过 1 MiB");
    const handle = await open(path, "a", 0o600);
    try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
  }

  async writeProviderCall(planningId: string, turnId: string, requestId: number, kind: "request" | "response", value: unknown): Promise<void> {
    this.validateId(planningId); this.validateId(turnId);
    if (!Number.isSafeInteger(requestId) || requestId < 1 || requestId > 8) throw new Error("Planner API requestId 无效");
    const contents = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(contents, "utf8") > 1024 * 1024) throw new Error("Planner API 调用记录超过 1 MiB");
    const directory = join(this.turnDirectory(planningId, turnId), "calls");
    await mkdir(directory, { recursive: true });
    const name = String(requestId).padStart(4, "0") + "." + kind + ".json";
    await atomicWrite(join(directory, name), contents);
  }

  async acquireLock(planningId: string): Promise<() => Promise<void>> {
    this.validateId(planningId);
    const directory = this.directory(planningId);
    await mkdir(directory, { recursive: false }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const path = join(directory, "conversation.lock");
    const owner = { planningId, pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() };
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify(owner) + "\n", "utf8");
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PlannerLockError("已有操作正在修改此规划记录");
      throw error;
    }
    return async () => {
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
        if (current.token === owner.token) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
  }

  turnDirectory(planningId: string, turnId: string): string {
    this.validateId(planningId); this.validateId(turnId);
    return join(this.directory(planningId), "turns", turnId);
  }

  private async writeSnapshot(snapshot: PlannerConversationSnapshot): Promise<void> {
    await atomicWrite(join(this.directory(snapshot.planningId), "conversation.json"), JSON.stringify(snapshot, null, 2) + "\n");
  }
  private directory(planningId: string): string { this.validateId(planningId); return join(this.root, planningId); }
  private draftPath(planningId: string, revision: number): string { return join(this.directory(planningId), "drafts", String(revision) + ".json"); }
  private proposalPath(planningId: string, proposalId: string, revision: number): string {
    this.validateId(proposalId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("确认提案版本无效");
    return join(this.directory(planningId), "proposals", proposalId, `${revision}.json`);
  }
  private confirmationEventPath(planningId: string, eventId: string): string {
    this.validateId(eventId);
    return join(this.directory(planningId), "confirmations", `${eventId}.json`);
  }
  private validateId(value: string): void { if (!UUID.test(value)) throw new Error("planningId/turnId 必须是 UUID"); }
}

export async function readJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (info.size > RECORD_LIMIT) throw new Error("Planner 记录超过 4 MiB");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), ".snapshot-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function validateDraft(value: unknown): PlannerDraft {
  const raw = object(value, "Planner 草案");
  const plan = parsePlan(raw.plan);
  if (raw.schemaVersion !== 1 || !isUuid(raw.planningId) || !Number.isSafeInteger(raw.draftRevision) || (raw.draftRevision as number) < 1 ||
      typeof raw.message !== "string" || Buffer.byteLength(raw.message, "utf8") > 16 * 1024 || !["model", "user"].includes(String(raw.source)) ||
      typeof raw.createdAt !== "string" || !Array.isArray(raw.context) || typeof raw.planHash !== "string" || !HASH.test(raw.planHash)) {
    throw new Error("Planner 草案字段无效");
  }
  const context = raw.context.map(parseEvidence);
  if (canonicalHash(plan) !== raw.planHash) throw new Error("Planner 草案哈希不匹配");
  return { schemaVersion: 1, planningId: raw.planningId as string, draftRevision: raw.draftRevision as number, plan, message: raw.message, source: raw.source as "model" | "user", context, planHash: raw.planHash, createdAt: raw.createdAt };
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + stableStringify(item)).join(",") + "}";
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("计划包含不能序列化的值");
  return serialized;
}

function validateSnapshot(value: unknown, workspace: string): PlannerConversationSnapshot {
  const raw = object(value, "Planner 快照");
  if (raw.schemaVersion !== 1 || !isUuid(raw.planningId) || raw.workspace !== workspace || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 ||
      !["collecting", "draft_ready", "approved", "execution_created"].includes(String(raw.status)) ||
      !raw.config || typeof raw.config !== "object" || !raw.executionDefaults || typeof raw.executionDefaults !== "object" ||
      !Array.isArray(raw.messages) || raw.messages.length > 512 || !Array.isArray(raw.turns) || raw.turns.length > 256 || !Array.isArray(raw.context) ||
      (raw.activeTurnId !== null && !isUuid(raw.activeTurnId)) ||
      (raw.draftRevision !== null && (!Number.isSafeInteger(raw.draftRevision) || (raw.draftRevision as number) < 1)) ||
      typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") throw new Error("Planner 快照字段无效");
  const config = raw.config as Record<string, unknown>;
  if (!["mock", "deepseek"].includes(String(config.provider)) || typeof config.model !== "string" || !config.model || Buffer.byteLength(config.model, "utf8") > 256 ||
      typeof config.baseUrl !== "string" || (config.provider === "mock" ? config.baseUrl !== "mock://local" : !safeEndpoint(config.baseUrl))) {
    throw new Error("Planner 配置快照无效");
  }
  const executionDefaults = parseExecution(raw.executionDefaults);
  const messages = raw.messages.map((entry, index) => {
    const message = object(entry, "messages[" + index + "]");
    if (!isUuid(message.messageId) || !["user", "assistant"].includes(String(message.role)) || typeof message.content !== "string" ||
        Buffer.byteLength(message.content, "utf8") > 64 * 1024) throw new Error("Planner messages[" + index + "] 无效");
    return { messageId: message.messageId, role: message.role as "user" | "assistant", content: message.content };
  });
  if (messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8"), 0) > 1024 * 1024) throw new Error("Planner 对话历史超过 1 MiB");
  const turns = raw.turns.map((entry) => parseTurn(entry, workspace, raw.planningId as string));
  const context = raw.context.map(parseEvidence);
  if (new Set(context.map((item) => item.path)).size !== context.length || context.reduce((sum, item) => sum + item.sizeBytes, 0) > 8 * 1024 * 1024) throw new Error("Planner Repository context 无效或超过读取预算");
  if (new Set(turns.map(({ turnId }) => turnId)).size !== turns.length) throw new Error("Planner 存在重复 turnId");
  const active = raw.activeTurnId as string | null;
  if ((active !== null) !== turns.some((turn) => turn.turnId === active && turn.status === "running")) throw new Error("Planner activeTurnId 与轮次状态不一致");
  const approval = raw.approval === null ? null : parseApproval(raw.approval);
  const requirements = raw.requirements === undefined ? undefined : validateRequirementsState(raw.requirements, messages);
  const confirmationState = raw.confirmationState === undefined ? undefined : validateConfirmationState(raw.confirmationState, messages);
  let planningAssessment = raw.planningAssessment === undefined ? undefined : parsePlanningAssessment(raw.planningAssessment);
  if (planningAssessment && requirements) {
    planningAssessment = validatePlanningAssessment(planningAssessment, {
      messages, requirements, evidence: context, currentMessageIds: messages.filter(({ role }) => role === "user").map(({ messageId }) => messageId),
      ...(confirmationState ? { confirmationState } : {}),
    });
  }
  const latestReviewId = raw.latestReviewId === undefined || raw.latestReviewId === null ? null : raw.latestReviewId;
  if (latestReviewId !== null && !isUuid(latestReviewId)) throw new Error("Planner latestReviewId 无效");
  const execution = raw.execution === null ? null : parseExecutionReference(raw.execution);
  if (raw.status === "approved" && (!approval || raw.draftRevision !== approval.draftRevision)) throw new Error("Planner approved 状态缺少当前批准");
  if (raw.status === "draft_ready" && raw.draftRevision === null) throw new Error("Planner draft_ready 状态缺少草案");
  if (raw.status === "execution_created" && !execution) throw new Error("Planner execution_created 状态缺少 Session 引用");
  if (approval && (raw.draftRevision !== approval.draftRevision || !isUuid(approval.approvalId))) throw new Error("Planner 批准引用无效");
  return {
    schemaVersion: 1, planningId: raw.planningId as string, workspace, revision: raw.revision as number,
    status: raw.status as PlannerConversationSnapshot["status"], config: { provider: config.provider as "mock" | "deepseek", model: config.model as string, baseUrl: config.baseUrl as string },
    executionDefaults, messages, ...(requirements === undefined ? {} : { requirements }),
    ...(planningAssessment === undefined ? {} : { planningAssessment }),
    ...(confirmationState === undefined ? {} : { confirmationState }),
    turns, context, activeTurnId: active, draftRevision: raw.draftRevision as number | null, approval, latestReviewId, execution,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt,
  };
}

function parseExecution(value: unknown): ExecutionConfig {
  const raw = object(value, "executionDefaults");
  const timeoutMs = raw.timeoutMs;
  const requiredCapabilities = raw.requiredCapabilities;
  if (Object.keys(raw).some((key) => !["runnerId", "modelId", "mode", "timeoutMs", "requiredCapabilities"].includes(key)) ||
      typeof raw.runnerId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.runnerId) || !["non_interactive", "managed"].includes(String(raw.mode)) ||
      (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 3_600_000)) ||
      (raw.modelId !== undefined && (typeof raw.modelId !== "string" || !raw.modelId || Buffer.byteLength(raw.modelId, "utf8") > 256)) ||
      (raw.runnerId === "mock" && raw.modelId !== undefined) ||
      (requiredCapabilities !== undefined && (!Array.isArray(requiredCapabilities) || requiredCapabilities.length > 2 || requiredCapabilities.some((item) => item !== "userInput" && item !== "toolApproval") || new Set(requiredCapabilities).size !== requiredCapabilities.length))) throw new Error("Planner executionDefaults 无效");
  return { runnerId: raw.runnerId, mode: raw.mode as ExecutionConfig["mode"], ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }), ...(raw.modelId === undefined ? {} : { modelId: raw.modelId as string }), ...(requiredCapabilities === undefined ? {} : { requiredCapabilities: requiredCapabilities as NonNullable<ExecutionConfig["requiredCapabilities"]> }) };
}

function parseTurn(value: unknown, workspace: string, planningId: string): PlannerTurnRef {
  const raw = object(value, "Planner turn");
  if (!isUuid(raw.turnId) || !isUuid(raw.messageId) || !["running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(raw.status)) ||
      raw.artifactDir !== join(workspace, ".token-coupon", "planners", planningId, "turns", String(raw.turnId)) || (raw.reasonCode !== null && typeof raw.reasonCode !== "string") ||
      typeof raw.createdAt !== "string" || (raw.finishedAt !== null && typeof raw.finishedAt !== "string") || (raw.operation !== undefined && typeof raw.operation !== "boolean")) throw new Error("Planner turn 引用无效");
  return raw as unknown as PlannerTurnRef;
}

function parseApproval(value: unknown): NonNullable<PlannerConversationSnapshot["approval"]> {
  const raw = object(value, "Planner approval");
  if (!isUuid(raw.approvalId) || !Number.isSafeInteger(raw.draftRevision) || (raw.draftRevision as number) < 1 || typeof raw.planHash !== "string" || !HASH.test(raw.planHash) || typeof raw.approvedAt !== "string" ||
      (raw.reviewId !== undefined && (typeof raw.reviewId !== "string" || !isUuid(raw.reviewId))) ||
      (raw.reportHash !== undefined && (typeof raw.reportHash !== "string" || !HASH.test(raw.reportHash))) ||
      (raw.waivedFindings !== undefined && (!Array.isArray(raw.waivedFindings) || raw.waivedFindings.length > 100 || raw.waivedFindings.some((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return true;
        const waiver = item as Record<string, unknown>;
        return typeof waiver.findingId !== "string" || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(waiver.findingId) || typeof waiver.reason !== "string" || Buffer.byteLength(waiver.reason, "utf8") > 1024 || typeof waiver.waivedAt !== "string";
      })))) throw new Error("Planner approval 无效");
  return {
    approvalId: raw.approvalId as string, draftRevision: raw.draftRevision as number, planHash: raw.planHash as string, approvedAt: raw.approvedAt,
    ...(raw.reviewId === undefined ? {} : { reviewId: raw.reviewId as string }), ...(raw.reportHash === undefined ? {} : { reportHash: raw.reportHash as string }),
    ...(raw.waivedFindings === undefined ? {} : { waivedFindings: raw.waivedFindings as NonNullable<NonNullable<PlannerConversationSnapshot["approval"]>["waivedFindings"]> }),
  };
}

function parseExecutionReference(value: unknown): NonNullable<PlannerConversationSnapshot["execution"]> {
  const raw = object(value, "Planner execution");
  if (!isUuid(raw.sessionId) || !isUuid(raw.approvalId) || !Number.isSafeInteger(raw.draftRevision) || typeof raw.planHash !== "string" || !HASH.test(raw.planHash) ||
      !["reserved", "created"].includes(String(raw.state))) throw new Error("Planner execution 引用无效");
  if (raw.isolation !== undefined) {
    const isolation = object(raw.isolation, "Planner execution isolation");
    if (isolation.mode === "shared") {
      if (Object.keys(isolation).some((key) => key !== "mode")) throw new Error("Planner shared isolation 无效");
    } else if (isolation.mode === "git-worktree") {
      if (Object.keys(isolation).some((key) => !["mode", "verificationTaskId", "setupHash"].includes(key)) ||
          typeof isolation.verificationTaskId !== "string" || !isolation.verificationTaskId ||
          (isolation.setupHash !== null && (typeof isolation.setupHash !== "string" || !/^[0-9a-f]{64}$/i.test(isolation.setupHash)))) throw new Error("Planner git-worktree isolation 无效");
    } else throw new Error("Planner execution isolation mode 无效");
  }
  return raw as unknown as NonNullable<PlannerConversationSnapshot["execution"]>;
}

function parseEvidence(value: unknown): RepositoryEvidence {
  const raw = object(value, "Repository evidence");
  if (typeof raw.path !== "string" || !raw.path || raw.path.startsWith("/") || raw.path.split("/").includes("..") ||
      typeof raw.sha256 !== "string" || !HASH.test(raw.sha256) || !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0 || (raw.sizeBytes as number) > 1024 * 1024) throw new Error("Repository evidence 无效");
  return { path: raw.path, sha256: raw.sha256, sizeBytes: raw.sizeBytes as number };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " 必须是对象");
  return value as Record<string, unknown>;
}
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function safeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (local && url.protocol === "http:")) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
