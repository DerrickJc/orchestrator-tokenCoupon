import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConnectionDiagnostics, type ConnectionObservation } from "../src/connection-diagnostics.js";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
it("persists only bounded diagnostic metadata and restores it without request or credential material", async () => {
  const path = await mkdtemp(join(tmpdir(), "tc-connection-diagnostics-")); roots.push(path);
  const diagnostics = new ConnectionDiagnostics(path); await diagnostics.initialize();
  const sample: ConnectionObservation = { traceId: randomUUID(), at: Date.now(), endpoint: "https://demo.trycloudflare.com/mcp", stage: "tool", outcome: "success", tool: "workspace_query", grantId: randomUUID(), clientId: randomUUID() };
  await diagnostics.record({ ...sample, headers: { Authorization: "Bearer SECRET_CANARY" }, arguments: { prompt: "PRIVATE_PROMPT" }, response: "PRIVATE_CONTENT" } as ConnectionObservation);
  const content = await readFile(join(path, "remote-mcp-diagnostics.json"), "utf8");
  expect(content).not.toMatch(/SECRET_CANARY|PRIVATE_PROMPT|PRIVATE_CONTENT|Authorization|headers|arguments/);
  expect(() => diagnostics.record({ ...sample, endpoint: "https://user:secret@demo.trycloudflare.com/mcp" })).toThrow("endpoint");
  await Promise.all(Array.from({ length: 105 }, () => diagnostics.record({ ...sample, traceId: randomUUID() })));
  expect(diagnostics.recent()).toHaveLength(100);
  const restored = new ConnectionDiagnostics(path); await restored.initialize();
  expect(restored.recent()).toEqual(diagnostics.recent()); expect(restored.storageUnavailable).toBe(false);
});

it("reports damaged or unavailable diagnostics without failing the business request", async () => {
  const path = await mkdtemp(join(tmpdir(), "tc-connection-diagnostics-")); roots.push(path);
  await writeFile(join(path, "remote-mcp-diagnostics.json"), "{broken");
  const damaged = new ConnectionDiagnostics(path); await damaged.initialize(); expect(damaged.storageUnavailable).toBe(true);
  const unavailable = join(path, "a-file"); await writeFile(unavailable, "file");
  const failed = new ConnectionDiagnostics(unavailable); await failed.initialize();
  await expect(failed.record({ traceId: randomUUID(), at: Date.now(), endpoint: "https://demo.trycloudflare.com/mcp", stage: "authentication", outcome: "error", code: "oauth_token_invalid" })).resolves.toBeUndefined();
  expect(failed.storageUnavailable).toBe(true);
});
