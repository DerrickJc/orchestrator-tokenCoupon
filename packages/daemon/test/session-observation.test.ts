import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { currentOwner, SessionStore, parsePlan, recoverSession, retrySession, resumeSession, MockRunner } from "@token-coupon/core";
import { observeSession } from "../src/session-observation.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(owner: Awaited<ReturnType<typeof currentOwner>>) {
  const workspace = await mkdtemp(join(tmpdir(), "session-observation-")); roots.push(workspace);
  const store = new SessionStore(workspace), task = (id: string) => ({ schemaVersion: 1, id, title: id, prompt: `Execute ${id}`, execution: { runnerId: "mock", mode: "non_interactive", timeoutMs: 3000 } });
  const record = await store.create(parsePlan({ schemaVersion: 1, id: "resume", title: "Resume", tasks: [
    { task: task("design"), dependsOn: [], status: "planned" }, { task: task("backend"), dependsOn: ["design"], status: "planned" }, { task: task("verify"), dependsOn: ["backend"], status: "planned" },
  ] }));
  const attemptId = randomUUID(), dir = join(workspace, ".token-coupon/runs", attemptId); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "attempt.json"), JSON.stringify({ attemptId, taskId: "backend", status: "running", owner }));
  await writeFile(join(dir, "events.jsonl"), JSON.stringify({ sequence: 1, attemptId, type: "attempt.started", payload: {} }) + "\n");
  const designId = randomUUID(), designDir = join(workspace, ".token-coupon/runs", designId);
  const snapshot = { ...record.snapshot, revision: 2, status: "running" as const, activeAttemptIds: [attemptId], tasks: record.snapshot.tasks.map(t => t.taskId === "design" ? { ...t, status: "succeeded" as const, attempts: [{ attemptId: designId, artifactDir: designDir, outcome: "recorded" as const }], result: { taskId: "design", attemptId: designId, status: "succeeded" as const, artifactDir: designDir, summary: "Design complete", summarySource: "final" as const, truncated: false } } : t.taskId === "backend" ? { ...t, status: "running" as const, activeAttemptId: attemptId, attempts: [{ attemptId, artifactDir: dir, outcome: "pending" as const }] } : t) };
  await store.save(snapshot);
  const lock = join(workspace, ".token-coupon/workspace.lock"); await writeFile(lock, JSON.stringify({ ...owner, sessionId: snapshot.sessionId, token: "do-not-project", acquiredAt: new Date().toISOString() }));
  return { workspace, store, snapshot, lock, dir, attemptId };
}
it("detects the demo's previous-boot owner without rewriting snapshots, attempts or locks", async () => {
  const f = await fixture({ ...await currentOwner(), bootId: "previous-boot" });
  const lock = await readFile(f.lock, "utf8"), before = await readFile(join(f.dir, "attempt.json"), "utf8");
  const result = await observeSession(f.workspace, f.snapshot);
  expect(result.status).toBe("interrupted"); expect(result.health.recoveryRequired).toBe(true);
  expect(result.tasks.get("backend")).toBe("interrupted"); expect(result.tasks.has("design")).toBe(false);
  expect(JSON.stringify(result)).not.toContain("do-not-project");
  expect((await f.store.load(f.snapshot.sessionId)).snapshot.status).toBe("running");
  expect(await readFile(f.lock, "utf8")).toBe(lock); expect(await readFile(join(f.dir, "attempt.json"), "utf8")).toBe(before);
});
it("keeps a live owner running and refuses to recover it even with confirmation", async () => {
  const f = await fixture(await currentOwner());
  const result = await observeSession(f.workspace, f.snapshot);
  expect(result.status).toBe("running"); expect(result.health.state).toBe("active"); expect(result.health.recoveryRequired).toBe(false);
  await expect(recoverSession({ workspace: f.workspace, sessionId: f.snapshot.sessionId, confirmedStopped: true })).rejects.toThrow("session_recovery_refused");
});
it("does not assert running or offer automatic recovery for an unknown or conflicting identity", async () => {
  const f = await fixture({ ...await currentOwner(), hostname: "another-host" });
  expect((await observeSession(f.workspace, f.snapshot))).toMatchObject({ status: "unavailable", health: { state: "unknown", recoveryRequired: false } });
  await writeFile(f.lock, JSON.stringify({ ...await currentOwner(), sessionId: randomUUID(), token: "different-session" }));
  expect((await observeSession(f.workspace, f.snapshot))).toMatchObject({ status: "unavailable", health: { state: "identity_conflict", recoveryRequired: false } });
});
it("recovers explicitly, retries only the interrupted task, then resumes remaining tasks while preserving completed work", async () => {
  const f = await fixture({ ...await currentOwner(), bootId: "previous-boot" }), sessionId = f.snapshot.sessionId;
  const options = { workspace: f.workspace, sessionId, createRunner: () => new MockRunner("success") };
  expect((await observeSession(f.workspace, f.snapshot)).status).toBe("interrupted");
  expect((await recoverSession({ ...options, confirmedStopped: true })).recovered).toBe(true);
  const recovered = await f.store.load(sessionId);
  expect(recovered.snapshot.tasks.map(t => t.status)).toEqual(["succeeded", "failed", "blocked"]);
  expect((await observeSession(f.workspace, recovered.snapshot)).health.recoveryRequired).toBe(false);
  const retried = await retrySession({ ...options, taskId: "backend" });
  expect(retried.snapshot.tasks.map(t => t.status)).toEqual(["succeeded", "succeeded", "planned"]);
  const finished = await resumeSession(options);
  expect(finished.snapshot.status).toBe("succeeded"); expect(finished.snapshot.tasks.map(t => t.attempts.length)).toEqual([1, 2, 1]);
  expect((await f.store.readAttempt(f.attemptId)) as any).toMatchObject({ status: "failed" });
});
it("reports detection failures as unknown instead of using stale running state", async () => {
  const f = await fixture(await currentOwner()); await rm(f.store.sessionDirectory(f.snapshot.sessionId), { recursive: true });
  expect(await observeSession(f.workspace, f.snapshot)).toMatchObject({ status: "unavailable", health: { state: "unknown", recoveryRequired: false } });
});
