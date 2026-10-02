import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
