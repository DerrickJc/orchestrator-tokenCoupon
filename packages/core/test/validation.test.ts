import { describe, expect, test } from "vitest";
import { InputValidationError, parsePlan, parseTask } from "../src/index.js";

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    title: `任务 ${id}`,
    prompt: `执行 ${id}`,
    execution: {
      runnerId: "mock",
      mode: "non_interactive",
      timeoutMs: 60000,
    },
    ...overrides,
  };
}

function makePlan() {
  return {
    schemaVersion: 1,
    id: "test-plan",
    title: "测试计划",
    tasks: [
      { task: makeTask("first"), dependsOn: [], status: "planned" },
      { task: makeTask("second"), dependsOn: ["first"], status: "planned" },
    ],
  };
}

describe("parseTask", () => {
  test("accepts the supported task shape and leaves an unspecified model empty", () => {
    const task = parseTask(makeTask("task-1"));

    expect(task.id).toBe("task-1");
    expect(task.execution).toEqual({
      runnerId: "mock",
      mode: "non_interactive",
      timeoutMs: 60000,
    });
  });

  test("reports unsupported fields with their path", () => {
    const value = makeTask("task-1", { extra: true });

    expect(() => parseTask(value)).toThrowError(
      new InputValidationError("task.extra", "不支持此字段"),
    );
  });

  test("rejects unsupported execution modes and non-positive timeouts", () => {
    const wrongMode = makeTask("task-1", {
      execution: { runnerId: "mock", mode: "interactive", timeoutMs: 1000 },
    });
    const wrongTimeout = makeTask("task-2", {
      execution: { runnerId: "mock", mode: "non_interactive", timeoutMs: 0 },
    });

    expect(() => parseTask(wrongMode)).toThrow("task.execution.mode");
    expect(() => parseTask(wrongTimeout)).toThrow("task.execution.timeoutMs");
  });
});

describe("parsePlan", () => {
  test("preserves task order and dependency links", () => {
    const plan = parsePlan(makePlan());

    expect(plan.tasks.map(({ task }) => task.id)).toEqual(["first", "second"]);
    expect(plan.tasks[1]?.dependsOn).toEqual(["first"]);
    expect(plan.tasks[1]?.status).toBe("planned");
  });

  test("rejects duplicate task IDs and references to missing tasks", () => {
    const duplicate = {
      ...makePlan(),
      tasks: [
        { task: makeTask("same"), dependsOn: [], status: "planned" },
        { task: makeTask("same"), dependsOn: [], status: "planned" },
      ],
    };
    const missingDependency = {
      ...makePlan(),
      tasks: [{ task: makeTask("only"), dependsOn: ["missing"], status: "planned" }],
    };

    expect(() => parsePlan(duplicate)).toThrow("任务 ID 重复");
    expect(() => parsePlan(missingDependency)).toThrow("找不到依赖任务");
  });

  test("rejects duplicate dependency entries and non-planned initial states", () => {
    const duplicateDependency = {
      ...makePlan(),
      tasks: [
        { task: makeTask("first"), dependsOn: [], status: "planned" },
        { task: makeTask("second"), dependsOn: ["first", "first"], status: "planned" },
      ],
    };
    const changedStatus = {
      ...makePlan(),
      tasks: [{ task: makeTask("only"), dependsOn: [], status: "running" }],
    };

    expect(() => parsePlan(duplicateDependency)).toThrow("依赖重复");
    expect(() => parsePlan(changedStatus)).toThrow("只支持 planned 状态");
  });

  test("rejects self-dependencies and multi-task dependency cycles", () => {
    const selfDependency = {
      ...makePlan(),
      tasks: [{ task: makeTask("only"), dependsOn: ["only"], status: "planned" }],
    };
    const cycle = {
      ...makePlan(),
      tasks: [
        { task: makeTask("first"), dependsOn: ["second"], status: "planned" },
        { task: makeTask("second"), dependsOn: ["first"], status: "planned" },
      ],
    };

    expect(() => parsePlan(selfDependency)).toThrow("不能依赖自身");
    expect(() => parsePlan(cycle)).toThrow("依赖关系存在循环");
  });
});
