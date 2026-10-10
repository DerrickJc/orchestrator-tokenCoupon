import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../src/main.js";
import { runPlannerCli } from "../src/planner-cli.js";

const temporaryDirectories: string[] = [];

async function invokeCli(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    stdout.push(values.join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderr.push(values.join(" "));
  });

  try {
    const exitCode = await runCli(args);
    return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI show commands", () => {
  test("lists registered runners and managed capabilities", async () => {
    const result = await invokeCli("runner", "list");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codex · modes=managed");
    expect(result.stdout).toContain("claude-code · modes=non_interactive,managed");
  });

  test("doctor scopes checks to a selected runner and validates its workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-runner-doctor-"));
    temporaryDirectories.push(directory);
    const result = await invokeCli("runner", "doctor", "--runner", "mock", "--workspace", directory);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock/non_interactive · available");
    expect(result.stdout).toContain("mock/managed · available");
    expect(result.stdout).not.toContain("claude-code");
  });

  test("doctor rejects an unknown runner", async () => {
    const result = await invokeCli("runner", "doctor", "--runner", "unknown");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("未知 Runner：unknown");
  });

  test("doctor leaves inference unverified until an explicit probe and stores probe evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-doctor-probe-"));
    temporaryDirectories.push(directory);
    const local = await invokeCli("runner", "doctor", "--runner", "mock", "--workspace", directory);
    expect(local.stdout).toContain("模型调用：unverified");
    expect(readdirSync(directory)).toEqual([]);
    const probe = await invokeCli("runner", "doctor", "--runner", "mock", "--workspace", directory, "--probe");
    expect(probe.exitCode, probe.stderr).toBe(0);
    expect(probe.stdout).toContain("succeeded");
    expect(readdirSync(join(directory, ".token-coupon", "runs"))).toHaveLength(1);
    expect((await invokeCli("runner", "doctor", "--probe")).exitCode).toBe(2);
  });

  test("persists a validated runner profile and resolved spec on the Session and Attempt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-runner-profile-"));
    temporaryDirectories.push(directory);
    const planFile = join(directory, "plan.json");
    const profileFile = join(directory, "runner-profile.json");
    const task = { schemaVersion: 1, id: "profile-task", title: "Profile task", prompt: "Run the mock task",
      execution: { runnerId: "mock", mode: "non_interactive" } };
    writeFileSync(planFile, JSON.stringify({ schemaVersion: 1, id: "profile-plan", title: "Profile plan",
      tasks: [{ task, dependsOn: [], status: "planned" }] }), "utf8");
    writeFileSync(profileFile, JSON.stringify({ schemaVersion: 1, runners: { mock: { configVersion: 1, settings: { mockScenario: "success" } } } }), "utf8");

    const result = await invokeCli("plan", "run", "--file", planFile, "--workspace", directory, "--runner-profile", profileFile);
    expect(result.exitCode).toBe(0);
    const sessionId = /Session：([\da-f-]{36})/.exec(result.stdout)?.[1];
    expect(sessionId).toBeDefined();
    const snapshot = JSON.parse(readFileSync(join(directory, ".token-coupon", "sessions", sessionId!, "session.json"), "utf8"));
    expect(snapshot.runnerProfile.runners.mock.settings.mockScenario).toBe("success");
    expect(snapshot.runnerProfileHash).toMatch(/^[0-9a-f]{64}$/);
    const attemptId = snapshot.tasks[0].attempts[0].attemptId;
    const attempt = JSON.parse(readFileSync(join(directory, ".token-coupon", "runs", attemptId, "attempt.json"), "utf8"));
    expect(attempt.runnerSpec).toMatchObject({ runnerId: "mock", mode: "non_interactive", configurationVersion: 1 });
    expect(attempt.runnerSpec.settingsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("prints task details from a plan, including dependency and initial status", async () => {
    const result = await invokeCli("plan", "show", "--file", "examples/plan.json");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("计划：demo-plan");
    expect(result.stdout).toContain("任务：demo-002");
    expect(result.stdout).toContain("依赖：demo-001");
    expect(result.stdout).toContain("状态：planned");
    expect(result.stderr).toBe("");
  });

  test("prints a standalone task and makes an unspecified model explicit", async () => {
    const result = await invokeCli("task", "show", "--file", "examples/task.mock.json");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("任务：demo-001");
    expect(result.stdout).toContain("Runner：mock");
    expect(result.stdout).toContain("模型：未指定");
  });

  test("returns exit code 2 and identifies an invalid input file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-cli-"));
    temporaryDirectories.push(directory);
    const invalidFile = join(directory, "invalid-task.json");
    writeFileSync(invalidFile, JSON.stringify({ schemaVersion: 2 }), "utf8");

    const result = await invokeCli("task", "show", "--file", invalidFile);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid-task.json");
    expect(result.stderr).toContain("schemaVersion");
  });

  test("rejects an unsupported runner instead of silently substituting Claude Code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-cli-"));
    temporaryDirectories.push(directory);
    const taskFile = join(directory, "task.json");
    writeFileSync(taskFile, JSON.stringify({
      schemaVersion: 1, id: "unsupported", title: "test", prompt: "test",
      execution: { runnerId: "other", mode: "non_interactive", timeoutMs: 1000 },
    }), "utf8");
    const result = await invokeCli("task", "run", "--file", taskFile, "--workspace", directory);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("不支持的 Runner");
  });

  test("accepts --accept-edits only for Claude Code runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-cli-"));
    temporaryDirectories.push(directory);
    const result = await invokeCli("task", "run", "--file", "examples/task.mock.json", "--workspace", directory, "--accept-edits");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("仅适用于 claude-code Runner");
  });

  test("runs without --workspace and records artifacts in the caller's directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-cli-"));
    temporaryDirectories.push(directory);
    const result = spawnSync(process.execPath, [
      resolve("packages/cli/dist/main.js"), "task", "run",
      "--file", resolve("examples/task.mock.json"),
    ], { cwd: directory, encoding: "utf8" });

    expect(result.status).toBe(0);
    const runsDirectory = join(directory, ".token-coupon", "runs");
    const attempts = readdirSync(runsDirectory);
    expect(attempts).toHaveLength(1);
    const attempt = JSON.parse(readFileSync(join(runsDirectory, attempts[0]!, "attempt.json"), "utf8"));
    expect(attempt.cwd).toBe(directory);
    expect(attempt.status).toBe("succeeded");
    expect(result.stdout).toContain(`产物：${attempt.artifactDir}`);
  });

  test("runs a plan, retries one failed task, then resumes the remaining tasks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-cli-session-"));
    temporaryDirectories.push(directory);
    const planFile = join(directory, "plan.json");
    const task = (id: string) => ({
      schemaVersion: 1, id, title: id, prompt: `Execute ${id}`,
      execution: { runnerId: "mock", mode: "non_interactive", timeoutMs: 3000 },
    });
    writeFileSync(planFile, JSON.stringify({
      schemaVersion: 1, id: "cli-session-test", title: "CLI Session test",
      tasks: [
        { task: task("first"), dependsOn: [], status: "planned" },
        { task: task("second"), dependsOn: ["first"], status: "planned" },
        { task: task("verify"), dependsOn: ["second"], status: "planned" },
      ],
    }), "utf8");

    const first = await invokeCli("plan", "run", "--file", planFile, "--workspace", directory, "--mock-task-scenario", "second=missing-marker");
    expect(first.exitCode).toBe(1);
    const sessionId = /Session：([\da-f-]{36})/.exec(first.stdout)?.[1];
    expect(sessionId).toBeDefined();
    expect(first.stdout).toContain("second — second：failed");
    expect(first.stdout).toContain("verify — verify：blocked");

    const shown = await invokeCli("session", "show", "--id", sessionId!, "--workspace", directory);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("状态：failed");

    const retried = await invokeCli("session", "retry", "--id", sessionId!, "--task", "second", "--workspace", directory, "--mock-task-scenario", "second=success");
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toContain("verify — verify：planned");

    const resumed = await invokeCli("session", "resume", "--id", sessionId!, "--workspace", directory);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("状态：succeeded");
    expect(resumed.stdout).toContain("verify — verify：succeeded");
  });

  test("runs a Git-isolated plan, prints delivery instructions, and cleans successful Attempt worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "token-coupon-cli-worktree-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repo");
    const hooks = join(root, "empty-hooks");
    mkdirSync(workspace);
    mkdirSync(hooks);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "--initial-branch=main", "--quiet");
    git("config", "user.name", "Token Coupon CLI Test");
    git("config", "user.email", "token-coupon-cli@example.invalid");
    git("config", "core.hooksPath", hooks);
    writeFileSync(join(workspace, ".gitignore"), ".token-coupon/\n", "utf8");
    writeFileSync(join(workspace, "README.md"), "Clean Git worktree CLI fixture.\n", "utf8");
    git("add", ".gitignore", "README.md");
    git("commit", "--quiet", "-m", "initial fixture");
    const baseCommit = git("rev-parse", "HEAD");
    const task = (id: string) => ({ schemaVersion: 1, id, title: id, prompt: `Execute ${id}`,
      execution: { runnerId: "mock", mode: "non_interactive", timeoutMs: 3000 } });
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, JSON.stringify({
      schemaVersion: 1, id: "phase4-cli-test", title: "Phase 4 CLI test",
      tasks: [
        { task: task("implement"), dependsOn: [], status: "planned" },
        { task: task("verify"), dependsOn: ["implement"], status: "planned" },
      ],
    }), "utf8");

    const executed = await invokeCli("plan", "run", "--file", planFile, "--workspace", workspace,
      "--isolation", "git-worktree", "--verification-task", "verify");
    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toContain("隔离：git-worktree");
    expect(executed.stdout).toContain("verify — verify：succeeded");
    const sessionId = /Session：([\da-f-]{36})/.exec(executed.stdout)?.[1];
    expect(sessionId).toBeDefined();
    const snapshot = JSON.parse(readFileSync(join(workspace, ".token-coupon", "sessions", sessionId!, "session.json"), "utf8"));
    const attemptId = snapshot.tasks[0].attempts[0].attemptId;
    const attempt = JSON.parse(readFileSync(join(workspace, ".token-coupon", "runs", attemptId, "attempt.json"), "utf8"));
    expect(attempt.cwd).toContain(join(".token-coupon", "worktrees", sessionId!, "attempts", attemptId));
    expect(attempt.artifactDir).toBe(join(workspace, ".token-coupon", "runs", attemptId));
    expect(git("rev-parse", "HEAD")).toBe(baseCommit);
    expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe("");

    const delivery = await invokeCli("session", "delivery", "--id", sessionId!, "--workspace", workspace);
    expect(delivery.exitCode).toBe(0);
    expect(delivery.stdout).toContain("Delivery：");
    expect(delivery.stdout).toContain("人工合并");
    expect(delivery.stdout).toContain("变更文件（0）：无");
    const cleanup = await invokeCli("session", "cleanup", "--id", sessionId!, "--workspace", workspace);
    expect(cleanup.exitCode).toBe(0);
    expect(cleanup.stdout).toContain("已移除 worktree：");
    expect(git("rev-parse", "HEAD")).toBe(baseCommit);
  });

  test("reopens, edits, approves, and runs a planner draft once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-planner-cli-"));
    temporaryDirectories.push(directory);
    const started = await invokeCli(
      "planner", "start", "--planner", "mock", "--runner", "mock",
      "--request", "Add a greeting function.", "--workspace", directory, "--mock-clarify",
    );
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("状态：collecting");
    expect(started.stdout).toContain("自动化测试");
    const planningId = /Planning：([\da-f-]{36})/.exec(started.stdout)?.[1];
    expect(planningId).toBeDefined();

    const reopened = await invokeCli("planner", "show", "--id", planningId!, "--workspace", directory);
    expect(reopened.exitCode).toBe(0);
    expect(reopened.stdout).toContain("用户：Add a greeting function.");
    expect(reopened.stdout).toContain("自动化测试");
    const drafted = await invokeCli(
      "planner", "reply", "--id", planningId!, "--message", "需要，同时覆盖空字符串。", "--workspace", directory,
    );
    expect(drafted.exitCode).toBe(0);
    expect(drafted.stdout).toContain("状态：draft_ready");

    const planFile = join(directory, "edited-plan.json");
    const exported = await invokeCli("planner", "export", "--id", planningId!, "--file", planFile, "--workspace", directory);
    expect(exported.exitCode).toBe(0);
    const editedPlan = JSON.parse(readFileSync(planFile, "utf8")) as { title: string; tasks: Array<{ task: { title: string } }> };
    editedPlan.title = "Greeting implementation and tests";
    editedPlan.tasks[0]!.task.title = "Implement greeting with the empty-string behavior";
    writeFileSync(planFile, JSON.stringify(editedPlan, null, 2), "utf8");
    const replaced = await invokeCli("planner", "replace", "--id", planningId!, "--file", planFile, "--workspace", directory);
    expect(replaced.exitCode).toBe(0);
    expect(replaced.stdout).toContain("草案版本：draft-2");

    const checked = await invokeCli("planner", "check", "--id", planningId!, "--workspace", directory);
    expect(checked.exitCode).toBe(0);
    expect(checked.stdout).toContain("执行配置：已与规划记录核对");
    const diff = await invokeCli("planner", "diff", "--id", planningId!, "--from", "1", "--to", "2", "--workspace", directory);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain("implement-request");

    const unapproved = await invokeCli("planner", "run", "--id", planningId!, "--workspace", directory);
    expect(unapproved.exitCode).toBe(1);
    expect(unapproved.stderr).toContain("必须批准");
    expect(readdirSync(join(directory, ".token-coupon")).filter((entry) => entry === "sessions")).toHaveLength(0);

    const reviewed = await invokeCli("planner", "review", "--id", planningId!, "--workspace", directory);
    expect(reviewed.exitCode).toBe(0);
    expect(reviewed.stdout).toContain("审查：");

    const approved = await invokeCli("planner", "approve", "--id", planningId!, "--revision", "2", "--workspace", directory);
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain("批准：");
    const executed = await invokeCli("planner", "run", "--id", planningId!, "--workspace", directory);
    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toContain("Session 状态：succeeded");
    expect(executed.stdout).toContain("verify-request — 验证实现：succeeded");
    const sessionId = /执行 Session：([\da-f-]{36})/.exec(executed.stdout)?.[1];
    expect(sessionId).toBeDefined();
    const sessionPlan = JSON.parse(readFileSync(join(directory, ".token-coupon", "sessions", sessionId!, "plan.json"), "utf8"));
    expect(sessionPlan).toEqual(editedPlan);

    const repeated = await invokeCli("planner", "run", "--id", planningId!, "--workspace", directory);
    expect(repeated.exitCode).toBe(0);
    expect(readdirSync(join(directory, ".token-coupon", "sessions"), { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(1);
  });
});

describe("Planner interactive chat", () => {
  test("shows requirements and provenance and revises with a report in the same chat", async () => {
    const directory = mkdtempSync(join(tmpdir(), "planner-bugfix-chat-"));
    temporaryDirectories.push(directory);
    const started = await invokeCli("planner", "start", "--planner", "mock", "--runner", "mock", "--request", "Create a greeting.", "--workspace", directory);
    const planningId = /Planning：([\da-f-]{36})/.exec(started.stdout)![1]!;
    const snapshotFile = join(directory, ".token-coupon", "planners", planningId, "conversation.json");
    const initial = JSON.parse(readFileSync(snapshotFile, "utf8"));
    const requirementId = initial.requirements.items[0].requirementId;
    const listed = await invokeCli("planner", "requirements", "--id", planningId, "--workspace", directory);
    expect(listed.stdout).toContain(requirementId + "@1");
    const traced = await invokeCli("planner", "trace", "--id", planningId, "--requirement", requirementId, "--workspace", directory);
    expect(traced.stdout).toContain("Create a greeting.");
    expect(traced.stdout).toContain("日志目录");
    const missing = await invokeCli("planner", "revise", "--id", planningId, "--workspace", directory);
    expect(missing.exitCode).toBe(1);
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => stdout.push(values.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...values) => stderr.push(values.join(" ")));
    try {
      const replies = ["/requirements", `/trace ${requirementId} 1`, "/review", "/revise", "/review", "/exit"];
      let pending = "";
      output.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        if (replies.length && /planner> $/.test(pending)) { pending = ""; input.write(replies.shift() + "\n"); }
      });
      expect(await runPlannerCli(["chat", "--id", planningId, "--workspace", directory], { input, output, isTTY: true })).toBe(0);
    } finally { log.mockRestore(); error.mockRestore(); input.destroy(); output.destroy(); }
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("有效需求");
    const after = JSON.parse(readFileSync(snapshotFile, "utf8"));
    expect(after.requirements.items.filter((item: { status: string }) => item.status === "active")).toHaveLength(1);
    expect(after.requirements.messageDecisions.at(-1).kind).toBe("operation");
    const turn = JSON.parse(readFileSync(join(directory, ".token-coupon", "planners", planningId, "turns", after.turns.at(-1).turnId, "turn.json"), "utf8"));
    expect(turn.reviewId).toBeDefined();
    const single = await invokeCli("planner", "revise", "--id", planningId, "--workspace", directory);
    expect(single.exitCode).toBe(0);
    const refresh = await invokeCli("planner", "requirements", "--id", planningId, "--refresh", "--workspace", directory);
    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain("有效需求");
  });
  const hasPosixPty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty, termios"]).status === 0;
  for (const mode of ["save", "fail", "missing"] as const) {
    test.skipIf(!hasPosixPty)(`hands terminal input to the editor and restores chat (${mode})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "token-coupon-editor-pty-"));
      temporaryDirectories.push(directory);
      const started = await invokeCli("planner", "start", "--planner", "mock", "--runner", "mock", "--request", "Create a greeting.", "--workspace", directory);
      const planningId = /Planning：([\da-f-]{36})/.exec(started.stdout)?.[1];
      expect(planningId).toBeDefined();
      const result = spawnSync("python3", [resolve("packages/cli/test/fixtures/editor-pty.py"), process.execPath,
        resolve("packages/cli/dist/main.js"), directory, planningId!, mode], { encoding: "utf8", timeout: 20_000 });
      expect(result.status, result.stderr).toBe(0);
      const terminal = JSON.parse(result.stdout);
      expect(terminal.chatRawRestored).toBe(true);
      expect(terminal.continuedChat).toBe(true);
      expect(terminal.exitCode).toBe(0);
      if (mode !== "missing") {
        expect(terminal.canonicalAtEntry).toBe(true);
        expect(terminal.echoAtEntry).toBe(true);
        expect(terminal.mouseInputIntact).toBe(true);
      }
      const current = JSON.parse(readFileSync(join(directory, ".token-coupon", "planners", planningId!, "conversation.json"), "utf8"));
      expect(current.draftRevision).toBe(mode === "save" ? 2 : 1);
    }, 25_000);
  }

  test("uses the configured editor with a path containing spaces and imports a new revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-planner-editor-"));
    temporaryDirectories.push(directory);
    const started = await invokeCli("planner", "start", "--planner", "mock", "--runner", "mock", "--request", "Create a greeting.", "--workspace", directory);
    const planningId = /Planning：([\da-f-]{36})/.exec(started.stdout)?.[1];
    expect(planningId).toBeDefined();
    const editorPath = join(directory, "editor helper.cjs");
    writeFileSync(editorPath, [
      "const fs = require('node:fs');",
      "const file = process.argv[2];",
      "const plan = JSON.parse(fs.readFileSync(file, 'utf8'));",
      "plan.title = 'Edited from the configured editor';",
      "fs.writeFileSync(file, JSON.stringify(plan));",
    ].join("\n"), "utf8");
    const oldEditor = process.env.EDITOR;
    process.env.EDITOR = `${process.execPath} "${editorPath}"`;

    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => stdout.push(values.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => stderr.push(values.join(" ")));
    try {
      const replies = ["/edit", "/exit"];
      let pending = "";
      output.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        if (replies.length && /planner> $/.test(pending)) {
          pending = "";
          input.write(replies.shift() + "\n");
        }
      });
      expect(await runPlannerCli(["chat", "--id", planningId!, "--workspace", directory], { input, output, isTTY: true })).toBe(0);
    } finally {
      if (oldEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = oldEditor;
      log.mockRestore();
      error.mockRestore();
      input.destroy();
      output.destroy();
    }

    const current = JSON.parse(readFileSync(join(directory, ".token-coupon", "planners", planningId!, "drafts", "2.json"), "utf8")) as { plan: { title: string } };
    expect(current.plan.title).toBe("Edited from the configured editor");
    expect(stdout.join("\n")).toContain("计划差异：draft-1 → draft-2");
    expect(stderr).toEqual([]);
  });

  test("treats terminal EOF as a clean exit before the first request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-planner-eof-"));
    temporaryDirectories.push(directory);
    const input = new PassThrough();
    const output = new PassThrough();
    const promptReady = new Promise<void>((resolve) => output.once("data", () => resolve()));
    const running = runPlannerCli(["chat", "--planner", "mock", "--runner", "mock", "--workspace", directory], {
      input, output, isTTY: true,
    });
    await promptReady;
    input.end();
    expect(await running).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
    input.destroy();
    output.destroy();
  });

  test("accepts multiple user turns in one process and shows local checks and draft diffs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "token-coupon-planner-chat-"));
    temporaryDirectories.push(directory);
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => stdout.push(values.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => stderr.push(values.join(" ")));
    try {
      const replies = ["Create a greeting API.", "Also add tests for an empty name.", "/exit"];
      let pending = "";
      output.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        if (replies.length && /(?:request|planner)> $/.test(pending)) {
          pending = "";
          input.write(replies.shift() + "\n");
        }
      });
      const running = runPlannerCli(["chat", "--planner", "mock", "--runner", "mock", "--workspace", directory], {
        input, output, isTTY: true,
      });
      expect(await running, stderr.join("\n")).toBe(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
      input.destroy();
      output.destroy();
    }

    const plannerDirectory = join(directory, ".token-coupon", "planners");
    const planningId = readdirSync(plannerDirectory)[0]!;
    const snapshot = JSON.parse(readFileSync(join(plannerDirectory, planningId, "conversation.json"), "utf8")) as {
      messages: Array<{ role: string; content: string }>;
      draftRevision: number;
    };
    expect(snapshot.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "Create a greeting API.", "Also add tests for an empty name.",
    ]);
    expect(snapshot.draftRevision).toBe(2);
    expect(stdout.join("\n")).toContain("保存后本地校验通过");
    expect(stdout.join("\n")).toContain("计划差异：draft-1 → draft-2");
    expect(stderr).toEqual([]);
  });
});
