import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLockCoordination, currentOwner, inspectLock } from "@token-coupon/core";
import { readDaemonOwnerCredential } from "@token-coupon/client/node";
import { prepareTunnelDirectory } from "./private-gateway.js";

export type DaemonOwnerRelease = (() => Promise<void>) & { readonly token: string };

/** One daemon per state directory, shared by Web, HTTP MCP and stdio MCP. */
export async function acquireDaemonOwner(directory: string, port?: number): Promise<DaemonOwnerRelease> {
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1024 || port > 65535)) throw new Error("daemon_owner_port_invalid：后台监听端口无效");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("daemon_profile_invalid：后台数据目录必须是专用普通目录，不能使用链接");
  const path = join(directory, "daemon-owner.json");
  const guard = await acquireLockCoordination([path], 3);
  const token = randomUUID();
  try {
    const observed = await inspectLock(path);
    if (observed.exists) {
      if (observed.state === "active" || observed.state === "unknown") throw new Error(`daemon_owner_conflict：后台已运行或身份无法核验（PID ${observed.owner?.pid ?? "未知"}）。请使用已有后台；不要同时启动普通 daemon 与 stdio daemon。`);
    }
    if (process.platform === "win32") {
      // Node's mode bits do not set Windows DACLs. Protect the dedicated state
      // directory before creating the HMAC key; never adopt an active old owner.
      try { await prepareTunnelDirectory(directory); }
      catch { throw new Error("daemon_profile_permissions：无法保护后台数据目录的 Windows 权限。请使用当前用户的专用目录，不要使用共享目录或链接"); }
    }
    if (observed.exists) {
      await rename(path, `${path}.${randomUUID()}.interrupted`);
    }
    await writeFile(path, JSON.stringify({ ...await currentOwner(), ...(port === undefined ? {} : { port }), token, sessionId: null, acquiredAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      try {
        // Use the desktop's actual owner/ancestor checks before advertising a
        // running daemon. A permissive parent remains a refusal, not a bypass.
        await readDaemonOwnerCredential(directory);
      } catch (error) {
        await unlink(path);
        throw error;
      }
    }
  } finally { await guard(); }
  return Object.assign(async () => {
    const release = await acquireLockCoordination([path], 3);
    try { if ((await inspectLock(path)).owner?.token === token) await unlink(path); }
    finally { await release(); }
  }, { token });
}
