import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { SessionStore, parsePlan, readSessionModels, updateSessionModel, taskWithSessionModel, runPlan, runGit, type Runner } from "../src/index.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "session-models-")); roots.push(workspace);
  const plan = parsePlan({ schemaVersion: 1, id: "model-policy", title: "Model policy", tasks: ["a", "b", "verify"].map(id => ({ task: { schemaVersion: 1, id, title: id, prompt: `Execute ${id}`, execution: { runnerId: "codex", mode: "managed", modelId: "fast" } }, dependsOn: id === "verify" ? ["a", "b"] : [], status: "planned" })) });
  const store = new SessionStore(workspace), record = await store.create(plan);
  return { workspace, plan, store, sessionId: record.snapshot.sessionId };
}
it("persists an audited model override without modifying the approved plan and detects stale revisions", async () => {
  const f = await fixture(), original = await readFile(join(f.store.sessionDirectory(f.sessionId), "plan.json"), "utf8"), requestKey = randomUUID();
  const input = { workspace: f.workspace, sessionId: f.sessionId, taskId: "a", modelId: "smart", expectedRevision: 0, requestKey };
  const policy = await updateSessionModel(input); expect(policy.revision).toBe(1); expect(policy.history).toHaveLength(1);
  expect((await taskWithSessionModel(f.plan.tasks[0]!.task, f.workspace, f.sessionId)).execution.modelId).toBe("smart");
  expect((await taskWithSessionModel(f.plan.tasks[1]!.task, f.workspace, f.sessionId)).execution.modelId).toBe("fast");
  expect((await updateSessionModel(input)).revision).toBe(1);
  await expect(updateSessionModel({ ...input, requestKey: randomUUID() })).rejects.toThrow("session_models_changed");
  await expect(updateSessionModel({ ...input, modelId: "other" })).rejects.toThrow("idempotency_conflict");
  expect(await readFile(join(f.store.sessionDirectory(f.sessionId), "plan.json"), "utf8")).toBe(original);
  await updateSessionModel({ ...input, expectedRevision: 1, requestKey: randomUUID(), modelId: null });
  expect((await taskWithSessionModel(f.plan.tasks[0]!.task, f.workspace, f.sessionId)).execution.modelId).toBe("fast");
});
it("rejects symlink, invalid model and foreign-plan configuration rather than dispatching it", async () => {
  const f = await fixture(), path = join(f.store.sessionDirectory(f.sessionId), "models.json"), outside = join(f.workspace, "outside.json");
  await writeFile(outside, "{}"); await symlink(outside, path);
  await expect(readSessionModels(f.workspace, f.sessionId)).rejects.toThrow("session_models_invalid"); await rm(path);
  await expect(updateSessionModel({ ...f, taskId: "a", modelId: "bad\nmodel", expectedRevision: 0, requestKey: randomUUID() })).rejects.toThrow("input_invalid");
  const data = await readSessionModels(f.workspace, f.sessionId); await writeFile(path, JSON.stringify({ ...data, planDigest: "wrong" }));
  await expect(taskWithSessionModel(f.plan.tasks[0]!.task, f.workspace, f.sessionId)).rejects.toThrow("session_models_invalid");
});
it("cancels only the selected parallel Attempt and leaves its sibling running to completion", async () => {
  const f = await fixture();
  await runGit(f.workspace, ["init"]); await runGit(f.workspace, ["config", "user.name", "model-test"]); await runGit(f.workspace, ["config", "user.email", "model@example.invalid"]);
  await writeFile(join(f.workspace, "README.md"), "fixture\n"); await runGit(f.workspace, ["add", "README.md"]); await runGit(f.workspace, ["commit", "-m", "fixture"]);
  const target = new AbortController(), started = new Set<string>(); let siblingAborted = false;
  const running = runPlan({ workspace: f.workspace, plan: f.plan, createRunner: () => ({ id: "codex", supportsModel: true, checkAvailable: async () => undefined,
    run: async (input, context) => {
      context.onStarted(); started.add(input.task.id);
      if (input.task.id === "a") { await new Promise<void>(resolve => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); }); return { started: true, exitCode: null, signal: null, transport: "app-server", nativeOutcome: "cancelled", cleanupStatus: "completed" }; }
      while (!target.signal.aborted) await delay(5);
      siblingAborted = context.signal.aborted; await writeFile(join(input.cwd, "b.txt"), "sibling completed\n");
      context.onOutput({ stream: "stdout", text: input.completionMarker + "\n", agentText: input.completionMarker + "\n" });
      return { started: true, exitCode: 0, signal: null, transport: "app-server", nativeOutcome: "completed", cleanupStatus: "completed" };
    },
  } satisfies Runner), isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2, taskSignal: id => id === "a" ? target.signal : new AbortController().signal });
  await expect.poll(() => started.size).toBe(2); target.abort();
  const result = await running;
  expect(siblingAborted).toBe(false); expect(result.snapshot.tasks.find(task => task.taskId === "b")?.status).toBe("succeeded");
  expect(result.snapshot.tasks.find(task => task.taskId === "a")?.status).toBe("cancelled");
});
