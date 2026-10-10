import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@token-coupon/core";
import { runCli } from "../src/main.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session logs CLI", () => {
  it("shows semantic execution evidence and hides raw runner output unless requested", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "token-coupon-session-logs-"));
    directories.push(workspace);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const task = { schemaVersion: 1, id: "verify", title: "Verify", prompt: "Run tests", execution: { runnerId: "mock", mode: "non_interactive" } } as const;
    const plan = { schemaVersion: 1 as const, id: "logs-plan", title: "Logs plan", tasks: [{ task, dependsOn: [], status: "planned" as const }] };
    const store = new SessionStore(workspace);
    const record = await store.create(plan, sessionId);
    const artifactDir = join(workspace, ".token-coupon", "runs", attemptId);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "events.jsonl"), [
      { sequence: 1, timestamp: "2026-10-09T00:00:00.000Z", attemptId, type: "command.completed", payload: { command: "node --test", cwd: workspace, exitCode: 0, status: "succeeded" } },
      { sequence: 2, timestamp: "2026-10-09T00:00:01.000Z", attemptId, type: "runner.output", payload: { stream: "stdout", text: "private raw output" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await store.save({
      ...record.snapshot,
      tasks: [{ taskId: "verify", status: "planned", activeAttemptId: null, attempts: [{ attemptId, artifactDir, outcome: "recorded" }], result: null, reasonCode: null }],
    });

    const first = await invoke("session", "logs", "--id", sessionId, "--task", "verify", "--workspace", workspace);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("node --test");
    expect(first.stdout).toContain("exit=0 status=succeeded");
    expect(first.stdout).not.toContain("private raw output");

    const raw = await invoke("session", "logs", "--id", sessionId, "--attempt", attemptId, "--raw", "--workspace", workspace);
    expect(raw.stdout).toContain("private raw output");
  });
});

async function invoke(...args: string[]): Promise<{ code: number; stdout: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => lines.push(values.join(" ")));
  try { return { code: await runCli(args), stdout: lines.join("\n") }; }
  finally { log.mockRestore(); }
}
