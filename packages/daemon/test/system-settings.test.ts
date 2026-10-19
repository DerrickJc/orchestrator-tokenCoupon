import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { defaultSystemSettings, SystemSettingsStore } from "../src/system-settings.js";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "tc-settings-")); cleanups.push(() => rm(root, { recursive: true, force: true })); return root; }

it("persists per-function preferences privately, detects concurrent edits and rejects unknown fields", async () => {
  const root = await temporary(), path = join(root, "system-settings.json"), store = new SystemSettingsStore(path);
  const initial = await store.read(); expect(initial.initialized).toBe(false);
  initial.mode = "per-function"; initial.functions.planning = { priority: "agent", agent: { runnerId: "claude-code", modelId: "deepseek-flash" }, webSource: "claude" };
  const saved = await store.update(initial);
  expect(saved).toMatchObject({ revision: 1, initialized: true, mode: "per-function" });
  expect(await new SystemSettingsStore(path).read()).toEqual(saved);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const writes = await Promise.allSettled([store.update(saved), store.update(saved)]);
  expect(writes.map(item => item.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(String((writes.find(item => item.status === "rejected") as PromiseRejectedResult).reason)).toContain("settings_revision_conflict");
  expect(() => store.update({ ...saved, apiKey: "not-allowed" })).toThrow("settings_invalid");
  expect(() => store.update({ ...saved, unified: { ...saved.unified, agent: { runnerId: "dsh" } } })).toThrow("settings_invalid");
  expect(() => store.update({ ...saved, unified: { ...saved.unified, agent: { runnerId: "codex", modelId: "bad\nmodel" } } })).toThrow("settings_invalid");
  expect(await readFile(path, "utf8")).not.toContain("not-allowed");
});

it("requires local authentication for preferences and cancels a native picker on HTTP disconnect", async () => {
  const root = await temporary(), dataDirectory = join(root, "daemon");
  const service = new ApplicationService({ dataDirectory }); await service.initialize();
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  let pickerSignal: AbortSignal | undefined;
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory, nativePicker: async (_kind, signal) => {
    pickerSignal = signal;
    await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
    return { cancelled: true, paths: [] };
  } });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${port}`, cookie = (await fetch(origin)).headers.getSetCookie()[0]!.split(";")[0]!;
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
  expect((await fetch(`${origin}/api/v1/settings`)).status).toBe(403);
  expect((await fetch(`${origin}/api/v1/settings`, { method: "POST", headers: { ...headers, Origin: "https://outside.invalid" }, body: "{}" })).status).toBe(403);
  const settings = defaultSystemSettings(); settings.unified.priority = "agent";
  const saved = await fetch(`${origin}/api/v1/settings`, { method: "POST", headers, body: JSON.stringify(settings) }).then(r => r.json());
  expect(saved).toMatchObject({ initialized: true, revision: 1 });
  const reloaded = new ApplicationService({ dataDirectory }); await reloaded.initialize();
  expect(await reloaded.systemSettings()).toEqual(saved);
  const controller = new AbortController();
  const picking = fetch(`${origin}/api/v1/native-picker`, { method: "POST", headers, body: JSON.stringify({ kind: "directory" }), signal: controller.signal }).catch(error => error.name);
  await expect.poll(() => !!pickerSignal).toBe(true); controller.abort();
  expect(await picking).toBe("AbortError"); await expect.poll(() => pickerSignal?.aborted).toBe(true);
});
