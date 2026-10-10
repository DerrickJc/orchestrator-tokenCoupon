import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface ProcessOwner { pid: number; hostname?: string; processStart?: string; bootId?: string; }
export type OwnerObservation = { state: "active" | "owner_exited" | "owner_identity_changed" | "unknown"; reason: string };
export interface ExecutionLock extends ProcessOwner { schemaVersion?: number; token: string; sessionId: string | null; acquiredAt: string; }
export interface LockObservation extends OwnerObservation { path: string; exists: boolean; owner?: ExecutionLock; identity?: string; }

export async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]; }
  catch { return undefined; }
}
export async function currentOwner(): Promise<ProcessOwner & { hostname: string }> {
  const start = await processStart(process.pid);
  const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").then((s) => s.trim()).catch(() => undefined);
  return { pid: process.pid, hostname: hostname(), ...(start ? { processStart: start } : {}), ...(bootId ? { bootId } : {}) };
}
export async function observeOwner(owner?: ProcessOwner): Promise<OwnerObservation> {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return { state: "unknown", reason: "owner 身份缺失或 PID 无效" };
  if (owner.hostname && owner.hostname !== hostname()) return { state: "unknown", reason: "owner 位于其他主机" };
  if (owner.bootId) {
    const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8").then((s) => s.trim()).catch(() => undefined);
    if (!boot) return { state: "unknown", reason: "无法核验启动身份" };
    if (boot !== owner.bootId) return { state: "owner_identity_changed", reason: "系统启动身份已变化" };
  }
  try { process.kill(owner.pid, 0); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? { state: "owner_exited", reason: "记录的 PID 已退出；原生子进程仍需人工确认停止" }
      : { state: "unknown", reason: "没有权限核验 owner" };
  }
  if (!owner.hostname || !owner.processStart) return { state: "unknown", reason: "PID 存活，但历史记录缺少主机/进程启动身份" };
  const start = await processStart(owner.pid);
  if (!start) return { state: "unknown", reason: "无法核验进程启动身份" };
  return start === owner.processStart
    ? { state: "active", reason: "owner 存活且身份一致" }
    : { state: "owner_identity_changed", reason: "PID 已被其他进程复用，不操作该新进程" };
}
export async function inspectLock(path: string): Promise<LockObservation> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error("锁不是普通文件或超过上限");
    const owner = JSON.parse(await readFile(path, "utf8")) as ExecutionLock;
    if (!owner || typeof owner.token !== "string" || !owner.token || (owner.sessionId !== null && typeof owner.sessionId !== "string")) throw new Error("锁身份无效");
    return { path, exists: true, owner, identity: `${info.dev}:${info.ino}:${owner.token}`, ...await observeOwner(owner) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false, state: "unknown", reason: "无锁文件" };
    return { path, exists: true, state: "unknown", reason: error instanceof Error ? error.message : "锁无法读取" };
  }
}
export function lockDescription(lock: LockObservation): string {
  const lead = lock.state === "active" ? "工作目录由活动 owner 持有"
    : lock.state === "owner_exited" || lock.state === "owner_identity_changed" ? "锁文件存在，但原 owner 已退出或身份变化"
      : "锁 owner 状态 unknown";
  return `${lead}（PID ${lock.owner?.pid ?? "未知"}，Session ${lock.owner?.sessionId ?? "未知"}）：${lock.reason}。请使用 /status、/recover 或 session recover 核验；不会自动解锁。`;
}

/** Kernel advisory locks release on process death: persistent guard files are not ownership. */
export async function acquireLockCoordination(paths: string[], waitSeconds = 0): Promise<() => Promise<void>> {
  if (process.platform !== "linux") throw new Error("lock_coordination_unsupported：当前恢复协调需要 Linux flock；不安全地降级解锁被禁止");
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const path of paths) {
      await mkdir(dirname(path), { recursive: true });
      const guard = `${path}.coord`;
      const info = await lstat(guard).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("协调文件必须是普通文件");
      const child = spawn("flock", ["-w", String(waitSeconds), "--", guard, process.execPath, "-e", "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: ["pipe", "pipe", "pipe"] });
      const exit = new Promise<void>((resolve) => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
      await new Promise<void>((resolve, reject) => {
        let diagnostic = "";
        child.stderr.on("data", (data: Buffer) => { diagnostic += data.toString().slice(0, 1024); });
        const onClose = (code: number | null) => reject(new Error(code === 1 ? "lock_coordination_busy：正在恢复或获取锁，请稍后重试" : `lock_coordination_failed：flock 退出 ${code} ${diagnostic}`));
        child.once("error", reject); child.once("close", onClose);
        child.stdout.once("data", () => { child.removeListener("close", onClose); child.removeListener("error", reject); resolve(); });
      });
      releases.push(async () => { child.stdin.end(); await exit; });
    }
  } catch (error) { for (const release of releases.reverse()) await release(); throw error; }
  return async () => { for (const release of releases.reverse()) await release(); };
}
export async function createExecutionLock(path: string, sessionId?: string): Promise<() => Promise<void>> {
  const releaseGuard = await acquireLockCoordination([path]);
  const owner: ExecutionLock = { ...await currentOwner(), schemaVersion: 2, token: randomUUID(), sessionId: sessionId ?? null, acquiredAt: new Date().toISOString() };
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner) + "\n"); } finally { await handle.close(); }
  } finally { await releaseGuard(); }
  return async () => {
    const release = await acquireLockCoordination([path], 3);
    try { const current = await inspectLock(path); if (current.owner?.token === owner.token) await unlink(path); }
    finally { await release(); }
  };
}
