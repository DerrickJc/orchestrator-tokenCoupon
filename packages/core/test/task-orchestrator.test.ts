import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parsePlan, SessionLockError } from "../src/index.js";
import { resumeSession, retrySession, runPlan } from "../src/task-orchestrator.js";
import { SessionStore } from "../src/session-store.js";
import { MockRunner } from "../src/runners/mock-runner.js";
import type { PlanDefinition } from "../src/plan.js";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "token-coupon-phase2-"));
  roots.push(path);
  return path;
}

function planValue(): unknown {
  const task = (id: string, prompt = `Execute ${id}`) => ({
    schemaVersion: 1, id, title: id, prompt,
    execution: { runnerId: "mock", mode: "non_interactive", timeoutMs: 3000 },
  });
  return {
    schemaVersion: 1, id: "phase2-test", title: "Phase 2 test",
    tasks: [
      { task: task("implement"), dependsOn: [], status: "planned" },
      { task: task("test"), dependsOn: ["implement"], status: "planned" },
      { task: task("verify"), dependsOn: ["test"], status: "planned" },
    ],
  };
}

const createRunner = (_task: PlanDefinition["tasks"][number]["task"], options: { mockScenario?: string }) => new MockRunner(options.mockScenario);

afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Phase 2 plan execution and Session persistence", () => {
  it("runs tasks serially, stops on failure, and resumes after an explicit retry", async () => {
    const cwd = await workspace();
    const plan = parsePlan(planValue());
    const first = await runPlan({
      plan, workspace: cwd, createRunner,
      mockTaskScenarios: new Map([["test", "missing-marker"]]),
    });

    expect(first.snapshot.status).toBe("failed");
    expect(first.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "failed", "blocked"]);
    expect(first.snapshot.tasks[0]?.attempts).toHaveLength(1);
    expect(first.snapshot.tasks[2]?.attempts).toHaveLength(0);

    const store = new SessionStore(cwd);
    const loaded = await store.load(first.snapshot.sessionId);
    expect(loaded.snapshot.revision).toBe(first.snapshot.revision);
    expect(loaded.plan.id).toBe(plan.id);

    const retried = await retrySession({
      sessionId: first.snapshot.sessionId, workspace: cwd, createRunner, taskId: "test",
      mockTaskScenarios: new Map([["test", "success"]]),
    });
    expect(retried.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "planned"]);
    expect(retried.snapshot.tasks[1]?.attempts).toHaveLength(2);
    expect(retried.snapshot.tasks[1]?.attempts[0]?.attemptId).not.toBe(retried.snapshot.tasks[1]?.attempts[1]?.attemptId);

    const resumed = await resumeSession({ sessionId: first.snapshot.sessionId, workspace: cwd, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(resumed.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(resumed.snapshot.tasks.map(({ attempts }) => attempts.length)).toEqual([1, 2, 1]);

    const verifyAttempt = resumed.snapshot.tasks[2]?.attempts[0]?.attemptId;
    const prompt = await readFile(join(cwd, ".token-coupon", "runs", verifyAttempt!, "prompt.txt"), "utf8");
    expect(prompt).toContain("前置任务结果");
    expect(prompt).toContain("### test (");
    expect(prompt).toContain("mock runner started");
    const handoff = await readFile(join(cwd, ".token-coupon", "runs", verifyAttempt!, "handoff.json"), "utf8");
    expect(JSON.parse(handoff)).toMatchObject({ taskId: "verify", status: "succeeded" });
  });

  it("rejects an empty plan before creating a Session", async () => {
    const cwd = await workspace();
    const empty = parsePlan({ schemaVersion: 1, id: "empty", title: "empty", tasks: [] });
    await expect(runPlan({ plan: empty, workspace: cwd, createRunner })).rejects.toThrow("空计划不能执行");
    await expect(readdir(join(cwd, ".token-coupon", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unblocks a full dependency chain after retrying its failed root task", async () => {
    const cwd = await workspace();
    const plan = parsePlan(planValue());
    const failed = await runPlan({
      plan, workspace: cwd, createRunner,
      mockTaskScenarios: new Map([["implement", "missing-marker"]]),
    });
    expect(failed.snapshot.tasks.map(({ status }) => status)).toEqual(["failed", "blocked", "blocked"]);

    const retried = await retrySession({
      sessionId: failed.snapshot.sessionId, workspace: cwd, createRunner, taskId: "implement",
      mockTaskScenarios: new Map([["implement", "success"]]),
    });
    expect(retried.operationStatus).toBe("succeeded");
    expect(retried.snapshot.status).toBe("ready");
    expect(retried.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "planned", "planned"]);

    const resumed = await resumeSession({ sessionId: failed.snapshot.sessionId, workspace: cwd, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
  });

  it("rejects competing sessions in the same workspace", async () => {
    const cwd = await workspace();
    const store = new SessionStore(cwd);
    const release = await store.acquireLock();
    try {
      await expect(runPlan({ plan: parsePlan(planValue()), workspace: cwd, createRunner })).rejects.toBeInstanceOf(SessionLockError);
    } finally {
      await release();
    }
  });

  it("marks an unknown running Attempt as interrupted and does not restart it automatically", async () => {
    const cwd = await workspace();
    const store = new SessionStore(cwd);
    const plan = parsePlan(planValue());
    const created = await store.create(plan);
    const attemptId = randomUUID();
    const attemptPath = join(cwd, ".token-coupon", "runs", attemptId);
    const running = {
      ...created.snapshot,
      revision: created.snapshot.revision + 1,
      status: "running" as const,
      tasks: created.snapshot.tasks.map((state, index) => index === 0 ? {
        ...state,
        status: "running" as const,
        activeAttemptId: attemptId,
        attempts: [{ attemptId, artifactDir: attemptPath, outcome: "pending" as const }],
      } : state),
    };
    await store.save(running);

    await expect(resumeSession({ sessionId: created.snapshot.sessionId, workspace: cwd, createRunner })).rejects.toThrow("未解决的任务");
    const recovered = await store.load(created.snapshot.sessionId);
    expect(recovered.snapshot.status).toBe("interrupted");
    expect(recovered.snapshot.tasks[0]?.status).toBe("interrupted");
    expect(recovered.snapshot.tasks[0]?.attempts[0]?.outcome).toBe("record_missing");
    expect(recovered.snapshot.tasks[0]?.attempts).toHaveLength(1);
  });
});
