import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PlanDefinition } from "./plan.js";
import type { SessionRecord, SessionSnapshot, SessionTaskState } from "./session-types.js";
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

  async create(plan: PlanDefinition, sessionId: string = randomUUID()): Promise<SessionRecord> {
    if (!UUID.test(sessionId)) throw new Error("sessionId 必须是 UUID");
    const sessionDir = join(this.root, "sessions", sessionId);
    const now = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      schemaVersion: 1, sessionId, workspace: this.workspace, revision: 1, status: "ready",
      planId: plan.id, planTitle: plan.title,
      tasks: plan.tasks.map(({ task }) => ({ taskId: task.id, status: "planned", activeAttemptId: null, attempts: [], result: null, reasonCode: null })),
      createdAt: now, updatedAt: now,
    };
    await mkdir(dirname(sessionDir), { recursive: true });
    await mkdir(sessionDir, { recursive: false });
    await writeFile(join(sessionDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    await this.save(snapshot);
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
    return { plan, snapshot };
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
  if (raw.schemaVersion !== 1 || raw.sessionId !== sessionId || raw.workspace !== workspace || raw.planId !== plan.id || raw.planTitle !== plan.title) {
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
  return { schemaVersion: 1, sessionId, workspace, revision: raw.revision as number, status, planId: plan.id, planTitle: plan.title, tasks, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}
