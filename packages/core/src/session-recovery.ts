import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptRecord } from "./attempt.js";
import { recoverAbandonedAttempt } from "./attempt-recovery.js";
import { acquireLockCoordination, inspectLock, observeOwner, type LockObservation, type OwnerObservation } from "./owner-lock.js";
import { SessionStore } from "./session-store.js";
import { reconcileInterruptedSession } from "./task-orchestrator.js";
import type { SessionRecord } from "./session-types.js";

export interface SessionDiagnosis {
  sessionId: string; savedStatus: string; revision: number; isolation: string; maxParallel: number;
  state: "active" | "owner_exited" | "unknown" | "identity_conflict" | "idle";
  locks: LockObservation[];
  attempts: Array<{ taskId: string; attemptId: string; status: string; owner: OwnerObservation }>;
}
function lockPaths(store: SessionStore, record: SessionRecord): string[] {
  return [...(record.snapshot.isolation?.mode === "git-worktree" ? [join(record.snapshot.isolation.gitCommonDir, "token-coupon-worktree.lock")] : []), join(store.workspace, ".token-coupon", "workspace.lock")];
}
export async function diagnoseSession(workspace: string, sessionId: string): Promise<SessionDiagnosis> {
  const store = new SessionStore(workspace);
  const record = await store.load(sessionId);
  const locks = await Promise.all(lockPaths(store, record).map(inspectLock));
  const attempts: SessionDiagnosis["attempts"] = [];
  let conflict = locks.some((lock) => lock.exists && lock.owner && lock.owner.sessionId !== sessionId);
  for (const task of record.snapshot.tasks.filter((t) => t.activeAttemptId || t.status === "running")) {
    if (!task.activeAttemptId) { conflict = true; continue; }
    const raw = await store.readAttempt(task.activeAttemptId).catch(() => undefined) as AttemptRecord | undefined;
    if (!raw || raw.attemptId !== task.activeAttemptId || raw.taskId !== task.taskId) { conflict = true; continue; }
    attempts.push({ taskId: task.taskId, attemptId: raw.attemptId, status: raw.status, owner: await observeOwner(raw.owner) });
  }
  // Persisted terminal attempts may legitimately outlive their owner process.
  const observations = [...locks.filter((l) => l.exists), ...attempts.filter((a) => ["created", "running"].includes(a.status)).map((a) => a.owner)];
  const state = conflict ? "identity_conflict" : observations.some((o) => o.state === "active") ? "active"
    : observations.some((o) => o.state === "unknown") ? "unknown"
      : observations.length ? "owner_exited" : record.snapshot.tasks.some((t) => t.status === "running") ? "owner_exited" : "idle";
  return { sessionId, savedStatus: record.snapshot.status, revision: record.snapshot.revision, isolation: record.snapshot.isolation?.mode ?? "shared", maxParallel: record.snapshot.maxParallel ?? 1, state, locks, attempts };
}
export function formatSessionDiagnosis(d: SessionDiagnosis): string {
  return [`当前检查：${d.state}；保存状态：${d.savedStatus}；revision：${d.revision}；隔离：${d.isolation}；并发：${d.maxParallel}`,
    ...d.locks.map((l) => `锁：${l.path} · ${l.exists ? l.state : "absent"} · PID ${l.owner?.pid ?? "未知"} · ${l.reason}`),
    ...d.attempts.map((a) => `Task ${a.taskId} · Attempt ${a.attemptId} · ${a.status} · owner ${a.owner.state}：${a.owner.reason}`),
    d.state === "owner_exited" ? "建议：确认原生执行停止后 /recover；再 /retry <taskId>，成功后 /resume。恢复不会启动任务。" : d.state === "active" ? "活动 owner 持有执行；请等待或通过第二终端处理待审批请求。" : d.state === "idle" ? "当前无活动执行或遗留锁，无需恢复。" : "未知或冲突身份不会自动恢复；请先核验。"].join("\n");
}
interface RecoveryRecord { schemaVersion: 1; recoveryId: string; sessionId: string; stage: "prepared" | "attempts" | "session" | "completed"; before: SessionRecord["snapshot"]; locks: LockObservation[]; createdAt: string; updatedAt: string; }
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
/** Explicit, coordinated recovery. Never kills, retries, lands commits or invents success. */
export async function recoverSession(options: { workspace: string; sessionId: string; confirmedStopped?: boolean }): Promise<{ diagnosis: SessionDiagnosis; recovered: boolean; recoveryId?: string }> {
  const store = new SessionStore(options.workspace);
  const initial = await store.load(options.sessionId);
  if (!options.confirmedStopped) return { diagnosis: await diagnoseSession(options.workspace, options.sessionId), recovered: false };
  const release = await acquireLockCoordination(lockPaths(store, initial));
  try {
    let record = await store.load(options.sessionId);
    const diagnosis = await diagnoseSession(options.workspace, options.sessionId);
    if (["active", "unknown", "identity_conflict"].includes(diagnosis.state)) throw new Error(`session_recovery_refused：${formatSessionDiagnosis(diagnosis)}`);
    const directory = join(store.sessionDirectory(options.sessionId), "recovery");
    const ledgerPath = join(directory, "current.json");
    let ledger = await readFile(ledgerPath, "utf8").then((s) => JSON.parse(s) as RecoveryRecord).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
    if (ledger && (ledger.sessionId !== options.sessionId || ledger.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(ledger.recoveryId) || !["prepared", "attempts", "session", "completed"].includes(ledger.stage) || !Array.isArray(ledger.locks) || ledger.before?.sessionId !== options.sessionId || ledger.locks.some((l) => !lockPaths(store, initial).includes(l.path)))) throw new Error("recovery_identity_conflict");
    if (diagnosis.state === "idle" && (!ledger || ledger.stage === "completed")) return { diagnosis, recovered: false, ...(ledger ? { recoveryId: ledger.recoveryId } : {}) };
    if (!ledger || ledger.stage === "completed") {
      if (record.snapshot.revision !== initial.snapshot.revision) throw new Error("session_revision_changed：预检后 Session 已变化");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const recoveryId = randomUUID();
      ledger = { schemaVersion: 1, recoveryId, sessionId: options.sessionId, stage: "prepared", before: record.snapshot, locks: diagnosis.locks, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeFile(join(directory, `${recoveryId}.before.json`), JSON.stringify(ledger, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await atomicJson(ledgerPath, ledger);
    }
    const checkpoint = async (stage: RecoveryRecord["stage"]) => {
      ledger!.stage = stage; ledger!.updatedAt = new Date().toISOString(); await atomicJson(ledgerPath, ledger);
    };
    for (const previous of ledger.locks.filter((l) => l.exists)) {
      const current = await inspectLock(previous.path);
      if (current.exists && current.identity !== previous.identity) throw new Error("lock_identity_changed：不会移动新的 owner 锁");
    }
    if (ledger.stage === "prepared") {
      for (const task of record.snapshot.tasks.filter((t) => t.activeAttemptId)) {
        const raw = await store.readAttempt(task.activeAttemptId!) as AttemptRecord;
        if (["created", "running"].includes(raw.status)) await recoverAbandonedAttempt({ workspace: store.workspace, attemptId: raw.attemptId, confirmedStopped: true });
      }
      await checkpoint("attempts");
    }
    if (ledger.stage === "attempts") {
      record = await reconcileInterruptedSession(await store.load(options.sessionId), store);
      const snapshot = { ...record.snapshot, revision: record.snapshot.revision + 1, executionId: randomUUID(), controlState: { requestId: null, kind: null, requestedAt: null, acknowledgedAt: null }, updatedAt: new Date().toISOString() };
      await store.save(snapshot);
      await checkpoint("session");
    }
    if (ledger.stage === "session") {
      for (const name of ["request.json", "ack.json"]) {
        const path = join(store.sessionDirectory(options.sessionId), "control", name);
        const info = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error("recovery_control_invalid：控制记录无法安全备份");
        const control = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        if (control.sessionId !== options.sessionId) throw new Error("recovery_control_identity_conflict");
        await rename(path, join(directory, `${ledger.recoveryId}.control-${name}`));
      }
      const saved = await store.load(options.sessionId);
      const events = await readFile(join(store.sessionDirectory(options.sessionId), "scheduler-events.jsonl"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return ""; });
      const recoveryCode = `recovery_${ledger.recoveryId}`;
      if (saved.snapshot.schemaVersion === 3 && !events.split("\n").filter(Boolean).some((line) => { const event = JSON.parse(line); return event.event === "scheduler.recovered" && event.reasonCode === recoveryCode; })) {
        await store.appendSchedulerEvent(options.sessionId, saved.snapshot.executionId!, "scheduler.recovered", { reasonCode: recoveryCode });
      }
      for (const previous of ledger.locks.filter((l) => l.exists)) {
        const current = await inspectLock(previous.path);
        if (!current.exists) continue;
        if (current.identity !== previous.identity) throw new Error("lock_identity_changed：恢复未完成，拒绝移动新锁");
        await rename(previous.path, `${previous.path}.before-recovery-${ledger.recoveryId}`);
      }
      await atomicJson(join(directory, `${ledger.recoveryId}.json`), { ...ledger, stage: "completed" });
      await checkpoint("completed");
    }
    return { diagnosis: await diagnoseSession(options.workspace, options.sessionId), recovered: true, recoveryId: ledger.recoveryId };
  } finally { await release(); }
}
