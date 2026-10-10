import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RunnerInteractionOwner, RunnerInteractionRequest } from "@token-coupon/core";
import { createRunnerInteractionHandler, createRunnerInteractionIO, submitAttemptInteractionReply } from "../src/interaction-cli.js";
import { PassThrough } from "node:stream";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Runner interaction CLI", () => {
  test("forwards terminal Ctrl-C to cancellation even outside a question, then removes its listener", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    let calls = 0;
    const io = createRunnerInteractionIO({ workspace: tmpdir(), input, output, isTTY: true, onCancel: () => { calls++; controller.abort(); } });
    input.write("\x03");
    expect(controller.signal.aborted).toBe(true);
    expect(calls).toBe(1);
    io.close();
    input.write("\x03");
    expect(calls).toBe(1);
    input.destroy(); output.destroy();
  });
  test("forwards a second-terminal reply to the waiting Attempt owner", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "token-coupon-interaction-"));
    roots.push(workspace);
    const attemptId = "d71318be-d4d9-4e93-a95d-a87ebd7b054f";
    const requestId = "e71318be-d4d9-4e93-a95d-a87ebd7b054f";
    const owner: RunnerInteractionOwner = { attemptId, taskId: "compile", runnerId: "codex", cwd: workspace };
    const request: RunnerInteractionRequest = { kind: "approval", title: "批准测试命令", summary: "Codex 请求运行测试", operation: { kind: "command", command: "npm test" } };
    const interactions = join(workspace, ".token-coupon", "runs", attemptId, "interactions");
    mkdirSync(interactions, { recursive: true });
    writeFileSync(join(interactions, requestId + ".json"), JSON.stringify({
      schemaVersion: 1, requestId, attemptId, taskId: owner.taskId, runnerId: owner.runnerId,
      status: "pending", request, requestHash: "test",
    }), "utf8");

    const handler = createRunnerInteractionHandler({ workspace, isTTY: false, ask: async () => null, output: () => undefined });
    const controller = new AbortController();
    const pending = handler(requestId, request, owner, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await submitAttemptInteractionReply({ workspace, attemptId, requestId, reply: { kind: "approval", decision: "allow-once" } });

    await expect(pending).resolves.toEqual({ kind: "approval", decision: "allow-once" });
  });

  test("invalidates the local inbox poll when the foreground prompt wins", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "token-coupon-interaction-"));
    roots.push(workspace);
    const owner: RunnerInteractionOwner = { attemptId: "d71318be-d4d9-4e93-a95d-a87ebd7b054f", taskId: "compile", runnerId: "claude-code", cwd: workspace };
    const request: RunnerInteractionRequest = { kind: "approval", title: "Approve", summary: "Run a test command", operation: { kind: "command", command: "npm test" } };
    const handler = createRunnerInteractionHandler({ workspace, isTTY: true, ask: async () => "allow-once", output: () => undefined });

    await expect(handler("e71318be-d4d9-4e93-a95d-a87ebd7b054f", request, owner, new AbortController().signal))
      .resolves.toEqual({ kind: "approval", decision: "allow-once" });
  });
});
