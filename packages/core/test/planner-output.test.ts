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
  return { kind: "draft", message: "Prepared plan", plan: plan(), requirementsUpdate: {
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
