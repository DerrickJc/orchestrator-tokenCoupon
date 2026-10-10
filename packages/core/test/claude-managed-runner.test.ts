import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEvent, RunnerInteractionReply } from "../src/runner.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeManagedRunner } from "../src/runners/claude-managed-runner.js";

let fixtureRoot = "";
beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "token-coupon-claude-sdk-"));
  const bin = join(fixtureRoot, "bin");
  mkdirSync(bin);
  const executable = join(bin, "claude");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(executable, 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  queryMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("ClaudeManagedRunner", () => {
  it("maps a user selection under the full native question text expected by AskUserQuestion", async () => {
    const questionText = "Should an empty name be accepted by greet(name)?";
    let permissionResult: unknown;
    queryMock.mockImplementation((request: { options: { canUseTool: (name: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> } }) => ({
      async *[Symbol.asyncIterator]() {
        permissionResult = await request.options.canUseTool("AskUserQuestion", {
          questions: [{ question: questionText, header: "Empty name", multiSelect: false, options: [
            { label: "Allow", description: "Keep interpolation behavior" },
            { label: "Reject", description: "Throw on empty input" },
          ] }],
        }, { signal: new AbortController().signal, toolUseID: "toolu-question" });
        yield { type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [] };
      },
      close() {},
    }));

    const task = {
      schemaVersion: 1 as const, id: "claude-question", title: "Ask a question", prompt: "Ask before implementing",
      execution: { runnerId: "claude-code", mode: "managed" as const },
    };
    const events: RunnerEvent[] = [];
    const runner = new ClaudeManagedRunner();
    const result = await runner.run({ attemptId: "attempt-1", cwd: process.cwd(), task, execution: task.execution, prompt: task.prompt, completionMarker: "<<<TOKEN_COUPON_DONE:abc123>>>" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async recordEvent(event) { events.push(event); },
      async requestInteraction(request) {
        expect(request.kind).toBe("question");
        expect(request.questions?.[0]).toMatchObject({ id: questionText, header: "Empty name" });
        const reply: RunnerInteractionReply = { kind: "question", answers: [{ questionId: questionText, optionIds: ["Allow"] }] };
        return { ...reply, interactionId: "broker-request-1" };
      },
    });

    expect(result).toMatchObject({ started: true, transport: "sdk", nativeOutcome: "completed", cleanupStatus: "completed" });
    expect(permissionResult).toMatchObject({ behavior: "allow", updatedInput: { answers: { [questionText]: "Allow" } }, toolUseID: "toolu-question" });
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction.forwarded", requestId: "broker-request-1" }));
  });

  it("closes the active SDK query when the owner cancels", async () => {
    let finish: (() => void) | undefined;
    let closed = false;
    queryMock.mockImplementation(() => ({
      [Symbol.asyncIterator]() { return this; },
      next() { return new Promise((resolve) => { finish = () => resolve({ done: true, value: undefined }); }); },
      return() { finish?.(); return Promise.resolve({ done: true, value: undefined }); },
      close() { closed = true; finish?.(); },
    }));

    const task = {
      schemaVersion: 1 as const, id: "claude-cancel", title: "Cancel a query", prompt: "Wait for a response",
      execution: { runnerId: "claude-code", mode: "managed" as const },
    };
    const controller = new AbortController();
    const events: RunnerEvent[] = [];
    const runner = new ClaudeManagedRunner();
    const run = runner.run({ attemptId: "attempt-cancel", cwd: process.cwd(), task, execution: task.execution, prompt: task.prompt, completionMarker: "marker" }, {
      signal: controller.signal, onStarted() {}, onOutput() {},
      async recordEvent(event) { events.push(event); },
      async requestInteraction() { throw new Error("no interaction expected"); },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("test cancellation"));
    const result = await run;

    expect(closed).toBe(true);
    expect(result).toMatchObject({ nativeOutcome: "cancelled", signal: "ABORTED", cleanupStatus: "completed" });
    expect(events).toContainEqual(expect.objectContaining({ type: "runner.native.finished", outcome: "cancelled" }));
  });

  it("records Bash execution evidence without inventing a successful exit code", async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "assistant-1", content: [
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "node --test" } },
        ] } };
        yield { type: "user", parent_tool_use_id: "bash-1", message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "bash-1", content: "tests 2; pass 2; fail 0", is_error: false },
        ] } };
        yield { type: "result", subtype: "success", is_error: false, result: "tests passed", permission_denials: [] };
      },
      close() {},
    }));

    const task = { schemaVersion: 1 as const, id: "claude-command-evidence", title: "Record a command", prompt: "Run tests", execution: { runnerId: "claude-code", mode: "managed" as const } };
    const events: RunnerEvent[] = [];
    const runner = new ClaudeManagedRunner();
    await runner.run({ attemptId: "attempt-command", cwd: "/repo/worktree", task, execution: task.execution, prompt: task.prompt, completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async recordEvent(event) { events.push(event); },
      async requestInteraction() { return { kind: "approval", decision: "allow-once", interactionId: "approval" }; },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "command.completed", toolId: "bash-1", command: "node --test", cwd: "/repo/worktree",
      exitCode: null, status: "unknown", evidenceSource: "claude-sdk-tool-result", outputSummary: "tests 2; pass 2; fail 0",
    }));
  });
});
