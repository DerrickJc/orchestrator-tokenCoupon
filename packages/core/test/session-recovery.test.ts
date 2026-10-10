import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { diagnoseSession, recoverSession } from "../src/session-recovery.js";
import { acquireLockCoordination, currentOwner, inspectLock, observeOwner } from "../src/owner-lock.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(gitIsolation = false, parallel = false) {
  const workspace = await mkdtemp(join(tmpdir(), "session-recovery-")); roots.push(workspace);
  const store = new SessionStore(workspace);
  const plan = { schemaVersion: 1 as const, id: "recovery", title: "Recovery", tasks: [
    { task: { schemaVersion: 1 as const, id: "implement", title: "Implement", prompt: "Implement", execution: { runnerId: "mock", mode: "non_interactive" as const } }, dependsOn: [], status: "planned" as const },
    { task: { schemaVersion: 1 as const, id: "verify", title: "Verify", prompt: "Verify", execution: { runnerId: "mock", mode: "non_interactive" as const } }, dependsOn: ["implement"], status: "planned" as const },
  ] };
  if (parallel) plan.tasks.push(
    { task: { ...plan.tasks[0]!.task, id: "parallel" }, dependsOn: [], status: "planned" },
    { task: { ...plan.tasks[0]!.task, id: "preserved" }, dependsOn: [], status: "planned" },
  );
  const gitCommonDir = join(workspace, ".git");
  const sessionIdSeed = randomUUID();
  const record = await store.create(plan, sessionIdSeed, gitIsolation ? { mode: "git-worktree", status: "ready", repositoryRoot: workspace, gitCommonDir, baseCommit: "a".repeat(40), sourceBranch: "main", integrationBranch: `token-coupon/session/${sessionIdSeed}`, integrationWorktree: join(workspace, ".token-coupon", "worktrees", sessionIdSeed, "integration"), verificationTaskId: "verify", setupHash: null } : { mode: "shared" }, { maxParallel: parallel ? 2 : 1 });
  const sessionId = record.snapshot.sessionId;
  const attemptId = randomUUID();
  const dir = join(workspace, ".token-coupon", "runs", attemptId); await mkdir(dir, { recursive: true });
  const owner = { pid: 2147483647, hostname: hostname(), processStart: "dead" };
  await writeFile(join(dir, "attempt.json"), JSON.stringify({ attemptId, taskId: "implement", status: "running", owner }));
  await writeFile(join(dir, "events.jsonl"), JSON.stringify({ sequence: 1, attemptId, type: "attempt.started" }) + "\n");
  const requestId = randomUUID(); await mkdir(join(dir, "interactions"));
  await writeFile(join(dir, "interactions", requestId + ".json"), JSON.stringify({ attemptId, requestId, status: "pending" }));
  await store.save({ ...record.snapshot, revision: 2, status: "running", schedulerState: "dispatching", activeAttemptIds: [attemptId], tasks: record.snapshot.tasks.map((t) => t.taskId === "implement" ? { ...t, status: "running", activeAttemptId: attemptId, attempts: [{ attemptId, artifactDir: dir, outcome: "pending" }] } : t) });
  const lockPath = join(workspace, ".token-coupon", "workspace.lock");
  await writeFile(lockPath, JSON.stringify({ ...owner, sessionId, token: "original", acquiredAt: new Date().toISOString() }));
  return { workspace, store, sessionId, attemptId, lockPath, requestId, dir, owner, gitCommonDir };
}
test("read-only diagnosis then explicit recovery backs up records, expires requests and blocks dependencies", async () => {
  const f = await fixture(); const before = await readFile(f.lockPath, "utf8");
  expect((await recoverSession(f)).recovered).toBe(false);
  expect(await readFile(f.lockPath, "utf8")).toBe(before);
  expect((await diagnoseSession(f.workspace, f.sessionId)).state).toBe("owner_exited");
  const recovered = await recoverSession({ ...f, confirmedStopped: true });
  expect(recovered.recovered).toBe(true);
  expect((await inspectLock(f.lockPath)).exists).toBe(false);
  const record = await f.store.load(f.sessionId);
  expect(record.snapshot.tasks.map((t) => t.status)).toEqual(["failed", "blocked"]);
  expect(record.snapshot.activeAttemptIds).toEqual([]);
  expect(JSON.parse(await readFile(join(f.dir, "interactions", f.requestId + ".json"), "utf8")).status).toBe("expired");
  expect((await f.store.readAttempt(f.attemptId))).toMatchObject({ status: "failed", nativeOutcome: "incomplete", cleanupStatus: "unknown" });
  const revision = record.snapshot.revision;
  expect((await recoverSession({ ...f, confirmedStopped: true })).recovered).toBe(false);
  expect((await f.store.load(f.sessionId)).snapshot.revision).toBe(revision);
  expect((await readdir(join(f.workspace, ".token-coupon"))).some((s) => s.startsWith("workspace.lock.before-recovery-"))).toBe(true);
});
test("active, conflicting and unknown owners cannot be recovered, even with confirmation", async () => {
  const f = await fixture();
  const active = await currentOwner();
  for (const owner of [active, { ...active, hostname: "other-host" }, { pid: process.pid }]) {
    await writeFile(f.lockPath, JSON.stringify({ ...owner, sessionId: f.sessionId, token: "other", acquiredAt: new Date().toISOString() }));
    await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("session_recovery_refused");
    expect((await f.store.readAttempt(f.attemptId))).toMatchObject({ status: "running" });
  }
  await writeFile(f.lockPath, JSON.stringify({ ...f.owner, sessionId: randomUUID(), token: "different" }));
  expect((await diagnoseSession(f.workspace, f.sessionId)).state).toBe("identity_conflict");
  await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("identity_conflict");
});
test("recovery and execution lock creation share the same coordination gate", async () => {
  const f = await fixture(); const release = await acquireLockCoordination([f.lockPath]);
  try {
    await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("lock_coordination_busy");
    await expect(f.store.acquireLock(f.sessionId)).rejects.toThrow("lock_coordination_busy");
    expect((await inspectLock(f.lockPath)).owner?.token).toBe("original");
  } finally { await release(); }
  const results = await Promise.allSettled([recoverSession({ ...f, confirmedStopped: true }), recoverSession({ ...f, confirmedStopped: true })]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
test("PID reuse is distinct from unknown; no-lock running attempts still need recovery", async () => {
  expect((await observeOwner({ ...await currentOwner(), processStart: "another-start" })).state).toBe("owner_identity_changed");
  expect((await observeOwner({ pid: process.pid })).state).toBe("unknown");
  const f = await fixture(); await rm(f.lockPath);
  expect((await diagnoseSession(f.workspace, f.sessionId)).state).toBe("owner_exited");
  expect((await recoverSession({ ...f, confirmedStopped: true })).recovered).toBe(true);
});
test("a succeeded attempt without handoff stays interrupted, never synthesizes success", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "attempt.json"), JSON.stringify({ attemptId: f.attemptId, taskId: "implement", status: "succeeded", owner: f.owner }));
  await recoverSession({ ...f, confirmedStopped: true });
  expect((await f.store.load(f.sessionId)).snapshot.tasks.map((t) => t.status)).toEqual(["interrupted", "blocked"]);
  expect((await f.store.readAttempt(f.attemptId))).toMatchObject({ status: "succeeded" });
});
test("Git common lock is diagnosed together with workspace lock and both are archived", async () => {
  const f = await fixture(true); await mkdir(f.gitCommonDir, { recursive: true });
  const gitLock = join(f.gitCommonDir, "token-coupon-worktree.lock");
  await writeFile(gitLock, JSON.stringify({ ...await currentOwner(), sessionId: f.sessionId, token: "git", acquiredAt: new Date().toISOString() }));
  await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("session_recovery_refused");
  expect((await inspectLock(f.lockPath)).exists).toBe(true);
  await writeFile(gitLock, JSON.stringify({ ...f.owner, sessionId: f.sessionId, token: "git", acquiredAt: new Date().toISOString() }));
  await recoverSession({ ...f, confirmedStopped: true });
  expect((await inspectLock(gitLock)).exists).toBe(false);
  expect((await inspectLock(f.lockPath)).exists).toBe(false);
  expect((await f.store.load(f.sessionId)).isolationJournal?.attempts).toEqual([]);
});
test("failed snapshot persistence retains owner locks and retry resumes the recovery ledger", async () => {
  const f = await fixture();
  const save = vi.spyOn(SessionStore.prototype, "save").mockRejectedValueOnce(new Error("disk full"));
  try { await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("disk full"); }
  finally { save.mockRestore(); }
  expect((await inspectLock(f.lockPath)).owner?.token).toBe("original");
  expect((await f.store.readAttempt(f.attemptId))).toMatchObject({ status: "failed" });
  expect((await recoverSession({ ...f, confirmedStopped: true })).recovered).toBe(true);
  expect((await f.store.load(f.sessionId)).snapshot.tasks[0]?.status).toBe("failed");
  const events = await readFile(join(f.store.sessionDirectory(f.sessionId), "scheduler-events.jsonl"), "utf8");
  expect(events.split("\n").filter((line) => line.includes('"scheduler.recovered"'))).toHaveLength(1);
});
test("corrupt locks and replaced recovery identities leave records unchanged", async () => {
  const f = await fixture(); await writeFile(f.lockPath, "{");
  await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("unknown");
  expect((await f.store.readAttempt(f.attemptId))).toMatchObject({ status: "running" });
  await writeFile(f.lockPath, JSON.stringify({ ...f.owner, sessionId: f.sessionId, token: "new" }));
  const dir = join(f.store.sessionDirectory(f.sessionId), "recovery"); await mkdir(dir);
  const record = await f.store.load(f.sessionId);
  await writeFile(join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, recoveryId: randomUUID(), sessionId: f.sessionId, stage: "prepared", before: record.snapshot, locks: [{ path: f.lockPath, exists: true, identity: "old" }] }));
  await expect(recoverSession({ ...f, confirmedStopped: true })).rejects.toThrow("lock_identity_changed");
  expect((await inspectLock(f.lockPath)).owner?.token).toBe("new");
});
test("successful handoff is preserved when an adjacent execution is recovered", async () => {
  const f = await fixture();
  const old = await f.store.load(f.sessionId);
  const handoff = { taskId: "implement", attemptId: f.attemptId, status: "succeeded" as const, summary: "Validated before owner crash", summarySource: "final" as const, truncated: false, artifactDir: f.dir };
  await writeFile(join(f.dir, "attempt.json"), JSON.stringify({ attemptId: f.attemptId, taskId: "implement", status: "succeeded", owner: f.owner }));
  await f.store.saveHandoff(f.attemptId, handoff);
  const control = join(f.store.sessionDirectory(f.sessionId), "control"); await mkdir(control);
  await writeFile(join(control, "request.json"), JSON.stringify({ sessionId: f.sessionId, executionId: old.snapshot.executionId, requestId: randomUUID(), kind: "cancel" }));
  await recoverSession({ ...f, confirmedStopped: true });
  const record = await f.store.load(f.sessionId);
  expect(record.snapshot.tasks.map((t) => t.status)).toEqual(["succeeded", "planned"]);
  expect(record.snapshot.tasks[0]?.result).toEqual(handoff);
  expect(record.snapshot.executionId).not.toBe(old.snapshot.executionId);
  await expect(readFile(join(control, "request.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(join(f.store.sessionDirectory(f.sessionId), "recovery"))).some((p) => p.endsWith(".control-request.json"))).toBe(true);
});
test("parallel recovery checks every active attempt and retains a prior successful independent task", async () => {
  const f = await fixture(true, true); const record = await f.store.load(f.sessionId);
  const otherId = randomUUID(), preservedId = randomUUID();
  const otherDir = join(f.workspace, ".token-coupon", "runs", otherId), preservedDir = join(f.workspace, ".token-coupon", "runs", preservedId);
  await mkdir(otherDir, { recursive: true }); await mkdir(preservedDir, { recursive: true });
  await writeFile(join(otherDir, "attempt.json"), JSON.stringify({ attemptId: otherId, taskId: "parallel", status: "running", owner: f.owner }));
  await writeFile(join(otherDir, "events.jsonl"), JSON.stringify({ sequence: 1, attemptId: otherId, type: "attempt.started" }) + "\n");
  const handoff = { taskId: "preserved", attemptId: preservedId, status: "succeeded" as const, summary: "Already delivered", summarySource: "final" as const, truncated: false, artifactDir: preservedDir };
  await f.store.saveHandoff(preservedId, handoff);
  await f.store.save({ ...record.snapshot, revision: 3, activeAttemptIds: [f.attemptId, otherId], tasks: record.snapshot.tasks.map((t) => t.taskId === "parallel" ? { ...t, status: "running", activeAttemptId: otherId, attempts: [{ attemptId: otherId, artifactDir: otherDir, outcome: "pending" }] } : t.taskId === "preserved" ? { ...t, status: "succeeded", result: handoff, attempts: [{ attemptId: preservedId, artifactDir: preservedDir, outcome: "recorded" }] } : t) });
  await recoverSession({ ...f, confirmedStopped: true });
  const recovered = await f.store.load(f.sessionId);
  expect(recovered.snapshot.tasks.map((t) => t.status)).toEqual(["failed", "blocked", "failed", "succeeded"]);
  expect(recovered.snapshot.tasks[3]?.result).toEqual(handoff);
  expect(recovered.snapshot.activeAttemptIds).toEqual([]);
  expect((await f.store.readAttempt(otherId))).toMatchObject({ status: "failed", reasonCode: "owner_interrupted" });
});
