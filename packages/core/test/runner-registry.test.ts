import { describe, expect, it } from "vitest";
import { RunnerRegistry, parseRunnerProfile } from "../src/runner-registry.js";
import type { Runner, RunnerCapabilities, RunnerRegistration } from "../src/runner.js";
import type { ExecutionMode, TaskDefinition } from "../src/task.js";

const all: RunnerCapabilities = {
  structuredEvents: "supported", userInput: "supported", toolApproval: "supported",
  cancellation: "supported", reportedModel: "unverified",
};
const none: RunnerCapabilities = {
  structuredEvents: "supported", userInput: "unsupported", toolApproval: "unsupported",
  cancellation: "supported", reportedModel: "unsupported",
};

function fakeRegistration(id: string, mode: ExecutionMode, capabilities = all): RunnerRegistration {
  return {
    id, adapterVersion: "1.0.0", configurationVersion: 1, supportedModes: [mode], supportsModel: true,
    capabilities: { [mode]: capabilities } as Record<ExecutionMode, RunnerCapabilities>,
    validateSettings(settings, version) {
      if (version !== 1) throw new Error("unsupported config version");
      const allowed = new Set(["label", "nested"]);
      for (const key of Object.keys(settings)) if (!allowed.has(key)) throw new Error(`unknown setting ${key}`);
      return { ...settings };
    },
    create() { return fakeRunner(id); },
  };
}

function fakeRunner(id: string): Runner {
  return { id, supportsModel: true, async checkAvailable() {}, async run(_input, context) {
    await context.recordEvent?.({ type: "runner.native.finished", outcome: "completed" });
    return { started: true, exitCode: 0, signal: null };
  } };
}

function task(id: string, runnerId: string, mode: ExecutionMode, requiredCapabilities: TaskDefinition["execution"]["requiredCapabilities"] = []): TaskDefinition {
  return { schemaVersion: 1, id, title: id, prompt: "run", execution: { runnerId, mode, requiredCapabilities } };
}

describe("RunnerRegistry", () => {
  it("preserves optional adapter diagnostics through registry resolution", async () => {
    const registry = new RunnerRegistry();
    const registration = fakeRegistration("diagnostic-agent", "managed");
    const visited: string[] = [];
    registration.create = () => ({ ...fakeRunner("diagnostic-agent"), async diagnose(cwd) {
      visited.push(cwd);
      return { version: "1.2.3", configurationSources: [], authentication: "unknown", inference: "unverified" };
    } });
    registry.register(registration);
    const runner = registry.resolve(task("one", "diagnostic-agent", "managed")).runner;
    expect(await runner.diagnose?.("/workspace")).toMatchObject({ version: "1.2.3", inference: "unverified" });
    expect(visited).toEqual(["/workspace"]);
  });
  it("routes a third SDK-style adapter through the common contract without native process assumptions", async () => {
    const registry = new RunnerRegistry();
    registry.register(fakeRegistration("future-agent", "managed"));
    const resolved = registry.resolve(task("one", "future-agent", "managed", ["userInput", "toolApproval"]));
    const recorded: unknown[] = [];
    const result = await resolved.runner.run({ attemptId: "attempt", cwd: "/repo/worktree", task: task("one", "future-agent", "managed"), execution: task("one", "future-agent", "managed").execution, prompt: "run", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {}, recordEvent: async (event) => { recorded.push(event); },
    });
    expect(result).toMatchObject({ started: true, exitCode: 0 });
    expect(resolved.spec.runnerId).toBe("future-agent");
    expect(recorded).toEqual([{ type: "runner.native.finished", outcome: "completed" }]);
  });

  it("checks partial capabilities per mode and rejects duplicate adapter IDs", () => {
    const registry = new RunnerRegistry();
    registry.register(fakeRegistration("approval-agent", "managed", { ...all, userInput: "unsupported" }));
    expect(() => registry.resolve(task("q", "approval-agent", "managed", ["userInput"]))).toThrow("userInput 能力为 unsupported");
    expect(() => registry.resolve(task("q", "approval-agent", "managed", ["toolApproval"]))).not.toThrow();
    expect(() => registry.register(fakeRegistration("approval-agent", "managed"))).toThrow("重复注册");
  });

  it("hashes normalized settings, rejects unknown versions and never accepts credential fields", () => {
    const registry = new RunnerRegistry();
    registry.register(fakeRegistration("future-agent", "managed"));
    const taskValue = task("one", "future-agent", "managed");
    const left = parseRunnerProfile({ schemaVersion: 1, runners: { "future-agent": { configVersion: 1, settings: { label: "x", nested: { b: 2, a: 1 } } } } });
    const right = parseRunnerProfile({ schemaVersion: 1, runners: { "future-agent": { configVersion: 1, settings: { nested: { a: 1, b: 2 }, label: "x" } } } });
    expect(registry.resolve(taskValue, left).spec.settingsHash).toBe(registry.resolve(taskValue, right).spec.settingsHash);
    expect(() => registry.resolve(taskValue, parseRunnerProfile({ schemaVersion: 1, runners: { "future-agent": { configVersion: 2, settings: {} } } }))).toThrow("unsupported config version");
    expect(() => parseRunnerProfile({ schemaVersion: 1, runners: { "future-agent": { configVersion: 1, settings: { apiKey: "secret" } } } })).toThrow("不允许保存凭证");
    expect(() => parseRunnerProfile({ schemaVersion: 1, runners: { "future-agent": { configVersion: 1, settings: {}, extra: true } } })).toThrow("未知字段");
  });
});
