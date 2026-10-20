import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLockCoordination, currentOwner, inspectLock } from "@token-coupon/core";

export type DaemonOwnerRelease = (() => Promise<void>) & { readonly token: string };

/** One daemon per state directory, shared by Web, HTTP MCP and stdio MCP. */
export async function acquireDaemonOwner(directory: string, port?: number): Promise<DaemonOwnerRelease> {
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1024 || port > 65535)) throw new Error("daemon_owner_port_invalid：后台监听端口无效");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "daemon-owner.json");
  const guard = await acquireLockCoordination([path], 3);
  const token = randomUUID();
  try {
    const observed = await inspectLock(path);
    if (observed.exists) {
      if (observed.state === "active" || observed.state === "unknown") throw new Error(`daemon_owner_conflict：后台已运行或身份无法核验（PID ${observed.owner?.pid ?? "未知"}）。请使用已有后台；不要同时启动普通 daemon 与 stdio daemon。`);
      await rename(path, `${path}.${randomUUID()}.interrupted`);
    }
    await writeFile(path, JSON.stringify({ ...await currentOwner(), ...(port === undefined ? {} : { port }), token, sessionId: null, acquiredAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  } finally { await guard(); }
  return Object.assign(async () => {
    const release = await acquireLockCoordination([path], 3);
    try { if ((await inspectLock(path)).owner?.token === token) await unlink(path); }
    finally { await release(); }
  }, { token });
}
