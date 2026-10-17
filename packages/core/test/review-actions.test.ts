import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { applyReviewActions, approvePlannerDraft, MockPlanner, MockPlanReviewer, startPlannerConversation, reviewPlannerDraft, replacePlannerDraft, PlannerStore } from "../src/index.js";
import type { PlannerInput } from "../src/index.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "review-actions-")); roots.push(workspace);
  const first = await startPlannerConversation({ workspace, request: "Create a greeting", config: { provider: "mock", model: "mock", baseUrl: "mock://local" }, executionDefaults: { runnerId: "mock", mode: "non_interactive" }, planner: new MockPlanner() });
  const planningId = first.snapshot.planningId;
  const findings = ["F1", "F2", "F3"].map((findingId) => ({ findingId, severity: "error", category: "testing", taskIds: ["verify-request"], description: `Missing test ${findingId}`, basis: "Explicit acceptance requirement", suggestion: `Add regression test ${findingId}` }));
  const reviewed = await reviewPlannerDraft({ workspace, planningId, reviewer: new MockPlanReviewer({ summary: "Missing tests", findings }) });
  return { workspace, planningId, review: reviewed.review, first, findings };
}
test("three selections produce one audited revision; custom requirement stays classifiable", async () => {
  const f = await fixture(); const inputs: PlannerInput[] = [];
  const result = await applyReviewActions({ ...f, actions: [{ findingId: "F1", action: "suggestion" }, { findingId: "F2", action: "custom", text: "Use HTTP tests" }, { findingId: "F3", action: "keep" }], planner: { id: "mock", generate: async (input) => {
    inputs.push(input); const plan = structuredClone(f.first.draft!.plan); plan.tasks[1]!.task.objective += " Use HTTP tests and test F1";
    return { kind: "draft", message: "Revised", plan, requirementsUpdate: { messageDecisions: input.pendingMessages!.map((m) => ({ messageId: m.messageId, kind: "operation", reason: "Test repair" })), changes: [] } };
  } } });
  expect(inputs).toHaveLength(1); expect(inputs[0]!.operationMessageIds).toEqual([]);
  expect(inputs[0]!.reviewContext?.review.reviewId).toBe(f.review.reviewId);
  expect(result.revised?.draft?.draftRevision).toBe(2);
  const store = new PlannerStore(f.workspace); const snapshot = await store.load(f.planningId);
  expect(snapshot.approval).toBeFalsy(); expect(snapshot.execution).toBeFalsy();
  const files = await readdir(join(f.workspace, ".token-coupon", "planners", f.planningId, "review-actions")); expect(files).toHaveLength(1);
  const audit = JSON.parse(await readFile(join(f.workspace, ".token-coupon", "planners", f.planningId, "review-actions", files[0]!), "utf8"));
  expect(audit.decisions.map((d: any) => d.action)).toEqual(["suggestion", "custom", "keep"]);
  await expect(approvePlannerDraft({ workspace: f.workspace, planningId: f.planningId })).rejects.toThrow();
});
test("keeping every finding changes neither draft nor approval, and does not waive errors", async () => {
  const f = await fixture(); let calls = 0;
  const result = await applyReviewActions({ ...f, actions: f.findings.map((finding) => ({ findingId: finding.findingId, action: "keep" })), planner: { id: "mock", generate: async () => { calls++; throw new Error("Must not generate"); } } });
  expect(calls).toBe(0); expect(result.revised).toBeUndefined();
  expect((await new PlannerStore(f.workspace).load(f.planningId)).draftRevision).toBe(1);
  await expect(approvePlannerDraft({ workspace: f.workspace, planningId: f.planningId })).rejects.toThrow();
});
test("stale report, incomplete choices and invalid custom text reject before model calls", async () => {
  const f = await fixture(); const keep = f.findings.map((v) => ({ findingId: v.findingId, action: "keep" as const }));
  await expect(applyReviewActions({ ...f, actions: keep.slice(1) })).rejects.toThrow("全部问题");
  await expect(applyReviewActions({ ...f, actions: [{ findingId: "F1", action: "custom", text: " " }, ...keep.slice(1)] })).rejects.toThrow("不能为空");
  const plan = structuredClone(f.first.draft!.plan); plan.title += " changed";
  await replacePlannerDraft({ workspace: f.workspace, planningId: f.planningId, value: plan });
  await expect(applyReviewActions({ ...f, actions: keep })).rejects.toThrow("stale");
});
test("a failed revision preserves the valid old draft and leaves the audit available", async () => {
  const f = await fixture();
  const result = await applyReviewActions({ ...f, actions: f.findings.map((finding) => ({ findingId: finding.findingId, action: "suggestion" })), planner: new MockPlanner([{ kind: "wrong" }, { kind: "wrong" }, { kind: "wrong" }]) });
  expect(result.revised?.error).toBeDefined();
  expect((await new PlannerStore(f.workspace).loadDraft(f.planningId, 1)).planHash).toBe(f.review.planHash);
});
