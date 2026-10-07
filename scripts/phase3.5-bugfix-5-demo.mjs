import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  approvePlannerDraft, checkPlan, DeepSeekPlanner, effectiveRequirements, loadPlannerConversation,
  MockPlanReviewer, PlannerStore, replyToPlanner, reviewPlannerDraft, runApprovedPlanner,
} from "../packages/core/dist/index.js";

// A scrubbed historical failure fixture; the original conversation is never modified.
const fixture = JSON.parse(await readFile(new URL("../packages/core/test/fixtures/planner-revision-failure.json", import.meta.url), "utf8"));
const real = process.argv.includes("--real");
const workspace = resolve("demo-workspace/phase3.5-bugfix-5", `${real ? "real" : "offline"}-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
const report = { status: "running", workspace, source: fixture.source, mode: real ? "recorded-and-real-deepseek" : "recorded-replay", checks: [] };
const reportFile = join(workspace, "bugfix-5-demo-report.json");

async function runCase(name, responseIndex, live = false) {
  const root = join(workspace, name);
  const snapshot = { ...structuredClone(fixture.snapshot), workspace: root };
  if (live) snapshot.config = { provider: "deepseek", model: process.env.TOKEN_COUPON_PLANNER_MODEL,
    baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com" };
  const store = new PlannerStore(root);
  await store.create(snapshot);
  await store.writeDraft(structuredClone(fixture.draft));
  await store.writeRequirements(snapshot.planningId, snapshot.requirements);
  const options = { workspace: root, planningId: snapshot.planningId };
  const prior = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer(fixture.review) });
  let calls = 0;
  const planner = live ? new DeepSeekPlanner(snapshot.config) : new DeepSeekPlanner({
    model: "recorded-replay", baseUrl: "https://api.deepseek.com", apiKey: "offline-test-key", fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const messageId = JSON.parse(/待整理输入：([^\n]+)/.exec(body.messages[0].content)[1])[0].messageId;
      const message = JSON.parse(JSON.stringify(fixture.responses[calls++ === 0 ? 0 : responseIndex])
        .replaceAll(fixture.source.originalMessageId, messageId));
      return new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    },
  });
  const result = await replyToPlanner({ ...options, message: fixture.request, planner });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.snapshot.status, "draft_ready");
  assert.equal(result.draft.draftRevision, 3);
  assert.equal(checkPlan(result.draft.plan, snapshot.executionDefaults).valid, true);
  if (!live) assert.equal(calls, 2, "No formatting/provenance repairs should be needed");
  const persisted = await loadPlannerConversation(snapshot.planningId, root);
  assert.deepEqual(persisted.draft.plan, result.draft.plan);
  const review = await reviewPlannerDraft({ ...options, reviewer: live ? planner : new MockPlanReviewer({
    summary: "Recorded repair tasks specify Java/Spring Boot, scripted MySQL and document checklists", findings: [],
    resolutions: prior.review.findings.map(({ findingId }) => ({ findingId, status: "resolved", basis: "Recorded revised tasks supply the requested fixes" })),
  }) });
  assert.equal(review.review.status, "succeeded");
  assert.equal(review.review.resolutions.length, 3);
  const blocking = review.review.findings.filter(({ severity }) => severity === "error");
  if (blocking.length) throw new Error("真实复审仍有阻塞问题；已保存报告：" + blocking.map(({ description }) => description).join("；"));
  await approvePlannerDraft({ ...options, draftRevision: 3 });
  const prompts = [];
  const runner = { id: "claude-code", supportsModel: true, async checkAvailable() {}, async run(input, context) {
    prompts.push(input.prompt);
    context.onStarted();
    context.onOutput({ stream: "stdout", text: input.completionMarker + "\n", agentText: input.completionMarker + "\n" });
    return { started: true, exitCode: 0, signal: null };
  } };
  const executed = await runApprovedPlanner({ ...options, createRunner: () => runner });
  assert.equal(executed.sessionStatus, "succeeded");
  assert.equal(prompts.length, result.draft.plan.tasks.length);
  assert.ok(prompts.every((prompt) => prompt.includes("Java 21") && prompt.includes("MySQL 8")));
  const turn = result.snapshot.turns.at(-1);
  const turnRecord = JSON.parse(await readFile(join(turn.artifactDir, "turn.json"), "utf8"));
  const check = { name, workspace: root, planningId: snapshot.planningId, turnId: turn.turnId,
    turnStatus: turn.status, draftRevision: result.draft.draftRevision, planSchemaVersion: result.draft.plan.schemaVersion,
    apiRequests: turnRecord.apiRequests, toolCalls: turnRecord.toolCalls,
    repairs: turnRecord.events.filter(({ type }) => type === "planner.validation_failed").length,
    reviewId: review.review.reviewId, reviewFindings: review.review.findings.map(({ severity, description }) => ({ severity, description })),
    testingRequirement: effectiveRequirements(result.snapshot.requirements).find(({ requirementId }) => requirementId === "R-decision-testing"),
    sessionStatus: executed.sessionStatus, runner: "simulated", runnerPrompts: prompts.length };
  report.checks.push(check);
  console.log(JSON.stringify(check));
}

try {
  for (const index of [1, 2, 3]) await runCase(`recorded-candidate-${index}`, index);
  if (real) {
    if (!process.env.TOKEN_COUPON_PLANNER_API_KEY || !process.env.TOKEN_COUPON_PLANNER_MODEL) throw new Error("缺少 Planner API key 或 model 环境配置");
    await runCase("live-revision-and-review", 3, true);
  }
  report.status = "succeeded";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log("Report: " + reportFile);
}
