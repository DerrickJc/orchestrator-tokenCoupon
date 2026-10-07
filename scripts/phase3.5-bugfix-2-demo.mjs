import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DeepSeekPlanner,
  MockPlanReviewer,
  MockPlanner,
  executeTask,
  reviewPlannerDraft,
  startPlannerConversation,
} from "../packages/core/dist/index.js";

const workspace = resolve("demo-workspace/phase3.5-bugfix-2", `offline-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
const report = { mode: "offline-fakes", workspace, status: "running", checks: [] };

function record(name, details = {}) {
  report.checks.push({ name, ...details });
  console.log(JSON.stringify({ check: name, ...details }));
}

function apiResponse(content) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
}

function pendingMessages(body) {
  const system = body.messages.find(({ role }) => role === "system").content;
  const match = /待整理输入：([^\n]+)/.exec(system);
  assert.ok(match, "规划请求应包含待整理输入");
  return JSON.parse(match[1]);
}

try {
  // A: timeoutMs remains readable as legacy metadata, but does not stop an Attempt.
  const slowTask = {
    schemaVersion: 1,
    id: "legacy-timeout-demo",
    title: "等待超过历史超时值的任务",
    prompt: "演示运行超过历史 timeoutMs 后仍可正常完成。",
    execution: { runnerId: "demo", mode: "non_interactive", timeoutMs: 5 },
  };
  const slowRunner = {
    id: "demo",
    supportsModel: false,
    async checkAvailable() {},
    async run(input, context) {
      context.onStarted();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
      context.onOutput({ stream: "stdout", text: `${input.completionMarker}\n`, agentText: `${input.completionMarker}\n` });
      return { started: true, exitCode: 0, signal: null };
    },
  };
  const slowRun = await executeTask({ task: slowTask, cwd: workspace, runner: slowRunner });
  assert.equal(slowRun.attempt.status, "succeeded");
  assert.equal(slowRun.attempt.executionPolicy.mode, "idle_notice");
  assert.equal(slowRun.attempt.executionPolicy.idleAfterMs, 60_000);
  record("legacy-timeout-is-advisory-only", { elapsedMs: 35, attemptId: slowRun.attempt.attemptId, status: slowRun.attempt.status, executionPolicy: slowRun.attempt.executionPolicy });

  // B: a backend CRUD draft with unresolved implementation choices is corrected into clarification.
  const decisionIds = ["language_runtime", "web_framework", "database", "documentation", "testing", "business_rules"];
  const executionDefaults = { runnerId: "mock", mode: "non_interactive" };
  const plan = { schemaVersion: 1, id: "course-planner", title: "排课后端", tasks: [
    { task: { schemaVersion: 1, id: "implement", title: "实现后端", prompt: "实现排课后端 CRUD。", execution: executionDefaults }, dependsOn: [], status: "planned" },
    { task: { schemaVersion: 1, id: "verify", title: "验证后端", prompt: "运行后端测试并报告结果。", execution: executionDefaults }, dependsOn: ["implement"], status: "planned" },
  ] };
  const pendingAssessment = (source) => ({
    profile: "backend_crud",
    classification: { rationale: "用户要求后端 CRUD", sourceMessageId: source.messageId, quote: source.content },
    decisions: decisionIds.map((decisionId) => ({
      decisionId, value: "尚未确认", status: "pending", rationale: "请求没有指定此实现决策", question: `请确认 ${decisionId}`,
    })),
  });
  const pendingPlanner = new DeepSeekPlanner({
    model: "offline-fake", baseUrl: "https://api.deepseek.com", apiKey: "offline-fake",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const source = pendingMessages(body).at(-1);
      const requirementsUpdate = {
        messageDecisions: pendingMessages(body).map(({ messageId }) => ({ messageId, kind: "requirement", reason: "用户提出排课后端需求" })),
        changes: [{ requirementId: "R-course-backend", text: source.content, status: "active", sourceMessageIds: [source.messageId] }],
      };
      const assessment = pendingAssessment(source);
      const response = body.tools
        ? { kind: "draft", message: "抽象计划", plan, requirementsUpdate, planningAssessment: assessment }
        : { kind: "clarification", message: "需要先确认实现边界。", questions: ["请授权 Planner 在排课后端范围内选择语言、框架、数据库、文档、测试与业务规则。"],
          questionBindings: [{ questionId: "implementation-scope", displayIndex: 1, decisionIds, answerMode: "delegate_choice" }], requirementsUpdate, planningAssessment: assessment };
      return apiResponse(JSON.stringify(response));
    },
  });
  const planning = await startPlannerConversation({
    workspace, request: "设计一个简单的计算机专业排课系统，只需后端 CRUD；技术栈和文档细节尚未确定。",
    config: { provider: "deepseek", model: "offline-fake", baseUrl: "https://api.deepseek.com" },
    executionDefaults, planner: pendingPlanner,
  });
  assert.equal(planning.error, undefined);
  assert.equal(planning.snapshot.status, "collecting");
  assert.equal(planning.snapshot.draftRevision, null);
  assert.equal(planning.snapshot.planningAssessment.decisions.filter(({ status }) => status === "pending").length, 6);
  record("missing-critical-decisions-return-clarification", { planningId: planning.snapshot.planningId, pendingDecisions: 6, draftRevision: null });

  // C: an incomplete F4 resolution is repaired within the same review and keeps its issue identity.
  const reviewStart = await startPlannerConversation({
    workspace, request: "Use MySQL for the small demo.",
    config: { provider: "mock", model: "mock", baseUrl: "mock://local" },
    executionDefaults, planner: new MockPlanner(),
  });
  const reviewOptions = { planningId: reviewStart.snapshot.planningId, workspace };
  const priorFindings = ["F1", "F2", "F3", "F4", "F5"].map((findingId) => ({
    findingId, severity: findingId === "F4" ? "info" : "warning", category: "dependency", taskIds: ["verify-request"],
    description: `Prior issue ${findingId}`, basis: "Prior report evidence", suggestion: "Keep this item tracked.",
  }));
  const prior = await reviewPlannerDraft({ ...reviewOptions, reviewer: new MockPlanReviewer({ summary: "Prior review", findings: priorFindings }) });
  const f4 = prior.review.findings.find(({ findingId }) => findingId === "F4");
  const incomplete = {
    summary: "F4 remains informational and tracked",
    findings: [{ findingId: "F4", severity: "info", category: "dependency", taskIds: ["verify-request"], description: f4.description, basis: f4.basis, suggestion: f4.suggestion, priorFindingId: "F4" }],
    resolutions: ["F1", "F2", "F3", "F5"].map((findingId) => ({ findingId, status: "resolved", basis: `Plan addresses ${findingId}` })),
  };
  const complete = {
    ...incomplete,
    resolutions: ["F1", "F2", "F3", "F4", "F5"].map((findingId) => ({
      findingId, status: findingId === "F4" ? "unresolved" : "resolved",
      basis: findingId === "F4" ? "The informational recommendation remains tracked." : `Plan addresses ${findingId}`,
    })),
  };
  const reviewBodies = [];
  const replies = ["Research complete", JSON.stringify(incomplete), JSON.stringify(complete)];
  const reviewer = new DeepSeekPlanner({
    model: "offline-fake", baseUrl: "https://api.deepseek.com", apiKey: "offline-fake",
    fetchImpl: async (_url, init) => {
      reviewBodies.push(JSON.parse(String(init.body)));
      return apiResponse(replies.shift());
    },
  });
  const repaired = await reviewPlannerDraft({ ...reviewOptions, reviewer });
  assert.equal(repaired.review.status, "succeeded");
  assert.equal(repaired.review.resolutions.length, 5);
  assert.equal(repaired.review.resolutions.find(({ findingId }) => findingId === "F4").status, "unresolved");
  assert.equal(repaired.review.resolutions.find(({ findingId }) => findingId === "F4").issueId, f4.issueId);
  assert.equal(reviewBodies.length, 3);
  assert.ok(reviewBodies.slice(1).every(({ tools }) => tools === undefined), "格式修正阶段不得再次调用工具");
  assert.ok(JSON.stringify(reviewBodies[2].messages).includes("遗漏：F4"));
  record("same-review-repairs-missing-F4", { reviewId: repaired.review.reviewId, requests: reviewBodies.length, resolutionCount: repaired.review.resolutions.length, f4IssueId: f4.issueId });

  report.status = "passed";
  report.artifacts = { idleAttempt: slowRun.artifactDir, workspace };
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: report.status, error: report.error }));
  process.exitCode = 1;
} finally {
  const reportFile = join(workspace, "bugfix-2-demo-report.json");
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportFile }));
}
