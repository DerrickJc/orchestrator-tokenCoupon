import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { expect, it, vi } from "vitest";
import { createClient, API_PROTOCOL } from "@token-coupon/client";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";

it("exposes an authenticated handshake and rejects stale/incompatible writes before any mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-protocol-"));
  const service = new ApplicationService({ dataDirectory: root }); await service.initialize();
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, "127.0.0.1", done));
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory: root });
  await new Promise<void>(done => server.listen(port, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${port}`;
  try {
    expect((await fetch(`${origin}/api/v1/health`)).status).toBe(403);
    const cookie = (await fetch(origin)).headers.getSetCookie()[0]!.split(";")[0]!;
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
    const client = createClient({ fetch: (async (path, options) => fetch(origin + String(path), { ...options, headers: { ...Object.fromEntries(new Headers(options?.headers)), Cookie: cookie, Origin: origin } })) as typeof fetch });
    const health = await client.api("/api/v1/health") as { protocol: unknown; epoch: string; applicationVersion: string; profile: { id: string } };
    expect(health.protocol).toEqual(API_PROTOCOL); expect(health.epoch).toBe(service.epoch);
    expect(health.applicationVersion).toBe("0.1.0"); expect(health.profile.id).toMatch(/^[0-9a-f]{24}$/);
    const register = vi.spyOn(service, "addWorkspace");
    const stale = await fetch(`${origin}/api/v1/workspaces`, { method: "POST", headers: { ...headers, "X-Token-Coupon-Protocol": "1", "X-Token-Coupon-Epoch": "old" }, body: "{}" });
    expect(stale.status).toBe(409); expect(await stale.text()).toContain("daemon_epoch_changed");
    const incompatible = await fetch(`${origin}/api/v1/workspaces`, { method: "POST", headers: { ...headers, "X-Token-Coupon-Protocol": "2", "X-Token-Coupon-Epoch": service.epoch }, body: "{}" });
    expect(incompatible.status).toBe(426); expect(register).not.toHaveBeenCalled();
    await client.api("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ path: root, label: "临时验证" }) });
    expect(register).toHaveBeenCalledTimes(1);

    // Actual SSE HTTP response: old epoch/cursor and an exhausted retention window request a snapshot reconciliation.
    await service.publish({ type: "test.first" });
    const readHello = async (query: string) => {
      const controller = new AbortController();
      const stream = await fetch(`${origin}/api/v1/events?${query}`, { headers: { Cookie: cookie }, signal: controller.signal });
      const reader = stream.body!.getReader();
      try { return new TextDecoder().decode((await reader.read()).value); }
      finally { controller.abort(); await reader.cancel().catch(() => undefined); }
    };
    expect(await readHello("after=999&epoch=old")).toContain('"resetReason":"epoch_changed"');
    expect(await readHello(`after=999&epoch=${service.epoch}`)).toContain('"resetReason":"cursor_invalid"');
    vi.spyOn(service, "eventWindow").mockReturnValue({ first: 20, latest: 30 });
    expect(await readHello(`after=2&epoch=${service.epoch}`)).toContain('"resetReason":"window_lost"');
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await service.shutdown(); await rm(root, { recursive: true, force: true });
  }
});
