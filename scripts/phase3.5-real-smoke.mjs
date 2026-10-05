import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MockRunner, SessionStore, approvePlannerDraft, checkPlan, diffPlans,
  loadCurrentPlanReview, loadPlannerConversation, replacePlannerDraft,
  replyToPlanner, reviewPlannerDraft, runApprovedPlanner, startPlannerConversation,
} from "../packages/core/dist/index.js";

// Opt-in integration test: real planner/reviewer requests; task execution is mocked.
if (!process.env.TOKEN_COUPON_PLANNER_API_KEY || !process.env.TOKEN_COUPON_PLANNER_MODEL) {
  console.error("请通过 node --env-file=<配置文件> 加载 Planner API Key 和模型。");
  process.exit(2);
}

const workspace = resolve("demo-workspace/phase3.5-real", `run-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "greet-smoke", private: true, type: "module", scripts: { test: "node --test greet.test.mjs" } }, null, 2) + "\n");
await writeFile(join(workspace, "README.md"), "# Greet smoke workspace\nNode.js ESM project. Use built-in node:test and node:assert/strict; no external dependencies. Implementation files do not exist yet.\n");

const config = {
  provider: "deepseek",
  model: process.env.TOKEN_COUPON_PLANNER_MODEL,
  baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com",
};
const executionDefaults = { runnerId: "mock", mode: "non_interactive", timeoutMs: 10_000 };
const report = { workspace, config, taskExecution: "mock", status: "running", checks: [], reviews: [] };
// Keep mutable diagnostics outside the repository files inspected by the model.
const diagnosticDirectory = join(workspace, ".token-coupon");
await mkdir(diagnosticDirectory, { recursive: true });
const reportFile = join(diagnosticDirectory, "smoke-report.json");
let stage = "planning";

async function checkpoint(name, details = {}) {
  report.checks.push({ name, status: "passed", ...details });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ check: name, ...details }));
}

async function review(draftRevision) {
  const result = await reviewPlannerDraft({ planningId: report.planningId, workspace });
  assert.equal(result.review.status, "succeeded");
  report.reviews.push({ reviewId: result.review.reviewId, draftRevision, summary: result.review.summary, findings: result.review.findings });
  return result;
}

try {
  console.log(JSON.stringify({ workspace, model: config.model, stage }));
  let drafted = await startPlannerConversation({
    workspace, config, executionDefaults,
    request: "请调研 package.json 和 README.md，然后生成可直接执行的两项任务计划，不要执行任务，也不要提澄清问题。任务一：新增 greet.mjs，导出 greet(name)，返回 `Hello, ${name}!`；新增 greet.test.mjs，用 node:test 和 node:assert/strict 覆盖 greet('World') === 'Hello, World!' 及 greet('') === 'Hello, !'。任务二是最终验证任务，必须依赖任务一，运行 npm test 并汇总真实测试结果。不安装依赖，不引入框架。每项任务严格使用系统提供的 execution 配置。",
  });
  report.planningId = drafted.snapshot.planningId;
  if (drafted.error) throw new Error(drafted.error);
  if (!drafted.draft) {
    drafted = await replyToPlanner({ planningId: report.planningId, workspace, message: "确认使用 Node.js ESM 和内置 node:test，函数文件与测试文件均放在工作区根目录，空字符串返回 Hello, !。不安装依赖。请直接生成包含实现和最终验证两项任务的完整草案。" });
    if (drafted.error) throw new Error(drafted.error);
  }
  assert.ok(drafted.draft, "真实模型应生成草案");
  assert.equal(checkPlan(drafted.draft.plan, executionDefaults).valid, true);
  await checkpoint("real-planning-and-structure", { planningId: report.planningId, draftRevision: drafted.draft.draftRevision });

  stage = "review-gate";
  await assert.rejects(approvePlannerDraft({ planningId: report.planningId, workspace, draftRevision: drafted.draft.draftRevision }), /审查/);
  await checkpoint("approval-requires-review");

  stage = "first-review";
  const firstReview = await review(drafted.draft.draftRevision);
  await checkpoint("real-review", { reviewId: firstReview.review.reviewId, findings: firstReview.review.findings.length });

  stage = "draft-edit";
  const editedPlan = structuredClone(drafted.draft.plan);
  editedPlan.tasks.at(-1).task.prompt += "\n验证报告应明确列出执行命令、测试数量和通过/失败结果。";
  const edited = await replacePlannerDraft({ planningId: report.planningId, workspace, value: editedPlan });
  assert.ok(edited.draft);
  const changes = diffPlans(drafted.draft.plan, edited.draft.plan);
  assert.ok(changes.some((change) => change.field === "prompt"));
  assert.equal(await loadCurrentPlanReview(report.planningId, workspace), undefined);
  await assert.rejects(approvePlannerDraft({ planningId: report.planningId, workspace, draftRevision: edited.draft.draftRevision }), /审查/);
  await checkpoint("edit-diff-and-stale-review-gate", { draftRevision: edited.draft.draftRevision, changes });

  stage = "final-review";
  let current = edited;
  let finalReview = await review(current.draft.draftRevision);
  const serious = finalReview.review.findings.filter(({ severity }) => severity === "error");
  if (serious.length) {
    await assert.rejects(approvePlannerDraft({ planningId: report.planningId, workspace, draftRevision: current.draft.draftRevision }), /修订或显式豁免/);
    await checkpoint("serious-findings-block-approval", { count: serious.length });
    stage = "repair";
    current = await replyToPlanner({ planningId: report.planningId, workspace, message: "请根据以下审查问题修订草案，不豁免问题。保持两项任务、实现与验证依赖、原 execution 配置和原验收要求：\n" + JSON.stringify(serious) });
    if (current.error) throw new Error(current.error);
    assert.ok(current.draft);
    finalReview = await review(current.draft.draftRevision);
  }
  assert.equal(finalReview.review.findings.filter(({ severity }) => severity === "error").length, 0, "严重问题应修订后重新审查通过；测试不自动豁免");
  await checkpoint("real-review-after-edit", { reviewId: finalReview.review.reviewId, findings: finalReview.review.findings.length });

  stage = "approval";
  const approved = await approvePlannerDraft({ planningId: report.planningId, workspace, draftRevision: current.draft.draftRevision, reviewId: finalReview.review.reviewId });
  assert.equal(approved.snapshot.status, "approved");
  await checkpoint("approval-binds-current-draft-and-review");

  stage = "mock-execution";
  const runOptions = { planningId: report.planningId, workspace, createRunner: () => new MockRunner() };
  const run = await runApprovedPlanner(runOptions);
  report.sessionId = run.snapshot.execution.sessionId;
  report.sessionStatus = run.sessionStatus;
  assert.equal(run.sessionStatus, "succeeded");
  const session = await new SessionStore(workspace).load(report.sessionId);
  assert.deepEqual(session.plan, current.draft.plan);
  assert.ok(session.snapshot.tasks.every(({ status }) => status === "succeeded"));
  report.attempts = [];
  for (const task of session.snapshot.tasks) {
    assert.equal(task.attempts.length, 1);
    const ref = task.attempts[0];
    const attempt = JSON.parse(await readFile(join(ref.artifactDir, "attempt.json"), "utf8"));
    assert.equal(attempt.status, "succeeded");
    report.attempts.push({ taskId: task.taskId, attemptId: ref.attemptId, status: attempt.status, artifactDir: ref.artifactDir });
  }
  await checkpoint("mock-session-and-attempts", { sessionId: report.sessionId, tasks: session.snapshot.tasks.length });
  const repeated = await runApprovedPlanner(runOptions);
  assert.equal(repeated.snapshot.execution.sessionId, report.sessionId);
  assert.deepEqual((await new SessionStore(workspace).load(report.sessionId)).snapshot.tasks, session.snapshot.tasks);
  await checkpoint("repeated-run-reuses-session");

  stage = "cli-inspection";
  for (const action of ["show", "check", "review"]) {
    const args = [resolve("packages/cli/dist/main.js"), "planner", action, "--id", report.planningId, "--workspace", workspace];
    if (action === "review") args.push("--review-id", finalReview.review.reviewId);
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15_000 });
    await writeFile(join(diagnosticDirectory, `cli-${action}.log`), (result.stdout ?? "") + (result.stderr ?? ""), { mode: 0o600 });
    assert.equal(result.status, 0, `planner ${action} 应正常显示产物`);
  }
  const loaded = await loadPlannerConversation(report.planningId, workspace);
  report.draftRevision = loaded.draft.draftRevision;
  report.reviewId = finalReview.review.reviewId;
  await checkpoint("cli-show-check-review");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failedStage = stage;
  report.error = String(error instanceof Error ? error.message : error).replaceAll(process.env.TOKEN_COUPON_PLANNER_API_KEY, "[已隐藏]");
  console.error(JSON.stringify({ status: report.status, stage, error: report.error }));
  process.exitCode = 1;
} finally {
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportFile, workspace }));
}
