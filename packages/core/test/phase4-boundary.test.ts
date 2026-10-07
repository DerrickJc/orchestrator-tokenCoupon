import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlannerDraft, continueSessionLanding, createSessionDelivery, MockPlanReviewer, MockPlanner,
  parsePlan, parseWorktreeSetupProfile, reviewPlannerDraft, resumeSession, retrySession, runApprovedPlanner,
  runPlan, SessionStore, startPlannerConversation, validateVerificationTask,
} from "../src/index.js";
import type { PlanDefinition } from "../src/plan.js";
import type { ProcessResult, Runner, RunnerContext, RunnerInput } from "../src/runner.js";
import type { TaskDefinition } from "../src/task.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

interface Repository { root: string; workspace: string; hooks: string; baseCommit: string; }

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function gitResult(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

async function createRepository(ignore = "", tracked: Record<string, string> = {}): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-phase4-boundary-"));
  roots.push(root);
  const workspace = join(root, "repo");
  const hooks = join(root, "empty-hooks");
  await mkdir(workspace);
  await mkdir(hooks);
  await git(workspace, ["init", "--initial-branch=main", "--quiet"]);
  await git(workspace, ["config", "user.name", "Phase 4 Test"]);
  await git(workspace, ["config", "user.email", "phase4@example.invalid"]);
  await git(workspace, ["config", "core.hooksPath", hooks]);
  await writeFile(join(workspace, ".gitignore"), ".token-coupon/\n.env\n.cache/\n" + ignore, "utf8");
  await writeFile(join(workspace, "README.md"), "base README\n", "utf8");
  for (const [path, content] of Object.entries(tracked)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content, "utf8");
  }
  await git(workspace, ["add", ".gitignore", "README.md"]);
  for (const path of Object.keys(tracked)) await git(workspace, ["add", "-f", "--", path]);
  await git(workspace, ["commit", "--quiet", "-m", "fixture baseline"]);
  return { root, workspace, hooks, baseCommit: await git(workspace, ["rev-parse", "HEAD"]) };
}

function makePlan(ids: string[], dependencies: Record<string, string[]> = {}): PlanDefinition {
  return parsePlan({
    schemaVersion: 1, id: "phase4-boundary", title: "Phase 4 boundary test",
    tasks: ids.map((id) => ({
      task: { schemaVersion: 1, id, title: id, prompt: "Perform " + id, execution: { runnerId: "mock", mode: "non_interactive" } },
      dependsOn: dependencies[id] ?? [], status: "planned",
    })),
  });
}

type ActionResult = { exitCode: number; output?: string; marker?: boolean } | void;
type Action = (input: RunnerInput, context: RunnerContext) => Promise<ActionResult>;

class ActionRunner implements Runner {
  readonly id = "mock";
  readonly supportsModel = false;
  constructor(private readonly action: Action) {}
  async checkAvailable(): Promise<void> {}
  async run(input: RunnerInput, context: RunnerContext): Promise<ProcessResult> {
    context.onStarted();
    const actionResult = await this.action(input, context);
    const result = actionResult ?? { exitCode: 0 };
    if (result.output) context.onOutput({ stream: "stdout", text: result.output, agentText: result.output });
    if (result.marker) {
      const marker = "\n" + input.completionMarker + "\n";
      context.onOutput({ stream: "stdout", text: marker, agentText: marker });
    }
    return { started: true, exitCode: result.exitCode, signal: null };
  }
}

function runner(action: Action) { return (_task: TaskDefinition) => new ActionRunner(action); }

function successfulAction(action?: Action): Action {
  return async (input, context) => {
    const actionResult = action ? await action(input, context) : undefined;
    const result = actionResult ?? { exitCode: 0 };
    return { ...result, marker: result.marker ?? result.exitCode === 0 };
  };
}

function setup(command: string, args: string[]) {
  return { schemaVersion: 1 as const, commands: [{ executable: command, args }] };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Phase 4 repository and setup boundaries", () => {
  it.each([
    ["unstaged", async (repo: Repository) => writeFile(join(repo.workspace, "README.md"), "user edit\n")],
    ["staged", async (repo: Repository) => { await writeFile(join(repo.workspace, "README.md"), "staged edit\n"); await git(repo.workspace, ["add", "README.md"]); }],
    ["untracked", async (repo: Repository) => writeFile(join(repo.workspace, "user-file.txt"), "keep me\n")],
  ])("refuses a dirty source repository (%s) without changing its contents", async (_label, prepare) => {
    const repo = await createRepository();
    await prepare(repo);
    const beforeStatus = await git(repo.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const beforeHead = await git(repo.workspace, ["rev-parse", "HEAD"]);
    await expect(runPlan({ plan: makePlan(["verify"]), workspace: repo.workspace, createRunner: runner(successfulAction()), isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow("工作区干净");
    expect(await git(repo.workspace, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(beforeHead);
    await expect(readFile(join(repo.workspace, ".token-coupon", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a repository subdirectory, a no-commit repository, and a symlink workspace", async () => {
    const repo = await createRepository();
    const child = join(repo.workspace, "src");
    await mkdir(child);
    await expect(runPlan({ plan: makePlan(["verify"]), workspace: child, createRunner: runner(successfulAction()), isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow("仓库根目录");

    const empty = join(repo.root, "empty-repo");
    await mkdir(empty);
    await git(empty, ["init", "--quiet"]);
    await expect(runPlan({ plan: makePlan(["verify"]), workspace: empty, createRunner: runner(successfulAction()), isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow();

    const alias = join(repo.root, "repo-link");
    await symlink(repo.workspace, alias);
    await expect(runPlan({ plan: makePlan(["verify"]), workspace: alias, createRunner: runner(successfulAction()), isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow("符号链接");
  });

  it("rejects linked or tracked .token-coupon metadata without touching the external target", async () => {
    const linked = await createRepository();
    const external = join(linked.root, "external-metadata");
    await mkdir(external);
    await writeFile(join(external, "sentinel.txt"), "do not touch\n", "utf8");
    await symlink(external, join(linked.workspace, ".token-coupon"));
    await expect(runPlan({ plan: makePlan(["verify"]), workspace: linked.workspace, createRunner: runner(successfulAction()), isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow("符号链接");
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe("do not touch\n");

    const tracked = await createRepository("", { ".token-coupon/tracked.txt": "tracked metadata\n" });
    await expect(runPlan({ plan: makePlan(["verify"]), workspace: tracked.workspace, createRunner: runner(successfulAction()), isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow("含有 Git 跟踪文件");
    expect(await readFile(join(tracked.workspace, ".token-coupon", "tracked.txt"), "utf8")).toBe("tracked metadata\n");
  });

  it("does not copy ignored local environment files into an Attempt worktree", async () => {
    const repo = await createRepository();
    await writeFile(join(repo.workspace, ".env"), "PHASE4_SENTINEL=local-secret\n", "utf8");
    const observed: string[] = [];
    const result = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        try { await readFile(join(input.cwd, ".env"), "utf8"); observed.push("present"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") observed.push("absent"); else throw error; }
        if (input.task.id === "implement") await writeFile(join(input.cwd, "feature.txt"), "implemented\n", "utf8");
        if (input.task.id === "verify") expect(await readFile(join(input.cwd, "feature.txt"), "utf8")).toBe("implemented\n");
      })),
    });
    expect(result.snapshot.status, JSON.stringify(result.snapshot.tasks.map(({ taskId, status, reasonCode }) => ({ taskId, status, reasonCode })))).toBe("succeeded");
    expect(observed).toEqual(["absent", "absent"]);
    const store = new SessionStore(repo.workspace);
    const delivery = await createSessionDelivery(await store.load(result.snapshot.sessionId), store);
    expect(delivery.changedFiles).toEqual(["feature.txt"]);
    expect(await git(repo.workspace, ["show", delivery.integrationHead + ":.env"]).catch(() => "")).toBe("");
  });

  it("stops a cancelled setup before Runner startup and records the Session as cancelled", async () => {
    if (process.platform === "win32") return;
    const repo = await createRepository();
    const pidFile = join(repo.root, "setup-child.pid");
    const childProgram = "require('node:fs').writeFileSync(" + JSON.stringify(pidFile) + ",String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const controller = new AbortController();
    let runnerCalls = 0;
    const pending = runPlan({ plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify", setupProfile: setup(process.execPath, ["-e", childProgram]), signal: controller.signal,
      createRunner: runner(async () => { runnerCalls += 1; return { exitCode: 0, marker: true }; }) });
    let childPid: number | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { childPid = Number(await readFile(pidFile, "utf8")); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      expect(childPid).toBeDefined();
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* child may already have exited */ } }
      const result = await pending;
      expect(result.snapshot.status).toBe("cancelled");
      expect(result.snapshot.tasks[0]?.status).toBe("cancelled");
      expect(runnerCalls).toBe(0);
      await expect(access(pidFile)).resolves.toBeUndefined();
    } finally {
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* child may already have exited */ } }
    }
  });

  it("runs setup before a task, rejects failed or source-changing setup, and binds retry to the original hash", async () => {
    const failedRepo = await createRepository();
    let failedRunnerCalls = 0;
    const failed = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: failedRepo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify", setupProfile: setup(process.execPath, ["-e", "process.exit(7)"]),
      createRunner: runner(async () => { failedRunnerCalls += 1; return { exitCode: 0, marker: true }; }),
    });
    expect(failed.snapshot.tasks[0]?.reasonCode).toBe("setup_command_failed");
    expect(failedRunnerCalls).toBe(0);
    const setupDirectory = join(new SessionStore(failedRepo.workspace).sessionDirectory(failed.snapshot.sessionId), "setup");
    expect(await readFile(join(setupDirectory, failed.snapshot.tasks[0]!.attempts[0]!.attemptId + ".json"), "utf8")).toContain('"status": "failed"');

    const changingRepo = await createRepository();
    const changed = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: changingRepo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      setupProfile: setup(process.execPath, ["-e", "require('node:fs').writeFileSync('README.md','changed')"]),
      createRunner: runner(async () => { throw new Error("Runner must not start"); }),
    });
    expect(changed.snapshot.tasks[0]?.reasonCode).toBe("workspace_setup_changed_source");
    expect(await readFile(join(changingRepo.workspace, "README.md"), "utf8")).toBe("base README\n");

    const retryRepo = await createRepository();
    const originalSetup = setup(process.execPath, ["-e", "require('node:fs').mkdirSync('.cache',{recursive:true});require('node:fs').writeFileSync('.cache/setup','ready')"]);
    let runnerCalls = 0;
    const retryable = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: retryRepo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify", setupProfile: originalSetup,
      createRunner: runner(async () => { runnerCalls += 1; return { exitCode: 1, output: "failure", marker: false }; }),
    });
    await expect(retrySession({
      sessionId: retryable.snapshot.sessionId, workspace: retryRepo.workspace, taskId: "implement",
      setupProfile: setup(process.execPath, ["-e", "require('node:fs').mkdirSync('.cache',{recursive:true});require('node:fs').writeFileSync('.cache/setup','different')"]),
      createRunner: runner(async () => { runnerCalls += 1; return { exitCode: 0, marker: true }; }),
    })).rejects.toThrow("SHA-256");
    expect(runnerCalls).toBe(1);
  });

  it("enforces setup profile boundaries at item, argument, and UTF-8 byte limits", () => {
    const command = (args: string[] = []) => ({ executable: "node", args });
    expect(parseWorktreeSetupProfile({ schemaVersion: 1, commands: Array.from({ length: 16 }, () => command()) }).commands).toHaveLength(16);
    expect(() => parseWorktreeSetupProfile({ schemaVersion: 1, commands: Array.from({ length: 17 }, () => command()) })).toThrow("最多包含 16");
    expect(parseWorktreeSetupProfile({ schemaVersion: 1, commands: [command(Array(128).fill("x"))] }).commands[0]?.args).toHaveLength(128);
    expect(() => parseWorktreeSetupProfile({ schemaVersion: 1, commands: [command(Array(129).fill("x"))] })).toThrow("argv 数组");
    expect(parseWorktreeSetupProfile({ schemaVersion: 1, commands: [command(["x".repeat(8192)])] }).commands[0]?.args[0]).toHaveLength(8192);
    expect(() => parseWorktreeSetupProfile({ schemaVersion: 1, commands: [command(["x".repeat(8193)])] })).toThrow("argv 数组");
    expect(() => parseWorktreeSetupProfile({ schemaVersion: 1, commands: [command(["a\0b"])] })).toThrow("argv 数组");
    expect(() => parseWorktreeSetupProfile({ schemaVersion: 1, commands: [{ ...command(), extra: true }] })).toThrow("argv 数组");
    expect(() => parseWorktreeSetupProfile({ schemaVersion: 1, commands: [{ ...command(), env: { "BAD-KEY": "value" } }] })).toThrow("环境变量");
  });
});

describe("Phase 4 landing, verification, and cleanup boundaries", () => {
  it("rejects invalid final verification task shapes before starting a Runner", async () => {
    const leaf = makePlan(["implement", "verify"], { verify: ["implement"] });
    expect(() => validateVerificationTask(leaf, "missing")).toThrow("不存在");
    expect(() => validateVerificationTask(leaf, "implement")).toThrow("不能是其他任务的前置依赖");
    expect(() => validateVerificationTask(makePlan(["implement", "verify"]), "verify")).toThrow("必须依赖所有其他任务");
    await expect(runPlan({ plan: leaf, workspace: "/not-used", createRunner: runner(successfulAction()), isolation: "git-worktree" })).rejects.toThrow("需要指定");
  });

  it("blocks a final verification Attempt that changes source, even when the Runner reports success", async () => {
    const repo = await createRepository();
    const result = await runPlan({ plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id === "implement") await writeFile(join(input.cwd, "feature.txt"), "ready\n", "utf8");
        if (input.task.id === "verify") await writeFile(join(input.cwd, "verification-source-edit.txt"), "must not be delivered\n", "utf8");
      })),
    });
    expect(result.snapshot.status).toBe("failed");
    expect(result.snapshot.tasks[0]?.status).toBe("succeeded");
    expect(result.snapshot.tasks[1]?.reasonCode).toBe("verification_modified_source");
    const store = new SessionStore(repo.workspace);
    await expect(createSessionDelivery(await store.load(result.snapshot.sessionId), store)).rejects.toThrow("尚未全部成功");
  });

  it("handles special Git paths and stages only the selected, non-ignored files", async () => {
    const repo = await createRepository();
    const names = ["space name.txt", "-leading.txt", "quote'name.txt", "line\nbreak.txt", "glob[?]*.txt", "semi;$(echo nope).txt"];
    const result = await runPlan({
      plan: makePlan(["write", "verify"], { verify: ["write"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id === "write") {
          for (const name of names) await writeFile(join(input.cwd, name), "value:" + name + "\n", "utf8");
          await writeFile(join(input.cwd, ".env"), "ignored credential sentinel\n", "utf8");
          await git(input.cwd, ["add", "-f", "--", ".env"]);
          await git(input.cwd, ["add", "--", ...names]);
        } else {
          for (const name of names) expect(await readFile(join(input.cwd, name), "utf8")).toContain("value:");
          await expect(readFile(join(input.cwd, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
      })),
    });
    expect(result.snapshot.status, JSON.stringify(result.snapshot.tasks.map(({ taskId, status, reasonCode }) => ({ taskId, status, reasonCode })))).toBe("succeeded");
    const store = new SessionStore(repo.workspace);
    const delivery = await createSessionDelivery(await store.load(result.snapshot.sessionId), store);
    expect(delivery.changedFiles).toEqual([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    expect(await git(repo.workspace, ["show", delivery.integrationHead + ":.env"]).catch(() => "")).toBe("");
  });

  it("blocks a mixed deliverable change when the same Attempt edits a baseline tracked ignored file", async () => {
    const repo = await createRepository("", { ".env": "baseline secret\n" });
    const result = await runPlan({ plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id !== "implement") return;
        await writeFile(join(input.cwd, "feature.txt"), "deliverable\n", "utf8");
        await writeFile(join(input.cwd, ".env"), "changed secret\n", "utf8");
      })),
    });
    expect(result.snapshot.status).toBe("failed");
    expect(result.snapshot.tasks[0]?.reasonCode).toBe("tracked_ignored_changes");
    expect(result.snapshot.tasks[1]?.status).toBe("blocked");
    const record = await new SessionStore(repo.workspace).load(result.snapshot.sessionId);
    expect(record.isolationJournal?.integrationHead).toBe(repo.baseCommit);
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
  });

  it("uses newly changed ignore rules while still rejecting a baseline tracked ignored file", async () => {
    const repo = await createRepository("", { "excluded.txt": "original\n" });
    const result = await runPlan({ plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id !== "implement") return;
        await writeFile(join(input.cwd, ".gitignore"), ".token-coupon/\n.env\n.cache/\n/excluded.txt\n", "utf8");
        await writeFile(join(input.cwd, "excluded.txt"), "changed but now ignored\n", "utf8");
      })),
    });
    expect(result.snapshot.status).toBe("failed");
    expect(result.snapshot.tasks[0]?.reasonCode).toBe("tracked_ignored_changes");
    const record = await new SessionStore(repo.workspace).load(result.snapshot.sessionId);
    expect(record.isolationJournal?.integrationHead).toBe(repo.baseCommit);
  });

  it("rejects Runner-created commits and keeps the successful Runner verdict separate from Task failure", async () => {
    const repo = await createRepository();
    const result = await runPlan({ plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id !== "implement") return;
        await writeFile(join(input.cwd, "runner-commit.txt"), "runner commit\n", "utf8");
        await git(input.cwd, ["add", "runner-commit.txt"]);
        await git(input.cwd, ["commit", "--quiet", "-m", "Runner-owned commit"]);
      })),
    });
    expect(result.snapshot.tasks[0]?.status).toBe("failed");
    expect(result.snapshot.tasks[0]?.reasonCode).toBe("worktree_head_mismatch");
    expect(result.snapshot.tasks[1]?.status).toBe("blocked");
    const attemptId = result.snapshot.tasks[0]!.attempts[0]!.attemptId;
    expect((await new SessionStore(repo.workspace).readAttempt(attemptId) as Record<string, unknown>).status).toBe("succeeded");
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
  });

  it.each([
    ["pre-commit rejects", "#!/bin/sh\nexit 29\n", "git_landing_failed"],
    ["hook stages ignored file", "#!/bin/sh\ngit add -f -- .env\n", "commit_boundary_violation"],
    ["hook leaves tracked edit", "#!/bin/sh\nprintf 'hook edit\\n' >> README.md\n", "commit_hook_left_worktree_dirty"],
  ])("does not integrate code when a Git commit hook %s", async (label, hook, reasonCode) => {
    const repo = await createRepository();
    await writeFile(join(repo.hooks, "pre-commit"), hook, "utf8");
    await chmod(join(repo.hooks, "pre-commit"), 0o755);
    const result = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id === "implement") {
          await writeFile(join(input.cwd, "feature.txt"), "feature\n", "utf8");
          if (label === "hook stages ignored file") await writeFile(join(input.cwd, ".env"), "private\n", "utf8");
        }
      })),
    });
    expect(result.snapshot.status).toBe("failed");
    expect(result.snapshot.tasks[0]?.reasonCode).toBe(reasonCode);
    expect(result.snapshot.tasks[1]?.status).toBe("blocked");
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
    const record = await new SessionStore(repo.workspace).load(result.snapshot.sessionId);
    expect(record.isolationJournal?.integrationHead).toBe(repo.baseCommit);
  });

  it("blocks integration when the user advances the integration worktree during Runner execution", async () => {
    const repo = await createRepository();
    const sessionId = randomUUID();
    const integration = join(repo.workspace, ".token-coupon", "worktrees", sessionId, "integration");
    const result = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      sessionId, isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id !== "implement") return;
        await writeFile(join(input.cwd, "feature.txt"), "runner feature\n", "utf8");
        await writeFile(join(integration, "README.md"), "user's concurrent edit\n", "utf8");
        await git(integration, ["add", "README.md"]);
        await git(integration, ["commit", "--quiet", "-m", "user concurrent commit"]);
      })),
    });
    expect(result.snapshot.status).toBe("failed");
    expect(result.snapshot.tasks[0]?.reasonCode).toBe("landing_base_changed");
    expect(result.snapshot.tasks[0]?.attempts).toHaveLength(1);
    const attemptId = result.snapshot.tasks[0]!.attempts[0]!.attemptId;
    const attempt = await new SessionStore(repo.workspace).readAttempt(attemptId) as Record<string, unknown>;
    expect(attempt.status).toBe("succeeded");
    expect(await readFile(join(integration, "README.md"), "utf8")).toBe("user's concurrent edit\n");
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
  });

  it("continues a real manual conflict without rerunning a successful Runner", async () => {
    const repo = await createRepository();
    const sessionId = randomUUID();
    const integration = join(repo.workspace, ".token-coupon", "worktrees", sessionId, "integration");
    let implementCalls = 0;
    const createRunner = runner(successfulAction(async (input) => {
      if (input.task.id === "implement") {
        implementCalls += 1;
        await writeFile(join(input.cwd, "README.md"), "task version\n", "utf8");
        await writeFile(join(integration, "README.md"), "human version\n", "utf8");
        await git(integration, ["add", "README.md"]);
        await git(integration, ["commit", "--quiet", "-m", "human side change"]);
      } else {
        expect(await readFile(join(input.cwd, "README.md"), "utf8")).toBe("human and task versions\n");
      }
    }));
    const plan = makePlan(["implement", "verify"], { verify: ["implement"] });
    const failed = await runPlan({ plan, workspace: repo.workspace, sessionId, createRunner, isolation: "git-worktree", verificationTaskId: "verify" });
    expect(failed.snapshot.tasks[0]?.reasonCode).toBe("landing_base_changed");
    const attemptId = failed.snapshot.tasks[0]!.attempts[0]!.attemptId;
    const store = new SessionStore(repo.workspace);
    const record = await store.load(sessionId);
    const attempt = record.isolationJournal!.attempts.find(({ attemptId: id }) => id === attemptId)!;
    await git(attempt.worktreePath, ["add", "README.md"]);
    await git(attempt.worktreePath, ["commit", "--quiet", "-m", "approved task content"]);
    const merged = await gitResult(integration, ["merge", "--no-ff", attempt.branch]);
    expect(merged.code).not.toBe(0);
    await writeFile(join(integration, "README.md"), "human and task versions\n", "utf8");
    await git(integration, ["add", "README.md"]);
    await git(integration, ["commit", "--quiet", "-m", "resolve task conflict"]);
    await expect(continueSessionLanding({ sessionId, workspace: repo.workspace, taskId: "implement", createRunner })).resolves.toMatchObject({ operationStatus: "succeeded" });
    const resumed = await resumeSession({ sessionId, workspace: repo.workspace, createRunner });
    expect(resumed.snapshot.status).toBe("succeeded");
    expect(implementCalls).toBe(1);
    expect(await readFile(join(integration, "README.md"), "utf8")).toBe("human and task versions\n");
    const delivery = await createSessionDelivery(await store.load(sessionId), store);
    expect(delivery.verificationCommit).toBe(delivery.integrationHead);
  });

  it("rejects delivery for a stale integration head while preserving the historical report", async () => {
    const repo = await createRepository();
    const result = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id === "implement") await writeFile(join(input.cwd, "feature.txt"), "ready\n", "utf8");
      })),
    });
    const store = new SessionStore(repo.workspace);
    const record = await store.load(result.snapshot.sessionId);
    const firstDelivery = await createSessionDelivery(record, store);
    const reportPath = join(store.sessionDirectory(result.snapshot.sessionId), "delivery.json");
    const oldReport = await readFile(reportPath, "utf8");
    const isolation = record.snapshot.isolation;
    if (isolation?.mode !== "git-worktree") throw new Error("expected Git worktree mode");
    const integration = isolation.integrationWorktree;
    await writeFile(join(integration, "post-verify.txt"), "late change\n", "utf8");
    await git(integration, ["add", "post-verify.txt"]);
    await git(integration, ["commit", "--quiet", "-m", "late integration change"]);
    await expect(createSessionDelivery(record, store)).rejects.toThrow("integration_head_changed");
    expect(await readFile(reportPath, "utf8")).toBe(oldReport);
    expect(firstDelivery.integrationHead).not.toBe(await git(integration, ["rev-parse", "HEAD"]));
  });

  it("retains a dirty successful Attempt during cleanup and keeps central logs readable", async () => {
    const repo = await createRepository();
    const result = await runPlan({
      plan: makePlan(["implement", "verify"], { verify: ["implement"] }), workspace: repo.workspace,
      isolation: "git-worktree", verificationTaskId: "verify",
      createRunner: runner(successfulAction(async (input) => {
        if (input.task.id === "implement") await writeFile(join(input.cwd, "feature.txt"), "ready\n", "utf8");
      })),
    });
    const store = new SessionStore(repo.workspace);
    const record = await store.load(result.snapshot.sessionId);
    const attemptId = record.snapshot.tasks[0]!.attempts[0]!.attemptId;
    const attempt = record.isolationJournal!.attempts.find(({ attemptId: id }) => id === attemptId)!;
    await writeFile(join(attempt.worktreePath, "local-inspection.txt"), "keep this edit\n", "utf8");
    const { cleanupSessionWorktrees } = await import("../src/task-orchestrator.js");
    const cleanup = await cleanupSessionWorktrees({ sessionId: result.snapshot.sessionId, workspace: repo.workspace });
    expect(cleanup.retainedWorktrees).toContainEqual({ path: attempt.worktreePath, reason: "worktree 有未提交修改" });
    expect(await readFile(join(attempt.worktreePath, "local-inspection.txt"), "utf8")).toBe("keep this edit\n");
    expect(await readFile(join(repo.workspace, ".token-coupon", "runs", attemptId, "attempt.json"), "utf8")).toContain('"status": "succeeded"');
  });

  it("serializes two Sessions sharing one Git common directory", async () => {
    const repo = await createRepository();
    const firstSessionId = randomUUID();
    const secondSessionId = randomUUID();
    let startedResolve!: () => void;
    let releaseRunner!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRunner = resolve; });
    const createRunner = runner(async () => { startedResolve(); await gate; return { exitCode: 0, marker: true }; });
    const first = runPlan({ plan: makePlan(["verify"]), workspace: repo.workspace, sessionId: firstSessionId, createRunner, isolation: "git-worktree", verificationTaskId: "verify" });
    try {
      await started;
      await expect(runPlan({ plan: makePlan(["verify"]), workspace: repo.workspace, sessionId: secondSessionId, createRunner, isolation: "git-worktree", verificationTaskId: "verify" })).rejects.toThrow("另一个 Token Coupon Git Session 正在操作");
      await expect(access(join(repo.workspace, ".token-coupon", "sessions", secondSessionId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { releaseRunner(); }
    expect((await first).snapshot.status).toBe("succeeded");
    expect(await git(repo.workspace, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
  });

  it("runs a Planner-approved plan in worktrees, reuses its Session, and rejects a changed verification task", async () => {
    const repo = await createRepository();
    const execution = { runnerId: "mock", mode: "non_interactive", timeoutMs: 3000 };
    const planner = new MockPlanner([{
      kind: "draft", message: "Implement and test a greeting.",
      plan: { schemaVersion: 1, id: "planner-phase4", title: "Planner Phase 4",
        tasks: [
          { task: { schemaVersion: 1, id: "implement", title: "Implement", prompt: "Create feature.txt.", execution }, dependsOn: [], status: "planned" },
          { task: { schemaVersion: 1, id: "verify", title: "Verify", prompt: "Check feature.txt.", execution }, dependsOn: ["implement"], status: "planned" },
        ] },
    }]);
    const started = await startPlannerConversation({ workspace: repo.workspace, request: "Implement and test a small feature.",
      config: { provider: "mock", model: "mock", baseUrl: "mock://local" }, executionDefaults: execution, planner });
    const planningId = started.snapshot.planningId;
    const reviewed = await reviewPlannerDraft({ planningId, workspace: repo.workspace, reviewer: new MockPlanReviewer() });
    await approvePlannerDraft({ planningId, workspace: repo.workspace, draftRevision: 1, reviewId: reviewed.review.reviewId });
    let runnerCalls = 0;
    const createRunner = runner(successfulAction(async (input) => {
      runnerCalls += 1;
      if (input.task.id === "implement") await writeFile(join(input.cwd, "feature.txt"), "approved feature\n", "utf8");
      if (input.task.id === "verify") expect(await readFile(join(input.cwd, "feature.txt"), "utf8")).toBe("approved feature\n");
    }));
    const options = { planningId, workspace: repo.workspace, createRunner, isolation: "git-worktree" as const, verificationTaskId: "verify" };
    const first = await runApprovedPlanner(options);
    expect(first.sessionStatus).toBe("succeeded");
    const second = await runApprovedPlanner(options);
    expect(second.snapshot.execution?.sessionId).toBe(first.snapshot.execution?.sessionId);
    expect(runnerCalls).toBe(2);
    await expect(runApprovedPlanner({ ...options, verificationTaskId: "implement" })).rejects.toThrow("最终验证任务与本次请求不一致");
    expect(runnerCalls).toBe(2);
  });
});
