import type { Planner, PlannerInput, PlannerContext } from "../planner-types.js";

export class MockPlanner implements Planner {
  readonly id = "mock" as const;
  constructor(private readonly replies: unknown[] = []) {}

  async generate(input: PlannerInput, _context: PlannerContext): Promise<unknown> {
    if (this.replies.length) return this.replies.shift();
    const request = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "完成用户提出的需求";
    const makeTask = (id: string, title: string, prompt: string) => ({
      schemaVersion: 1, id, title, prompt, execution: input.executionDefaults,
    });
    return {
      kind: "draft",
      message: "我根据需求准备了实现和验证计划，请检查每项任务及其依赖。",
      plan: {
        schemaVersion: 1,
        id: "planner-generated-plan",
        title: "需求实现计划",
        tasks: [
          { task: makeTask("implement-request", "实现需求", request), dependsOn: [], status: "planned" },
          { task: makeTask("verify-request", "验证实现", "检查前置任务的代码变更，运行相关测试并汇报实际结果。"), dependsOn: ["implement-request"], status: "planned" },
        ],
      },
    };
  }
}
