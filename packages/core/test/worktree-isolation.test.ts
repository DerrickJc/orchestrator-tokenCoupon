import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupSessionWorktrees, createSessionDelivery, formatSessionDelivery, parsePlan,
  resumeSession, retrySession, runPlan, SessionStore,
} from "../src/index.js";
import type { PlanDefinition } from "../src/plan.js";
import type { ProcessResult, Runner, RunnerContext, RunnerInput } from "../src/runner.js";
import type { TaskDefinition } from "../src/task.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

interface TestRepository { root: string; workspace: string; baseCommit: string; }

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function createRepository(extraIgnore = "", trackedFiles: Record<string, string> = {}): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-phase4-"));
  roots.push(root);
  const workspace = join(root, "repo");
  const hooks = join(root, "empty-hooks");
  await mkdir(workspace);
  await mkdir(hooks);
  await git(workspace, ["init", "--quiet"]);
  await git(workspace, ["config", "user.name", "Token Coupon Test"]);
  await git(workspace, ["config", "user.email", "token-coupon-test@example.invalid"]);
  await git(workspace, ["config", "core.hooksPath", hooks]);
  await writeFile(join(workspace, ".gitignore"), `.token-coupon/\n.env\n.phase4-setup-cache\n${extraIgnore}`, "utf8");
  await writeFile(join(workspace, "README.md"), "Phase 4 test repository\n", "utf8");
  for (const [path, contents] of Object.entries(trackedFiles)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), contents, "utf8");
  }
  await git(workspace, ["add", ".gitignore", "README.md"]);
  for (const path of Object.keys(trackedFiles)) await git(workspace, ["add", "-f", "--", path]);
  await git(workspace, ["commit", "--quiet", "-m", "initial fixture"]);
  return { root, workspace, baseCommit: await git(workspace, ["rev-parse", "HEAD"]) };
}

function plan(taskIds: Array<{ id: string; dependsOn: string[] }>): PlanDefinition {
  return parsePlan({
    schemaVersion: 1, id: "phase4-worktree-test", title: "Phase 4 worktree integration",
    tasks: taskIds.map(({ id, dependsOn }) => ({
      task: { schemaVersion: 1, id, title: id, prompt: `Run task ${id}`, execution: { runnerId: "mock", mode: "non_interactive" } },
      dependsOn, status: "planned",
    })),
  });
}

type Action = (input: RunnerInput, context: RunnerContext) => Promise<{ exitCode: number; output?: string; marker?: boolean }>;

class ActionRunner implements Runner {
  readonly id = "mock";
  readonly supportsModel = false;
  constructor(private readonly action: Action) {}
  async checkAvailable(): Promise<void> {}
  async run(input: RunnerInput, context: RunnerContext): Promise<ProcessResult> {
    context.onStarted();
    const result = await this.action(input, context);
    if (result.output) context.onOutput({ stream: "stdout", text: result.output, agentText: result.output });
    if (result.marker) {
      const marker = `\n${input.completionMarker}\n`;
      context.onOutput({ stream: "stdout", text: marker, agentText: marker });
    }
    return { started: true, exitCode: result.exitCode, signal: null };
  }
}

function runner(action: Action): (task: TaskDefinition) => Runner {
  return () => new ActionRunner(action);
}

async function runNode(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`node ${args.join(" ")} stopped by ${signal}`));
      else resolveResult({ code: code ?? 1, output: Buffer.concat(output).toString("utf8") });
    });
  });
}

function setupProfile() {
  return {
    schemaVersion: 1 as const,
    commands: [{ executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('.phase4-setup-cache', 'ready')"] }],
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Phase 4 Git worktree execution and delivery", () => {
  it("lands serial task commits, verifies the integrated code, and keeps logs central", async () => {
    const repo = await createRepository();
    const runPlanValue = plan([
      { id: "implement", dependsOn: [] },
      { id: "tests", dependsOn: ["implement"] },
      { id: "verify", dependsOn: ["tests"] },
    ]);
    const profile = setupProfile();
    let testOutput = "";
    const createRunner = runner(async (input) => {
      expect(await readFile(join(input.cwd, ".phase4-setup-cache"), "utf8")).toBe("ready");
      if (input.task.id === "implement") {
        await writeFile(join(input.cwd, "greet.mjs"), "export function greet(name) { return `Hello, ${name}!`; }\n", "utf8");
        return { exitCode: 0, marker: true, output: "created greet.mjs" };
      }
      if (input.task.id === "tests") {
        expect(await readFile(join(input.cwd, "greet.mjs"), "utf8")).toContain("export function greet");
        await writeFile(join(input.cwd, "greet.test.mjs"), [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { greet } from './greet.mjs';",
          "test('greets a name', () => assert.equal(greet('World'), 'Hello, World!'));",
          "test('accepts an empty name', () => assert.equal(greet(''), 'Hello, !'));",
          "",
        ].join("\n"), "utf8");
        return { exitCode: 0, marker: true, output: "created greet.test.mjs" };
      }
      expect(input.task.id).toBe("verify");
      expect(await readFile(join(input.cwd, "greet.test.mjs"), "utf8")).toContain("node:test");
      const test = await runNode(input.cwd, ["--test", "--test-reporter=tap", "greet.test.mjs"]);
      testOutput = test.output;
      return { exitCode: test.code, marker: test.code === 0, output: test.output };
    });
    const result = await runPlan({
      plan: runPlanValue, workspace: repo.workspace, createRunner,
      isolation: "git-worktree", verificationTaskId: "verify", setupProfile: profile,
    });

    expect(result.snapshot.status).toBe("succeeded");
    expect(result.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(testOutput).toContain("# pass 2");
    expect(testOutput).toContain("# fail 0");
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
    expect(await git(repo.workspace, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

    const store = new SessionStore(repo.workspace);
    const record = await store.load(result.snapshot.sessionId);
    expect(record.snapshot.isolation?.mode).toBe("git-worktree");
    if (record.snapshot.isolation?.mode !== "git-worktree") throw new Error("expected git isolation");
    expect(record.snapshot.isolation.setupHash).toMatch(/^[a-f0-9]{64}$/);
    const verification = record.snapshot.tasks.find(({ taskId }) => taskId === "verify")!;
    const verificationAttempt = verification.attempts[0]!.attemptId;
    const attemptRecord = await store.readAttempt(verificationAttempt) as Record<string, unknown>;
    expect(attemptRecord.cwd).toContain(join(".token-coupon", "worktrees", result.snapshot.sessionId, "attempts", verificationAttempt));
    expect(attemptRecord.artifactDir).toBe(join(repo.workspace, ".token-coupon", "runs", verificationAttempt));
    expect(record.isolationJournal?.attempts.map(({ status }) => status)).toEqual(["landed", "landed", "no_changes"]);
    const delivery = await createSessionDelivery(record, store);
    expect(delivery.changedFiles).toEqual(["greet.mjs", "greet.test.mjs"]);
    expect(delivery.verificationCommit).toBe(delivery.integrationHead);
    expect(formatSessionDelivery(delivery, repo.workspace)).toContain(`merge --no-ff -- 'token-coupon/session/${result.snapshot.sessionId}'`);
    expect(JSON.parse(await readFile(join(store.sessionDirectory(result.snapshot.sessionId), "delivery.json"), "utf8"))).toMatchObject({
      status: "ready", diffSha256: delivery.diffSha256,
    });

    const cleanup = await cleanupSessionWorktrees({ sessionId: result.snapshot.sessionId, workspace: repo.workspace });
    expect(cleanup.removedWorktrees).toHaveLength(3);
    expect(cleanup.retainedWorktrees).toEqual([]);
    expect((await stat(record.snapshot.isolation.integrationWorktree)).isDirectory()).toBe(true);
  });

  it("preserves a failed Attempt and retries from a clean new worktree", async () => {
    const repo = await createRepository();
    let implementRuns = 0;
    const calls: Array<{ taskId: string; cwd: string }> = [];
    const createRunner = (task: TaskDefinition) => new ActionRunner(async (input) => {
      calls.push({ taskId: input.task.id, cwd: input.cwd });
      if (task.id === "implement") {
        implementRuns += 1;
        if (implementRuns === 1) {
          await writeFile(join(input.cwd, "failed-attempt-only.txt"), "preserve for inspection\n", "utf8");
          return { exitCode: 1, marker: false, output: "simulated non-zero Runner exit" };
        }
        await writeFile(join(input.cwd, "greet.mjs"), "export const greet = (name) => `Hello, ${name}!`;\n", "utf8");
      }
      return { exitCode: 0, marker: true };
    });
    const value = plan([{ id: "implement", dependsOn: [] }, { id: "verify", dependsOn: ["implement"] }]);
    const failed = await runPlan({ plan: value, workspace: repo.workspace, createRunner, isolation: "git-worktree", verificationTaskId: "verify" });
    expect(failed.snapshot.status).toBe("failed");
    expect(failed.snapshot.tasks.map(({ status }) => status)).toEqual(["failed", "blocked"]);
    expect(await git(repo.workspace, ["rev-parse", `refs/heads/token-coupon/session/${failed.snapshot.sessionId}`])).toBe(repo.baseCommit);

    const firstAttempt = failed.snapshot.tasks[0]!.attempts[0]!.attemptId;
    const retried = await retrySession({ sessionId: failed.snapshot.sessionId, workspace: repo.workspace, createRunner, taskId: "implement" });
    expect(retried.operationStatus).toBe("succeeded");
    expect(retried.snapshot.tasks[0]!.attempts).toHaveLength(2);
    const retryAttempt = retried.snapshot.tasks[0]!.attempts[1]!.attemptId;
    const oldCwd = calls.find(({ taskId }) => taskId === "implement")!.cwd;
    const retryCwd = calls.filter(({ taskId }) => taskId === "implement")[1]!.cwd;
    expect(oldCwd).not.toBe(retryCwd);
    await readFile(join(oldCwd, "failed-attempt-only.txt"), "utf8");
    await expect(readFile(join(retryCwd, "failed-attempt-only.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await resumeSession({ sessionId: failed.snapshot.sessionId, workspace: repo.workspace, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(resumed.snapshot.tasks.map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    const record = await new SessionStore(repo.workspace).load(failed.snapshot.sessionId);
    expect(record.isolationJournal?.attempts.find(({ attemptId }) => attemptId === firstAttempt)?.status).toBe("failed");
    expect(record.isolationJournal?.attempts.find(({ attemptId }) => attemptId === retryAttempt)?.status).toBe("landed");
  });

  it("does not land ignored untracked files and rejects edits to tracked ignored files", async () => {
    const ignoredOnlyRepo = await createRepository();
    const ignoredOnlyPlan = plan([{ id: "write-ignored", dependsOn: [] }, { id: "verify", dependsOn: ["write-ignored"] }]);
    const ignoredOnly = await runPlan({
      plan: ignoredOnlyPlan, workspace: ignoredOnlyRepo.workspace,
      createRunner: runner(async (input) => {
        if (input.task.id === "write-ignored") await writeFile(join(input.cwd, ".env"), "local-only\n", "utf8");
        else await expect(readFile(join(input.cwd, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        return { exitCode: 0, marker: true };
      }),
      isolation: "git-worktree", verificationTaskId: "verify",
    });
    expect(ignoredOnly.snapshot.status).toBe("succeeded");
    const ignoredRecord = await new SessionStore(ignoredOnlyRepo.workspace).load(ignoredOnly.snapshot.sessionId);
    expect(ignoredRecord.isolationJournal?.attempts[0]?.status).toBe("no_changes");
    expect((await createSessionDelivery(ignoredRecord, new SessionStore(ignoredOnlyRepo.workspace))).changedFiles).toEqual([]);

    const trackedIgnoredRepo = await createRepository("/private.txt\n", { "private.txt": "baseline secret\n" });
    const blocked = await runPlan({
      plan: plan([{ id: "edit-private", dependsOn: [] }, { id: "verify", dependsOn: ["edit-private"] }]),
      workspace: trackedIgnoredRepo.workspace,
      createRunner: runner(async (input) => {
        if (input.task.id === "edit-private") await writeFile(join(input.cwd, "private.txt"), "changed secret\n", "utf8");
        return { exitCode: 0, marker: true };
      }),
      isolation: "git-worktree", verificationTaskId: "verify",
    });
    expect(blocked.snapshot.status).toBe("failed");
    expect(blocked.snapshot.tasks.map(({ status }) => status)).toEqual(["failed", "blocked"]);
    expect(blocked.snapshot.tasks[0]?.reasonCode).toBe("tracked_ignored_changes");
    expect(await git(trackedIgnoredRepo.workspace, ["rev-parse", `refs/heads/token-coupon/session/${blocked.snapshot.sessionId}`])).toBe(trackedIgnoredRepo.baseCommit);
  });

  it("rejects a dirty source workspace before creating a Session", async () => {
    const repo = await createRepository();
    await writeFile(join(repo.workspace, "untracked.txt"), "keep me\n", "utf8");
    const dirtyPlan = plan([{ id: "implement", dependsOn: [] }, { id: "verify", dependsOn: ["implement"] }]);
    await expect(runPlan({
      plan: dirtyPlan, workspace: repo.workspace, createRunner: runner(async () => ({ exitCode: 0, marker: true })),
      isolation: "git-worktree", verificationTaskId: "verify",
    })).rejects.toThrow("工作区干净");
    expect(await readFile(join(repo.workspace, "untracked.txt"), "utf8")).toBe("keep me\n");
    await expect(readFile(join(repo.workspace, ".token-coupon", "sessions"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
