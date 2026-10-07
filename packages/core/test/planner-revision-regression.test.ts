import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlannerDraft, checkPlan, DeepSeekPlanner, effectiveRequirements, loadPlannerConversation,
  MockPlanReviewer, PlannerStore, replyToPlanner, replacePlannerDraft, retryPlannerTurn, reviewPlannerDraft, runApprovedPlanner,
} from "../src/index.js";
import { decisionValueHash } from "../src/plan.js";
import type { PlannerConversationSnapshot, PlannerDraft, Runner } from "../src/index.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/planner-revision-failure.json", import.meta.url), "utf8"));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function seed() {
  const root = await mkdtemp(join(tmpdir(), "planner-revision-regression-"));
  roots.push(root);
  const snapshot = { ...structuredClone(fixture.snapshot), workspace: root } as PlannerConversationSnapshot;
  const store = new PlannerStore(root);
  await store.create(snapshot);
  await store.writeDraft(fixture.draft as PlannerDraft);
  await store.writeRequirements(snapshot.planningId, snapshot.requirements!);
  return { workspace: root, planningId: snapshot.planningId, snapshot, store };
}

function replay(responseIndex: number, alter?: (reply: any, messageId: string) => void) {
  const bodies: any[] = [];
  let messageId = "";
  const planner = new DeepSeekPlanner({ model: "recorded-replay", baseUrl: "https://api.deepseek.com", apiKey: "test-key", fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    const system = body.messages[0].content;
    messageId = JSON.parse(/待整理输入：([^\n]+)/.exec(system)![1]!)[0].messageId;
    const response = JSON.parse(JSON.stringify(fixture.responses[bodies.length === 1 ? 0 : responseIndex])
      .replaceAll(fixture.source.originalMessageId, messageId));
    if (response.content && alter) {
      const reply = JSON.parse(response.content);
      alter(reply, messageId);
      response.content = JSON.stringify(reply);
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: response.tool_calls ? "tool_calls" : "stop", message: response }] }));
  } });
  return { planner, bodies, source: () => messageId };
}

describe("recorded phase3.5-new4 draft revision regression", () => {
  it("retries the archived failed turn using the same user message without losing failure history", async () => {
    const options = await seed();
    const recorded = fixture.failedTurn;
    const failed = { turnId: recorded.turnId, messageId: recorded.messageId, status: "failed" as const,
      reasonCode: recorded.reasonCode, createdAt: recorded.createdAt, finishedAt: recorded.finishedAt,
      artifactDir: options.store.turnDirectory(options.planningId, recorded.turnId) };
    const messages = [...options.snapshot.messages, { role: "user" as const, messageId: recorded.messageId, content: recorded.input }];
    await options.store.writeTurn(failed, recorded);
    await options.store.save({ ...options.snapshot, revision: 2, status: "collecting", messages, turns: [failed] });
    const adapter = replay(3);
    const result = await retryPlannerTurn({ ...options, planner: adapter.planner });
    expect(result.error).toBeUndefined();
    expect(result.draft!.draftRevision).toBe(3);
    expect(result.snapshot.turns.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
    expect(result.snapshot.turns.at(-1)!.messageId).toBe(recorded.messageId);
    expect(result.snapshot.messages.filter(({ messageId }) => messageId === recorded.messageId)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(failed.artifactDir, "turn.json"), "utf8")).error).toBe(recorded.error);
    expect((await loadPlannerConversation(options.planningId, options.workspace)).draft!.plan).toEqual(result.draft!.plan);
  });

  it.each([1, 2, 3])("replays recorded candidate %i through revision, review, approval and Runner execution", async (index) => {
    const options = await seed();
    const previous = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer(fixture.review) });
    const adapter = replay(index);
    const result = await replyToPlanner({ ...options, message: fixture.request, planner: adapter.planner });
    expect(result.error).toBeUndefined();
    expect(result.snapshot.status).toBe("draft_ready");
    expect(result.draft!.draftRevision).toBe(3);
    expect(adapter.bodies).toHaveLength(2); // original repository/history tools + one candidate; no repairs
    expect(JSON.stringify(adapter.bodies[0].messages)).toContain("当前草案（仅任务结构");
    const current = JSON.parse(/当前草案（仅任务结构；决策记录见上文）：([^\n]+)/.exec(adapter.bodies[0].messages[0].content)![1]!);
    expect(current.schemaVersion).toBe(1);
    expect(current.decisionContext).toBeUndefined();
    expect(current.tasks.every((entry: any) => !entry.decisionRefs)).toBe(true);
    const plan = result.draft!.plan;
    expect(checkPlan(plan, options.snapshot.executionDefaults).valid).toBe(true);
    const oldDecisions = new Map((fixture.draft.plan.decisionContext.decisions as any[]).map((item) => [item.decisionId, item]));
    for (const decision of plan.decisionContext!.decisions) {
      expect(decision.valueHash).toBe(decisionValueHash(decision.decisionId, decision.value));
      expect(decision.revision).toBe(oldDecisions.get(decision.decisionId).valueHash === decision.valueHash ? 1 : 2);
      for (const entry of plan.tasks) expect(entry.decisionRefs).toContainEqual({ decisionId: decision.decisionId, revision: decision.revision, valueHash: decision.valueHash });
    }
    expect(plan.tasks.find(({ task }) => task.id === "db-migration")!.task.prompt).toMatch(/^在 Java 21 \+ Spring Boot 3 工程/);
    expect(plan.tasks.find(({ task }) => task.id === "verify")!.task.prompt).toMatch(/MySQL 8/);
    const testing = effectiveRequirements(result.snapshot.requirements!).find(({ requirementId }) => requirementId === "R-decision-testing")!;
    expect(testing.revision).toBe(3);
    expect(testing.text).toContain("启动 MySQL 8");
    expect(testing.sourceMessageIds).toEqual([index === 1 ? adapter.source() : "ce9c188b-6e17-43be-bace-b3550852dcec"]);
    const reloaded = await loadPlannerConversation(options.planningId, options.workspace);
    expect(reloaded.draft!.plan).toEqual(plan);
    expect(reloaded.snapshot.requirements).toEqual(result.snapshot.requirements);
    await expect(approvePlannerDraft({ ...options, draftRevision: 3 })).rejects.toThrow(/审查/);
    const resolutions = previous.review.findings.map(({ findingId }) => ({ findingId, status: "resolved", basis: "Recorded revised tasks explicitly specify Java/Spring Boot migration, scripted MySQL setup and document field lists" }));
    const review = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "Recorded fixes verified", findings: [], resolutions }) });
    expect(review.review.resolutions).toHaveLength(3);
    expect(review.review.resolutions!.map(({ issueId }) => issueId)).toEqual(previous.review.findings.map(({ issueId }) => issueId));
    await approvePlannerDraft({ ...options, draftRevision: 3 });
    const prompts: string[] = [];
    const runner: Runner = { id: "claude-code", supportsModel: true, async checkAvailable() {}, async run(input, context) {
      prompts.push(input.prompt);
      context.onStarted();
      context.onOutput({ stream: "stdout", text: input.completionMarker + "\n", agentText: input.completionMarker + "\n" });
      return { started: true, exitCode: 0, signal: null };
    } };
    const execution = await runApprovedPlanner({ ...options, createRunner: () => runner });
    expect(execution.sessionStatus).toBe("succeeded");
    expect(prompts).toHaveLength(5);
    expect(prompts.every((prompt) => /Java 21/.test(prompt) && /Spring Boot 3/.test(prompt) && /MySQL 8/.test(prompt))).toBe(true);
    expect(prompts.at(-1)).toContain("启动 MySQL 8");
  });

  it("still rejects a stale hash in a manually imported plan without changing the draft", async () => {
    const options = await seed();
    const value = structuredClone(fixture.draft.plan);
    value.decisionContext.decisions[2].value += " changed";
    await expect(replacePlannerDraft({ ...options, value })).rejects.toThrow("哈希不匹配");
    expect((await loadPlannerConversation(options.planningId, options.workspace)).draft!.draftRevision).toBe(2);
  });

  it.each(["operation", "noise", "invented", "false-quote", "dependency", "runner", "unknown-field"])("rejects %s without publishing a partial requirements or draft update", async (fault) => {
    const options = await seed();
    const adapter = replay(1, (reply, source) => {
      const testing = reply.planningAssessment.decisions.find((item: any) => item.decisionId === "testing");
      if (fault === "operation" || fault === "noise") {
        reply.requirementsUpdate.messageDecisions[0].kind = fault;
        reply.requirementsUpdate.changes = [];
      } else if (fault === "invented") testing.sourceMessageId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      else if (fault === "false-quote") testing.quote = "This statement is not in the user input";
      else if (fault === "dependency") reply.plan.tasks[1].dependsOn = ["missing-task"];
      else if (fault === "runner") reply.plan.tasks[0].task.execution.runnerId = "mock";
      else if (fault === "unknown-field") reply.plan.tasks[0].unknown = source;
    });
    const result = await replyToPlanner({ ...options, message: fixture.request, planner: adapter.planner });
    expect(result.error).toBeDefined();
    expect(result.snapshot.turns.at(-1)!.status).toBe("failed");
    expect(result.snapshot.requirements).toEqual(options.snapshot.requirements);
    expect((await loadPlannerConversation(options.planningId, options.workspace)).draft!.draftRevision).toBe(2);
    expect(adapter.bodies).toHaveLength(4); // still bounded to two repairs
    if (["operation", "noise", "invented", "false-quote"].includes(fault)) expect(result.error).toContain("已分类的业务输入和真实原文");
  });

  it("versions a changed source even when the decision value is unchanged", async () => {
    const options = await seed();
    const adapter = replay(1, (reply) => {
      const testing = reply.planningAssessment.decisions.find((item: any) => item.decisionId === "testing");
      testing.value = fixture.snapshot.planningAssessment.decisions.find((item: any) => item.decisionId === "testing").value;
    });
    const result = await replyToPlanner({ ...options, message: fixture.request, planner: adapter.planner });
    expect(result.error).toBeUndefined();
    const testing = effectiveRequirements(result.snapshot.requirements!).find(({ requirementId }) => requirementId === "R-decision-testing")!;
    expect(testing.revision).toBe(3);
    expect(testing.sourceMessageIds).toEqual([adapter.source()]);
  });
});
