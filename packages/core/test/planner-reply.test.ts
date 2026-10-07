import { describe, expect, it } from "vitest";
import { decodePlannerJson, parsePlannerJson, parsePlannerReply } from "../src/planner-reply.js";

const value = {
  kind: "draft", message: '字符串中的 } 和 ,"requirementsUpdate": 不能当作结构；\\"',
  plan: { title: "SQLite" }, planningAssessment: { decisions: [{ value: "Java 21" }] },
  requirementsUpdate: { changes: [] },
};
const valid = JSON.stringify(value);
const malformed = valid.replace(',"requirementsUpdate":', '},"requirementsUpdate":');

describe("Planner JSON structural recovery and field diagnostics", () => {
  it("leaves valid JSON unchanged and recovers only the premature root close", () => {
    expect(decodePlannerJson(valid)).toEqual({ value });
    const decoded = decodePlannerJson(malformed);
    expect(decoded.value).toEqual(value);
    expect(decoded.repair).toEqual({ code: "premature_root_close", offset: malformed.indexOf('},"requirementsUpdate":'), field: "requirementsUpdate" });
    expect(() => parsePlannerJson(malformed)).toThrow("根对象在 requirementsUpdate 前提前关闭");
  });

  it.each([
    '{"kind":"draft"}{"requirementsUpdate":{}}',
    '{"kind":"draft"},"unknown":{}}',
    '{"kind":"draft","requirementsUpdate":{}},"requirementsUpdate":{}}',
    '{"kind":"draft"},"requirementsUpdate":{},"k\\u0069nd":"clarification"}',
    '{"kind":"draft"},"requirementsUpdate":',
    '{"kind":"draft"},"requirementsUpdate":{}',
    '```json\n' + malformed + '\n```',
  ])("rejects ambiguous or incomplete content: %s", (content) => {
    expect(() => decodePlannerJson(content)).toThrow("不是合法 JSON");
  });

  it.each([
    [{ message: "x" }, "缺少 kind 字段"],
    [{ kind: "other", message: "x" }, "kind 只能"],
    [{ kind: "draft", message: "x", plan: {}, questions: ["x"] }, "draft 不能包含 questions"],
    [{ kind: "clarification", message: "x", plan: {}, questions: ["x"] }, "clarification 不能包含 plan"],
    [{ kind: "draft", message: "x" }, "缺少 plan 字段"],
    [{ kind: "draft", message: "x", plan: {}, surprise: true }, "未知字段"],
  ])("gives a specific schema diagnosis", (reply, diagnostic) => {
    expect(() => parsePlannerReply(reply)).toThrow(diagnostic);
  });
});
