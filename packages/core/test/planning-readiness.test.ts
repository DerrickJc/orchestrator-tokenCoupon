import { describe, expect, it } from "vitest";
import { assertPlanningReady, validatePlanningAssessment } from "../src/planning-readiness.js";
import type { ConversationMessage, PlanningAssessment } from "../src/planner-types.js";

const values = { language_runtime: "Java 21", inputs_outputs: "命令行参数", side_effects: "只写工作区", testing: "node:test" };
function assessment(quote: string): PlanningAssessment {
  return { profile: "script", classification: { rationale: "脚本", sourceMessageId: "request", quote: "编写脚本" },
    decisions: Object.entries(values).map(([decisionId, value]) => ({ decisionId: decisionId as keyof typeof values, value, status: "defaulted", rationale: "授权的默认值", sourceMessageId: "answer", authorizationQuote: quote })) };
}
function validate(source: string, preceding: ConversationMessage[] = [], quote = source) {
  return validatePlanningAssessment(assessment(quote), {
    messages: [{ messageId: "request", role: "user", content: "编写脚本" }, ...preceding, { messageId: "answer", role: "user", content: source }],
    requirements: { revision: 0, items: [], messageDecisions: [] }, evidence: [], currentMessageIds: ["answer"],
  });
}
function proposal(): ConversationMessage {
  return { messageId: "proposal", role: "assistant", content: JSON.stringify({ kind: "clarification", questions: ["确认默认方案？"], planningAssessment: {
    ...assessment("unused"), decisions: Object.entries(values).map(([decisionId, value]) => ({ decisionId, value, status: "pending", rationale: "等待确认", question: `是否授权采用${value}作为默认方案？` })),
  } }) };
}

describe("default authorization follows persisted conversation context", () => {
  it("identifies the exact decision and index when a required field is missing", () => {
    const reply = assessment("全部由你决定");
    const { rationale: _rationale, ...missing } = reply.decisions[3]!;
    expect(() => validatePlanningAssessment({ ...reply, decisions: [...reply.decisions.slice(0, 3), missing] }, {
      messages: [], requirements: { revision: 0, items: [], messageDecisions: [] }, evidence: [], currentMessageIds: [],
    })).toThrow("planningAssessment.decisions[3](testing).rationale");
  });

  it.each(["全部由你完成模拟，技术栈和细节我暂时不关注", "所有细节由你决定", "按推荐的默认方案", "use defaults"])("accepts clear delegation: %s", (source) => {
    expect(validate(source).decisions.every(({ status }) => status === "defaulted")).toBe(true);
  });

  it("uses the full source to recognize delegation even when the quote omits its opening clause", () => {
    expect(validate("全部由你完成模拟，技术栈和细节我暂时不关注", [], "技术栈和细节我暂时不关注").decisions).toHaveLength(4);
  });

  it("checks actual prompt text without JSON escaping and still rejects omitted decision values", () => {
    const choice = assessment("全部由你决定");
    choice.decisions[0]!.value = 'Node.js "22"';
    const prompt = choice.decisions.map(({ value }) => value).join("；");
    const plan = { schemaVersion: 1 as const, id: "script", title: "脚本", tasks: [{ task: { schemaVersion: 1 as const, id: "verify", title: "验证", prompt, execution: { runnerId: "mock", mode: "non_interactive" as const } }, dependsOn: [], status: "planned" as const }] };
    expect(() => assertPlanningReady(choice, plan)).not.toThrow();
    expect(() => assertPlanningReady(choice, { ...plan, tasks: [{ ...plan.tasks[0]!, task: { ...plan.tasks[0]!.task, prompt: "其他内容" } }] })).toThrow("执行约束");
  });

  it("keeps legacy Plan v1 usable without structured readiness while requiring a registry for v2", () => {
    const legacy = { schemaVersion: 1 as const, id: "legacy", title: "Legacy plan", tasks: [] };
    expect(() => assertPlanningReady(undefined, legacy)).not.toThrow();
    expect(() => assertPlanningReady(undefined, { ...legacy, schemaVersion: 2, decisionContext: { schemaVersion: 1, decisions: [], globalDecisionIds: [] } }))
      .toThrow("缺少结构化规划决策记录");
  });

  it.each(["同意", "同意该默认方案", "同意上述方案", "好的", "yes"])("accepts consent only for the preceding concrete default proposals: %s", (source) => {
    expect(validate(source, [proposal()]).decisions).toHaveLength(4);
    expect(() => validate(source)).toThrow("缺少有效授权");
  });

  it("allows failed confirmations between a successful proposal and its confirmation", () => {
    expect(validate("同意该默认方案", [proposal(), { messageId: "failed", role: "user", content: "同意" }]).decisions).toHaveLength(4);
  });

  it("adopts an unchanged concrete proposal value when its question summarizes explanations", () => {
    const proposed = JSON.parse(proposal().content) as { planningAssessment: PlanningAssessment };
    proposed.planningAssessment.decisions[0]!.value = "Java 21（Maven 构建）";
    const accepted = assessment("同意");
    accepted.decisions[0]!.value = "Java 21（Maven 构建）";
    const input = { messages: [{ messageId: "request", role: "user" as const, content: "编写脚本" }, { ...proposal(), content: JSON.stringify(proposed) }, { messageId: "answer", role: "user" as const, content: "同意" }], requirements: { revision: 0, items: [], messageDecisions: [] }, evidence: [], currentMessageIds: ["answer"] };
    expect(validatePlanningAssessment(accepted, input).decisions[0]!.value).toBe("Java 21（Maven 构建）");
    accepted.decisions[0]!.value = "Java 21（Gradle 构建）";
    expect(() => validatePlanningAssessment(accepted, input)).toThrow("缺少有效授权");
  });

  it("reads an older proposal's concrete question when its stored value is unspecified", () => {
    const old = JSON.parse(proposal().content) as { planningAssessment: PlanningAssessment };
    old.planningAssessment.decisions.forEach((item) => { item.value = "未指定，等待用户确认"; });
    expect(validate("同意", [{ ...proposal(), content: JSON.stringify(old) }]).decisions).toHaveLength(4);
  });

  it("rejects refusal, quote cherry-picking, scoped delegation and unrelated intervening messages", () => {
    expect(() => validate("不同意该默认方案", [proposal()])).toThrow("缺少有效授权");
    expect(() => validate("不要按推荐的默认方案", [], "按推荐的默认方案")).toThrow("缺少有效授权");
    expect(() => validate("技术栈由你决定")).toThrow("决策 inputs_outputs");
    expect(() => validate("同意", [proposal(), { messageId: "other", role: "user", content: "先换成 Python" }])).toThrow("缺少有效授权");
    expect(() => validate("同意", [{ ...proposal(), content: JSON.stringify({ kind: "draft" }) }])).toThrow("缺少有效授权");
  });

  it("rejects a new value or alternatives without a concrete default proposal", () => {
    const changed = JSON.parse(proposal().content) as { planningAssessment: PlanningAssessment };
    changed.planningAssessment.decisions[0]!.value = "Python 3.12";
    changed.planningAssessment.decisions[0]!.question = "是否授权采用Python 3.12作为默认方案？";
    expect(() => validate("同意", [{ ...proposal(), content: JSON.stringify({ ...changed, kind: "clarification" }) }])).toThrow("缺少有效授权");
    changed.planningAssessment.decisions[0]!.question = "请选择 Java 21 或 Python 3.12";
    expect(() => validate("同意", [{ ...proposal(), content: JSON.stringify({ ...changed, kind: "clarification" }) }])).toThrow("缺少有效授权");
  });

  it("cannot bypass contextual consent by labeling an invented default confirmed", () => {
    const result = assessment("同意");
    result.decisions[0] = { decisionId: "language_runtime", value: "Java 21", status: "confirmed", rationale: "试图绕过提案", requirementId: "R-runtime", sourceMessageId: "answer", quote: "同意" };
    expect(() => validatePlanningAssessment(result, {
      messages: [{ messageId: "request", role: "user", content: "编写脚本" }, { messageId: "answer", role: "user", content: "同意" }],
      requirements: { revision: 1, messageDecisions: [], items: [{ requirementId: "R-runtime", revision: 1, status: "active", text: "Java 21", sourceMessageIds: ["answer"] }] }, evidence: [], currentMessageIds: ["answer"],
    })).toThrow("不能用 confirmed 绕过默认授权校验");
  });
});
