import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DeepSeekPlanner,
  loadPlannerConversation,
  replyToPlanner,
  runPlan,
  startPlannerConversation,
} from "../packages/core/dist/index.js";

const real = process.argv.includes("--real");
if (real && (!process.env.TOKEN_COUPON_PLANNER_API_KEY || !process.env.TOKEN_COUPON_PLANNER_MODEL)) {
  throw new Error("真实冒烟需要 TOKEN_COUPON_PLANNER_API_KEY 和 TOKEN_COUPON_PLANNER_MODEL");
}

const workspace = resolve("demo-workspace/phase3.5-bugfix-4", `${real ? "real" : "offline"}-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
const report = { mode: real ? "real-deepseek" : "offline-fake", workspace, status: "running", checks: [] };
const config = {
  provider: "deepseek",
  model: real ? process.env.TOKEN_COUPON_PLANNER_MODEL : "offline-fake",
  baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com",
};
const executionDefaults = { runnerId: "mock", mode: "non_interactive" };
const decisions = [
  ["language_runtime", "Java 17"],
  ["web_framework", "Spring Boot 3 + Spring Data JPA"],
  ["database", "SQLite"],
  ["documentation", "Markdown REST 与数据库设计文档"],
  ["testing", "JUnit 5 集成测试"],
  ["business_rules", "课程、教师、班级；不做冲突检测"],
];
const decisionById = new Map(decisions);
const questionSpecs = [
  { questionId: "technology", displayIndex: 1, decisionIds: ["language_runtime", "web_framework", "database", "testing"], answerMode: "accept_proposal", text: "是否采用所列技术提案？" },
  { questionId: "business", displayIndex: 2, decisionIds: ["business_rules"], answerMode: "delegate_choice", text: "是否授权在已说明的简单范围内决定业务细节？" },
  { questionId: "documentation", displayIndex: 3, decisionIds: ["documentation"], answerMode: "delegate_choice", text: "是否授权决定文档的具体结构？" },
];
const request = "设计一个简单的计算机专业排课系统给学生教师使用，不需要前端页面，只需要简单的后端 CRUD，只需要后端逻辑和数据库文档。先写接口文档和数据库设计文档，写完之后进行测试，成功后交付。";

function record(name, details = {}) {
  report.checks.push({ name, ...details });
  console.log(JSON.stringify({ check: name, ...details }));
}

function makeAssessment(source, state, pendingIds = []) {
  const latest = new Map();
  for (const event of state?.events ?? []) for (const id of event.decisionIds) latest.set(id, event);
  return {
    profile: "backend_crud",
    classification: { rationale: "计算机专业排课后端", sourceMessageId: source.messageId, quote: source.content.slice(0, 80) },
    decisions: decisions.map(([decisionId, value]) => {
      const event = latest.get(decisionId);
      if (pendingIds.includes(decisionId)) return {
        decisionId, value, status: "pending", rationale: "等待当前问题的回答", question: `请确认是否采用默认方案：${value}`,
      };
      if (!event) throw new Error(`离线场景没有为 ${decisionId} 保存确认事件`);
      const selected = event.values?.find((item) => item.decisionId === decisionId)?.value ?? value;
      return {
        decisionId, value: selected, status: "defaulted", rationale: "来自当前提案或授权范围内的 Planner 选择",
        sourceMessageId: event.sourceMessageId, authorizationQuote: event.quote,
      };
    }),
  };
}

function offlinePlanner() {
  return {
    id: "deepseek",
    async generate(input, context) {
      const latestUser = input.pendingMessages.at(-1);
      if (!latestUser) throw new Error("离线 Planner 缺少待处理用户消息");
      const original = {
        messageId: input.planningAssessment?.classification.sourceMessageId ?? latestUser.messageId,
        content: input.planningAssessment ? request : latestUser.content,
      };
      const state = input.confirmationState ?? { schemaVersion: 1, activeProposal: null, events: [] };
      const confirmed = new Set(state.events.flatMap(({ decisionIds }) => decisionIds));
      const pendingIds = decisions.map(([id]) => id).filter((id) => !confirmed.has(id));
      let reply;

      if (!state.events.length) {
        reply = {
          kind: "clarification", message: "先确认具体技术提案，并确定业务与文档选择范围。",
          questions: questionSpecs.map(({ text }) => text),
          questionBindings: questionSpecs.map(({ text: _text, ...binding }) => binding),
          planningAssessment: makeAssessment(original, state, decisions.map(([id]) => id)),
          requirementsUpdate: {
            messageDecisions: input.pendingMessages.map(({ messageId }) => ({ messageId, kind: "requirement", reason: "排课系统需求" })),
            changes: [{ requirementId: "R-course-scheduling", text: request, status: "active", sourceMessageIds: [original.messageId] }],
          },
        };
      } else if (pendingIds.length) {
        const remainingQuestions = questionSpecs.filter(({ decisionIds }) => decisionIds.some((id) => pendingIds.includes(id)))
          .map((question, index) => ({ ...question, displayIndex: index + 1, decisionIds: question.decisionIds.filter((id) => pendingIds.includes(id)) }));
        reply = {
          kind: "clarification", message: "已保存已回答的选项，只询问尚未决定的范围。",
          questions: remainingQuestions.map(({ text }) => text),
          questionBindings: remainingQuestions.map(({ text: _text, ...binding }) => binding),
          planningAssessment: makeAssessment(original, state, pendingIds),
          requirementsUpdate: {
            messageDecisions: input.pendingMessages.map(({ messageId }) => ({ messageId, kind: "requirement", reason: "当前消息确认或委托了关键决策" })),
            changes: [],
          },
        };
      } else {
        reply = {
          kind: "draft", message: "提案确认和委托范围已绑定，生成 Plan v2。",
          plan: { schemaVersion: 1, id: "course-scheduling", title: "计算机专业排课后端", tasks: [
            { task: { schemaVersion: 1, id: "docs", title: "编写接口与数据库设计文档", prompt: "为课程、教师和班级整理 REST 接口及关系数据模型，使用 SQLite 保存数据。", execution: input.executionDefaults }, dependsOn: [], status: "planned" },
            { task: { schemaVersion: 1, id: "backend", title: "实现后端 CRUD", prompt: "使用 Spring Boot 3 和 JPA 完成简单后端；按‘先设计一个简单版本’的偏好实现，不加入排课冲突检测。", execution: input.executionDefaults }, dependsOn: ["docs"], status: "planned" },
            { task: { schemaVersion: 1, id: "tests", title: "执行并报告 CRUD 测试", prompt: "使用 JUnit 覆盖课程、教师、班级的基础 CRUD，并按文档接口验证。", execution: input.executionDefaults }, dependsOn: ["backend"], status: "planned" },
          ] },
          planningAssessment: makeAssessment(original, state),
          requirementsUpdate: {
            messageDecisions: input.pendingMessages.map(({ messageId }) => ({ messageId, kind: "requirement", reason: "已核验的确认动作或原始需求" })),
            changes: [],
          },
        };
      }
      return context.validateReply(reply);
    },
  };
}

async function runOffline() {
  const root = join(workspace, "numbered-and-partial");
  await mkdir(root, { recursive: true });
  const planner = offlinePlanner();
  const initial = await startPlannerConversation({ workspace: root, request, config, executionDefaults, planner });
  assert.equal(initial.error, undefined, initial.error);
  assert.equal(initial.snapshot.confirmationState?.activeProposal?.questions.length, 3);

  const first = await replyToPlanner({ planningId: initial.snapshot.planningId, workspace: root, message: "/confirm 1", planner });
  assert.equal(first.error, undefined, first.error);
  assert.equal(first.snapshot.status, "collecting");
  assert.equal(first.snapshot.confirmationState?.events.length, 1);
  assert.equal(first.snapshot.confirmationState?.events[0]?.action, "accept");
  assert.equal(first.snapshot.planningAssessment?.decisions.filter(({ status }) => status === "pending").length, 2);
  assert.equal(first.snapshot.confirmationState?.activeProposal?.questions.length, 2);
  record("partial-confirm-accepts-only-selected-question", {
    acceptedDecisionIds: first.snapshot.confirmationState?.events[0]?.decisionIds,
    stillPending: first.snapshot.planningAssessment?.decisions.filter(({ status }) => status === "pending").map(({ decisionId }) => decisionId),
  });

  const second = await replyToPlanner({ planningId: initial.snapshot.planningId, workspace: root, message: "1.授权，先设计一个简单版本。2.授权", planner });
  assert.equal(second.error, undefined, second.error);
  assert.equal(second.snapshot.status, "draft_ready");
  assert.deepEqual(second.snapshot.confirmationState?.events.map(({ action }) => action), ["accept", "delegate", "delegate"]);
  assert.equal(second.snapshot.requirements?.messageDecisions.find(({ messageId }) => messageId === second.snapshot.messages.at(-2)?.messageId)?.kind, "requirement");
  assert.equal(second.draft?.plan.schemaVersion, 2);
  assert.equal(second.draft?.plan.decisionContext?.decisions.length, decisions.length);
  assert.ok(second.draft?.plan.tasks.every(({ decisionRefs }) => decisionRefs?.length === decisions.length));
  assert.equal(second.draft?.plan.tasks.some(({ task }) => task.prompt.includes("Spring Boot 3 + Spring Data JPA")), false);
  assert.equal(second.draft?.plan.decisionContext?.decisions.find(({ decisionId }) => decisionId === "business_rules")?.preference, "先设计一个简单版本");

  const observedPrompts = [];
  const runner = {
    id: "mock", supportsModel: false, async checkAvailable() {},
    async run(input, context) {
      observedPrompts.push(input.prompt);
      context.onStarted();
      context.onOutput({ stream: "stdout", text: `${input.completionMarker}\n`, agentText: `${input.completionMarker}\n` });
      return { started: true, exitCode: 0, signal: null };
    },
  };
  const execution = await runPlan({ plan: second.draft.plan, workspace: root, createRunner: () => runner });
  assert.equal(execution.snapshot.status, "succeeded");
  assert.equal(observedPrompts.length, 3);
  for (const prompt of observedPrompts) {
    assert.match(prompt, /Java 17/);
    assert.match(prompt, /SQLite/);
    assert.match(prompt, /Spring Data JPA/);
  }
  assert.ok(observedPrompts[1]?.includes("先设计一个简单版本"));
  const reloaded = await loadPlannerConversation(initial.snapshot.planningId, root);
  assert.deepEqual(reloaded.snapshot.confirmationState?.events.map(({ action }) => action), ["accept", "delegate", "delegate"]);
  const attempt = execution.snapshot.tasks[0].attempts[0];
  const eventLines = (await readFile(join(attempt.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(eventLines.some(({ type, payload }) => type === "attempt.decision_context" && payload.decisionIds.length === decisions.length));
  record("numbered-answer-delegation-and-runner-context", {
    planningId: second.snapshot.planningId, status: second.snapshot.status, planSchemaVersion: second.draft.plan.schemaVersion,
    actions: second.snapshot.confirmationState?.events.map(({ action }) => action), sessionStatus: execution.snapshot.status,
    runnerPrompts: observedPrompts.length, attemptId: attempt.attemptId,
  });
}

async function runReal() {
  const root = join(workspace, "request-replay");
  await mkdir(root, { recursive: true });
  const planner = new DeepSeekPlanner({ model: config.model, baseUrl: config.baseUrl });
  const initial = await startPlannerConversation({ workspace: root, request, config, executionDefaults, planner });
  if (initial.error) throw new Error(`真实初始澄清失败：${initial.error}`);
  const proposal = initial.snapshot.confirmationState?.activeProposal;
  if (!proposal) throw new Error("真实回复没有生成带问题关联的确认提案");
  const answer = proposal.questions.map(({ displayIndex, answerMode }) => {
    if (answerMode === "accept_proposal") return `${displayIndex}.采用`;
    if (answerMode === "delegate_choice") return `${displayIndex}.授权，先设计一个简单版本`;
    return `${displayIndex}.授权由你决定`;
  }).join("。");
  const result = await replyToPlanner({ planningId: initial.snapshot.planningId, workspace: root, message: answer, planner });
  if (result.error) throw new Error(`真实编号确认后未能生成草案：${result.error}`);
  assert.equal(result.snapshot.status, "draft_ready");
  assert.equal(result.draft?.plan.schemaVersion, 2);
  assert.equal(result.snapshot.planningAssessment?.decisions.some(({ status }) => status === "pending"), false);
  record("real-numbered-confirmation-and-delegation", {
    planningId: result.snapshot.planningId, proposalId: proposal.proposalId, questions: proposal.questions.length,
    actions: result.snapshot.confirmationState?.events.map(({ action }) => action), planSchemaVersion: result.draft.plan.schemaVersion,
    draftRevision: result.draft.draftRevision,
  });
}

try {
  if (real) await runReal();
  else await runOffline();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  const key = process.env.TOKEN_COUPON_PLANNER_API_KEY;
  report.error = error instanceof Error ? error.message : String(error);
  if (key) report.error = report.error.replaceAll(key, "[已隐藏]");
  console.error(JSON.stringify({ status: report.status, error: report.error }));
  process.exitCode = 1;
} finally {
  const reportFile = join(workspace, "bugfix-4-demo-report.json");
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportFile }));
}
