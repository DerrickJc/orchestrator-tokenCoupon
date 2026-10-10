import { randomUUID } from "node:crypto";
import { appendFile, lstat, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { AttemptRecord } from "./attempt.js";

export async function currentAttemptOwner(): Promise<NonNullable<AttemptRecord["owner"]>> {
  const processStart = await readProcessStart(process.pid);
  return { pid: process.pid, hostname: hostname(), ...(processStart ? { processStart } : {}) };
}

/** Does not kill processes or infer task success. Unknown native cleanup requires operator verification. */
export async function recoverAbandonedAttempt(options: { workspace: string; attemptId: string; confirmedStopped?: boolean }): Promise<AttemptRecord> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.attemptId)) throw new Error("attemptId 必须是 UUID");
  const directory = join(resolve(options.workspace), ".token-coupon", "runs", options.attemptId);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Attempt 目录不能为符号链接");
  const lockPath = join(directory, ".recovery.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const attemptPath = join(directory, "attempt.json");
    const original = await readOrdinaryFile(attemptPath, 1024 * 1024);
    const attempt = JSON.parse(original) as AttemptRecord;
    if (attempt.attemptId !== options.attemptId || !["created", "running"].includes(attempt.status)) throw new Error("只能恢复身份匹配的未结束 Attempt；已结束记录保持不变");
    if (attempt.owner) {
      if (attempt.owner.hostname !== hostname()) throw new Error("Attempt owner 位于其他主机，无法确认已停止");
      if (!Number.isSafeInteger(attempt.owner.pid) || attempt.owner.pid < 1) throw new Error("Attempt owner PID 无效");
      let alive = true;
      try { process.kill(attempt.owner.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive && attempt.owner.processStart) {
        const start = await readProcessStart(attempt.owner.pid);
        if (start && start !== attempt.owner.processStart) alive = false;
      }
      if (alive) throw new Error("Attempt owner 仍在运行，拒绝恢复");
    } else if (!options.confirmedStopped) throw new Error("历史 Attempt 缺少 owner 信息；确认原生执行已停止后显式使用 --confirm-stopped");
    // A dead parent alone does not prove that its native descendants have stopped.
    if (!options.confirmedStopped) throw new Error("请确认原生子进程已停止后使用 --confirm-stopped；恢复不会终止进程");
    const eventsPath = join(directory, "events.jsonl");
    const lines = (await readOrdinaryFile(eventsPath, 16 * 1024 * 1024)).trim().split("\n").filter(Boolean);
    let sequence = 0;
    for (const line of lines) {
      const event = JSON.parse(line) as { sequence: number; attemptId: string };
      if (event.attemptId !== attempt.attemptId || !Number.isSafeInteger(event.sequence) || event.sequence <= sequence) throw new Error("Attempt 日志身份或序号无效，拒绝恢复");
      sequence = event.sequence;
    }
    const finishedAt = new Date().toISOString();
    const recovered: AttemptRecord = { ...attempt, status: "failed", finishedAt, nativeOutcome: "incomplete", cleanupStatus: "unknown",
      reasonCode: "owner_interrupted", reason: "执行 owner 已中断，未取得完整结束证据；已由操作者确认原生执行停止" };
    await writeFile(join(directory, `attempt.before-recovery-${randomUUID()}.json`), original, { flag: "wx", mode: 0o600 });
    const expiredRequestIds: string[] = [];
    const interactions = join(directory, "interactions");
    for (const filename of await readdir(interactions).catch(() => [])) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(filename)) continue;
      const path = join(interactions, filename);
      const request = JSON.parse(await readOrdinaryFile(path, 64 * 1024)) as Record<string, unknown>;
      if (request.attemptId !== attempt.attemptId || request.requestId !== filename.slice(0, -5) || !["pending", "response_submitted"].includes(String(request.status))) continue;
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...request, status: "expired", reason: "owner_interrupted" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      expiredRequestIds.push(String(request.requestId));
    }
    const payload = { status: recovered.status, reasonCode: recovered.reasonCode, cleanupStatus: "unknown", confirmedStopped: true, expiredRequestIds };
    await appendFile(eventsPath, JSON.stringify({ sequence: ++sequence, timestamp: finishedAt, attemptId: attempt.attemptId, type: "attempt.recovered", payload }) + "\n");
    const temporary = join(directory, `.attempt-recovery-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(recovered, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, attemptPath);
    return recovered;
  } finally { await lock.close(); await unlink(lockPath); }
}

async function readProcessStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  } catch { return undefined; }
}

async function readOrdinaryFile(path: string, limit: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("Attempt 文件不安全或超过大小限制");
  return readFile(path, "utf8");
}
