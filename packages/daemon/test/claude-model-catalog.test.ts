import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const { queryMock, spawnMock, resolveMock } = vi.hoisted(() => ({ queryMock: vi.fn(), spawnMock: vi.fn(), resolveMock: vi.fn(async () => "C:\\tools\\claude.cmd") }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("@token-coupon/core", async importOriginal => ({ ...await importOriginal<typeof import("@token-coupon/core")>(), resolveAgentExecutable: resolveMock, spawnNative: spawnMock }));
import { discoverRunnerModels } from "../src/model-catalog.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.clearAllMocks(); });
it("uses the discovered external Claude command for metadata and confines Windows shims to the managed process adapter", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }); spawnMock.mockReturnValue(child);
  const close = vi.fn();
  queryMock.mockImplementation(({ options }) => {
    expect(options.pathToClaudeCodeExecutable).toBe("C:\\tools\\claude.cmd");
    options.spawnClaudeCodeProcess({ command: options.pathToClaudeCodeExecutable, args: ["--output-format", "stream-json"], env: {}, signal: options.abortController.signal });
    return { close, supportedModels: async () => [{ value: "configured-model", displayName: "Configured" }] };
  });
  const result = await discoverRunnerModels("claude-code", "C:\\project");
  expect(result.models[0]?.id).toBe("configured-model"); expect(resolveMock).toHaveBeenCalledWith("claude-code");
  expect(spawnMock).toHaveBeenCalledWith("C:\\tools\\claude.cmd", ["--output-format", "stream-json"], expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
  expect(await queryMock.mock.calls[0]![0].options.canUseTool()).toMatchObject({ behavior: "deny" });
  expect(close).toHaveBeenCalledOnce();
});
