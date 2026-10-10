import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DeepSeekPlanner, startPlannerConversation } from "../src/index.js";
import { parsePlanningAssessment } from "../src/planning-readiness.js";
import { parsePlannerReply, PlannerReplyValidationError } from "../src/planner-reply.js";
import { makeConfirmationProposal } from "../src/confirmation.js";

const historical = JSON.parse(await readFile(new URL("./fixtures/phase6-invalid-decisions.json", import.meta.url), "utf8"));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

test.each([0, 1, 2])("recorded response %s diagnoses task_scope without blaming valid pending", (index) => {
  try { parsePlanningAssessment(historical.replies[index].planningAssessment); throw new Error("Expected diagnosis"); }
  catch (e) {
    expect(e).toBeInstanceOf(PlannerReplyValidationError);
    const error = e as PlannerReplyValidationError;
    expect(error.diagnostics).toHaveLength(1);
    expect(error.diagnostics![0]).toMatchObject({ path: "planningAssessment.decisions[0].decisionId", actual: "task_scope" });
    expect(error.diagnostics![0]!.allowed).toContain("acceptance");
  }
});
test("invalid decision and status have independent structured diagnostics", () => {
  const value = structuredClone(historical.replies[0].planningAssessment);
  value.decisions[0].status = "waiting";
  try { parsePlanningAssessment(value); } catch (e) {
    expect((e as PlannerReplyValidationError).diagnostics?.map((d) => d.path)).toEqual(["planningAssessment.decisions[0].decisionId", "planningAssessment.decisions[0].status"]);
    expect((e as PlannerReplyValidationError).diagnostics?.[1]?.allowed).toContain("pending");
    return;
  }
  throw new Error("Should reject invalid fields");
});
test("ordinary and bound questions coexist, without duplicate or missing pending decisions", () => {
  const value = structuredClone(historical.replies[0]);
  value.planningAssessment.decisions = [value.planningAssessment.decisions[1]];
  value.questionBindings = [value.questionBindings[1]];
  const reply = parsePlannerReply(value, true, true);
  const proposal = makeConfirmationProposal(reply, "assistant", 1)!;
  expect(proposal.questions).toHaveLength(1);
  expect(proposal.questions[0]!.displayIndex).toBe(2);
  expect(proposal.questions[0]!.decisionIds).toEqual(["acceptance"]);
  value.questionBindings.push({ ...value.questionBindings[0], questionId: "duplicate", displayIndex: 1 });
  expect(() => makeConfirmationProposal(parsePlannerReply(value, true, true), "assistant", 1)).toThrow("重复关联");
});
async function replay(correct: boolean) {
  const workspace = await mkdtemp(join(tmpdir(), "phase6-protocol-")); roots.push(workspace);
  const bodies: any[] = [];
  const planner = new DeepSeekPlanner({ model: "replay", baseUrl: "http://localhost", apiKey: "test", fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init!.body)); bodies.push(body);
    const id = JSON.parse(/待整理输入：([^\n]+)/.exec(body.messages[0].content)![1]!)[0].messageId;
    const reply = JSON.parse(JSON.stringify(historical.replies[Math.min(bodies.length - 1, 2)]).replaceAll("79bcfc03-8f98-44de-80aa-597f7c0d39f8", id));
    if (correct && bodies.length > 1) { delete reply.questionBindings; reply.planningAssessment.decisions = []; }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(reply) } }] }));
  } });
  const result = await startPlannerConversation({ workspace, request: historical.request, config: { provider: "deepseek", model: "replay", baseUrl: "http://localhost" }, executionDefaults: { runnerId: "mock", mode: "non_interactive" }, planner });
  return { result, bodies, workspace };
}
test("one bounded correction preserves all original requirements and creates no fake decision", async () => {
  const { result, bodies } = await replay(true);
  expect(result.error).toBeUndefined(); expect(bodies).toHaveLength(2);
  expect(result.snapshot.status).toBe("collecting"); expect(result.snapshot.draftRevision).toBe(null);
  expect(result.snapshot.requirements?.items.filter((r) => r.status === "active").map((r) => r.text)).toEqual(["使用 Node.js 与 .mjs 文件实现，且不安装任何第三方依赖", "计划只包含三个任务"]);
  expect(result.snapshot.planningAssessment?.decisions).toEqual([]);
  expect(result.snapshot.confirmationState?.activeProposal).toBeFalsy();
  const correction = JSON.stringify(bodies[1].messages);
  expect(correction).toContain("planningAssessment.decisions[0].decisionId");
  expect(correction).toContain("task_scope"); expect(bodies[1].tools).toBeUndefined();
});
test("three recorded failures exhaust repair budget without publishing partial requirements", async () => {
  const { result, bodies } = await replay(false);
  expect(bodies).toHaveLength(3);
  expect(result.snapshot.turns.at(-1)?.reasonCode).toBe("planner_readiness_invalid");
  expect(result.snapshot.requirements?.items ?? []).toEqual([]);
  expect(result.snapshot.draftRevision).toBe(null);
});
