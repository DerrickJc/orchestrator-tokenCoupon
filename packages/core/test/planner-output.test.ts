import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeepSeekPlanner, effectiveRequirements, formatPlanner, loadPlannerConversation, MockPlanReviewer,
  replyToPlanner, reviewPlannerDraft, revisePlannerDraft, startPlannerConversation,
} from "../src/index.js";

const roots: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), "planner-output-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const config = { provider: "deepseek" as const, model: "fake", baseUrl: "https://api.deepseek.com" };
const executionDefaults = { runnerId: "mock", mode: "non_interactive" as const, timeoutMs: 3000 };
const plan = (dependsOn = ["implement"]) => ({ schemaVersion: 1, id: "greet-plan", title: "Greeting", tasks: [
  { task: { schemaVersion: 1, id: "implement", title: "Implement", prompt: "Implement greeting and tests", execution: executionDefaults }, dependsOn: [], status: "planned" },
  { task: { schemaVersion: 1, id: "verify", title: "Verify", prompt: "Run tests", execution: executionDefaults }, dependsOn, status: "planned" },
] });
interface Message { role: string; content?: string | null; tool_calls?: unknown[] }
interface Body { messages: Message[]; tools?: unknown[]; response_format?: unknown }
function pending(body: Body): Array<{ messageId: string; content: string }> {
  const system = body.messages[0]!.content!;
  return JSON.parse(/待整理输入：([^\n]+)/.exec(system)![1]!);
}
function draft(body: Body, kind: "requirement" | "operation" | "noise" = "requirement") {
  const sources = pending(body);
  const classificationSource = sources.at(-1)!;
  return { kind: "draft", message: "Prepared plan", plan: plan(), planningAssessment: {
    profile: "general", classification: { rationale: "Generic greeting change", sourceMessageId: classificationSource.messageId, quote: classificationSource.content }, decisions: [],
  }, requirementsUpdate: {
    messageDecisions: sources.map(({ messageId }) => ({ messageId, kind, reason: "Classified current input" })),
    changes: kind === "requirement" ? [{ requirementId: "R-greet", text: "Implement greeting and tests", status: "active", sourceMessageIds: sources.map(({ messageId }) => messageId) }] : [],
  } };
}
function fake(respond: (body: Body, index: number) => Message | Response) {
  const bodies: Body[] = [];
  const planner = new DeepSeekPlanner({ ...config, apiKey: "fake-key", fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    const reply = respond(body, bodies.length - 1);
    return reply instanceof Response ? reply : new Response(JSON.stringify({ choices: [{ finish_reason: reply.tool_calls ? "tool_calls" : "stop", message: reply }] }));
  } });
  return { planner, bodies };
}
const assistant = (value: unknown): Message => ({ role: "assistant", content: JSON.stringify(value) });
const repoList = (): Message => ({ role: "assistant", content: null, tool_calls: [{ id: "list-1", type: "function", function: { name: "repo_list", arguments: "{}" } }] });
async function start(root: string, planner: DeepSeekPlanner) {
  return startPlannerConversation({ workspace: root, request: "Implement greeting and tests", config, executionDefaults, planner });
}

describe("new conversation output and bounded correction", () => {
  it("recovers the logged extra root brace without a new API request and preserves the raw response", async () => {
    const root = await workspace();
    let raw = "";
    const { planner, bodies } = fake((body) => {
      raw = JSON.stringify(draft(body)).replace(',"requirementsUpdate":', '},"requirementsUpdate":');
      return { role: "assistant", content: raw };
    });
    const result = await start(root, planner);
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe("draft_ready");
    expect(bodies).toHaveLength(1);
    const directory = result.snapshot.turns.at(-1)!.artifactDir;
    const response = JSON.parse(await readFile(join(directory, "calls", "0001.response.json"), "utf8"));
    expect(JSON.parse(response.body).choices[0].message.content).toBe(raw);
    const turn = JSON.parse(await readFile(join(directory, "turn.json"), "utf8"));
    expect(turn.events).toContainEqual({ type: "planner.json_repaired", payload: expect.objectContaining({ code: "premature_root_close", field: "requirementsUpdate" }) });
    expect((await loadPlannerConversation(result.snapshot.planningId, root)).draft!.plan).toEqual(result.draft!.plan);
  });

  it("fully validates a recovered candidate and gives a precise missing-kind repair instruction", async () => {
    const root = await workspace();
    const { planner, bodies } = fake((body, index) => {
      if (index === 0) {
        const reply = { ...draft(body), plan: plan(["missing-task"]) };
        return { role: "assistant", content: JSON.stringify(reply).replace(',"requirementsUpdate":', '},"requirementsUpdate":') };
      }
      if (index === 1) { const { kind: _kind, ...reply } = draft(body); return assistant(reply); }
      return assistant(draft(body));
    });
    const result = await start(root, planner);
    expect(result.error).toBeUndefined();
    expect(result.draft!.plan.tasks[1]!.dependsOn).toEqual(["implement"]);
    expect(bodies).toHaveLength(3);
    expect(bodies.slice(1).every((body) => !body.tools)).toBe(true);
    expect(bodies[2]!.messages.some(({ content }) => content?.includes("缺少 kind 字段"))).toBe(true);
    expect(bodies[2]!.messages.filter(({ role }) => role === "system").slice(1).every(({ content }) => !content?.includes("完整 JSON 格式示例"))).toBe(true);
  });

  it.each(["同意", "同意该默认方案", "全部由你完成模拟，技术栈和细节我暂时不关注"])("resolves and reloads pending defaults after contextual authorization: %s", async (answer) => {
    const root = await workspace();
    const values = { language_runtime: "Java 21", web_framework: "Spring Boot", database: "SQLite", documentation: "Markdown", testing: "JUnit", business_rules: "基础 CRUD" };
    const { planner, bodies } = fake((body, index) => {
      const base = draft(body);
      const source = pending(body).at(-1)!;
      // The second response repeats already-authorized questions; the application
      // must request a correction in this turn rather than publish another pending state.
      const pendingPhase = index < 2;
      const decisions = Object.entries(values).map(([decisionId, value]) => pendingPhase
        ? { decisionId, value, status: "pending", rationale: "待确认默认值", question: `是否授权采用${value}作为默认方案？` }
        : { decisionId, value, status: "defaulted", rationale: "用户授权", sourceMessageId: source.messageId, authorizationQuote: source.content });
      const planningAssessment = { profile: "backend_crud", classification: { rationale: "后端 CRUD", sourceMessageId: source.messageId, quote: source.content }, decisions };
      if (pendingPhase) {
        const { plan: _plan, ...reply } = base;
        return assistant({ ...reply, kind: "clarification", questions: ["是否同意这些默认值？"], questionBindings: [{
          questionId: "defaults", displayIndex: 1, decisionIds: Object.keys(values), answerMode: "accept_proposal",
        }], planningAssessment });
      }
      const adopted = plan();
      adopted.tasks[0]!.task.prompt = Object.values(values).join("；");
      return assistant({ ...base, plan: adopted, planningAssessment });
    });
    const initial = await start(root, planner);
    expect(initial.error).toBeUndefined();
    expect(initial.snapshot.status).toBe("collecting");
    expect(formatPlanner(initial)).toContain("具体默认提案（输入‘同意该默认方案’将接受下列值）");
    const result = await replyToPlanner({ planningId: initial.snapshot.planningId, workspace: root, message: answer, planner });
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe("draft_ready");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.tools).toBeUndefined();
    const confirmationTurn = JSON.parse(await readFile(join(result.snapshot.turns.at(-1)!.artifactDir, "turn.json"), "utf8")) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    expect(confirmationTurn.events.some(({ type, payload }) => type === "planner.validation_failed" &&
      /重复询问已接受的决策|重复询问已委托的决策|已获得本轮明确委托或默认提案确认/.test(String(payload.message)))).toBe(true);
    const loaded = await loadPlannerConversation(initial.snapshot.planningId, root);
    expect(loaded.snapshot.planningAssessment!.decisions.every(({ status }) => status === "defaulted")).toBe(true);
    for (const decisionId of Object.keys(values)) {
      expect(loaded.snapshot.requirements!.items.filter(({ requirementId }) => requirementId === "R-decision-" + decisionId).map(({ status }) => status)).toEqual(["superseded", "active"]);
    }
    const firstSystem = bodies[1]!.messages[0]!.content!;
    const sample = JSON.parse(/草案：([^\n]+)/.exec(firstSystem)![1]!);
    expect(sample.planningAssessment.decisions).toEqual([]);
  });

  it("accepts a valid clarification, draft and operation revision directly, preserving requirements", async () => {
    const root = await workspace();
    const { planner, bodies } = fake((body, index) => {
      if (index === 0) {
        const { plan: _plan, ...reply } = draft(body);
        return assistant({ ...reply, kind: "clarification", message: "Confirm the greeting", questions: ["Use Hello?"] });
      }
      return assistant(draft(body, index === 2 ? "operation" : "requirement"));
    });
    const first = await start(root, planner);
    expect(first.error).toBeUndefined();
    expect(first.snapshot.status).toBe("collecting");
    expect(first.snapshot.requirements!.revision).toBe(1);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const second = await replyToPlanner({ ...options, message: "Use Hello", planner });
    expect(second.snapshot.status).toBe("draft_ready");
    await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer() });
    const revised = await revisePlannerDraft({ ...options, planner });
    expect(revised.error).toBeUndefined();
    expect(revised.draftChanged).toBe(false);
    expect(effectiveRequirements(revised.snapshot.requirements!)).toHaveLength(1);
    expect(revised.snapshot.requirements!.items.at(-1)!.revision).toBe(2);
    expect(revised.snapshot.requirements!.messageDecisions.at(-1)!.kind).toBe("operation");
    expect(bodies).toHaveLength(3);
    // A fresh turn can research; a valid candidate avoids an additional final-format request.
    expect(bodies.every((body) => body.tools)).toBe(true);
    expect(bodies[0]!.messages[0]!.content).toContain('"kind":"clarification"');
    expect(bodies[0]!.messages[0]!.content).toContain('"requirementsUpdate"');
  });

  it("repairs missing metadata without repeating tools or losing the previous transcript", async () => {
    const root = await workspace();
    const { planner, bodies } = fake((body, index) => {
      if (index === 0) return repoList();
      if (index === 1) return assistant({ kind: "draft", message: "Prepared", plan: plan() });
      return assistant(draft(body));
    });
    const result = await start(root, planner);
    expect(result.error).toBeUndefined();
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.tools).toBeUndefined();
    expect(bodies[2]!.response_format).toEqual({ type: "json_object" });
    expect(bodies[2]!.messages.some(({ role }) => role === "tool")).toBe(true);
    expect(bodies[2]!.messages.some(({ content }) => content?.includes("必须返回 requirementsUpdate"))).toBe(true);
    const turn = result.snapshot.turns.at(-1)!;
    const artifact = JSON.parse(await readFile(join(turn.artifactDir, "turn.json"), "utf8"));
    expect(artifact.toolCalls).toBe(1);
    expect(artifact.apiRequests).toBe(3);
  });

  it("repairs invalid dependency graphs using full application validation", async () => {
    const root = await workspace();
    const { planner, bodies } = fake((body, index) => assistant({ ...draft(body), plan: index === 0 ? plan(["missing-task"]) : plan() }));
    const result = await start(root, planner);
    expect(result.error).toBeUndefined();
    expect(result.draft!.plan.tasks[1]!.dependsOn).toEqual(["implement"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[1]!.messages.some(({ role, content }) => role === "user" && content?.includes("未通过应用校验"))).toBe(true);
  });

  it("rejects an abstract backend CRUD draft until every critical decision is clarified", async () => {
    const root = await workspace();
    const decisionIds = ["language_runtime", "web_framework", "database", "documentation", "testing", "business_rules"];
    const backendReply = (body: Body, asDraft: boolean) => {
      const source = pending(body).at(-1)!;
      const base = draft(body);
      const { plan: _plan, ...clarification } = base;
      return {
        ...(asDraft ? base : clarification),
        kind: asDraft ? "draft" : "clarification",
        ...(asDraft ? {} : {
          questions: ["请确认语言、框架、数据库、文档深度、测试方式和冲突规则。"],
          questionBindings: [{ questionId: "backend-decisions", displayIndex: 1, decisionIds, answerMode: "provide_value" }],
        }),
        planningAssessment: {
          profile: "backend_crud",
          classification: { rationale: "用户明确要求后端 CRUD", sourceMessageId: source.messageId, quote: source.content },
          decisions: decisionIds.map((decisionId) => ({
            decisionId, value: "尚未确认", status: "pending", rationale: "用户没有给出此实现选择",
            question: "请确认 " + decisionId,
          })),
        },
      };
    };
    const { planner, bodies } = fake((body, index) => assistant(backendReply(body, index === 0)));
    const result = await start(root, planner);
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe("collecting");
    expect(result.snapshot.draftRevision).toBeNull();
    expect(result.snapshot.planningAssessment?.profile).toBe("backend_crud");
    expect(result.snapshot.planningAssessment?.decisions.filter(({ status }) => status === "pending")).toHaveLength(6);
    expect(result.snapshot.requirements?.items.filter(({ requirementId, status }) => requirementId.startsWith("R-decision-") && status === "pending")).toHaveLength(6);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages.some(({ content }) => content?.includes("关键实施决策仍待澄清"))).toBe(true);
  });

  it("resolves pending decision requirements under the same IDs after the user confirms choices", async () => {
    const root = await workspace();
    const decisionValues = {
      language_runtime: "Java 8",
      web_framework: "Spring Boot",
      database: "SQLite",
      documentation: "表结构说明、ER 图和 DDL",
      testing: "JUnit 5",
      business_rules: "基础 CRUD，不做排课冲突校验",
    };
    const answer = "使用 Java 8、Spring Boot、SQLite；交付表结构说明、ER 图和 DDL；用 JUnit 5 测试；范围是基础 CRUD，不做排课冲突校验。";
    const ids = Object.keys(decisionValues) as Array<keyof typeof decisionValues>;
    const { planner } = fake((body, index) => {
      const source = pending(body).at(-1)!;
      const requirementsUpdate = {
        messageDecisions: pending(body).map(({ messageId }) => ({ messageId, kind: "requirement", reason: "用户确认排课实现决策" })),
        changes: [{ requirementId: "R-course-backend", text: source.content, status: "active", sourceMessageIds: [source.messageId] }],
      };
      if (source.content === answer) {
        const prompt = Object.values(decisionValues).join("；");
        const confirmedPlan = plan();
        confirmedPlan.tasks[0]!.task.prompt = prompt;
        requirementsUpdate.changes[0]!.text = source.content;
        return assistant({ kind: "draft", message: "决策已落实", plan: confirmedPlan, planningAssessment: {
          profile: "backend_crud",
          classification: { rationale: "用户确认后端技术与交付范围", sourceMessageId: source.messageId, quote: source.content },
          decisions: ids.map((decisionId) => ({
            decisionId, value: decisionValues[decisionId], status: "confirmed", rationale: "用户在本轮明确确认",
            requirementId: "R-course-backend", sourceMessageId: source.messageId, quote: source.content,
          })),
        }, requirementsUpdate });
      }
      const base = draft(body);
      const assessment = {
          profile: "backend_crud",
          classification: { rationale: "用户明确要求后端 CRUD", sourceMessageId: source.messageId, quote: source.content },
          decisions: ids.map((decisionId) => ({ decisionId, value: "尚未确认", status: "pending", rationale: "用户没有确认此项", question: `请确认 ${decisionId}` })),
      };
      if (index === 0) return assistant({ ...base, planningAssessment: assessment, requirementsUpdate });
      return assistant({ kind: "clarification", message: "需要确认六项实现决策。", questions: ["请确认 Java 版本、框架、数据库、文档、测试和业务规则。"],
        questionBindings: [{ questionId: "backend-decisions", displayIndex: 1, decisionIds: ids, answerMode: "provide_value" }], planningAssessment: assessment, requirementsUpdate });
    });
    const first = await start(root, planner);
    expect(first.snapshot.status).toBe("collecting");
    const pendingIds = first.snapshot.requirements!.items.filter(({ requirementId, status }) => requirementId.startsWith("R-decision-") && status === "pending").map(({ requirementId }) => requirementId);
    expect(pendingIds).toHaveLength(6);

    const confirmed = await replyToPlanner({ planningId: first.snapshot.planningId, workspace: root, message: answer, planner });
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.snapshot.status).toBe("draft_ready");
    for (const requirementId of pendingIds) {
      const versions = confirmed.snapshot.requirements!.items.filter((item) => item.requirementId === requirementId);
      expect(versions.map(({ revision, status }) => ({ revision, status }))).toEqual([{ revision: 1, status: "superseded" }, { revision: 2, status: "active" }]);
    }
  });

  it("reports malformed JSON accurately and stops after two corrections without publishing", async () => {
    const root = await workspace();
    const { planner, bodies } = fake(() => ({ role: "assistant", content: '{"kind":"clarification","message":"Valid message","questions":["Which database?"]}\nrequirementsUpdate:{"changes":[]}' }));
    const result = await start(root, planner);
    expect(result.error).toContain("不是合法 JSON");
    expect(result.error).not.toContain("message 必须");
    expect(result.snapshot.turns.at(-1)!.reasonCode).toBe("planner_invalid_json");
    expect(result.snapshot.requirements).toBeUndefined();
    expect(result.snapshot.draftRevision).toBeNull();
    expect(bodies).toHaveLength(3);
    expect(bodies.slice(1).every((body) => !body.tools)).toBe(true);
  });

  it("keeps maximum research plus corrections within the existing API budget", async () => {
    const root = await workspace();
    const { planner, bodies } = fake((_body, index) => index < 4 ? repoList() : ({ role: "assistant", content: "{broken" }));
    const result = await start(root, planner);
    expect(result.snapshot.turns.at(-1)!.reasonCode).toBe("planner_invalid_json");
    expect(bodies).toHaveLength(7);
    expect(bodies.slice(4).every((body) => !body.tools)).toBe(true);
  });

  it.each([401, 429, 500])("does not treat HTTP %s as a repairable format error", async (status) => {
    const root = await workspace();
    const { planner, bodies } = fake(() => new Response("Rejected", { status }));
    const result = await start(root, planner);
    expect(result.error).toContain("HTTP " + status);
    expect(bodies).toHaveLength(1);
  });

  it.each([
    ["missing message", (body: Body) => ({ ...draft(body), message: undefined }), "planner_invalid_reply", "message 必须是非空文本"],
    ["oversized message", (body: Body) => ({ ...draft(body), message: "a".repeat(16 * 1024 + 1) }), "planner_invalid_reply", "message 超过 16 KiB"],
    ["invented source", (body: Body) => { const reply = draft(body); reply.requirementsUpdate.changes[0]!.sourceMessageIds.push("00000000-0000-0000-0000-000000000000"); return reply; }, "planner_requirements_invalid", "需求记录无效"],
  ] as const)("distinguishes %s from JSON syntax errors", async (_name, makeReply, code, error) => {
    const root = await workspace();
    const { planner, bodies } = fake((body) => assistant(makeReply(body)));
    const result = await start(root, planner);
    expect(result.snapshot.turns.at(-1)!.reasonCode).toBe(code);
    expect(result.error).toContain(error);
    expect(bodies).toHaveLength(3);
  });

  it("marks cancelled history reference-only and rejects its classification during a new turn", async () => {
    const root = await workspace();
    const first = await start(root, fake((body) => assistant(draft(body))).planner);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const controller = new AbortController();
    const cancelledPlanner = new DeepSeekPlanner({ ...config, apiKey: "fake-key", fetchImpl: async () => { controller.abort(); throw new Error("cancelled"); } });
    const cancelled = await replyToPlanner({ ...options, message: "accidental input", signal: controller.signal, planner: cancelledPlanner });
    expect(cancelled.snapshot.turns.at(-1)!.status).toBe("cancelled");
    const cancelledId = cancelled.snapshot.turns.at(-1)!.messageId;
    const { planner, bodies } = fake((body, index) => {
      if (index === 0) return { role: "assistant", content: null, tool_calls: [{ id: "history-1", type: "function", function: { name: "conversation_read", arguments: JSON.stringify({ messageIds: [cancelledId] }) } }] };
      if (index === 1) {
        const reply = draft(body, "operation");
        reply.requirementsUpdate.messageDecisions.push({ messageId: cancelledId, kind: "noise", reason: "Cancelled input" });
        return assistant(reply);
      }
      return assistant(draft(body, "operation"));
    });
    const continued = await replyToPlanner({ ...options, message: "Continue without changing requirements", planner });
    expect(continued.error).toBeUndefined();
    expect(bodies).toHaveLength(3);
    const history = JSON.parse(bodies[1]!.messages.find(({ role }) => role === "tool")!.content!);
    expect(history.messages[0]).toMatchObject({ messageId: cancelledId, classificationAllowed: false });
    expect(bodies[2]!.tools).toBeUndefined();
    expect(continued.snapshot.requirements!.messageDecisions.some(({ messageId }) => messageId === cancelledId)).toBe(false);
    expect(effectiveRequirements(continued.snapshot.requirements!)).toEqual(effectiveRequirements(first.snapshot.requirements!));
  });

  it("distinguishes reports that were not loaded, stale reports and genuine read failures", async () => {
    const root = await workspace();
    const first = await start(root, fake((body) => assistant(draft(body))).planner);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const review = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer() });
    expect(formatPlanner({ snapshot: review.snapshot })).toContain("本次未加载");
    const loaded = await loadPlannerConversation(options.planningId, root);
    expect(formatPlanner(loaded)).toContain("适用于当前草案");
    const changed = await replyToPlanner({ ...options, message: "Also require empty-name tests", planner: fake((body) => assistant(draft(body))).planner });
    expect(changed.error).toBeUndefined();
    expect(formatPlanner(await loadPlannerConversation(options.planningId, root))).toContain("已过期");
    await writeFile(join(root, ".token-coupon", "planners", options.planningId, "reviews", review.review.reviewId, "review.json"), "{broken");
    const failed = await loadPlannerConversation(options.planningId, root);
    expect(failed.reviewReadError).toBeTruthy();
    expect(formatPlanner(failed)).toContain("读取失败");
  });
});
