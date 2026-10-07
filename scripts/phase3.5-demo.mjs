import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  MockPlanReviewer,
  MockPlanner,
  SessionStore,
  approvePlannerDraft,
  checkPlan,
  diffPlans,
  loadPlannerConversation,
  replacePlannerDraft,
  replyToPlanner,
  reviewPlannerDraft,
  runApprovedPlanner,
  startPlannerConversation,
} from "../packages/core/dist/index.js";

const workspace = resolve("demo-workspace/phase3.5", `run-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
const execution = { runnerId: "mock", mode: "non_interactive", timeoutMs: 10_000 };
const issuePlan = {
  schemaVersion: 1,
  id: "phase35-demo-plan",
  title: "Express API implementation and tests",
  tasks: [
    {
      task: { schemaVersion: 1, id: "implement-api", title: "Implement API with Express", prompt: "Implement the backend API using Express.", execution },
      dependsOn: [], status: "planned",
    },
    {
      task: { schemaVersion: 1, id: "test-api", title: "Test API with Fastify", prompt: "Write and run Fastify API tests after implementation.", execution },
      dependsOn: [], status: "planned",
    },
  ],
};

const planner = new MockPlanner([
  { kind: "clarification", message: "我先确认验证范围。", questions: ["是否需要 API 自动化测试？"] },
  { kind: "draft", message: "已纳入 API 与测试任务。", plan: issuePlan },
]);
const started = await startPlannerConversation({
  workspace,
  request: "实现一个后端 API。",
  config: { provider: "mock", model: "mock", baseUrl: "mock://local" },
  executionDefaults: execution,
  planner,
});
assert.equal(started.reply?.kind, "clarification");
const drafted = await replyToPlanner({
  planningId: started.snapshot.planningId,
  workspace,
  message: "需要自动化测试。",
  planner,
});
assert.equal(drafted.draft?.draftRevision, 1);

const cyclicPlan = structuredClone(issuePlan);
cyclicPlan.tasks[0].dependsOn = ["test-api"];
cyclicPlan.tasks[1].dependsOn = ["implement-api"];
assert.equal(checkPlan(cyclicPlan, execution).valid, false, "本地校验应拒绝循环依赖");
await assert.rejects(replacePlannerDraft({ planningId: started.snapshot.planningId, workspace, value: cyclicPlan }));
assert.equal((await loadPlannerConversation(started.snapshot.planningId, workspace)).draft?.draftRevision, 1, "非法草案不能覆盖当前版本");

const firstReview = await reviewPlannerDraft({ planningId: started.snapshot.planningId, workspace, reviewer: new MockPlanReviewer() });
assert.deepEqual(firstReview.review.findings.map(({ category }) => category), ["dependency", "technology"]);
await assert.rejects(approvePlannerDraft({ planningId: started.snapshot.planningId, workspace, draftRevision: 1 }), /修订或显式豁免/);

const fixedPlan = structuredClone(issuePlan);
fixedPlan.tasks[1].task.title = "Test API with Express";
fixedPlan.tasks[1].task.prompt = "Write and run Express API tests after implementation.";
fixedPlan.tasks[1].dependsOn = ["implement-api"];
const fixed = await replacePlannerDraft({ planningId: started.snapshot.planningId, workspace, value: fixedPlan });
assert.equal(fixed.draft?.draftRevision, 2);
assert.ok(diffPlans(issuePlan, fixedPlan).some(({ taskId, field }) => taskId === "test-api" && field === "dependsOn"));
await assert.rejects(approvePlannerDraft({ planningId: started.snapshot.planningId, workspace, draftRevision: 2 }), /完成当前草案的审查/);

const finalReview = await reviewPlannerDraft({ planningId: started.snapshot.planningId, workspace, reviewer: new MockPlanReviewer() });
assert.equal(finalReview.review.findings.length, 0);
await approvePlannerDraft({ planningId: started.snapshot.planningId, workspace, draftRevision: 2, reviewId: finalReview.review.reviewId });

class DemoRunner {
  id = "mock";
  supportsModel = false;
  async checkAvailable() {}
  async run(input, context) {
    context.onStarted();
    const agentText = `演示任务已完成。\n${input.completionMarker}\n`;
    context.onOutput({ stream: "stdout", text: agentText, agentText });
    return { started: true, exitCode: 0, signal: null };
  }
}

const run = await runApprovedPlanner({
  planningId: started.snapshot.planningId,
  workspace,
  createRunner: () => new DemoRunner(),
});
assert.equal(run.sessionStatus, "succeeded");
const repeated = await runApprovedPlanner({
  planningId: started.snapshot.planningId,
  workspace,
  createRunner: () => new DemoRunner(),
});
assert.equal(repeated.snapshot.execution?.sessionId, run.snapshot.execution?.sessionId, "重复 run 应返回已有关联 Session");

const loaded = await loadPlannerConversation(started.snapshot.planningId, workspace);
const session = await new SessionStore(workspace).load(run.snapshot.execution.sessionId);
const reviews = await readdir(join(workspace, ".token-coupon", "planners", started.snapshot.planningId, "reviews"));
assert.deepEqual(session.plan, fixed.draft.plan, "Session 执行计划必须等于最终批准草案");
const report = {
  planningId: started.snapshot.planningId,
  conversationTurns: loaded.snapshot.turns.length,
  draftRevision: loaded.draft?.draftRevision,
  priorReviewFindings: firstReview.review.findings,
  currentReviewId: loaded.snapshot.latestReviewId,
  reviewCount: reviews.length,
  approval: loaded.snapshot.approval,
  sessionId: session.snapshot.sessionId,
  sessionStatus: session.snapshot.status,
  artifacts: join(workspace, ".token-coupon", "sessions", session.snapshot.sessionId),
};
await writeFile(join(workspace, "demo-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`\n演示工作区：${workspace}`);
