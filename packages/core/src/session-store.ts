import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PlanDefinition } from "./plan.js";
import type { GitIsolationJournal, SessionIsolation, SessionRecord, SessionSnapshot, SessionTaskState } from "./session-types.js";
import { parsePlan } from "./validate-plan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATUSES = new Set(["ready", "running", "succeeded", "failed", "cancelled", "interrupted"]);
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

  async create(plan: PlanDefinition, sessionId: string = randomUUID(), isolation: SessionIsolation = { mode: "shared" }): Promise<SessionRecord> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const sessionDir = join(this.root, "sessions", sessionId);
    const now = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      schemaVersion: 2, sessionId, workspace: this.workspace, revision: 1, status: "ready", isolation,
      planId: plan.id, planTitle: plan.title,
      tasks: plan.tasks.map(({ task }) => ({ taskId: task.id, status: "planned", activeAttemptId: null, attempts: [], result: null, reasonCode: null })),
      createdAt: now, updatedAt: now,
    };
    await mkdir(dirname(sessionDir), { recursive: true });
    await mkdir(sessionDir, { recursive: false });
    await writeFile(join(sessionDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    await this.save(snapshot);
    if (isolation.mode === "git-worktree") {
      const journal: GitIsolationJournal = { schemaVersion: 1, sessionId, status: "initializing", integrationHead: isolation.baseCommit, attempts: [], updatedAt: now };
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

}

function parseIsolationJournal(value: unknown, sessionId: string, workspace: string, isolation: Extract<SessionIsolation, { mode: "git-worktree" }>, plan: PlanDefinition): GitIsolationJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git worktree journal 必须是对象");
  const raw = value as Record<string, unknown>;
  const isOid = (item: unknown): item is string => typeof item === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item);
  const attempts = raw.attempts;
  if (raw.schemaVersion !== 1 || raw.sessionId !== sessionId || !["initializing", "ready", "blocked"].includes(String(raw.status)) ||
      !isOid(raw.integrationHead) || !Array.isArray(attempts) || attempts.length > 10_000 || typeof raw.updatedAt !== "string") {
    throw new Error("Git worktree journal 字段无效");
  }
  const ids = new Set<string>();
  const parsed = attempts.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git Attempt 隔离记录无效");
    const item = value as Record<string, unknown>;
    const expectedPath = join(workspace, ".token-coupon", "worktrees", sessionId, "attempts", String(item.attemptId));
    if (!UUID.test(String(item.attemptId)) || typeof item.taskId !== "string" || !plan.tasks.some(({ task }) => task.id === item.taskId) || ids.has(String(item.attemptId)) ||
        !isOid(item.baseCommit) || typeof item.branch !== "string" || item.branch !== `token-coupon/attempt/${item.attemptId}` ||
        item.worktreePath !== expectedPath || !["creating", "ready", "committing", "committed", "landed", "no_changes", "failed", "blocked"].includes(String(item.status)) ||
        (item.taskCommit !== null && !isOid(item.taskCommit)) || !Array.isArray(item.changedFiles) || item.changedFiles.length > 10_000 ||
        item.changedFiles.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) ||
        (item.reasonCode !== null && typeof item.reasonCode !== "string")) throw new Error("Git Attempt 隔离字段无效");
    ids.add(String(item.attemptId));
    return item;
  });
  if (isolation.repositoryRoot !== workspace && !isolation.repositoryRoot.startsWith(workspace + "/") && !workspace.startsWith(isolation.repositoryRoot + "/")) {
    throw new Error("Git worktree journal 与仓库边界不匹配");
  }
  return { schemaVersion: 1, sessionId, status: raw.status as GitIsolationJournal["status"], integrationHead: raw.integrationHead, attempts: parsed as unknown as GitIsolationJournal["attempts"], updatedAt: raw.updatedAt };
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
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || raw.sessionId !== sessionId || raw.workspace !== workspace || raw.planId !== plan.id || raw.planTitle !== plan.title) {
    throw new Error("Session 快照版本、目录或计划身份不匹配");
  }
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 || !SESSION_STATUSES.has(String(raw.status))) throw new Error("Session 快照 revision/status 无效");
  if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string" || !Array.isArray(raw.tasks)) throw new Error("Session 快照字段无效");
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
  if (runningCount > 1 || (runningCount === 1) !== (status === "running")) throw new Error("Session 快照的运行状态与任务状态不一致");
  if (tasks.length > 0 && tasks.every((task) => task.status === "succeeded") && status !== "succeeded") throw new Error("所有任务已成功但 Session 未完成");
  let isolation: SessionIsolation | undefined;
  if (raw.schemaVersion === 2) {
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
  return { schemaVersion: raw.schemaVersion as SessionSnapshot["schemaVersion"], sessionId, workspace, revision: raw.revision as number, status, planId: plan.id, planTitle: plan.title, tasks, ...(isolation ? { isolation } : {}), createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}
