import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLockCoordination, observeOwner } from "@token-coupon/core";
import { networkFetch } from "./network-fetch.js";
import { PRESERVE_TUNNEL, type TunnelAdapter, type TunnelRuntime } from "./quick-tunnel.js";

type ProcessOwner = NonNullable<Parameters<typeof observeOwner>[0]>;
export interface TunnelRecord extends ProcessOwner {
  version: 1; token: string; gatewayPort: number; controlPort: number;
  phase: "starting" | "running" | "error"; origin?: string; child?: ProcessOwner;
}
export const tunnelRecordPath = (directory: string) => join(directory, "supervisor.json");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function readTunnelRecord(directory: string): Promise<TunnelRecord | undefined> {
  const path = tunnelRecordPath(directory);
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384 || process.platform !== "win32" && (info.mode & 0o077)) throw new Error("tunnel_state_invalid：连接进程记录必须是仅当前用户可读写的普通文件");
  let item: TunnelRecord;
  try { item = JSON.parse(await readFile(path, "utf8")) as TunnelRecord; }
  catch { throw new Error("tunnel_state_invalid：连接进程记录无法读取，请检查组件状态；不会自动重建"); }
  if (!item || typeof item !== "object") throw new Error("tunnel_state_invalid：连接进程记录格式无效");
  if (item.version !== 1 || !Number.isSafeInteger(item.pid) || item.pid < 1 || !/^[a-f0-9]{64}$/.test(item.token) || !Number.isInteger(item.controlPort) || item.controlPort < 1024 || item.controlPort > 65535 || !Number.isInteger(item.gatewayPort) || item.gatewayPort < 1024 || item.gatewayPort > 65535 || !["starting", "running", "error"].includes(item.phase) || item.origin !== undefined && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(item.origin)) throw new Error("tunnel_state_invalid：连接进程记录损坏，请检查本机连接组件");
  return item;
}

export async function writeTunnelRecord(directory: string, item: TunnelRecord, create = false): Promise<void> {
  const target = tunnelRecordPath(directory);
  if (create) { await writeFile(target, JSON.stringify(item), { mode: 0o600, flag: "wx" }); return; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(item), { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => undefined); }
}

export async function tunnelControl(record: TunnelRecord, action: "status" | "stop" | "attach" | "detach", signal?: AbortSignal, socketPath?: string): Promise<TunnelRecord> {
  const response = await networkFetch(`http://127.0.0.1:${record.controlPort}/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${record.token}`, "X-Token-Coupon-Tunnel": "1" },
    ...(socketPath ? { body: JSON.stringify({ socketPath }) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000), redirect: "error",
  });
  if (!response.ok) throw new Error("tunnel_control_unavailable：无法验证常驻连接进程，请检查连接组件；不会创建重复隧道");
  const text = await response.text();
  if (text.length > 16_384) throw new Error("tunnel_control_invalid");
  const data = JSON.parse(text) as TunnelRecord;
  if (data.token !== record.token || data.pid !== record.pid || data.gatewayPort !== record.gatewayPort || data.controlPort !== record.controlPort || data.version !== 1 || data.origin !== undefined && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(data.origin)) throw new Error("tunnel_control_identity_conflict：连接进程身份不一致");
  return data;
}

async function liveRecord(directory: string): Promise<TunnelRecord | undefined> {
  const record = await readTunnelRecord(directory); if (!record) return undefined;
  const owner = await observeTunnelOwner(record);
  if (owner.state === "owner_exited" || owner.state === "owner_identity_changed") {
    // A killed supervisor may have left its child behind. Only signal a verified child.
    if (!record.child && record.phase === "starting") throw new Error("tunnel_owner_unknown：连接组件启动被中断，无法确认子进程；请检查后再重建连接");
    if (record.child) {
      const child = await observeTunnelOwner(record.child);
      if (child.state === "unknown") throw new Error("tunnel_owner_unknown：无法核验残留连接子进程，未自动重建");
      if (child.state === "active") {
        try { process.kill(record.child.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        for (let i = 0; i < 40 && (await observeTunnelOwner(record.child)).state === "active"; i++) await pause(50);
        if ((await observeTunnelOwner(record.child)).state === "active") throw new Error("tunnel_child_stopping：连接子进程仍在退出，请稍后重试");
      }
    }
    await unlink(tunnelRecordPath(directory)); return undefined;
  }
  // On platforms without /proc, the secret challenge still verifies the process.
  if (owner.state === "unknown" && record.hostname !== (await import("node:os")).hostname()) throw new Error("tunnel_owner_unknown：连接进程不属于本机");
  try { return await tunnelControl(record, "status"); }
  catch { throw new Error("tunnel_control_unavailable：常驻连接进程暂不可达；请稍后重试，不会更换地址或撤销授权"); }
}

async function observeTunnelOwner(owner: ProcessOwner) {
  const observation = await observeOwner(owner);
  if (observation.state === "active" && process.platform === "linux") {
    // Orphaned children can remain zombies under WSL/container init: kill(pid, 0) alone
    // calls these alive even though they can neither own a listener nor receive signals.
    const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8").catch(() => "");
    if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2))) return { state: "owner_exited" as const, reason: "连接进程已退出，等待系统回收" };
  }
  return observation;
}

/** A detached owner drains cloudflared output and survives application daemon restarts. */
export class PersistentQuickTunnelAdapter implements TunnelAdapter {
  readonly persistentGateway = true;
  constructor(private readonly startupTimeoutMs = 55_000, private readonly pollIntervalMs = 1500) {}

  async recover(port: number, directory: string, signal: AbortSignal, exited: () => void): Promise<TunnelRuntime | undefined> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await acquireLockCoordination([tunnelRecordPath(directory)], 3);
    try {
      const record = await liveRecord(directory); if (!record) return undefined;
      if (record.gatewayPort !== port) throw new Error("tunnel_port_changed：常驻隧道仍使用原网关端口；请先明确停止连接，再修改端口");
      return await this.waitReady(record, directory, signal, exited);
    } finally { await release(); }
  }

  async start(executable: string, port: number, directory: string, signal: AbortSignal, exited: () => void): Promise<TunnelRuntime> {
    await mkdir(directory, { recursive: true, mode: 0o700 }); signal.throwIfAborted();
    const release = await acquireLockCoordination([tunnelRecordPath(directory)], 3);
    let record: TunnelRecord | undefined;
    let launch: string | undefined;
    try {
      record = await liveRecord(directory);
      if (record) {
        if (record.gatewayPort !== port) throw new Error("tunnel_port_changed：请先停止旧连接，再修改端口");
        return await this.waitReady(record, directory, signal, exited);
      }
      const token = randomBytes(32).toString("hex");
      launch = join(directory, `launch-${randomUUID()}.json`);
      await writeFile(launch, JSON.stringify({ executable, port, token }), { flag: "wx", mode: 0o600 });
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/tunnel-supervisor.js", import.meta.url)), launch], {
        cwd: directory, detached: true, stdio: "ignore", windowsHide: true,
        // This long-lived process needs networking settings, never Planner/Runner credentials.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TMP|TEMP|TMPDIR|LANG|LC_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i.test(key))),
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      const deadline = Date.now() + this.startupTimeoutMs;
      do {
        record = await readTunnelRecord(directory);
        if (record) {
          if (record.token !== token || record.pid !== child.pid) throw new Error("tunnel_control_identity_conflict：连接进程启动身份冲突");
          return await this.waitReady(record, directory, signal, exited);
        }
        // Wait for the owner record even if cancellation arrived, so cleanup targets our owner.
        if (child.exitCode === 73) throw new Error("remote_port_in_use：MCP 网关端口被其他程序占用；未创建公网隧道，请先停止冲突服务或修改网关端口");
        if (child.exitCode !== null) throw new Error("tunnel_supervisor_failed：常驻连接进程启动失败，请检查组件和目录权限");
        await pause(40);
      } while (Date.now() < deadline);
      throw new Error("tunnel_supervisor_timeout：常驻连接进程未能启动");
    } catch (error) {
      if (record && signal.aborted && signal.reason !== PRESERVE_TUNNEL) await tunnelControl(record, "stop").catch(() => undefined);
      throw error;
    } finally { if (launch) await unlink(launch).catch(() => undefined); await release(); }
  }

  async stopSaved(directory: string): Promise<void> {
    const release = await acquireLockCoordination([tunnelRecordPath(directory)], 3);
    try { const record = await liveRecord(directory); if (record) await tunnelControl(record, "stop"); }
    finally { await release(); }
  }

  private async waitReady(record: TunnelRecord, directory: string, signal: AbortSignal, exited: () => void): Promise<TunnelRuntime> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (record.phase === "starting") {
      signal.throwIfAborted();
      if (Date.now() > deadline) throw new Error("tunnel_url_timeout：常驻隧道尚未取得地址，请检查网络后重试");
      await pause(80); record = await tunnelControl(record, "status", signal);
    }
    signal.throwIfAborted();
    if (record.phase !== "running" || !record.origin) throw new Error("tunnel_process_exited：常驻隧道已退出，请重新建立连接");
    let detached = false, timer: ReturnType<typeof setTimeout> | undefined, backendSocket: string | undefined;
    const unwatch = () => { detached = true; clearTimeout(timer); signal.removeEventListener("abort", cancelled); };
    const detach = async () => { unwatch(); if (backendSocket) await tunnelControl(record, "detach", undefined, backendSocket); };
    const cancelled = () => { unwatch(); };
    signal.addEventListener("abort", cancelled, { once: true });
    const check = async () => {
      try {
        const current = await readTunnelRecord(directory);
        if (!current || current.token !== record.token || (await tunnelControl(record, "status")).phase !== "running") { if (!detached) { unwatch(); exited(); } return; }
      } catch {
        // A control timeout is not proof of death; preserve the URL and verify again.
        const owner = await observeTunnelOwner(record);
        if (["owner_exited", "owner_identity_changed"].includes(owner.state)) { if (!detached) { unwatch(); exited(); } return; }
      }
      if (!detached) { timer = setTimeout(() => void check(), this.pollIntervalMs); timer.unref(); }
    };
    timer = setTimeout(() => void check(), this.pollIntervalMs); timer.unref();
    return { origin: record.origin, persistent: true, detach,
      attach: async socketPath => { await tunnelControl(record, "attach", undefined, socketPath); backendSocket = socketPath; },
      stop: async () => { unwatch(); await tunnelControl(record, "stop"); },
    };
  }
}
