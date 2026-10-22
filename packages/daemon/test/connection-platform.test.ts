import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationService } from "../src/application-service.js";
import { RemoteMcpConnection } from "../src/oauth-gateway.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(saved = false, platform: NodeJS.Platform = "win32") {
  const root = await mkdtemp(join(tmpdir(), "tc-connection-platform-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService({ dataDirectory: root }); await service.initialize();
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const configPath = join(root, "remote-mcp-connection.json"), origin = "https://windows-test.trycloudflare.com";
  if (saved) await writeFile(configPath, JSON.stringify({ mode: "quick_tunnel", enabled: true, connectionOnly: true, scopes: ["planning:read"], port, publicOrigin: origin }));
  const attach = vi.fn(async (_path: string, _key?: string) => {}), runtime = { origin, persistent: true, attach, detach: async () => {}, stop: async () => {} };
  const get = vi.fn(async () => ({ executable: process.execPath, version: "fixture", source: "existing" as const }));
  const start = vi.fn(async () => runtime), recover = vi.fn(async () => saved ? runtime : undefined);
  const remote = new RemoteMcpConnection(service, root, port, { platform, component: { get }, tunnel: { persistentGateway: true, start, recover }, probe: async () => {}, healthIntervalMs: 0 });
  cleanups.push(() => remote.shutdown()); await remote.initialize();
  return { remote, get, start, recover, attach, configPath, origin };
}
it("allows Windows quick connections and attaches a private gateway", async () => {
  const h = await fixture();
  expect(h.remote.status().quickTunnel.available).toBe(true);
  await h.remote.startQuick({ consent: true, connectionOnly: true });
  await vi.waitFor(() => expect(h.remote.status().transport).toBe("ready"));
  expect(h.start).toHaveBeenCalledOnce(); expect(h.attach).toHaveBeenCalledOnce();
  const [path, key] = h.attach.mock.calls[0]!;
  if (process.platform === "win32") { expect(path).toMatch(/^\\\\\.\\pipe\\tc-gateway-/); expect(key).toMatch(/^[a-f0-9]{64}$/); }
  else expect(path).toMatch(/gateway\.sock$/);
});
it("recovers saved Windows connections without downloading a component or replacing the URL", async () => {
  const h = await fixture(true);
  await vi.waitFor(() => expect(h.remote.status().transport).toBe("ready"));
  expect(h.recover).toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  expect(h.attach).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(h.configPath, "utf8")).publicOrigin).toBe(h.origin);
});
it("keeps unsupported platforms explicit before component download", async () => {
  const h = await fixture(false, "aix");
  expect(h.remote.status().quickTunnel.available).toBe(false);
  await expect(h.remote.startQuick({ consent: true, connectionOnly: true })).rejects.toThrow("remote_quick_tunnel_unsupported");
  expect(h.get).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
});
