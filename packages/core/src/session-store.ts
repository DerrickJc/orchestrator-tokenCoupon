import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { appendFile, open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PlanDefinition } from "./plan.js";
import type { GitIsolationJournal, SessionControlKind, SessionControlRequest, SessionIsolation, SessionRecord, SessionSchedulerEvent, SessionSnapshot, SessionTaskState } from "./session-types.js";
import { parsePlan } from "./validate-plan.js";
import { parseRunnerProfile, runnerProfileHash } from "./runner-registry.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATUSES = new Set(["ready", "running", "pausing", "paused", "succeeded", "failed", "cancelled", "interrupted", "blocked"]);
const TASK_STATUSES = new Set(["planned", "running", "succeeded", "failed", "cancelled", "timed_out", "blocked", "interrupted"]);

export class SessionLockError extends Error {
  constructor(message: string) { super(message); this.name = "SessionLockError"; }
}

export class SessionStore {
  readonly workspace: string;
  private readonly root: string;

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
    this.root = join(this.workspace, ".token-coupon");
  }

  async acquireLock(sessionId?: string): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true });
    const lockPath = join(this.root, "workspace.lock");
    const owner = { pid: process.pid, sessionId: sessionId ?? null, token: randomUUID(), acquiredAt: new Date().toISOString() };
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let description = "已有计划正在使用此工作目录";
        try {
          const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; sessionId?: string | null };
          description += `（PID ${existing.pid ?? "未知"}${existing.sessionId ? `，Session ${existing.sessionId}` : ""}）`;
        } catch { description += "（锁文件内容不可读）"; }
        throw new SessionLockError(description);
      }
      throw error;
    }

    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
        if (current.token === owner.token) await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
  }

  async create(plan: PlanDefinition, sessionId: string = randomUUID(), isolation: SessionIsolation = { mode: "shared" }, options: { maxParallel?: number; executionId?: string; runnerProfile?: import("./runner.js").RunnerProfile } = {}): Promise<SessionRecord> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const maxParallel = options.maxParallel ?? 1;
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error("maxParallel 必须是 1 到 8 之间的整数");
    if (isolation.mode === "shared" && maxParallel !== 1) throw new Error("shared workspace 只支持 maxParallel=1");
    const executionId = options.executionId ?? randomUUID();
    if (!UUID.test(executionId)) throw new Error("executionId 必须是 UUID");
    const sessionDir = join(this.root, "sessions", sessionId);
    const now = new Date().toISOString();
    const runnerProfile = options.runnerProfile ? parseRunnerProfile(options.runnerProfile) : undefined;
    const snapshot: SessionSnapshot = {
      schemaVersion: 3, sessionId, workspace: this.workspace, revision: 1, status: "ready", isolation,
      maxParallel, planDigest: digestPlan(plan), executionId, schedulerState: "idle", waveId: null, activeAttemptIds: [],
      controlState: { requestId: null, kind: null, requestedAt: null, acknowledgedAt: null },
      planId: plan.id, planTitle: plan.title,
      ...(runnerProfile ? { runnerProfile, runnerProfileHash: runnerProfileHash(runnerProfile) } : {}),
      tasks: plan.tasks.map(({ task }) => ({ taskId: task.id, status: "planned", activeAttemptId: null, attempts: [], result: null, reasonCode: null })),
      createdAt: now, updatedAt: now,
    };
    await mkdir(dirname(sessionDir), { recursive: true });
    await mkdir(sessionDir, { recursive: false });
    await writeFile(join(sessionDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    await this.save(snapshot);
    if (isolation.mode === "git-worktree") {
      const journal: GitIsolationJournal = { schemaVersion: 2, sessionId, status: "initializing", integrationHead: isolation.baseCommit, attempts: [], updatedAt: now };
      await writeFile(join(sessionDir, "isolation.json"), `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { plan, snapshot, isolationJournal: journal };
    }
    return { plan, snapshot };
  }

  async load(sessionId: string): Promise<SessionRecord> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const sessionDir = this.sessionDirectory(sessionId);
    let planValue: unknown;
    let snapshotValue: unknown;
    try {
      [planValue, snapshotValue] = await Promise.all([
        readFile(join(sessionDir, "plan.json"), "utf8").then((text) => JSON.parse(text) as unknown),
        readFile(join(sessionDir, "session.json"), "utf8").then((text) => JSON.parse(text) as unknown),
      ]);
    } catch (error) {
      throw new Error(`无法读取 Session ${sessionId}：${error instanceof Error ? error.message : String(error)}`);
    }
    const plan = parsePlan(planValue);
    const snapshot = parseSnapshot(snapshotValue, plan, this.workspace, sessionId);
    if (snapshot.isolation?.mode === "git-worktree") return { plan, snapshot, isolationJournal: await this.loadIsolationJournal(sessionId, snapshot.isolation, plan) };
    return { plan, snapshot };
  }

  async loadIsolationJournal(sessionId: string, isolation: Extract<SessionIsolation, { mode: "git-worktree" }>, plan?: PlanDefinition): Promise<GitIsolationJournal> {
    const raw = JSON.parse(await readFile(join(this.sessionDirectory(sessionId), "isolation.json"), "utf8")) as unknown;
    const recordPlan = plan ?? (await this.load(sessionId)).plan;
    return parseIsolationJournal(raw, sessionId, this.workspace, isolation, recordPlan);
  }

  async saveIsolationJournal(sessionId: string, journal: GitIsolationJournal): Promise<void> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const record = await this.load(sessionId);
    if (record.snapshot.isolation?.mode !== "git-worktree") throw new Error("Session 没有 Git worktree 隔离记录");
    const validated = parseIsolationJournal(journal, sessionId, this.workspace, record.snapshot.isolation, record.plan);
    await atomicWrite(join(this.sessionDirectory(sessionId), "isolation.json"), `${JSON.stringify(validated, null, 2)}\n`);
  }

  async saveDeliveryReport(sessionId: string, value: unknown): Promise<string> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const directory = this.sessionDirectory(sessionId);
    await stat(directory);
    const path = join(directory, "delivery.json");
    await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  async saveSetupRecord(sessionId: string, attemptId: string, value: unknown): Promise<string> {
    if (!UUID.test(sessionId) || !UUID.test(attemptId)) throw new Error("sessionId 和 attemptId 必须是 UUID");
    const directory = join(this.sessionDirectory(sessionId), "setup");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${attemptId}.json`);
    await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  async saveCleanupRecord(sessionId: string, value: unknown): Promise<string> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const directory = this.sessionDirectory(sessionId);
    await stat(directory);
    const path = join(directory, "cleanup.json");
    await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    if (!UUID.test(snapshot.sessionId)) throw new Error("sessionId 必须是 UUID");
    const sessionDir = this.sessionDirectory(snapshot.sessionId);
    await stat(sessionDir);
    await atomicWrite(join(sessionDir, "session.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  async requestControl(sessionId: string, kind: SessionControlKind, timeoutMs = 120_000): Promise<void> {
    const record = await this.load(sessionId);
    if (record.snapshot.schemaVersion !== 3 || !record.snapshot.executionId) throw new Error("session_control_unsupported：该 Session 尚不支持跨进程控制");
    if (record.snapshot.isolation?.mode !== "git-worktree") throw new Error("session_control_requires_worktree：跨进程 pause/cancel 仅支持 Git worktree Session");
    if (!["running", "pausing"].includes(record.snapshot.status)) throw new Error(`session_control_not_running：Session 当前状态为 ${record.snapshot.status}`);
    if (!await this.hasLiveOwner(sessionId)) throw new Error("session_owner_missing：没有可确认控制请求的运行 owner");
    const controlDir = join(this.sessionDirectory(sessionId), "control");
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    const requestPath = join(controlDir, "request.json");
    const ackPath = join(controlDir, "ack.json");
    try {
      const previous = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
      let acknowledged = false;
      try {
        const ack = JSON.parse(await readFile(ackPath, "utf8")) as Record<string, unknown>;
        acknowledged = ack.requestId === previous.requestId;
      } catch { /* no acknowledgement yet */ }
      if (!acknowledged) throw new Error("session_control_pending：上一个控制请求尚未确认");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const request: SessionControlRequest = {
      sessionId, executionId: record.snapshot.executionId, requestId: randomUUID(), kind, requestedAt: new Date().toISOString(), acknowledgedAt: null,
    };
    await atomicWrite(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ack = JSON.parse(await readFile(ackPath, "utf8")) as Record<string, unknown>;
        if (ack.sessionId === sessionId && ack.executionId === request.executionId && ack.requestId === request.requestId && ack.kind === kind && typeof ack.acknowledgedAt === "string") return;
      } catch { /* owner has not acknowledged yet */ }
      if (!await this.hasLiveOwner(sessionId)) throw new Error("session_owner_exited：运行 owner 在确认控制请求前退出");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("session_control_timeout：等待运行 owner 确认超时；请用 session show 检查状态");
  }

  async readControlRequest(sessionId: string): Promise<SessionControlRequest | undefined> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.sessionDirectory(sessionId), "control", "request.json"), "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session_control_invalid：控制请求不是对象");
    const item = raw as Record<string, unknown>;
    if (item.sessionId !== sessionId || !UUID.test(String(item.requestId)) || !UUID.test(String(item.executionId)) ||
        (item.kind !== "pause" && item.kind !== "cancel") || typeof item.requestedAt !== "string") throw new Error("session_control_invalid：控制请求身份或字段无效");
    return { sessionId, requestId: item.requestId as string, executionId: item.executionId as string, kind: item.kind, requestedAt: item.requestedAt as string, acknowledgedAt: null };
  }

  async saveControlAck(request: SessionControlRequest, acknowledgedAt: string): Promise<void> {
    const controlDir = join(this.sessionDirectory(request.sessionId), "control");
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    await atomicWrite(join(controlDir, "ack.json"), `${JSON.stringify({
      sessionId: request.sessionId, executionId: request.executionId, requestId: request.requestId,
      kind: request.kind, requestedAt: request.requestedAt, acknowledgedAt,
    }, null, 2)}\n`);
  }

  async appendSchedulerEvent(sessionId: string, executionId: string, event: string, details: Omit<SessionSchedulerEvent, "sequence" | "sessionId" | "executionId" | "event" | "occurredAt"> = {}): Promise<SessionSchedulerEvent> {
    if (!UUID.test(sessionId) || !UUID.test(executionId) || !/^[a-z][a-z0-9_.-]{0,63}$/.test(event)) throw new Error("scheduler_event_invalid：事件身份或名称无效");
    if ((details.taskId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(details.taskId)) ||
        (details.attemptId !== undefined && !UUID.test(details.attemptId)) ||
        (details.waveId !== undefined && !UUID.test(details.waveId)) ||
        (details.reasonCode !== undefined && !/^[a-z][a-z0-9_.-]{0,95}$/.test(details.reasonCode))) throw new Error("scheduler_event_invalid：事件详情字段无效");
    const record = await this.load(sessionId);
    if (record.snapshot.schemaVersion !== 3 || record.snapshot.executionId !== executionId) throw new Error("scheduler_event_stale：事件不属于 Session 当前 executionId");
    const path = join(this.sessionDirectory(sessionId), "scheduler-events.jsonl");
    let sequence = 1;
    try {
      const contents = await readFile(path, "utf8");
      const lines = contents.trimEnd().split("\n");
      if (contents.length && !contents.endsWith("\n")) throw new Error("scheduler_event_log_corrupt：事件日志末尾缺少换行");
      if (lines.length && lines[0] !== "") {
        const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
        if (!Number.isSafeInteger(last.sequence) || typeof last.sessionId !== "string" || typeof last.executionId !== "string") throw new Error("scheduler_event_log_corrupt：末尾事件身份无效");
        if (last.sessionId !== sessionId) throw new Error("scheduler_event_session_mismatch：日志尾部属于其他 Session");
        sequence = (last.sequence as number) + 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const value: SessionSchedulerEvent = { sequence, sessionId, executionId, event, occurredAt: new Date().toISOString(), ...details };
    await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    return value;
  }

  async beginExecution(record: SessionRecord): Promise<SessionRecord> {
    const previous = record.snapshot;
    const next: SessionSnapshot = {
      ...previous, schemaVersion: 3, revision: previous.revision + 1, status: "ready", isolation: previous.isolation ?? { mode: "shared" },
      maxParallel: previous.maxParallel ?? 1, planDigest: digestPlan(record.plan), executionId: randomUUID(),
      schedulerState: "idle", waveId: null, activeAttemptIds: [],
      controlState: { requestId: null, kind: null, requestedAt: null, acknowledgedAt: null }, updatedAt: new Date().toISOString(),
    };
    await this.save(next);
    return { ...record, snapshot: next };
  }

  async saveHandoff(attemptId: string, value: unknown): Promise<void> {
    if (!UUID.test(attemptId)) throw new Error("attemptId 必须是 UUID");
    const attemptDir = join(this.root, "runs", attemptId);
    await stat(attemptDir);
    await atomicWrite(join(attemptDir, "handoff.json"), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readAttempt(attemptId: string): Promise<unknown> {
    if (!UUID.test(attemptId)) throw new Error("attemptId 必须是 UUID");
    const text = await readFile(join(this.root, "runs", attemptId, "attempt.json"), "utf8");
    return JSON.parse(text) as unknown;
  }

  async readHandoff(attemptId: string): Promise<unknown> {
    if (!UUID.test(attemptId)) throw new Error("attemptId 必须是 UUID");
    const text = await readFile(join(this.root, "runs", attemptId, "handoff.json"), "utf8");
    return JSON.parse(text) as unknown;
  }

  sessionDirectory(sessionId: string): string {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    return join(this.root, "sessions", sessionId);
  }

  private async hasLiveOwner(sessionId: string): Promise<boolean> {
    let owner: { pid?: number; sessionId?: string | null };
    try { owner = JSON.parse(await readFile(join(this.root, "workspace.lock"), "utf8")) as typeof owner; }
    catch { return false; }
    if (!Number.isSafeInteger(owner.pid) || owner.sessionId !== sessionId) return false;
    try { process.kill(owner.pid!, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }

}

function parseIsolationJournal(value: unknown, sessionId: string, workspace: string, isolation: Extract<SessionIsolation, { mode: "git-worktree" }>, plan: PlanDefinition): GitIsolationJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git worktree journal 必须是对象");
  const raw = value as Record<string, unknown>;
  const isOid = (item: unknown): item is string => typeof item === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item);
  const attempts = raw.attempts;
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || raw.sessionId !== sessionId || !["initializing", "ready", "blocked"].includes(String(raw.status)) ||
      !isOid(raw.integrationHead) || !Array.isArray(attempts) || attempts.length > 10_000 || typeof raw.updatedAt !== "string") {
    throw new Error("Git worktree journal 字段无效");
  }
  const ids = new Set<string>();
  const parsed = attempts.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git Attempt 隔离记录无效");
    const item = value as Record<string, unknown>;
    const expectedPath = join(workspace, ".token-coupon", "worktrees", sessionId, "attempts", String(item.attemptId));
    const legacyStatuses = ["creating", "ready", "committing", "committed", "landed", "no_changes", "failed", "blocked"];
    const parallelStatuses = [...legacyStatuses, "merging", "conflicted", "cancelled"];
    const validParents = item.mergeParents === undefined || (Array.isArray(item.mergeParents) && item.mergeParents.length <= 2 && item.mergeParents.every(isOid));
    const validConflicts = item.conflictPaths === undefined || (Array.isArray(item.conflictPaths) && item.conflictPaths.length <= 10_000 && item.conflictPaths.every((path) => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..")));
    if (!UUID.test(String(item.attemptId)) || typeof item.taskId !== "string" || !plan.tasks.some(({ task }) => task.id === item.taskId) || ids.has(String(item.attemptId)) ||
        !isOid(item.baseCommit) || typeof item.branch !== "string" || item.branch !== `token-coupon/attempt/${item.attemptId}` ||
        item.worktreePath !== expectedPath || !(raw.schemaVersion === 1 ? legacyStatuses : parallelStatuses).includes(String(item.status)) ||
        (item.taskCommit !== null && !isOid(item.taskCommit)) || !Array.isArray(item.changedFiles) || item.changedFiles.length > 10_000 ||
        item.changedFiles.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) ||
        (item.reasonCode !== null && typeof item.reasonCode !== "string") ||
        (item.waveId !== undefined && !UUID.test(String(item.waveId))) || (item.executionId !== undefined && !UUID.test(String(item.executionId))) ||
        (item.preIntegrationHead !== undefined && item.preIntegrationHead !== null && !isOid(item.preIntegrationHead)) ||
        (item.integrationCommit !== undefined && item.integrationCommit !== null && !isOid(item.integrationCommit)) ||
        (item.postIntegrationHead !== undefined && item.postIntegrationHead !== null && !isOid(item.postIntegrationHead)) || !validParents || !validConflicts ||
        (item.recoveryStage !== undefined && !["task_committed", "merge_started", "merge_applied", "journal_saved"].includes(String(item.recoveryStage)))) throw new Error("Git Attempt 隔离字段无效");
    ids.add(String(item.attemptId));
    return item;
  });
  if (isolation.repositoryRoot !== workspace && !isolation.repositoryRoot.startsWith(workspace + "/") && !workspace.startsWith(isolation.repositoryRoot + "/")) {
    throw new Error("Git worktree journal 与仓库边界不匹配");
  }
  return { schemaVersion: raw.schemaVersion as GitIsolationJournal["schemaVersion"], sessionId, status: raw.status as GitIsolationJournal["status"], integrationHead: raw.integrationHead, attempts: parsed as unknown as GitIsolationJournal["attempts"], updatedAt: raw.updatedAt };
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.snapshot-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function parseSnapshot(value: unknown, plan: PlanDefinition, workspace: string, sessionId: string): SessionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session 快照必须是对象");
  const raw = value as Record<string, unknown>;
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) || raw.sessionId !== sessionId || raw.workspace !== workspace || raw.planId !== plan.id || raw.planTitle !== plan.title) {
    throw new Error("Session 快照版本、目录或计划身份不匹配");
  }
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 || !SESSION_STATUSES.has(String(raw.status))) throw new Error("Session 快照 revision/status 无效");
  if (raw.schemaVersion === 3 && (!Number.isSafeInteger(raw.maxParallel) || (raw.maxParallel as number) < 1 || (raw.maxParallel as number) > 8 ||
      typeof raw.planDigest !== "string" || !/^[0-9a-f]{64}$/i.test(raw.planDigest) || raw.planDigest !== digestPlan(plan) ||
      typeof raw.executionId !== "string" || !UUID.test(raw.executionId) ||
      !["idle", "dispatching", "draining", "paused", "failed", "blocked", "cancelled"].includes(String(raw.schedulerState)) ||
      !(raw.waveId === null || (typeof raw.waveId === "string" && UUID.test(raw.waveId))) || !Array.isArray(raw.activeAttemptIds) ||
      raw.activeAttemptIds.length > 8 || raw.activeAttemptIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
      !raw.controlState || typeof raw.controlState !== "object" || Array.isArray(raw.controlState))) throw new Error("Session v3 执行身份或调度字段无效");
  if (raw.schemaVersion === 3 && (raw.isolation && typeof raw.isolation === "object" && (raw.isolation as Record<string, unknown>).mode === "shared") && raw.maxParallel !== 1) {
    throw new Error("shared workspace 只支持 maxParallel=1");
  }
  if (raw.schemaVersion === 3) {
    const control = raw.controlState as Record<string, unknown>;
    if (Object.keys(control).some((key) => !["requestId", "kind", "requestedAt", "acknowledgedAt"].includes(key)) ||
        !["requestId", "kind", "requestedAt", "acknowledgedAt"].every((key) => key in control) ||
        (control.requestId !== null && (typeof control.requestId !== "string" || !UUID.test(control.requestId))) ||
        (control.kind !== null && control.kind !== "pause" && control.kind !== "cancel") ||
        (control.requestedAt !== null && typeof control.requestedAt !== "string") ||
        (control.acknowledgedAt !== null && typeof control.acknowledgedAt !== "string") ||
        (control.requestId === null) !== (control.kind === null)) throw new Error("Session controlState 字段无效");
  }
  if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string" || !Array.isArray(raw.tasks)) throw new Error("Session 快照字段无效");
  let runnerProfile: SessionSnapshot["runnerProfile"];
  let runnerProfileHashValue: string | undefined;
  if (raw.runnerProfile !== undefined || raw.runnerProfileHash !== undefined) {
    if (raw.runnerProfile === undefined || typeof raw.runnerProfileHash !== "string" || !/^[0-9a-f]{64}$/i.test(raw.runnerProfileHash)) throw new Error("Session Runner profile/hash 必须同时存在");
    runnerProfile = parseRunnerProfile(raw.runnerProfile);
    runnerProfileHashValue = runnerProfileHash(runnerProfile);
    if (runnerProfileHashValue !== raw.runnerProfileHash) throw new Error("Session Runner profile hash 不匹配");
  }
  const expectedIds = plan.tasks.map(({ task }) => task.id);
  if (raw.tasks.length !== expectedIds.length) throw new Error("Session 任务数量与计划不匹配");
  const tasks: SessionTaskState[] = raw.tasks.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Session tasks[${index}] 无效`);
    const task = entry as Record<string, unknown>;
    if (task.taskId !== expectedIds[index] || !TASK_STATUSES.has(String(task.status)) || !Array.isArray(task.attempts)) throw new Error(`Session tasks[${index}] 与计划不匹配`);
    if (task.activeAttemptId !== null && (typeof task.activeAttemptId !== "string" || !UUID.test(task.activeAttemptId))) throw new Error(`Session tasks[${index}].activeAttemptId 无效`);
    const attempts = task.attempts.map((attempt, attemptIndex) => {
      if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) throw new Error(`Session tasks[${index}].attempts[${attemptIndex}] 无效`);
      const ref = attempt as Record<string, unknown>;
      if (typeof ref.attemptId !== "string" || !UUID.test(ref.attemptId) || ref.artifactDir !== join(workspace, ".token-coupon", "runs", ref.attemptId) || !["pending", "recorded", "record_missing"].includes(String(ref.outcome)) ||
          (ref.lastActivityAt !== undefined && typeof ref.lastActivityAt !== "string") || (ref.idleSince !== undefined && typeof ref.idleSince !== "string")) throw new Error(`Session tasks[${index}].attempts[${attemptIndex}] 引用无效`);
      return { attemptId: ref.attemptId, artifactDir: ref.artifactDir as string, outcome: ref.outcome as "pending" | "recorded" | "record_missing",
        ...(ref.lastActivityAt === undefined ? {} : { lastActivityAt: ref.lastActivityAt }), ...(ref.idleSince === undefined ? {} : { idleSince: ref.idleSince }) };
    });
    if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length) throw new Error(`Session tasks[${index}] 存在重复 Attempt`);
    let result: SessionTaskState["result"] = null;
    if (task.result !== null) {
      if (!task.result || typeof task.result !== "object" || Array.isArray(task.result)) throw new Error(`Session tasks[${index}].result 无效`);
      const rawResult = task.result as Record<string, unknown>;
      const lastAttemptId = attempts.at(-1)?.attemptId;
      if (rawResult.taskId !== task.taskId || rawResult.attemptId !== lastAttemptId || rawResult.status !== "succeeded" ||
          typeof rawResult.summary !== "string" || Buffer.byteLength(rawResult.summary, "utf8") > 8 * 1024 ||
          !["final", "stream", "none"].includes(String(rawResult.summarySource)) || typeof rawResult.truncated !== "boolean" ||
          rawResult.artifactDir !== join(workspace, ".token-coupon", "runs", String(lastAttemptId))) {
        throw new Error(`Session tasks[${index}].result 与 Attempt 不匹配`);
      }
      result = rawResult as unknown as SessionTaskState["result"];
    }
    if (task.status === "succeeded" && result === null) throw new Error(`Session tasks[${index}] 成功但缺少结果`);
    if (task.status === "running" && (typeof task.activeAttemptId !== "string" || !attempts.some((attempt) => attempt.attemptId === task.activeAttemptId && attempt.outcome === "pending"))) throw new Error(`Session tasks[${index}] running 状态缺少待确认 Attempt`);
    if (task.status !== "running" && task.activeAttemptId !== null) throw new Error(`Session tasks[${index}] 非 running 状态却保留活动 Attempt`);
    if (attempts.some((attempt) => attempt.outcome === "pending" && (task.status !== "running" || attempt.attemptId !== task.activeAttemptId))) throw new Error(`Session tasks[${index}] 存在非活动的 pending Attempt`);
    if (task.status !== "succeeded" && result !== null) throw new Error(`Session tasks[${index}] 未成功却保存了成功结果`);
    if (task.reasonCode !== null && typeof task.reasonCode !== "string") throw new Error(`Session tasks[${index}].reasonCode 无效`);
    return {
      taskId: task.taskId as string,
      status: task.status as SessionTaskState["status"],
      activeAttemptId: task.activeAttemptId as string | null,
      attempts,
      result,
      reasonCode: task.reasonCode as string | null,
    };
  });
  const status = raw.status as SessionSnapshot["status"];
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const maxParallel = raw.schemaVersion === 3 ? raw.maxParallel as number : 1;
  if (runningCount > maxParallel ||
      ((runningCount > 0) !== (["running", "pausing"].includes(status))) ||
      (raw.schemaVersion !== 3 && runningCount > 1)) throw new Error("Session 快照的运行状态与任务状态不一致");
  if (raw.schemaVersion === 3) {
    const activeIds = new Set(raw.activeAttemptIds as string[]);
    const runningIds = new Set(tasks.flatMap((task) => task.activeAttemptId ? [task.activeAttemptId] : []));
    if (activeIds.size !== runningIds.size || [...activeIds].some((id) => !runningIds.has(id))) throw new Error("Session 活跃 Attempt 清单与任务状态不一致");
    if (status === "paused" && (runningCount > 0 || raw.schedulerState !== "paused")) throw new Error("paused Session 仍有运行任务或 schedulerState 不匹配");
  }
  if (tasks.length > 0 && tasks.every((task) => task.status === "succeeded") && status !== "succeeded") throw new Error("所有任务已成功但 Session 未完成");
  let isolation: SessionIsolation | undefined;
  if (raw.schemaVersion === 2 || raw.schemaVersion === 3) {
    const record = raw.isolation;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Session v2 缺少隔离执行记录");
    const item = record as Record<string, unknown>;
    if (item.mode === "shared") {
      if (Object.keys(item).some((key) => key !== "mode")) throw new Error("shared 隔离记录字段无效");
      isolation = { mode: "shared" };
    } else if (item.mode === "git-worktree") {
      const expected = ["mode", "status", "repositoryRoot", "gitCommonDir", "baseCommit", "sourceBranch", "integrationBranch", "integrationWorktree", "verificationTaskId", "setupHash"];
      const expectedWorktree = join(workspace, ".token-coupon", "worktrees", sessionId, "integration");
      if (Object.keys(item).some((key) => !expected.includes(key)) || expected.some((key) => !(key in item)) ||
          !["initializing", "ready", "blocked"].includes(String(item.status)) ||
          item.repositoryRoot !== workspace ||
          typeof item.gitCommonDir !== "string" || !item.gitCommonDir.startsWith("/") ||
          typeof item.baseCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item.baseCommit) ||
          (item.sourceBranch !== null && (typeof item.sourceBranch !== "string" || !item.sourceBranch)) ||
          item.integrationBranch !== `token-coupon/session/${sessionId}` ||
          item.integrationWorktree !== expectedWorktree ||
          typeof item.verificationTaskId !== "string" || !plan.tasks.some(({ task }) => task.id === item.verificationTaskId) ||
          (item.setupHash !== null && (typeof item.setupHash !== "string" || !/^[0-9a-f]{64}$/i.test(item.setupHash)))) {
        throw new Error("Git worktree 隔离记录无效");
      }
      isolation = item as unknown as SessionIsolation;
    } else throw new Error("Session 隔离模式无效");
  } else if ("isolation" in raw) throw new Error("Session v1 不能携带 v2 隔离字段");
  const phase5Fields = raw.schemaVersion === 3 ? {
    maxParallel,
    planDigest: raw.planDigest as string,
    executionId: raw.executionId as string,
    schedulerState: raw.schedulerState as NonNullable<SessionSnapshot["schedulerState"]>,
    waveId: raw.waveId as string | null,
    activeAttemptIds: raw.activeAttemptIds as string[],
    controlState: raw.controlState as NonNullable<SessionSnapshot["controlState"]>,
  } : {};
  return { schemaVersion: raw.schemaVersion as SessionSnapshot["schemaVersion"], sessionId, workspace, revision: raw.revision as number, status, planId: plan.id, planTitle: plan.title, tasks, ...(isolation ? { isolation } : {}), ...phase5Fields, ...(runnerProfile && runnerProfileHashValue ? { runnerProfile, runnerProfileHash: runnerProfileHashValue } : {}), createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}

function digestPlan(plan: PlanDefinition): string {
  return createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex");
}
