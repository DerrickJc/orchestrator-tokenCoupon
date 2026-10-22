import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const { queryMock, spawnMock } = vi.hoisted(() => ({ queryMock: vi.fn(), spawnMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("../src/native-command.js", () => ({ resolveNativeExecutable: async () => "C:\\agent\\claude.cmd", spawnNative: spawnMock }));
import { ClaudeManagedRunner } from "../src/runners/claude-managed-runner.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); queryMock.mockReset(); spawnMock.mockReset(); });

it.each([0, 126])("binds Windows SDK execution to the controlled process and verifies its actual exit %i", async code => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null, killed: false });
  spawnMock.mockReturnValue(child);
  const forwarded = new AbortController(); let closed = false;
  queryMock.mockImplementation(({ options }) => {
    options.spawnClaudeCodeProcess({ command: "C:\\runtime\\node.exe", args: ["sdk.mjs"], env: { SAFE_ONLY: "yes" }, signal: forwarded.signal, cwd: "C:\\project" });
    return {
      async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, permission_denials: [] }; },
      close() { setTimeout(() => { closed = true; child.emit("close", code); }, 20); },
    };
  });
  const task = { schemaVersion: 1 as const, id: "sdk", title: "SDK", prompt: "fixture", execution: { runnerId: "claude-code", mode: "managed" as const } };
  const result = await new ClaudeManagedRunner().run({ task, execution: task.execution, attemptId: "fixture", cwd: "C:\\project", prompt: "fixture", completionMarker: "marker" }, {
    signal: new AbortController().signal, onStarted() {}, onOutput() {}, async requestInteraction() { throw new Error("no interaction expected"); },
  });
  expect(spawnMock).toHaveBeenCalledWith("C:\\runtime\\node.exe", ["sdk.mjs"], expect.objectContaining({ signal: forwarded.signal, env: { SAFE_ONLY: "yes" }, stdio: ["pipe", "pipe", "pipe"] }));
  expect(closed).toBe(true);
  expect(result.nativeOutcome).toBe(code === 0 ? "completed" : "failed");
  expect(result.cleanupStatus).toBe("completed");
});
