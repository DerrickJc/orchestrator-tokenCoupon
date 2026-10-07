import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommittedConfirmations, makeConfirmationProposal, parseConfirmationInput } from "../src/confirmation.js";
import { approvePlannerDraft, loadPlannerConversation, replyToPlanner, startPlannerConversation } from "../src/planner-conversation.js";
import { reviewPlannerDraft } from "../src/plan-review.js";
import type { Planner, PlannerContext, PlannerReply, PlanningAssessment, PlannerInput } from "../src/planner-types.js";
import type { PlanDefinition } from "../src/plan.js";
import type { Runner, RunnerInput } from "../src/runner.js";
import { runPlan } from "../src/task-orchestrator.js";
import { canonicalHash } from "../src/planner-store.js";
import { reviewerConfigHash } from "../src/plan-review.js";
import { DeepSeekPlanner } from "../src/planners/deepseek-planner.js";
import { MockRunner } from "../src/runners/mock-runner.js";

const roots: string[] = [];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function workspace() { const root = await mkdtemp(join(tmpdir(), "token-coupon-bugfix4-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const decisionIds = ["language_runtime", "web_framework", "database", "documentation", "testing", "business_rules"] as const;
const values = ["Java 17", "Spring Boot 3 + Spring Data JPA", "SQLite", "Markdown REST 与数据库设计文档", "JUnit 5 集成测试", "课程、教师、班级；不做冲突检测"];
const proposalQuestions = [
  "是否采用所列技术方案？",
  "是否授权自行决定数据模型与业务细节？",
  "是否授权自行确定文档形式？",
];
function assessment(messageId: string, message: string, statuses: Array<"pending" | "defaulted"> = decisionIds.map(() => "pending")) : PlanningAssessment {
  return {
    profile: "backend_crud",
    classification: { rationale: "用户提出后端排课系统需求", sourceMessageId: messageId, quote: message.slice(0, Math.min(message.length, 80)) },
    decisions: decisionIds.map((decisionId, index) => ({
      decisionId, value: values[index]!, status: statuses[index]!, rationale: "当前方案中的规划决策",
      ...(statuses[index] === "pending" ? { question: `是否授权采用${values[index]}作为默认方案？` } :
        { sourceMessageId: messageId, authorizationQuote: message }),
    })),
  };
}

function clarification(input: PlannerInput): PlannerReply {
  const message = input.pendingMessages!.at(-1)!;
  return {
    kind: "clarification", message: "请确认技术提案，并授权 Planner 选择业务和文档细节。", questions: proposalQuestions,
    questionBindings: [
      { questionId: "technology", displayIndex: 1, decisionIds: ["language_runtime", "web_framework", "database", "testing"], answerMode: "accept_proposal" },
      { questionId: "business", displayIndex: 2, decisionIds: ["business_rules"], answerMode: "delegate_choice" },
      { questionId: "docs", displayIndex: 3, decisionIds: ["documentation"], answerMode: "delegate_choice" },
    ],
    planningAssessment: assessment(message.messageId, message.content),
    requirementsUpdate: {
      messageDecisions: input.pendingMessages!.map(({ messageId }) => ({ messageId, kind: "requirement", reason: "排课系统业务需求" })),
      changes: [{ requirementId: "R-course-system", text: "实现排课系统后端 CRUD，先产出接口和数据库文档，再测试交付", status: "active", sourceMessageIds: input.pendingMessages!.map(({ messageId }) => messageId) }],
    },
  };
}

function draftReply(input: PlannerInput): PlannerReply {
  const message = input.pendingMessages!.at(-1)!;
  const plan: PlanDefinition = { schemaVersion: 1, id: "course-plan", title: "排课后端", tasks: [
    { task: { schemaVersion: 1, id: "docs", title: "编写接口和数据库文档", prompt: "编写接口和数据库设计文档。", execution: input.executionDefaults }, dependsOn: [], status: "planned" },
    { task: { schemaVersion: 1, id: "implementation", title: "实现 CRUD 并测试", prompt: "实现简单后端 CRUD 并运行测试。", execution: input.executionDefaults }, dependsOn: ["docs"], status: "planned" },
  ] };
  return {
    kind: "draft", message: "已按确认范围形成计划。", plan,
    planningAssessment: assessment(message.messageId, message.content, decisionIds.map(() => "defaulted")),
    requirementsUpdate: {
      messageDecisions: input.pendingMessages!.map(({ messageId }) => ({ messageId, kind: "operation", reason: "此轮回答的是已展示的决策问题" })),
      changes: [],
    },
  };
}

function scriptedPlanner(): Planner & { inputs: PlannerInput[] } {
  const inputs: PlannerInput[] = [];
  return {
    id: "deepseek", inputs,
    async generate(input, context) {
      inputs.push(input);
      const reply = input.confirmationState?.events.length ? draftReply(input) : clarification(input);
      return context.validateReply!(reply);
    },
  };
}

describe("structured confirmation and decision context", () => {
  it("versions Plan v2 semantic review without changing the Plan v1 review hash", () => {
    const config = { provider: "deepseek" as const, model: "deepseek-flash", baseUrl: "https://api.deepseek.com" };
    expect(reviewerConfigHash(config, 1, false)).toBe(canonicalHash({ ...config, reviewPromptVersion: 2 }));
    expect(reviewerConfigHash(config, 1, true)).toBe(canonicalHash({ ...config, reviewPromptVersion: 3 }));
    expect(reviewerConfigHash(config, 2)).toBe(canonicalHash({ ...config, reviewPromptVersion: 4 }));
    expect(reviewerConfigHash(config, 2)).not.toBe(reviewerConfigHash(config, 1));
  });

  it("tells the v2 Reviewer to assess the selected values semantically", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const reviewer = new DeepSeekPlanner({ model: "offline-fake", baseUrl: "https://example.test", apiKey: "fake", fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ summary: "Reviewed", findings: [] }) } }] }));
    } });
    const context: PlannerContext = {
      signal: new AbortController().signal,
      repository: { invoke: async () => "{}" } as unknown as PlannerContext["repository"],
      consumeApiRequest: () => 1,
      consumeToolCall() {},
      async record() {},
    };
    await reviewer.review({ requirements: [], executionDefaults: { runnerId: "mock", mode: "non_interactive" }, plan: {
      schemaVersion: 2, id: "plan", title: "Plan", tasks: [], decisionContext: { schemaVersion: 1, decisions: [], globalDecisionIds: [] },
    } }, context);
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("decisionContext 是所选值的规范记录");
    expect(messages[0]?.content).toContain("语义一致的正常改写可以通过");
  });

  it("parses the numbered accept/delegate answer by each question mode", () => {
    const input = "1.采用.2.授权，先设计一个简单版本。3.授权";
    const reply = clarification({ pendingMessages: [{ messageId: uuid(1), role: "user", content: "initial" }] } as PlannerInput);
    const pending = reply.planningAssessment!.decisions;
    const proposal = {
      schemaVersion: 1 as const, proposalId: uuid(20), revision: 1, hash: "a".repeat(64), sourceMessageId: uuid(2),
      questions: reply.questionBindings!.map((binding) => ({ ...binding, text: proposalQuestions[binding.displayIndex - 1]! })),
      candidates: pending.map((item) => ({ decisionId: item.decisionId, value: item.value, concrete: true })), createdAt: new Date().toISOString(),
    };
    const events = parseConfirmationInput(input, uuid(3), { schemaVersion: 1, activeProposal: proposal, events: [] })!;
    expect(events.map(({ action }) => action)).toEqual(["accept", "delegate", "delegate"]);
    expect(events[1]?.preference).toContain("先设计一个简单版本");
    expect(events[0]?.values).toHaveLength(4);
  });

  it("commits confirmation independently, promotes a misclassified answer, and binds selected values to a runnable v2 plan", async () => {
    const root = await workspace();
    const planner = scriptedPlanner();
    const initialText = "设计一个简单排课系统，提供后端 CRUD，先写接口和数据库文档，再测试交付";
    const started = await startPlannerConversation({ workspace: root, request: initialText,
      config: { provider: "deepseek", model: "fake", baseUrl: "https://example.test" },
      executionDefaults: { runnerId: "mock", mode: "non_interactive" }, planner });
    expect(started.error).toBeUndefined();
    expect(started.snapshot.confirmationState?.activeProposal?.questions).toHaveLength(3);

    const answer = "1.采用.2.授权，先设计一个简单版本。3.授权";
    const completed = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: answer, planner });
    expect(completed.error).toBeUndefined();
    expect(completed.snapshot.status).toBe("draft_ready");
    expect(completed.snapshot.confirmationState?.events.map(({ action }) => action)).toEqual(["accept", "delegate", "delegate"]);
    expect((await loadPlannerConversation(started.snapshot.planningId, root)).snapshot.confirmationState?.events).toHaveLength(3);
    expect(completed.snapshot.requirements?.messageDecisions.find(({ messageId }) => messageId === completed.snapshot.messages.at(-2)?.messageId)?.kind).toBe("requirement");
    expect(completed.draft?.plan.schemaVersion).toBe(2);
    expect(completed.draft?.plan.decisionContext?.decisions.map(({ value }) => value)).toEqual(values);
    expect(completed.draft?.plan.tasks.every(({ decisionRefs }) => decisionRefs?.length === values.length)).toBe(true);
    expect(completed.draft?.plan.tasks.some(({ task }) => task.prompt.includes("Spring Boot 3 + Spring Data JPA"))).toBe(false);

    const observedPrompts: string[] = [];
    const runner: Runner = {
      id: "mock", supportsModel: false, checkAvailable: async () => undefined,
      async run(input: RunnerInput, context) {
        observedPrompts.push(input.prompt);
        context.onStarted();
        context.onOutput({ stream: "stdout", text: input.completionMarker, agentText: input.completionMarker });
        return { started: true, exitCode: 0, signal: null };
      },
    };
    const run = await runPlan({ plan: completed.draft!.plan, workspace: root, createRunner: () => runner });
    expect(run.snapshot.status).toBe("succeeded");
    expect(observedPrompts).toHaveLength(2);
    expect(observedPrompts[0]).toContain("Java 17");
    expect(observedPrompts[0]).toContain("SQLite");
    expect(observedPrompts[1]).toContain("先设计一个简单版本");
    const attempt = run.snapshot.tasks[0]!.attempts[0]!;
    const eventLines = (await readFile(join(attempt.artifactDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(eventLines.map((line) => JSON.parse(line).type)).toContain("attempt.decision_context");
  });

  it("interprets a global authorization according to the displayed question modes", () => {
    const reply = clarification({ pendingMessages: [{ messageId: uuid(1), role: "user", content: "initial" }] } as PlannerInput);
    const proposal = {
      schemaVersion: 1 as const, proposalId: uuid(20), revision: 1, hash: "a".repeat(64), sourceMessageId: uuid(2),
      questions: reply.questionBindings!.map((binding) => ({ ...binding, text: proposalQuestions[binding.displayIndex - 1]! })),
      candidates: reply.planningAssessment!.decisions.map((item) => ({ decisionId: item.decisionId, value: item.value, concrete: true })), createdAt: new Date().toISOString(),
    };
    expect(parseConfirmationInput("全部授权", uuid(4), { schemaVersion: 1, activeProposal: proposal, events: [] })?.map(({ action }) => action))
      .toEqual(["accept", "delegate", "delegate"]);
    expect(() => parseConfirmationInput("/confirm all", uuid(5), { schemaVersion: 1, activeProposal: proposal, events: [] }))
      .toThrow("没有可直接接受的具体提案");
    expect(parseConfirmationInput("/reject 2", uuid(6), { schemaVersion: 1, activeProposal: proposal, events: [] })?.[0]?.action).toBe("reject");
    expect(parseConfirmationInput("/delegate 1", uuid(7), { schemaVersion: 1, activeProposal: proposal, events: [] })?.[0]?.action).toBe("delegate");
  });

  it("records a user-supplied replacement value against only its bound decision", () => {
    const sourceId = uuid(30);
    const original = clarification({ pendingMessages: [{ messageId: sourceId, role: "user", content: "initial" }] } as PlannerInput);
    const reply: PlannerReply = {
      ...original,
      questions: ["数据库使用哪一种？"],
      questionBindings: [{ questionId: "database", displayIndex: 1, decisionIds: ["database"], answerMode: "provide_value" }],
      planningAssessment: {
        ...original.planningAssessment!,
        decisions: [{ decisionId: "database", value: "尚未指定", status: "pending", rationale: "等待具体值", question: "请选择数据库" }],
      },
    };
    const proposal = makeConfirmationProposal(reply, uuid(31), 1)!;
    const state = { schemaVersion: 1 as const, activeProposal: proposal, events: [] };
    const events = parseConfirmationInput("1.改为 PostgreSQL", uuid(32), state)!;
    expect(events).toMatchObject([{ action: "provide_value", decisionIds: ["database"], values: [{ decisionId: "database", value: "PostgreSQL" }] }]);
  });

  it("allows explicit delegation for a question that originally asked the user to provide a value", () => {
    const proposal = {
      schemaVersion: 1 as const, proposalId: uuid(36), revision: 1, hash: "a".repeat(64), sourceMessageId: uuid(37),
      questions: [{ questionId: "database", displayIndex: 1, text: "请选择数据库", decisionIds: ["database" as const], answerMode: "provide_value" as const }],
      candidates: [{ decisionId: "database" as const, value: "未指定", concrete: false }], createdAt: new Date().toISOString(),
    };
    const events = parseConfirmationInput("1.授权由你决定", uuid(38), { schemaVersion: 1, activeProposal: proposal, events: [] })!;
    expect(events).toMatchObject([{ action: "delegate", decisionIds: ["database"] }]);
  });

  it("turns an explicit decision revocation into a pending choice", () => {
    const answer = "1.采用.2.授权.3.授权";
    const source = uuid(45);
    const clarified = clarification({ pendingMessages: [{ messageId: source, role: "user", content: "initial" }] } as PlannerInput);
    const proposal = {
      schemaVersion: 1 as const, proposalId: uuid(46), revision: 1, hash: "a".repeat(64), sourceMessageId: uuid(47),
      questions: clarified.questionBindings!.map((binding) => ({ ...binding, text: proposalQuestions[binding.displayIndex - 1]! })),
      candidates: clarified.planningAssessment!.decisions.map((item) => ({ decisionId: item.decisionId, value: item.value, concrete: true })), createdAt: new Date().toISOString(),
    };
    const accepted = parseConfirmationInput(answer, uuid(48), { schemaVersion: 1, activeProposal: proposal, events: [] })!;
    const acceptedState = { schemaVersion: 1 as const, activeProposal: null, events: accepted };
    const revoked = parseConfirmationInput("/revoke database", uuid(49), acceptedState)!;
    const assessment = { ...clarified.planningAssessment!, decisions: clarified.planningAssessment!.decisions.map((item) => ({
      ...item, status: "defaulted" as const, sourceMessageId: accepted.find((event) => event.decisionIds.includes(item.decisionId))!.sourceMessageId,
      authorizationQuote: answer,
    })) };
    const updated = applyCommittedConfirmations(assessment, { ...acceptedState, events: [...accepted, ...revoked] }, [uuid(49)]);
    expect(revoked).toMatchObject([{ action: "revoke", decisionIds: ["database"] }]);
    expect(updated.decisions.find(({ decisionId }) => decisionId === "database")).toMatchObject({ status: "pending", rationale: "用户撤回了此前的决策授权" });
  });

  it("requires a concrete default proposal to use the accept_proposal answer mode", () => {
    const sourceId = uuid(40);
    const reply = clarification({ pendingMessages: [{ messageId: sourceId, role: "user", content: "initial" }] } as PlannerInput);
    const inconsistent: PlannerReply = {
      ...reply,
      questions: ["可选建议：SQLite，请确认或指定其他方案。"],
      questionBindings: [{ questionId: "database", displayIndex: 1, decisionIds: ["database"], answerMode: "provide_value" }],
      planningAssessment: {
        ...reply.planningAssessment!,
        decisions: [{ decisionId: "database", value: "SQLite", status: "pending", rationale: "建议默认值", question: "是否授权采用 SQLite 作为默认方案？" }],
      },
    };
    expect(() => makeConfirmationProposal(inconsistent, uuid(41), 1)).toThrow("回答模式应为 accept_proposal");
  });

  it("keeps a confirmation after the subsequent Planner call fails", async () => {
    const root = await workspace();
    const firstPlanner = scriptedPlanner();
    const initialText = "设计排课后端，先交文档再测试";
    const started = await startPlannerConversation({ workspace: root, request: initialText,
      config: { provider: "deepseek", model: "fake", baseUrl: "https://example.test" },
      executionDefaults: { runnerId: "mock", mode: "non_interactive" }, planner: firstPlanner });
    expect(started.error).toBeUndefined();
    const failedPlanner: Planner = { id: "deepseek", async generate() { throw new Error("simulated planner outage"); } };
    const confirmation = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: "全部授权", planner: failedPlanner });
    expect(confirmation.error).toContain("simulated planner outage");
    expect(confirmation.snapshot.confirmationState?.events).toHaveLength(3);
    expect((await loadPlannerConversation(started.snapshot.planningId, root)).snapshot.confirmationState?.events).toHaveLength(3);
  });

  it("rejects a repeated clarification even when the Planner resubmits the already accepted question", async () => {
    const root = await workspace();
    let calls = 0;
    const planner: Planner = {
      id: "deepseek",
      async generate(input, context) {
        calls += 1;
        return context.validateReply!(clarification(input));
      },
    };
    const started = await startPlannerConversation({ workspace: root, request: "排课后端 CRUD", config: { provider: "deepseek", model: "fake", baseUrl: "https://example.test" },
      executionDefaults: { runnerId: "mock", mode: "non_interactive" }, planner });
    expect(started.error).toBeUndefined();
    const repeated = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: "/confirm 1", planner });
    expect(repeated.error).toContain("重复询问已接受的决策");
    expect(calls).toBe(4); // one initial reply, then the bounded two repairs plus final failed attempt
    expect(repeated.snapshot.confirmationState?.events).toHaveLength(1);
    expect((await loadPlannerConversation(started.snapshot.planningId, root)).snapshot.confirmationState?.events).toHaveLength(1);
  });

  it("revokes one selected decision and clears an existing approval", async () => {
    const root = await workspace();
    const base = scriptedPlanner();
    const planner: Planner = {
      id: "deepseek",
      async generate(input, context) {
        const latest = input.pendingMessages?.at(-1);
        if (latest?.content === "/revoke database") {
          const decisions = input.planningAssessment!.decisions.map((decision) => decision.decisionId === "database"
            ? { decisionId: "database" as const, value: "未指定", status: "pending" as const, rationale: "撤回后需要重新确认", question: "请选择新的数据库方案" }
            : decision);
          return context.validateReply!({
            kind: "clarification", message: "数据库决策已撤回，需要重新确认。", questions: ["请选择新的数据库方案"],
            questionBindings: [{ questionId: "database", displayIndex: 1, decisionIds: ["database"], answerMode: "provide_value" }],
            planningAssessment: { ...input.planningAssessment!, decisions },
            requirementsUpdate: { messageDecisions: input.pendingMessages!.map(({ messageId }) => ({ messageId, kind: "requirement", reason: "用户撤回决策授权" })), changes: [] },
          });
        }
        return base.generate(input, context);
      },
    };
    const started = await startPlannerConversation({ workspace: root, request: "设计简单排课系统", config: { provider: "deepseek", model: "fake", baseUrl: "https://example.test" },
      executionDefaults: { runnerId: "mock", mode: "non_interactive" }, planner });
    expect(started.error).toBeUndefined();
    const completed = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: "1.采用.2.授权.3.授权", planner });
    expect(completed.snapshot.status).toBe("draft_ready");
    const review = await reviewPlannerDraft({ planningId: started.snapshot.planningId, workspace: root,
      reviewer: { async review() { return { summary: "No blocking findings", findings: [] }; } } });
    const approved = await approvePlannerDraft({ planningId: started.snapshot.planningId, workspace: root, draftRevision: completed.draft!.draftRevision, reviewId: review.review.reviewId });
    expect(approved.snapshot.approval).toBeDefined();

    const revoked = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: "/revoke database", planner });
    expect(revoked.error).toBeUndefined();
    expect(revoked.snapshot.status).toBe("collecting");
    expect(revoked.snapshot.approval).toBeNull();
    expect(revoked.snapshot.confirmationState?.events.at(-1)).toMatchObject({ action: "revoke", decisionIds: ["database"] });
    expect(revoked.snapshot.planningAssessment?.decisions.find(({ decisionId }) => decisionId === "database")?.status).toBe("pending");
    expect(revoked.snapshot.confirmationState?.activeProposal?.questions[0]?.decisionIds).toEqual(["database"]);
  });
});
