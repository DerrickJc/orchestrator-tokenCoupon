import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { observeOwner } from "@token-coupon/core";
import { PersistentQuickTunnelAdapter, readTunnelRecord, tunnelControl, tunnelRecordPath } from "../src/persistent-tunnel.js";
import { createPrivateGateway, protectPrivateGateway, removePrivateGateway } from "../src/private-gateway.js";

const testTimeout = process.platform === "win32" ? 90000 : 15000;
const pollOptions = { timeout: process.platform === "win32" ? 30000 : 5000, interval: 100 };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function fixture(delay = 0) {
  const root = await mkdtemp(join(tmpdir(), "tc-persistent-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "runtime"), executable = process.execPath;
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "tunnel"), `require('node:fs').appendFileSync(${JSON.stringify(join(root, "starts"))},'start\\n');\nsetTimeout(()=>process.stderr.write('https://persistent-test.trycloudflare.com\\n'),${delay});\nsetInterval(()=>{},1000);\nprocess.on('SIGTERM',()=>process.exit(0));\n`);
  const adapter = new PersistentQuickTunnelAdapter(process.platform === "win32" ? 30000 : 5000, 250), port = await freePort();
  cleanups.push(() => adapter.stopSaved(directory));
  return { root, directory, executable, adapter, port };
}
async function backend(body = "backend-connected") {
  const endpoint = await createPrivateGateway(), { socketPath } = endpoint;
  const server = createServer((_request, response) => response.end(body));
  const dispose = endpoint.token ? protectPrivateGateway(server, endpoint.token) : () => {};
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanups.push(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removePrivateGateway(endpoint); });
  return { socketPath, server, token: endpoint.token };
}

it("retains the tunnel, reserves its port during restart, authenticates control and reconnects a private backend", async () => {
  const h = await fixture();
  const runtime = await h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {});
  const record = (await readTunnelRecord(h.directory))!;
  expect(record.child?.platform).toBe(process.platform);
  expect(record.child?.processStart).toMatch(/^\d+$/);
  expect(runtime.persistent).toBe(true);
  expect((await fetch(`http://127.0.0.1:${h.port}/mcp`)).status).toBe(503);
  expect((await fetch(`http://127.0.0.1:${record.controlPort}/stop`, { method: "POST" })).status).toBe(403);
  const front = await backend(); await runtime.attach!(front.socketPath, front.token);
  await expect(runtime.attach!(join(h.root, "arbitrary.sock"))).rejects.toThrow("tunnel_control_unavailable");
  expect(await (await fetch(`http://127.0.0.1:${h.port}/mcp`)).text()).toBe("backend-connected");
  await runtime.detach!();
  expect((await fetch(`http://127.0.0.1:${h.port}/mcp`)).status).toBe(503);
  const conflicting = createServer();
  await expect(new Promise<void>((resolve, reject) => { conflicting.once("error", reject); conflicting.listen(h.port, "127.0.0.1", resolve); })).rejects.toMatchObject({ code: "EADDRINUSE" });
  const restored = await h.adapter.recover(h.port, h.directory, new AbortController().signal, () => {});
  expect(restored?.origin).toBe(runtime.origin); expect((await readTunnelRecord(h.directory))?.pid).toBe(record.pid);
  await restored!.attach!(front.socketPath, front.token);
  expect(await (await fetch(`http://127.0.0.1:${h.port}/mcp`)).text()).toBe("backend-connected");
  expect((await readFile(join(h.root, "starts"), "utf8")).trim().split("\n")).toHaveLength(1);
  await restored!.stop(); expect(await readTunnelRecord(h.directory)).toBeUndefined();
  if (process.platform === "win32") expect((await observeOwner(record)).state).toBe("owner_exited");
}, testTimeout);

it("keeps a newly attached backend when the previous daemon detaches late", async () => {
  const h = await fixture(), first = await backend("first"), second = await backend("second");
  const original = await h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {});
  await original.attach!(first.socketPath, first.token);
  const recovered = await h.adapter.recover(h.port, h.directory, new AbortController().signal, () => {});
  await recovered!.attach!(second.socketPath, second.token);
  await original.detach!();
  expect(await (await fetch(`http://127.0.0.1:${h.port}/mcp`)).text()).toBe("second");
  await recovered!.stop();
}, testTimeout);

it("does not use an authenticated control response to override a different platform identity", async () => {
  const h = await fixture(), runtime = await h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {});
  const record = (await readTunnelRecord(h.directory))!;
  await writeFile(tunnelRecordPath(h.directory), JSON.stringify({ ...record, platform: process.platform === "win32" ? "linux" : "win32" }));
  try { await expect(h.adapter.recover(h.port, h.directory, new AbortController().signal, () => {})).rejects.toThrow("tunnel_platform_conflict"); }
  finally { await writeFile(tunnelRecordPath(h.directory), JSON.stringify(record)); }
  expect((await readFile(join(h.root, "starts"), "utf8")).trim()).toBe("start"); await runtime.stop();
}, testTimeout);

it("does not start a public tunnel over a port occupied by another service", async () => {
  const h = await fixture(), other = createServer((_request, response) => response.end("sentinel"));
  await new Promise<void>(resolve => other.listen(h.port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => other.close(() => resolve())));
  await expect(h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {})).rejects.toThrow("remote_port_in_use");
  expect(await readTunnelRecord(h.directory)).toBeUndefined();
  await expect(readFile(join(h.root, "starts"))).rejects.toMatchObject({ code: "ENOENT" });
}, testTimeout);

it("survives SIGKILL of the launching business process and can be recovered by another process owner", async () => {
  const h = await fixture();
  const module = pathToFileURL(join(process.cwd(), "packages/daemon/dist/persistent-tunnel.js")).href;
  const script = `import {PersistentQuickTunnelAdapter} from ${JSON.stringify(module)}; const r=await new PersistentQuickTunnelAdapter().start(${JSON.stringify(h.executable)},${h.port},${JSON.stringify(h.directory)},new AbortController().signal,()=>{}); console.log(r.origin); setInterval(()=>{},1000);`;
  const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanups.push(async () => { child.kill("SIGKILL"); await done; });
  await new Promise<void>((resolve, reject) => { let text = ""; child.stdout!.on("data", chunk => { text += chunk; if (text.includes("trycloudflare.com")) resolve(); }); child.once("exit", code => reject(new Error(`launcher exited ${code}`))); });
  const before = (await readTunnelRecord(h.directory))!;
  child.kill("SIGKILL"); await done;
  const restored = await h.adapter.recover(h.port, h.directory, new AbortController().signal, () => {});
  expect(restored?.origin).toBe(before.origin); expect((await readTunnelRecord(h.directory))?.pid).toBe(before.pid);
  expect((await fetch(`http://127.0.0.1:${h.port}/mcp`)).status).toBe(503);
  await restored!.stop();
}, testTimeout);

it("rejects changed ports and inaccessible control instead of silently replacing an alive tunnel", async () => {
  const h = await fixture();
  const runtime = await h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {});
  await runtime.detach!();
  await expect(h.adapter.recover(await freePort(), h.directory, new AbortController().signal, () => {})).rejects.toThrow("tunnel_port_changed");
  const record = (await readTunnelRecord(h.directory))!;
  await writeFile(tunnelRecordPath(h.directory), JSON.stringify({ ...record, token: "0".repeat(64) }), { mode: 0o600 });
  try { await expect(h.adapter.recover(h.port, h.directory, new AbortController().signal, () => {})).rejects.toThrow("tunnel_control_unavailable"); }
  finally { await writeFile(tunnelRecordPath(h.directory), JSON.stringify(record), { mode: 0o600 }); }
  expect((await readFile(join(h.root, "starts"), "utf8")).trim()).toBe("start");
}, testTimeout);

it("verifies a dead supervisor and cleans its own orphan before allowing a replacement", async () => {
  const h = await fixture();
  const runtime = await h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {});
  await runtime.detach!();
  const record = (await readTunnelRecord(h.directory))!;
  process.kill(record.pid, "SIGKILL");
  await expect.poll(async () => { try { await tunnelControl(record, "status"); return false; } catch { return true; } }, pollOptions).toBe(true);
  expect(await h.adapter.recover(h.port, h.directory, new AbortController().signal, () => {})).toBeUndefined();
  const replacement = await h.adapter.start(h.executable, h.port, h.directory, new AbortController().signal, () => {});
  expect((await readTunnelRecord(h.directory))?.pid).not.toBe(record.pid);
  expect((await readFile(join(h.root, "starts"), "utf8")).trim().split("\n")).toHaveLength(2);
  await replacement.stop();
}, testTimeout);

it("cancels a starting tunnel without leaving its supervisor or child running", async () => {
  const h = await fixture(10_000), controller = new AbortController();
  const pending = h.adapter.start(h.executable, h.port, h.directory, controller.signal, () => {});
  await expect.poll(() => readTunnelRecord(h.directory), pollOptions).toBeDefined();
  const record = (await readTunnelRecord(h.directory))!;
  controller.abort(); await expect(pending).rejects.toBeDefined();
  await expect.poll(() => readTunnelRecord(h.directory), pollOptions).toBeUndefined();
  await expect.poll(async () => { try { await tunnelControl(record, "status"); return false; } catch { return true; } }, pollOptions).toBe(true);
}, testTimeout);
