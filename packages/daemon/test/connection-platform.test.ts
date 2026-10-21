import { createServer } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationService } from "../src/application-service.js";
import { RemoteMcpConnection } from "../src/oauth-gateway.js";
import { PersistentQuickTunnelAdapter } from "../src/persistent-tunnel.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(saved = false) {
  const root = await mkdtemp(join(tmpdir(), "tc-connection-platform-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService({ dataDirectory: root }); await service.initialize();
  const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const configPath = join(root, "remote-mcp-connection.json");
  const savedConfig = JSON.stringify({ mode: "quick_tunnel", enabled: true, connectionOnly: true, scopes: ["planning:read"], port, publicOrigin: "https://old.trycloudflare.com" });
  if (saved) await writeFile(configPath, savedConfig);
  const get = vi.fn(async () => { throw new Error("component must not be downloaded"); });
  const start = vi.fn(async () => { throw new Error("tunnel must not be started"); });
  const remote = new RemoteMcpConnection(service, root, port, { platform: "win32", component: { get }, tunnel: { start }, probe: async () => {}, healthIntervalMs: 0 });
  cleanups.push(() => remote.shutdown()); await remote.initialize();
  return { root, remote, get, start, configPath, savedConfig };
}

it("reports unsupported native Windows quick connections and rejects before downloading or writing config", async () => {
  const h = await fixture();
  expect(h.remote.status()).toMatchObject({ configured: false, busy: false, quickTunnel: { available: false } });
  expect(h.remote.status().quickTunnel.reason).toContain("本机 Agent");
  await expect(h.remote.startQuick({ consent: true, connectionOnly: true })).rejects.toThrow("remote_quick_tunnel_unsupported");
  expect(h.get).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  await expect(readFile(h.configPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a saved Windows quick-connection config intact and permits an explicit fixed HTTPS configuration", async () => {
  const h = await fixture(true);
  expect(h.remote.status()).toMatchObject({ transport: "error", gateway: "error", busy: false });
  expect(h.remote.status().lastError).toContain("remote_quick_tunnel_unsupported");
  expect(await readFile(h.configPath, "utf8")).toBe(h.savedConfig);
  expect(h.get).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  await h.remote.configure("https://mcp.example.test");
  await vi.waitFor(() => expect(h.remote.status()).toMatchObject({ mode: "fixed_https", gateway: "running", transport: "ready", quickTunnel: { available: false } }));
});

it.runIf(process.platform === "win32")("rejects direct persistent adapter calls on Windows before any filesystem or process side effects", async () => {
  const h = await fixture(), directory = join(h.root, "not-created"), adapter = new PersistentQuickTunnelAdapter();
  await expect(adapter.start("missing-cloudflared.exe", 4178, directory, new AbortController().signal, () => {})).rejects.toThrow("remote_quick_tunnel_unsupported");
  await expect(adapter.recover(4178, directory, new AbortController().signal, () => {})).rejects.toThrow("remote_quick_tunnel_unsupported");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
