import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../src/main.js";

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
});
