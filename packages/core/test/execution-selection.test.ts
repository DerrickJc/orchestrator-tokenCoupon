import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  approvePlannerDraft, MockPlanner, MockPlanReviewer, parseExecutionSelection, parsePlan, reviewPlannerDraft,
  runApprovedPlanner, runPlan, runGit, retrySession, resumeSession, SessionStore, startPlannerConversation,
  taskWithSessionModel, updateSessionModel, type Runner, type TaskDefinition,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function workspace() { const path = await mkdtemp(join(tmpdir(), "tc-launch-models-")); roots.push(path); return path; }
const plan = () => parsePlan({ schemaVersion: 1, id: "launch", title: "Launch choices", tasks: ["a", "b", "verify"].map((id, index, all) => ({ task: { schemaVersion: 1, id, title: id, prompt: `Execute ${id}`, execution: { runnerId: "codex", mode: "managed", modelId: "approved-model" } }, dependsOn: index ? [all[index - 1]] : [], status: "planned" })) });
function factory(calls: Array<{ taskId: string; runnerId: string; modelId?: string }>, fail?: () => boolean) {
  return (task: TaskDefinition): Runner => ({ id: task.execution.runnerId, supportsModel: true, checkAvailable: async () => {}, run: async (input, context) => {
    context.onStarted(); calls.push({ taskId: input.task.id, runnerId: input.execution.runnerId, modelId: input.execution.modelId });
    if (input.task.id === "b" && fail?.()) return { started: true, exitCode: 1, signal: null };
    context.onOutput({ stream: "stdout", text: input.completionMarker + "\n", agentText: input.completionMarker + "\n" });
    return { started: true, exitCode: 0, signal: null };
  } });
}

it("rejects foreign tasks, duplicate assignments and edits outside Runner/model", () => {
  const original = plan();
  for (const input of [
    { tasks: [{ taskId: "foreign", runnerId: "codex" }] },
    { tasks: [{ taskId: "a", runnerId: "codex" }, { taskId: "a", runnerId: "claude-code" }] },
    { defaults: { runnerId: "codex", prompt: "replace approved text" } },
    { defaults: { runnerId: "codex", mode: "non_interactive" } },
    { defaults: { runnerId: "codex", modelId: "invalid\nmodel" } },
    { defaults: { runnerId: "codex", modelId: "x".repeat(121) } },
  ]) expect(() => parseExecutionSelection(input, original)).toThrow("execution_selection");
});

it("dispatches mixed launch choices, persists actual Attempt settings and keeps them across retry/resume", async () => {
  const cwd = await workspace(), original = plan(), calls: Parameters<typeof factory>[0] = [];
  await runGit(cwd, ["init"]); await runGit(cwd, ["config", "user.name", "Launch Fixture"]); await runGit(cwd, ["config", "user.email", "launch@example.invalid"]);
  await writeFile(join(cwd, "README.md"), "Isolated launch fixture\n"); await runGit(cwd, ["add", "README.md"]); await runGit(cwd, ["commit", "-m", "fixture"]);
  let failed = false;
  const createRunner = factory(calls, () => { if (!failed) { failed = true; return true; } return false; });
  const selection = { defaults: { runnerId: "codex", modelId: "fast" }, tasks: [{ taskId: "b", runnerId: "claude-code", modelId: "flash" }] };
  const result = await runPlan({ workspace: cwd, plan: original, executionSelection: selection, createRunner, isolation: "git-worktree", verificationTaskId: "verify" });
  expect(result.snapshot.status).toBe("failed");
  expect(calls).toEqual([{ taskId: "a", runnerId: "codex", modelId: "fast" }, { taskId: "b", runnerId: "claude-code", modelId: "flash" }]);
  const store = new SessionStore(cwd), sessionId = result.snapshot.sessionId;
  expect((await store.load(sessionId)).plan).toEqual(original);
  expect((await store.load(sessionId)).snapshot.executionSelection).toEqual(selection);
  await updateSessionModel({ workspace: cwd, sessionId, taskId: "b", modelId: "smarter", expectedRevision: 0, requestKey: randomUUID() });
  expect((await taskWithSessionModel(original.tasks[1]!.task, cwd, sessionId)).execution).toMatchObject({ runnerId: "claude-code", modelId: "smarter" });
  await updateSessionModel({ workspace: cwd, sessionId, taskId: "b", modelId: null, expectedRevision: 1, requestKey: randomUUID() });
  await retrySession({ workspace: cwd, sessionId, taskId: "b", createRunner });
  const completed = await resumeSession({ workspace: cwd, sessionId, createRunner });
  expect(completed.snapshot.status).toBe("succeeded");
  expect(calls.slice(2)).toEqual([{ taskId: "b", runnerId: "claude-code", modelId: "flash" }, { taskId: "verify", runnerId: "codex", modelId: "fast" }]);
  expect(calls.filter(item => item.taskId === "a")).toHaveLength(1);
  for (const task of completed.snapshot.tasks) {
    const attemptId = task.attempts.at(-1)!.attemptId;
    const attempt = JSON.parse(await readFile(join(cwd, ".token-coupon", "runs", attemptId, "attempt.json"), "utf8"));
    expect(attempt.execution.modelId).toBe(task.taskId === "b" ? "flash" : "fast");
    expect(attempt.runnerId).toBe(task.taskId === "b" ? "claude-code" : "codex");
  }
  expect((await store.load(sessionId)).plan).toEqual(original);
});

it("clears an approved model when Runner default is selected and rejects a corrupted launch configuration", async () => {
  const cwd = await workspace(), original = plan(), store = new SessionStore(cwd);
  const record = await store.create(original, randomUUID(), { mode: "shared" }, { executionSelection: { defaults: { runnerId: "claude-code" } } });
  const task = await taskWithSessionModel(original.tasks[0]!.task, cwd, record.snapshot.sessionId);
  expect(task.execution.runnerId).toBe("claude-code"); expect(task.execution.modelId).toBeUndefined();
  const path = join(store.sessionDirectory(record.snapshot.sessionId), "session.json");
  await writeFile(path, JSON.stringify({ ...record.snapshot, executionSelection: { defaults: { runnerId: "codex", modelId: "tampered" } } }));
  await expect(store.load(record.snapshot.sessionId)).rejects.toThrow("session_execution_selection_invalid");
});

it("binds launch settings to the approved draft, reuses its Session and rejects replacement settings", async () => {
  const cwd = await workspace(), calls: Parameters<typeof factory>[0] = [], createRunner = factory(calls);
  const started = await startPlannerConversation({ workspace: cwd, request: "Execute a small feature and verify it", config: { provider: "mock", model: "mock", baseUrl: "mock://local" }, executionDefaults: { runnerId: "codex", mode: "managed", modelId: "approved-model" }, planner: new MockPlanner([{ kind: "draft", message: "Review plan", plan: plan() }]) });
  const planningId = started.snapshot.planningId;
  const review = await reviewPlannerDraft({ workspace: cwd, planningId, reviewer: new MockPlanReviewer() });
  const approved = await approvePlannerDraft({ workspace: cwd, planningId, draftRevision: 1, reviewId: review.review.reviewId });
  await expect(runApprovedPlanner({ workspace: cwd, planningId, createRunner, expectedPlanHash: "stale" })).rejects.toThrow("planner_launch_context_changed");
  const executionSelection = { defaults: { runnerId: "claude-code", modelId: "flash" } };
  const first = await runApprovedPlanner({ workspace: cwd, planningId, createRunner, executionSelection, expectedPlanHash: approved.draft!.planHash, expectedDraftRevision: 1 });
  expect(first.snapshot.approval).toEqual(approved.snapshot.approval); expect(first.draft).toEqual(approved.draft);
  const repeated = await runApprovedPlanner({ workspace: cwd, planningId, createRunner, executionSelection });
  expect(repeated.snapshot.execution?.sessionId).toBe(first.snapshot.execution?.sessionId); expect(calls).toHaveLength(3);
  await expect(runApprovedPlanner({ workspace: cwd, planningId, createRunner, executionSelection: { defaults: { runnerId: "codex", modelId: "different" } } })).rejects.toThrow("session_execution_selection_fixed");
  expect(await readdir(join(cwd, ".token-coupon", "sessions"))).toHaveLength(1);
});
