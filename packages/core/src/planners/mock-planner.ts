import type { PlanReviewInput, PlanReviewer, Planner, PlannerInput, PlannerContext } from "../planner-types.js";

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

export class MockPlanReviewer implements PlanReviewer {
  constructor(private readonly response?: unknown) {}

  async review(input: PlanReviewInput, _context: PlannerContext): Promise<unknown> {
    if (this.response) return this.response;
    const findings: Array<Record<string, unknown>> = [];
    const text = (entry: PlanReviewInput["plan"]["tasks"][number]) => `${entry.task.title}\n${entry.task.prompt}`;
    const producers = input.plan.tasks.filter((entry) => /implement|implementation|实现|数据层|crud|service/i.test(text(entry)));
    for (const verifier of input.plan.tasks.filter((entry) => /test|testing|测试|验证|verify/i.test(text(entry)))) {
      const missing = producers.filter((producer) => producer.task.id !== verifier.task.id && !verifier.dependsOn.includes(producer.task.id));
      if (missing.length) findings.push({
        findingId: `F${findings.length + 1}`, severity: "error", category: "dependency", taskIds: [verifier.task.id, ...missing.map(({ task }) => task.id)],
        description: `验证任务 ${verifier.task.id} 没有依赖实现任务 ${missing.map(({ task }) => task.id).join(", ")}。`,
        basis: "任务标题或提示涉及测试/验证与实现，但 dependsOn 未建立顺序。",
        suggestion: `在 ${verifier.task.id}.dependsOn 中加入相关实现任务 ID。`,
      });
    }
    const frameworks = new Map<string, string[]>();
    for (const entry of input.plan.tasks) {
      for (const framework of ["express", "fastify"]) if (new RegExp(`\\b${framework}\\b`, "i").test(text(entry))) {
        frameworks.set(framework, [...(frameworks.get(framework) ?? []), entry.task.id]);
      }
    }
    if (frameworks.has("express") && frameworks.has("fastify")) findings.push({
      findingId: `F${findings.length + 1}`, severity: "error", category: "technology", taskIds: [...frameworks.get("express")!, ...frameworks.get("fastify")!],
      description: "不同任务分别指定 Express 和 Fastify。", basis: "任务提示中出现了两个不同 HTTP 框架。", suggestion: "确定一个框架，并同步更新实现和测试任务。",
    });
    return { summary: findings.length ? `Mock 审查发现 ${findings.length} 个待处理问题。` : "Mock 审查完成，未发现已编码规则覆盖的问题。", findings };
  }
}
