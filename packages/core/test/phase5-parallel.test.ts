import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { continueSessionLanding, parsePlan, PlanStore, resumeSession, retrySession, runPlan, SessionStore } from "../src/index.js";
import { WorktreeIsolation } from "../src/worktree-isolation.js";
import type { ProcessResult, Runner, RunnerContext, RunnerInput, TaskDefinition } from "../src/runner.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function createRepository(): Promise<{ workspace: string; baseCommit: string }> {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-phase5-"));
  roots.push(root);
  const workspace = join(root, "repo");
  await mkdir(workspace);
  await git(workspace, ["init", "--initial-branch=main", "--quiet"]);
  await git(workspace, ["config", "user.name", "Phase 5 Test"]);
  await git(workspace, ["config", "user.email", "phase5@example.invalid"]);
  await writeFile(join(workspace, ".gitignore"), ".token-coupon/\n", "utf8");
  await writeFile(join(workspace, "README.md"), "phase5 baseline\n", "utf8");
  await git(workspace, ["add", ".gitignore", "README.md"]);
  await git(workspace, ["commit", "--quiet", "-m", "fixture baseline"]);
  return { workspace, baseCommit: await git(workspace, ["rev-parse", "HEAD"]) };
}

function planValue(): unknown {
  const task = (id: string) => ({ schemaVersion: 1, id, title: id, prompt: `Run ${id}`, execution: { runnerId: "mock", mode: "non_interactive" } });
  return {
    schemaVersion: 1, id: "phase5-parallel-test", title: "Phase 5 parallel test",
    tasks: [
      { task: task("alpha"), dependsOn: [], status: "planned" },
      { task: task("beta"), dependsOn: [], status: "planned" },
      { task: task("verify"), dependsOn: ["alpha", "beta"], status: "planned" },
    ],
  };
}

type Action = (input: RunnerInput, context: RunnerContext) => Promise<void>;
class ActionRunner implements Runner {
  readonly id = "mock";
  readonly supportsModel = false;
  constructor(private readonly action: Action) {}
  async checkAvailable(): Promise<void> {}
  async run(input: RunnerInput, context: RunnerContext): Promise<ProcessResult> {
    context.onStarted();
    await this.action(input, context);
    const marker = `\n${input.completionMarker}\n`;
    context.onOutput({ stream: "stdout", text: marker, agentText: marker });
    return { started: true, exitCode: 0, signal: null };
  }
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Phase 5 bounded Git-worktree scheduling", () => {
  it("runs independent tasks concurrently, merges their sibling commits, then verifies the integrated tree", async () => {
    const { workspace, baseCommit } = await createRepository();
    let active = 0;
    let peak = 0;
    let started = 0;
    let releaseBarrier!: () => void;
    let failBarrier!: (error: Error) => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const timedOut = new Promise<never>((_, reject) => { failBarrier = reject; });
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (input) => {
      if (task.id === "verify") {
        expect(await readFile(join(input.cwd, "alpha.txt"), "utf8")).toBe("alpha\n");
        expect(await readFile(join(input.cwd, "beta.txt"), "utf8")).toBe("beta\n");
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      if (started === 2) releaseBarrier();
      const timeout = setTimeout(() => failBarrier(new Error("并行 worker 未同时启动")), 3000);
      try { await Promise.race([bothStarted, timedOut]); }
      finally { clearTimeout(timeout); }
      await writeFile(join(input.cwd, `${task.id}.txt`), `${task.id}\n`);
      active -= 1;
    });

    const result = await runPlan({
      plan: parsePlan(planValue()), workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2,
    });

    expect(result.snapshot.status, JSON.stringify({ tasks: result.snapshot.tasks, schedulerState: result.snapshot.schedulerState })).toBe("succeeded");
    expect(result.snapshot.maxParallel).toBe(2);
    expect(peak).toBe(2);
    expect(result.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    const record = await new SessionStore(workspace).load(result.snapshot.sessionId);
    expect(record.snapshot.schemaVersion).toBe(3);
    expect(record.isolationJournal?.schemaVersion).toBe(2);
    const landed = record.isolationJournal!.attempts.filter((attempt) => ["alpha", "beta"].includes(attempt.taskId));
    expect(landed).toHaveLength(2);
    expect(landed.every((attempt) => attempt.baseCommit === baseCommit && attempt.waveId && attempt.executionId)).toBe(true);
    expect(landed.every((attempt) => attempt.status === "landed" && attempt.mergeParents?.length === 2 && attempt.integrationCommit)).toBe(true);
    for (const attempt of landed) {
      const parents = (await git(workspace, ["rev-list", "--parents", "-n", "1", attempt.integrationCommit!])).split(" ").slice(1);
      expect(parents).toEqual(attempt.mergeParents);
      expect(parents[1]).toBe(attempt.taskCommit);
    }
    const finalHead = await git(workspace, ["rev-parse", `refs/heads/token-coupon/session/${result.snapshot.sessionId}`]);
    expect(await git(workspace, ["show", `${finalHead}:alpha.txt`])).toBe("alpha");
    expect(await git(workspace, ["show", `${finalHead}:beta.txt`])).toBe("beta");
    const store = new SessionStore(workspace);
    const events = (await readFile(join(store.sessionDirectory(result.snapshot.sessionId), "scheduler-events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; sessionId: string; executionId: string; event: string });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(events.every((event) => event.sessionId === result.snapshot.sessionId && /^[0-9a-f-]{36}$/i.test(event.executionId))).toBe(true);
    expect(events.at(-1)?.event).toBe("scheduler.completed");
  });

  it("rejects parallel execution in a shared workspace before creating a Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-phase5-shared-"));
    roots.push(root);
    await expect(runPlan({ plan: parsePlan(planValue()), workspace: root, createRunner: () => new ActionRunner(async () => {}), maxParallel: 2 }))
      .rejects.toThrow("shared workspace");
    await expect(readFile(join(root, ".token-coupon", "sessions"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates concurrency bounds and binds a v3 Session to its immutable Plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-phase5-bounds-"));
    roots.push(root);
    const store = new SessionStore(root);
    const plan = parsePlan(planValue());
    for (const maxParallel of [0, -1, 1.5, 9]) {
      await expect(store.create(plan, undefined, { mode: "shared" }, { maxParallel })).rejects.toThrow("maxParallel");
    }
    const created = await store.create(plan);
    await expect(store.requestControl(created.snapshot.sessionId, "pause")).rejects.toThrow("session_control_requires_worktree");
    const planPath = join(store.sessionDirectory(created.snapshot.sessionId), "plan.json");
    const changedPlan = { ...plan, tasks: plan.tasks.map((entry, index) => index === 0 ? { ...entry, task: { ...entry.task, prompt: "Tampered after Session approval" } } : entry) };
    await writeFile(planPath, `${JSON.stringify(changedPlan, null, 2)}\n`, "utf8");
    await expect(store.load(created.snapshot.sessionId)).rejects.toThrow("Session v3 执行身份或调度字段无效");
  });

  it("enforces the public 1–8 limit, permits 1 and 8 in Git mode, and preserves scheduler sequence across retries", async () => {
    for (const maxParallel of [0, -1, 1.5, 9]) {
      const root = await mkdtemp(join(tmpdir(), "token-coupon-phase5-invalid-limit-"));
      roots.push(root);
      await expect(runPlan({ plan: parsePlan(planValue()), workspace: root, createRunner: () => new ActionRunner(async () => {}), maxParallel }))
        .rejects.toThrow("1 到 8 之间的整数");
      await expect(readdir(join(root, ".token-coupon", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const maxParallel of [1, 8]) {
      const { workspace } = await createRepository();
      let active = 0;
      let peak = 0;
      const result = await runPlan({
        plan: parsePlan(planValue()), workspace, isolation: "git-worktree", verificationTaskId: "verify", maxParallel,
        createRunner: (task) => new ActionRunner(async () => {
          if (task.id === "verify") return;
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        }),
      });
      expect(result.snapshot.status).toBe("succeeded");
      expect(result.snapshot.maxParallel).toBe(maxParallel);
      expect(peak).toBe(maxParallel === 1 ? 1 : 2);
    }
    const root = await mkdtemp(join(tmpdir(), "token-coupon-phase5-stale-event-"));
    roots.push(root);
    const store = new SessionStore(root);
    const record = await store.create(parsePlan(planValue()));
    const firstAttemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondAttemptId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const firstStore = new PlanStore(record.plan, record.snapshot);
    const firstRunning = firstStore.beginAttempt("alpha", firstAttemptId, join(root, ".token-coupon", "runs", firstAttemptId));
    const firstFailed = firstStore.finishAttempt("alpha", firstAttemptId, "failed", "runner_failed", null, firstRunning);
    const retryStore = new PlanStore(record.plan, { ...record.snapshot, tasks: firstFailed });
    const retryRunning = retryStore.beginAttempt("alpha", secondAttemptId, join(root, ".token-coupon", "runs", secondAttemptId), true);
    expect(() => retryStore.finishAttempt("alpha", firstAttemptId, "succeeded", null, null, retryRunning)).toThrow("不是任务 alpha 的当前执行");
    await store.appendSchedulerEvent(record.snapshot.sessionId, record.snapshot.executionId!, "task.reserved", { taskId: "alpha", attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const nextExecution = await store.beginExecution(record);
    await expect(store.appendSchedulerEvent(record.snapshot.sessionId, record.snapshot.executionId!, "attempt.finished"))
      .rejects.toThrow("scheduler_event_stale");
    const next = await store.appendSchedulerEvent(nextExecution.snapshot.sessionId, nextExecution.snapshot.executionId!, "scheduler.idle");
    expect(next.sequence).toBe(2);
  });

  it("reads a legacy v2 Session serially and upgrades it to v3 on the next execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-phase5-legacy-"));
    roots.push(root);
    const store = new SessionStore(root);
    for (const schemaVersion of [1, 2] as const) {
      const created = await store.create(parsePlan(planValue()));
      const path = join(store.sessionDirectory(created.snapshot.sessionId), "session.json");
      const legacy = { ...created.snapshot, schemaVersion } as Record<string, unknown>;
      delete legacy.maxParallel;
      delete legacy.planDigest;
      delete legacy.executionId;
      delete legacy.schedulerState;
      delete legacy.waveId;
      delete legacy.activeAttemptIds;
      delete legacy.controlState;
      if (schemaVersion === 1) delete legacy.isolation;
      await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
      const loaded = await store.load(created.snapshot.sessionId);
      expect(loaded.snapshot.schemaVersion).toBe(schemaVersion);
      expect(loaded.snapshot.maxParallel).toBeUndefined();
      const upgraded = await store.beginExecution(loaded);
      expect(upgraded.snapshot).toMatchObject({ schemaVersion: 3, maxParallel: 1, schedulerState: "idle", activeAttemptIds: [] });
    }
  });

  it("keeps successful siblings across a failed task retry and does not rerun them", async () => {
    const { workspace } = await createRepository();
    const calls = new Map<string, number>();
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (input) => {
      const count = (calls.get(task.id) ?? 0) + 1;
      calls.set(task.id, count);
      if (task.id === "alpha" && count === 1) throw new Error("first attempt fails");
      if (task.id === "verify") {
        expect(await readFile(join(input.cwd, "alpha.txt"), "utf8")).toBe("alpha\n");
        expect(await readFile(join(input.cwd, "beta.txt"), "utf8")).toBe("beta\n");
      } else await writeFile(join(input.cwd, `${task.id}.txt`), `${task.id}\n`);
    });
    const failed = await runPlan({ plan: parsePlan(planValue()), workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2 });
    expect(failed.snapshot.status).toBe("failed");
    expect(failed.snapshot.tasks.map(({ status }) => status)).toEqual(["failed", "succeeded", "blocked"]);
    const retried = await retrySession({ sessionId: failed.snapshot.sessionId, workspace, taskId: "alpha", createRunner });
    expect(retried.snapshot.tasks[0]?.status).toBe("succeeded");
    expect(calls.get("beta")).toBe(1);
    const resumed = await resumeSession({ sessionId: failed.snapshot.sessionId, workspace, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(calls).toEqual(new Map([["alpha", 2], ["beta", 1], ["verify", 1]]));
  });

  it("recovers a completed no-ff merge whose journal write was interrupted", async () => {
    const { workspace } = await createRepository();
    const result = await runPlan({
      plan: parsePlan(planValue()), workspace, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2,
      createRunner: (task) => new ActionRunner(async (input) => {
        if (task.id === "verify") return;
        await writeFile(join(input.cwd, `${task.id}.txt`), `${task.id}\n`);
      }),
    });
    const store = new SessionStore(workspace);
    const record = await store.load(result.snapshot.sessionId);
    const journal = record.isolationJournal!;
    const recoveredAttempt = journal.attempts.find((attempt) => attempt.taskId === "beta")!;
    const priorHead = recoveredAttempt.preIntegrationHead!;
    const before = await git(record.snapshot.isolation!.mode === "git-worktree" ? record.snapshot.isolation.repositoryRoot : workspace, ["rev-parse", `refs/heads/${record.snapshot.isolation!.mode === "git-worktree" ? record.snapshot.isolation.integrationBranch : "HEAD"}`]);
    expect(before).toBe(recoveredAttempt.integrationCommit);
    const interruptedJournal = {
      ...journal, integrationHead: priorHead,
      attempts: journal.attempts.map((attempt) => attempt.attemptId === recoveredAttempt.attemptId ? {
        ...attempt, status: "merging" as const, integrationCommit: null, postIntegrationHead: null, mergeParents: [], recoveryStage: "merge_started" as const,
      } : attempt),
    };
    await store.saveIsolationJournal(result.snapshot.sessionId, interruptedJournal);
    const isolation = new WorktreeIsolation({ ...record, isolationJournal: interruptedJournal }, store);
    await isolation.initialize();
    const recovered = await store.load(result.snapshot.sessionId);
    expect(recovered.isolationJournal?.integrationHead).toBe(before);
    expect(recovered.isolationJournal?.attempts.find((attempt) => attempt.attemptId === recoveredAttempt.attemptId)).toMatchObject({
      status: "landed", integrationCommit: before, postIntegrationHead: before, mergeParents: [priorHead, recoveredAttempt.taskCommit], recoveryStage: "journal_saved",
    });
  });

  it("recovers a successful Attempt commit missing its journal update without rerunning the Runner", async () => {
    const { workspace, baseCommit } = await createRepository();
    const plan = parsePlan({
      schemaVersion: 1, id: "phase5-task-commit-recovery", title: "Recover task commit before landing",
      tasks: [
        { task: { schemaVersion: 1, id: "implement", title: "implement", prompt: "write file", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
        { task: { schemaVersion: 1, id: "verify", title: "verify", prompt: "verify file", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: ["implement"], status: "planned" },
      ],
    });
    let implementationCalls = 0;
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (input) => {
      if (task.id === "implement") {
        implementationCalls += 1;
        await writeFile(join(input.cwd, "recovered.txt"), "recovered\n");
      } else expect(await readFile(join(input.cwd, "recovered.txt"), "utf8")).toBe("recovered\n");
    });
    const completed = await runPlan({ plan, workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2 });
    const store = new SessionStore(workspace);
    const record = await store.load(completed.snapshot.sessionId);
    const attempt = record.isolationJournal!.attempts.find(({ taskId }) => taskId === "implement")!;
    const verifyState = record.snapshot.tasks.find(({ taskId }) => taskId === "verify")!;
    const integration = record.snapshot.isolation!.mode === "git-worktree" ? record.snapshot.isolation.integrationWorktree : workspace;

    // Model the durable state after taskCommit exists but before the isolation journal records it or it lands.
    await git(integration, ["reset", "--hard", baseCommit]);
    const interruptedJournal = {
      ...record.isolationJournal!, status: "ready" as const, integrationHead: baseCommit,
      attempts: record.isolationJournal!.attempts.filter((item) => item.taskId !== "verify").map((item) => item.attemptId === attempt.attemptId ? {
        ...item, status: "committing" as const, taskCommit: null, recoveryStage: "task_committed" as const,
      } : item),
    };
    await store.saveIsolationJournal(completed.snapshot.sessionId, interruptedJournal);
    const runningSnapshot = {
      ...record.snapshot, revision: record.snapshot.revision + 1, status: "running" as const,
      schedulerState: "dispatching" as const, waveId: attempt.waveId!, activeAttemptIds: [attempt.attemptId],
      tasks: record.snapshot.tasks.map((state) => state.taskId === "implement" ? {
        ...state, status: "running" as const, activeAttemptId: attempt.attemptId, result: null, reasonCode: null,
        attempts: state.attempts.map((ref) => ref.attemptId === attempt.attemptId ? { ...ref, outcome: "pending" as const } : ref),
      } : { ...state, status: "planned" as const, activeAttemptId: null, attempts: [], result: null, reasonCode: null }),
    };
    expect(verifyState.status).toBe("succeeded");
    await store.save(runningSnapshot);

    const resumed = await resumeSession({ sessionId: completed.snapshot.sessionId, workspace, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(implementationCalls).toBe(1);
    expect(resumed.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    const finalRecord = await store.load(completed.snapshot.sessionId);
    expect(finalRecord.isolationJournal!.attempts.find(({ attemptId }) => attemptId === attempt.attemptId)).toMatchObject({ status: "landed", taskCommit: attempt.taskCommit });
  });

  it("acknowledges pause after the active batch drains and resumes only pending work", async () => {
    const { workspace } = await createRepository();
    let started = 0;
    let releaseWorkers!: () => void;
    let releaseBoth!: () => void;
    const workersReleased = new Promise<void>((resolve) => { releaseWorkers = resolve; });
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (input) => {
      if (task.id === "verify") {
        expect(await readFile(join(input.cwd, "alpha.txt"), "utf8")).toBe("alpha\n");
        expect(await readFile(join(input.cwd, "beta.txt"), "utf8")).toBe("beta\n");
        return;
      }
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      await workersReleased;
      await writeFile(join(input.cwd, `${task.id}.txt`), `${task.id}\n`);
    });
    const running = runPlan({ plan: parsePlan(planValue()), workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2 });
    await bothStarted;
    const [sessionId] = await readdir(join(workspace, ".token-coupon", "sessions"));
    expect(sessionId).toBeTruthy();
    const store = new SessionStore(workspace);
    const cliPath = join(process.cwd(), "packages", "cli", "dist", "main.js");
    const requesting = execFile(process.execPath, [cliPath, "session", "pause", "--id", sessionId!, "--workspace", workspace], { encoding: "utf8" });
    const requestPath = join(store.sessionDirectory(sessionId!), "control", "request.json");
    for (let index = 0; index < 100; index += 1) {
      try { await access(requestPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    let draining = false;
    for (let index = 0; index < 100; index += 1) {
      const current = await store.load(sessionId!);
      if (current.snapshot.status === "pausing" && current.snapshot.schedulerState === "draining") { draining = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(draining).toBe(true);
    releaseWorkers();
    const [paused] = await Promise.all([requesting, running]);
    expect(paused.stdout).toContain("已确认暂停 Session");
    const pausedRecord = await store.load(sessionId!);
    expect(pausedRecord.snapshot.status).toBe("paused");
    expect(pausedRecord.snapshot.controlState?.kind).toBe("pause");
    expect(pausedRecord.snapshot.controlState?.acknowledgedAt).toBeTruthy();
    expect(pausedRecord.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "planned"]);

    const resumed = await resumeSession({ sessionId: sessionId!, workspace, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(resumed.snapshot.tasks.map(({ attempts }) => attempts.length)).toEqual([1, 1, 1]);
  });

  it("cancels active workers, waits for their Attempt records, and acknowledges after drain", async () => {
    const { workspace } = await createRepository();
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (_input, context) => {
      if (task.id === "verify") throw new Error("cancelled batch must not release verification");
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      if (!context.signal.aborted) await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const running = runPlan({ plan: parsePlan(planValue()), workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2 });
    await bothStarted;
    const [sessionId] = await readdir(join(workspace, ".token-coupon", "sessions"));
    const store = new SessionStore(workspace);
    const cliPath = join(process.cwd(), "packages", "cli", "dist", "main.js");
    const cancelling = execFile(process.execPath, [cliPath, "session", "cancel", "--id", sessionId!, "--workspace", workspace], { encoding: "utf8" });
    const result = await running;
    expect((await cancelling).stdout).toContain("已确认取消 Session");
    expect(result.snapshot.status).toBe("cancelled");
    expect(result.snapshot.tasks.map(({ status }) => status)).toEqual(["cancelled", "cancelled", "blocked"]);
    expect(result.snapshot.activeAttemptIds).toEqual([]);
    expect(result.snapshot.controlState?.kind).toBe("cancel");
    for (const taskState of result.snapshot.tasks.slice(0, 2)) {
      const attempt = await store.readAttempt(taskState.attempts[0]!.attemptId) as { status: string };
      expect(attempt.status).toBe("cancelled");
    }
  });

  it("preserves a real merge conflict for manual resolution and resumes downstream verification", async () => {
    const { workspace } = await createRepository();
    const value = (taskId: string) => ({
      schemaVersion: 1, id: `phase5-conflict-${taskId}`, title: "Phase 5 conflict recovery",
      tasks: [
        { task: { schemaVersion: 1, id: "alpha", title: "alpha", prompt: "write alpha", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
        { task: { schemaVersion: 1, id: "beta", title: "beta", prompt: "write beta", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
        { task: { schemaVersion: 1, id: "gamma", title: "gamma", prompt: "write gamma", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
        { task: { schemaVersion: 1, id: "verify", title: "verify", prompt: "verify", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: ["alpha", "beta", "gamma"], status: "planned" },
      ],
    });
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (input) => {
      if (task.id === "verify") {
        expect(await readFile(join(input.cwd, "shared.txt"), "utf8")).toBe("manually resolved\n");
        expect(await readFile(join(input.cwd, "gamma.txt"), "utf8")).toBe("gamma\n");
        return;
      }
      if (task.id === "gamma") await writeFile(join(input.cwd, "gamma.txt"), "gamma\n");
      else await writeFile(join(input.cwd, "shared.txt"), `${task.id}\n`);
    });
    const failed = await runPlan({ plan: parsePlan(value("conflict")), workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 3 });
    expect(failed.snapshot.status).toBe("failed");
    expect(failed.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "failed", "interrupted", "blocked"]);
    expect(failed.snapshot.tasks[1]?.reasonCode).toBe("git_merge_conflict");
    const store = new SessionStore(workspace);
    const record = await store.load(failed.snapshot.sessionId);
    const conflict = record.isolationJournal!.attempts.find((attempt) => attempt.taskId === "beta");
    expect(conflict).toMatchObject({ status: "conflicted", reasonCode: "git_merge_conflict", preIntegrationHead: expect.any(String), taskCommit: expect.any(String) });
    const integrationPath = record.snapshot.isolation?.mode === "git-worktree" ? record.snapshot.isolation.integrationWorktree : "";
    await writeFile(join(integrationPath, "shared.txt"), "manually resolved\n");
    await git(integrationPath, ["add", "shared.txt"]);
    await git(integrationPath, ["commit", "--quiet", "-m", "manual conflict resolution"]);

    const landed = await continueSessionLanding({ sessionId: failed.snapshot.sessionId, workspace, taskId: "beta", createRunner });
    expect(landed.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "interrupted", "blocked"]);
    const resumed = await resumeSession({ sessionId: failed.snapshot.sessionId, workspace, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(resumed.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });
});
