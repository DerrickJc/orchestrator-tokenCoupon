import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { checkPlan } from "../src/plan-check.js";
import { createDefaultRunnerRegistry } from "../src/default-runner-registry.js";
import { RunnerRegistry } from "../src/runner-registry.js";
import type { ExecutionConfig } from "../src/task.js";
import type { RunnerRegistration } from "../src/runner.js";

const defaults: ExecutionConfig = { runnerId: "codex", modelId: "gpt-6-luna", mode: "managed" };
const matrix = JSON.parse(await readFile(new URL("./fixtures/biz04-task-matrix.json", import.meta.url), "utf8"));
function plan(execution: unknown = defaults) {
  return { schemaVersion: 1, id: "execution-defaults", title: "Default and task execution", tasks: [{
    task: { schemaVersion: 1, id: "one", title: "One", prompt: "Complete this task", execution }, dependsOn: [], status: "planned",
  }] };
}

describe("planning execution defaults and per-task configurations", () => {
  it("accepts the BIZ-04 nine-task matrix under Codex defaults without rewriting the three Claude tasks", () => {
    const value = { schemaVersion: 1, id: "biz04-mixed", title: "BIZ-04", tasks: matrix.tasks.map((item: any) => ({
      task: { schemaVersion: 1, id: item.id, title: item.title, prompt: item.title, execution: item.execution }, dependsOn: item.dependsOn, status: "planned",
    })) };
    const before = structuredClone(value);
    const checked = checkPlan(value, defaults);
    expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
    expect(checked.executionPolicyChecked).toBe(true);
    expect(checked.plan!.tasks.map(({ task }) => ({ id: task.id, execution: task.execution }))).toEqual(matrix.tasks.map((item: any) => ({ id: item.id, execution: item.execution })));
    expect(checked.plan!.tasks.filter(({ task }) => task.execution.runnerId === "claude-code").map(({ task }) => task.id)).toEqual(["C", "F", "H"]);
    expect(value).toEqual(before);
  });

  it.each([undefined, {}])("fills missing execution fields from defaults (%j)", execution => {
    const result = checkPlan(plan(execution === undefined ? {} : execution), defaults);
    expect(result.valid).toBe(true);
    expect(result.plan!.tasks[0]!.task.execution).toEqual(defaults);
    const absent = plan(); delete (absent.tasks[0]!.task as { execution?: unknown }).execution;
    expect(checkPlan(absent, defaults).plan!.tasks[0]!.task.execution).toEqual(defaults);
  });

  it("allows a same-Runner model override and fills its missing mode", () => {
    expect(checkPlan(plan({ modelId: "another-codex-model" }), defaults).plan!.tasks[0]!.task.execution).toEqual({ ...defaults, modelId: "another-codex-model" });
  });

  it("does not carry a Codex model or capability requirements into a different Runner", () => {
    const value = plan({ runnerId: "claude-code" });
    const result = checkPlan(value, { ...defaults, requiredCapabilities: ["userInput"] });
    expect(result.valid).toBe(true);
    expect(result.plan!.tasks[0]!.task.execution).toEqual({ runnerId: "claude-code", mode: "managed" });
    expect(checkPlan(plan({ runnerId: "mock" }), defaults).valid).toBe(true);
  });

  it("accepts an explicitly supported mode instead of forcing the default mode", () => {
    expect(checkPlan(plan({ runnerId: "claude-code", modelId: "deepseek-flash", mode: "non_interactive" }), defaults).valid).toBe(true);
  });

  it.each([
    [{ runnerId: "unknown-agent", mode: "managed" }, "不支持的 Runner"],
    [{ runnerId: "codex", mode: "non_interactive" }, "不支持 non_interactive"],
    [{ runnerId: "mock", mode: "managed", modelId: "gpt-6-luna" }, "不支持 modelId"],
    [{ runnerId: "mock", mode: "managed", requiredCapabilities: ["userInput"] }, "userInput 能力"],
    [{ runnerId: "codex", mode: "invalid" }, "必须是 non_interactive 或 managed"],
    [{ runnerId: "codex", mode: "managed", apiKey: "must-not-be-accepted" }, "不支持此字段"],
    [null, "对象"],
    [[], "对象"],
  ])("rejects incompatible or malformed execution: %j", (execution, message) => {
    const result = checkPlan(plan(execution), defaults);
    expect(result.valid).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.diagnostics[0]!.message).toContain(message);
    expect(result.diagnostics[0]!.taskIds).toEqual(["one"]);
  });

  it("keeps DAG validation and rejects incomplete plans when no defaults exist", () => {
    const cyclic = plan(); cyclic.tasks[0]!.dependsOn = ["one"];
    expect(checkPlan(cyclic, defaults).valid).toBe(false);
    expect(checkPlan(plan({ runnerId: "codex" })).valid).toBe(false);
    expect(checkPlan(plan(defaults)).valid).toBe(true);
  });

  it("uses the supplied registry for future adapters and never starts a Runner or probes login", () => {
    const registry = new RunnerRegistry();
    const start = vi.fn(), probe = vi.fn();
    const registration: RunnerRegistration = {
      id: "future-agent", adapterVersion: "1", configurationVersion: 1, supportsModel: true, supportedModes: ["managed"],
      capabilities: { managed: { structuredEvents: "supported", userInput: "supported", toolApproval: "supported", cancellation: "supported", reportedModel: "unverified" }, non_interactive: { structuredEvents: "unsupported", userInput: "unsupported", toolApproval: "unsupported", cancellation: "unsupported", reportedModel: "unsupported" } },
      validateSettings: settings => settings,
      create: () => ({ id: "future-agent", supportsModel: true, checkAvailable: async () => { probe(); }, run: async () => { start(); return { started: true, exitCode: 0, signal: null }; } }),
    };
    registry.register(registration);
    expect(checkPlan(plan({ runnerId: "future-agent", modelId: "future-model", mode: "managed" }), defaults, registry).valid).toBe(true);
    expect(probe).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it("normalizes before hashing and leaves fully explicit approved plan hashes stable", () => {
    const shorthand = checkPlan(plan({ runnerId: "codex" }), defaults);
    const explicit = checkPlan(plan(defaults), defaults);
    expect(shorthand.planHash).toBe(explicit.planHash);
    expect(checkPlan(explicit.plan, defaults).planHash).toBe(explicit.planHash);
    expect(createDefaultRunnerRegistry().list().some(({ id }) => id === "claude-code")).toBe(true);
  });
});
