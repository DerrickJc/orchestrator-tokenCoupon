import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { RunnerInteractionOwner, RunnerInteractionReply, RunnerInteractionRequest } from "@token-coupon/core";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tc-pending-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService({ dataDirectory: join(root, "state") }); await service.initialize(); cleanup.push(() => service.shutdown());
  await mkdir(join(root, "one")); await mkdir(join(root, "two"));
  const one = await service.addWorkspace(join(root, "one"), "One"), two = await service.addWorkspace(join(root, "two"), "Two");
  const controller = new AbortController(); cleanup.push(async () => controller.abort());
  // Exercise the real interaction lifecycle directly, without invoking a paid Runner.
  const manager = service as unknown as { waitForInteraction(workspaceId: string, planningId: string, requestId: string, request: RunnerInteractionRequest, owner: RunnerInteractionOwner, signal: AbortSignal): Promise<RunnerInteractionReply> };
  const pending = (workspaceId: string, id: string, signal = controller.signal) => manager.waitForInteraction(workspaceId, "plan", id,
    { kind: "approval", title: "private prompt", summary: "private reason", operation: { kind: "command", command: "SECRET_COMMAND" }, decisions: ["allow-once", "deny"] },
    { attemptId: "attempt", taskId: "task", runnerId: "codex", cwd: "/private/path" }, signal).catch(error => error);
  return { service, root, one, two, controller, pending };
}

it("indexes live requests across projects without exposing prompts, commands or local paths", async () => {
  const h = await fixture(), a = h.pending(h.one.workspaceId, "a"), b = h.pending(h.two.workspaceId, "b");
  await expect.poll(() => h.service.pendingQueue().total).toBe(2);
  const summary = h.service.pendingQueue();
  expect(summary.epoch).toBe(h.service.epoch);
  expect(summary.items.map(item => item.workspaceLabel).sort()).toEqual(["One", "Two"]);
  expect(JSON.stringify(summary)).not.toMatch(/SECRET_COMMAND|private prompt|private reason|private\/path|attempt/);
  await expect(h.service.answerInteraction(h.two.workspaceId, "a", { kind: "approval", decision: "deny" })).rejects.toThrow("interaction_stale");
  await h.service.answerInteraction(h.one.workspaceId, "a", { kind: "approval", decision: "deny" });
  expect(await a).toEqual({ kind: "approval", decision: "deny" }); expect(h.service.pendingQueue().total).toBe(1);
  h.controller.abort(); await b;
  expect(h.service.pendingQueue().items).toEqual([]);
});

it("bounds each page, rejects invalid offsets and leaves no request after abort during publication", async () => {
  const h = await fixture();
  const waits = Array.from({ length: 102 }, (_, index) => h.pending(h.one.workspaceId, `r-${String(index).padStart(3, "0")}`));
  await expect.poll(() => h.service.pendingQueue().total).toBe(102);
  expect(h.service.pendingQueue().items).toHaveLength(100); expect(h.service.pendingQueue().nextOffset).toBe(100);
  expect(h.service.pendingQueue(100).items).toHaveLength(2); expect(h.service.pendingQueue(100).nextOffset).toBeNull();
  for (const offset of [-1, .5, NaN, Infinity]) expect(() => h.service.pendingQueue(offset)).toThrow("pending_offset_invalid");
  const interrupted = new AbortController();
  const unsubscribe = h.service.subscribe(event => { if (event.type === "interaction.requested" && (event.payload as any).requestId === "race") interrupted.abort(); });
  await h.pending(h.one.workspaceId, "race", interrupted.signal); unsubscribe();
  expect(h.service.pendingQueue().total).toBe(102);
  h.controller.abort(); await Promise.all(waits); expect(h.service.pendingQueue().total).toBe(0);
});

it("protects the summary endpoint with local authorization and advertises compatibility", async () => {
  const h = await fixture(); const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const server = await createLocalServer(h.service, { port, host: "127.0.0.1", dataDirectory: join(h.root, "state") });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${port}`;
  expect((await fetch(`${origin}/api/v1/pending`)).status).toBe(403);
  const landing = await fetch(origin), cookie = landing.headers.getSetCookie()[0]!.split(";")[0]!; await landing.body?.cancel();
  const headers = { Cookie: cookie };
  const health = await fetch(`${origin}/api/v1/health`, { headers }).then(response => response.json()); expect(health.capabilities.pendingQueue).toBe(1);
  const value = await fetch(`${origin}/api/v1/pending`, { headers }).then(response => response.json()); expect(value).toEqual({ epoch: h.service.epoch, total: 0, items: [], nextOffset: null });
  expect((await fetch(`${origin}/api/v1/pending?offset=-1`, { headers })).status).toBe(400);
  expect((await fetch(`${origin}/api/v1/pending?offset=invalid`, { headers })).status).toBe(400);
});
