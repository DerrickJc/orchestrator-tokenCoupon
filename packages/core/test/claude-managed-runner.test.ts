import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEvent, RunnerInteractionReply } from "../src/runner.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeManagedRunner } from "../src/runners/claude-managed-runner.js";
import { executeTask } from "../src/execute-task.js";

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
  const modelTask = () => ({ schemaVersion: 1 as const, id: "model-evidence", title: "Model evidence", prompt: "Only report the result", execution: { runnerId: "claude-code", mode: "managed" as const, modelId: "configured-alias" } });
  async function runMessages(messages: unknown[]) {
    queryMock.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield* messages; }, close() {} }));
    const events: RunnerEvent[] = [], task = modelTask();
    const result = await new ClaudeManagedRunner().run({ attemptId: "model-evidence", cwd: fixtureRoot, task, execution: task.execution, prompt: task.prompt, completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async recordEvent(event) { events.push(event); },
      async requestInteraction() { throw new Error("No tools expected"); },
    });
    return { result, events };
  }
  const reply = (model: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { id: "reply", model, content: [{ type: "text", text: "done" }] } });
  const success = (modelUsage = {}) => ({ type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [], modelUsage });

  it("records native init and main reply models without substituting the requested alias or subagent model", async () => {
    const { result, events } = await runMessages([
      { type: "system", subtype: "init", model: "startup-alias" }, reply("deepseek-flash"), reply("child-model", "child-tool"),
      success({ "deepseek-flash": { inputTokens: 10 }, "auxiliary-model": { inputTokens: 20 } }),
    ]);
    expect(result).toMatchObject({ reportedModel: "deepseek-flash", reportedModelSource: "claude-sdk-assistant", nativeOutcome: "completed" });
    expect(events.filter(event => event.type === "runner.model.reported")).toEqual([
      { type: "runner.model.reported", model: "startup-alias", source: "claude-sdk-init" },
      { type: "runner.model.reported", model: "deepseek-flash", source: "claude-sdk-assistant" },
    ]);
    expect(queryMock.mock.calls[0]?.[0].options.model).toBe("configured-alias");
  });

  it.each([
    { name: "SDK init only", messages: [{ type: "system", subtype: "init", model: "deepseek-flash" }, success()], model: "deepseek-flash", source: "claude-sdk-init" },
    { name: "single active usage entry", messages: [success({ "empty-model": { inputTokens: 0 }, "deepseek-flash": { cacheReadInputTokens: 2 } })], model: "deepseek-flash", source: "claude-sdk-model-usage" },
    { name: "ambiguous usage", messages: [success({ first: { inputTokens: 1 }, second: { outputTokens: 1 } })], model: undefined, source: undefined },
    { name: "missing native metadata", messages: [success()], model: undefined, source: undefined },
    { name: "synthetic or empty model", messages: [{ type: "system", subtype: "init", model: " " }, reply("<synthetic>"), reply("unknown"), success()], model: undefined, source: undefined },
    { name: "error reply is not inference evidence", messages: [{ ...reply("error-model"), error: "model_not_found" }, { type: "result", subtype: "error_during_execution", is_error: true }], model: undefined, source: undefined },
  ])("handles $name without inventing model evidence", async ({ messages, model, source }) => {
    const { result } = await runMessages(messages);
    expect(result.reportedModel).toBe(model);
    expect(result.reportedModelSource).toBe(source);
  });

  it("keeps the latest main-agent model and preserves its evidence when execution fails", async () => {
    const { result } = await runMessages([reply("first-model"), reply("second-model"), { type: "system", subtype: "init", model: "startup-alias" },
      { type: "result", subtype: "error_during_execution", is_error: true }]);
    expect(result).toMatchObject({ reportedModel: "second-model", reportedModelSource: "claude-sdk-assistant", nativeOutcome: "failed" });
  });

  it("persists the reported model while executeTask is still running and in the final Attempt", async () => {
    queryMock.mockImplementation((request: { prompt: string }) => ({
      async *[Symbol.asyncIterator]() {
        const marker = request.prompt.match(/<<<TOKEN_COUPON_DONE:[^>]+>>>/)?.[0];
        expect(marker).toBeTruthy();
        yield { ...reply("deepseek-flash"), message: { id: "completed", model: "deepseek-flash", content: [{ type: "text", text: marker }] } };
        const runs = join(fixtureRoot, ".token-coupon", "runs"), id = readdirSync(runs)[0]!;
        expect(JSON.parse(readFileSync(join(runs, id, "attempt.json"), "utf8"))).toMatchObject({ status: "running", reportedModel: "deepseek-flash", reportedModelSource: "claude-sdk-assistant" });
        yield { ...success(), result: marker };
      }, close() {},
    }));
    const result = await executeTask({ cwd: fixtureRoot, task: modelTask(), runner: new ClaudeManagedRunner() });
    expect(result.attempt).toMatchObject({ status: "succeeded", reportedModel: "deepseek-flash", reportedModelSource: "claude-sdk-assistant" });
    const saved = JSON.parse(readFileSync(join(result.artifactDir, "attempt.json"), "utf8"));
    expect(saved.reportedModel).toBe("deepseek-flash");
    const events = readFileSync(join(result.artifactDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"runner.model.reported"');
  });

  it("sends denial guidance through the native tool-permission response", async () => {
    const guidance = "Use the existing dependency; do not install another package.";
    let permissionResult: unknown;
    queryMock.mockImplementation((request: { options: { canUseTool: (name: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> } }) => ({
      async *[Symbol.asyncIterator]() {
        permissionResult = await request.options.canUseTool("Bash", { command: "npm install example" }, { signal: new AbortController().signal, toolUseID: "toolu-denied" });
        yield { type: "result", subtype: "success", is_error: false, result: "operation denied", permission_denials: [] };
      },
      close() {},
    }));
    const task = { schemaVersion: 1 as const, id: "claude-denial-guidance", title: "Respect denial guidance", prompt: "Choose dependencies carefully", execution: { runnerId: "claude-code", mode: "managed" as const } };
    const runner = new ClaudeManagedRunner();
    await runner.run({ attemptId: "attempt-guidance", cwd: process.cwd(), task, execution: task.execution, prompt: task.prompt, completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async requestInteraction(request) {
        expect(request.kind).toBe("approval");
        return { kind: "approval", decision: "deny", guidance, interactionId: "approval-guidance" };
      },
    });
    expect(permissionResult).toMatchObject({ behavior: "deny", message: expect.stringContaining(guidance), interrupt: false, toolUseID: "toolu-denied" });
  });

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
    let initialized = false;
    queryMock.mockImplementation(() => ({
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (!initialized) { initialized = true; return Promise.resolve({ done: false, value: { type: "system", subtype: "init", model: "deepseek-flash" } }); }
        return new Promise((resolve) => { finish = () => resolve({ done: true, value: undefined }); });
      },
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
    await vi.waitFor(() => expect(events.some(event => event.type === "runner.model.reported")).toBe(true));
    controller.abort(new Error("test cancellation"));
    const result = await run;

    expect(closed).toBe(true);
    expect(result).toMatchObject({ nativeOutcome: "cancelled", signal: "ABORTED", cleanupStatus: "completed", reportedModel: "deepseek-flash", reportedModelSource: "claude-sdk-init" });
    expect(events).toContainEqual(expect.objectContaining({ type: "runner.native.finished", outcome: "cancelled" }));
  });

  it("records Bash execution evidence without inventing a successful exit code", async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "assistant-1", content: [
          { type: "text", text: "准备运行测试。" },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "node --test" } },
          { type: "text", text: "将记录真实返回。" },
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
    const messages = events.filter(event => event.type === "message.completed");
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map(event => event.type === "message.completed" ? event.messageId : undefined)).size).toBe(2);
  });
  it("rejects AskUserQuestion with NO guidance instead of fabricating selected answers", async () => {
    let permissionResult: unknown;
    queryMock.mockImplementation((request: { options: { canUseTool: (name: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> } }) => ({
      async *[Symbol.asyncIterator]() {
        permissionResult = await request.options.canUseTool("AskUserQuestion", { questions: [{ question: "安装新依赖吗？", options: [{ label: "Install" }, { label: "Skip" }] }] }, { signal: new AbortController().signal, toolUseID: "question-no" });
        yield { type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [] };
      }, close() {},
    }));
    const task = { schemaVersion: 1 as const, id: "question-no", title: "Question guidance", prompt: "Ask", execution: { runnerId: "claude-code", mode: "managed" as const } };
    await new ClaudeManagedRunner().run({ attemptId: "question-no", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async requestInteraction(request) { expect(request.kind).toBe("question"); return { kind: "question", answers: [], guidance: "使用本地已有依赖", interactionId: "question-no" }; },
    });
    expect(permissionResult).toMatchObject({ behavior: "deny", message: expect.stringContaining("使用本地已有依赖"), interrupt: false, toolUseID: "question-no" });
    expect(permissionResult).not.toHaveProperty("updatedInput");
  });

});
