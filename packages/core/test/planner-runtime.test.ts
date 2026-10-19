import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { MockPlanner, MockPlanReviewer, PlannerInvocationError, startPlannerConversation, reviewPlannerDraft } from "../src/index.js";
import type { PlannerContext, PlannerInput } from "../src/planner-types.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function workspace() { const root = await mkdtemp(join(tmpdir(), "tc-planner-runtime-")); roots.push(root); return root; }
async function reply(input: PlannerInput, context: PlannerContext) {
  const value: any = await new MockPlanner().generate(input, context), message = input.pendingMessages!.at(-1)!;
  value.planningAssessment = { schemaVersion: 2, profile: "general", classification: { rationale: "简单问候函数", sourceMessageId: message.messageId, quote: message.content }, decisions: [] };
  value.requirementsUpdate = { messageDecisions: [{ messageId: message.messageId, kind: "requirement", reason: "业务需求" }], changes: [{ requirementId: "R-greet", text: message.content, status: "active", sourceMessageIds: [message.messageId] }] };
  return value;
}

it("replays the 87-second invalid business-rule proposal and finishes its repair beyond 120 seconds", async () => {
  const root = await workspace(), first = deferred(), second = deferred(), firstDone = deferred(), secondDone = deferred();
  const events: any[] = []; let calls = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const result = startPlannerConversation({ workspace: root, request: "增加问候函数和测试", config: { provider: "codex-agent", model: "runner-default", baseUrl: "agent://codex" }, executionDefaults: { runnerId: "mock", mode: "managed" }, onEvent: async event => { events.push(event); }, planner: {
    id: "codex-agent", async generate(input, context) {
      context.consumeApiRequest(); calls++;
      if (calls === 1) {
        first.resolve(); await firstDone.promise;
        const value = await reply(input, context);
        return { kind: "clarification", message: "请确认业务规则", questions: ["是否采用默认方案？"], requirementsUpdate: value.requirementsUpdate,
          planningAssessment: { ...value.planningAssessment, decisions: [{ decisionId: "business_rules", status: "pending", value: "待确认", question: "是否采用默认方案？", rationale: "范围待定" }] },
          questionBindings: [{ questionId: "business", displayIndex: 1, decisionIds: ["business_rules"], answerMode: "accept_proposal" }] };
      }
      expect(input.repairMessage).toContain("没有具体默认值"); second.resolve(); await secondDone.promise;
      expect(context.signal.aborted).toBe(false); return reply(input, context);
    },
  } });
  await first.promise; await vi.advanceTimersByTimeAsync(87_000); firstDone.resolve();
  await second.promise; await vi.advanceTimersByTimeAsync(80_000); secondDone.resolve();
  const done = await result;
  expect(done.error).toBeUndefined(); expect(done.snapshot.status).toBe("draft_ready"); expect(calls).toBe(2);
  expect(events.some(event => event.type === "planner.validation_failed")).toBe(true);
  expect(events.at(-1)).toMatchObject({ planningId: done.snapshot.planningId, type: "planner.turn.finished", payload: { status: "succeeded" } });
});

it("retains the API deadline and propagates the timeout cause instead of an adapter's cancelled text", async () => {
  const root = await workspace(), started = deferred();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const pending = startPlannerConversation({ workspace: root, request: "增加问候函数", config: { provider: "deepseek", model: "test", baseUrl: "https://example.test" }, executionDefaults: { runnerId: "mock", mode: "managed" }, planner: {
    id: "deepseek", async generate(_input, context) { started.resolve(); return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("local_agent_plan_failed：cancelled")), { once: true })); },
  } });
  await started.promise; await vi.advanceTimersByTimeAsync(120_000);
  const done = await pending;
  expect(done.reasonCode).toBe("planner_timed_out"); expect(done.error).toContain("超过 120 秒");
  expect(done.error).not.toContain("local_agent_plan_failed"); expect(done.snapshot.turns.at(-1)?.status).toBe("timed_out");
});

it("keeps explicit cancellation distinct and does not send initialization failures into JSON repairs", async () => {
  const root = await workspace(); let calls = 0;
  const config = { provider: "claude-agent" as const, model: "test", baseUrl: "agent://claude-code" };
  const failed = await startPlannerConversation({ workspace: root, request: "增加问候函数", config, executionDefaults: { runnerId: "mock", mode: "managed" }, planner: { id: "claude-agent", async generate() { calls++; throw new PlannerInvocationError("local_agent_initialization_failed", "initialize 请求超时"); } } });
  expect(calls).toBe(1); expect(failed.reasonCode).toBe("local_agent_initialization_failed");
  const abort = new AbortController(), started = deferred();
  const pending = startPlannerConversation({ workspace: root, request: "增加问候函数", config, signal: abort.signal, executionDefaults: { runnerId: "mock", mode: "managed" }, planner: { id: "claude-agent", async generate(_input, context) { started.resolve(); return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); } } });
  await started.promise; abort.abort(new Error("由用户在控制台取消"));
  const cancelled = await pending;
  expect(cancelled.reasonCode).toBe("planner_cancelled"); expect(cancelled.error).toContain("由用户在控制台取消");
});

it("lets a local Agent review finish after 120 seconds and retains observer identity", async () => {
  const root = await workspace();
  const initial = await startPlannerConversation({ workspace: root, request: "增加问候函数", config: { provider: "mock", model: "mock", baseUrl: "mock://local" }, executionDefaults: { runnerId: "mock", mode: "managed" } });
  const started = deferred(), finish = deferred(), events: any[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const pending = reviewPlannerDraft({ workspace: root, planningId: initial.snapshot.planningId, reviewerConfig: { provider: "claude-agent", model: "test", baseUrl: "agent://claude-code" }, onEvent: async event => { events.push(event); }, reviewer: {
    async review(input, context) { started.resolve(); await finish.promise; expect(context.signal.aborted).toBe(false); return new MockPlanReviewer().review(input, context); },
  } });
  await started.promise; await vi.advanceTimersByTimeAsync(180_000); finish.resolve();
  const done = await pending;
  expect(done.review.status).toBe("succeeded");
  expect(events.at(-1)).toMatchObject({ planningId: initial.snapshot.planningId, reviewId: done.review.reviewId, type: "planner.turn.finished" });
});
