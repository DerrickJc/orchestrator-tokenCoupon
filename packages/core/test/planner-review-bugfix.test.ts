import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlannerDraft, DeepSeekPlanner, effectiveRequirements, loadCurrentPlanReview, MockPlanReviewer, PlannerStore,
  refreshPlannerRequirements, replacePlannerDraft, replyToPlanner, requirementsHash, reviewPlannerDraft, revisePlannerDraft,
  startPlannerConversation, traceRequirement,
  retryPlannerTurn,
} from "../src/index.js";
import { createHistoryReader } from "../src/requirements.js";
import { validateReviewReply } from "../src/review-reply.js";
import type { Planner, PlannerInput, PlanReviewInput, RequirementsUpdate } from "../src/index.js";

const roots: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), "review-bugfix-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const config = { provider: "mock" as const, model: "mock", baseUrl: "mock://local" };
const executionDefaults = { runnerId: "mock", mode: "non_interactive" as const, timeoutMs: 3000 };
function plan(prompt = "Implement greeting and automated tests", dependsOn = ["implement"]) {
  return { schemaVersion: 1 as const, id: "greet-plan", title: "Greeting", tasks: [
    { task: { schemaVersion: 1 as const, id: "implement", title: "Implement greeting", prompt, execution: executionDefaults }, dependsOn: [], status: "planned" as const },
    { task: { schemaVersion: 1 as const, id: "verify", title: "Verify greeting", prompt: "Run the tests and report the result", execution: executionDefaults }, dependsOn, status: "planned" as const },
  ] };
}
function update(input: PlannerInput, kind: "requirement" | "operation" | "noise", text?: string): RequirementsUpdate {
  const messages = input.pendingMessages!;
  return { messageDecisions: messages.map(({ messageId }) => ({ messageId, kind, reason: "Test semantic decision" })),
    changes: kind === "requirement" ? [{ requirementId: "R-stack", text: text ?? messages.at(-1)!.content, status: "active", sourceMessageIds: messages.map(({ messageId }) => messageId) }] : [] };
}
function planner(generate: Planner["generate"]): Planner { return { id: "mock", generate }; }
async function start(root: string, adapter?: Planner) {
  return startPlannerConversation({ workspace: root, request: "Use MySQL", config, executionDefaults,
    planner: adapter ?? planner(async (input) => ({ kind: "draft", message: "Plan", plan: plan(), requirementsUpdate: update(input, "requirement", "Use MySQL") })) });
}
const finding = { findingId: "F1", severity: "error", category: "dependency", taskIds: ["verify"],
  description: "Verification must depend on implementation", basis: "dependsOn is empty", suggestion: "Add implement to dependsOn" };

describe("Phase 3.5 review repair and requirement provenance", () => {
  it("supersedes a constraint, preserves source versions, and keeps noise and operations out of model requirements", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const inputs: PlannerInput[] = [];
    const adapter = planner(async (input) => {
      inputs.push(input);
      const kind = inputs.length === 1 ? "requirement" : inputs.length === 2 ? "noise" : "operation";
      return { kind: "draft", message: "Updated", plan: plan(), requirementsUpdate: update(input, kind, "Use SQLite") };
    });
    const second = await replyToPlanner({ ...options, message: "Replace MySQL with SQLite", planner: adapter });
    const beforeNoiseHash = requirementsHash(second.snapshot);
    await replyToPlanner({ ...options, message: "OBBCOCOCOCCOCO", planner: adapter });
    const fourth = await replyToPlanner({ ...options, message: "Show the current plan", planner: adapter });
    expect(effectiveRequirements(fourth.snapshot.requirements!)).toEqual([expect.objectContaining({ text: "Use SQLite", revision: 2 })]);
    expect(requirementsHash(fourth.snapshot)).toBe(beforeNoiseHash);
    expect(inputs[2]!.messages).toEqual([{ role: "user", content: "Show the current plan" }]);
    expect(JSON.stringify(inputs[2]!.requirements)).not.toContain("OBBCO");
    const old = traceRequirement(fourth.snapshot, "R-stack", 1);
    expect(old.requirement.status).toBe("superseded");
    expect(old.sources[0]!.message.content).toBe("Use MySQL");
    expect(old.sources[0]!.turns[0]!.status).toBe("succeeded");
    const archived = JSON.parse(await readFile(join(root, ".token-coupon", "planners", options.planningId, "requirements", "1.json"), "utf8"));
    expect(archived.state.items[0].status).toBe("active");
    let reviewInput: PlanReviewInput | undefined;
    await reviewPlannerDraft({ ...options, reviewer: { review: async (input) => { reviewInput = input; return { summary: "Reviewed", findings: [] }; } } });
    expect(reviewInput!.requirements).toEqual(["Use SQLite"]);
    expect(reviewInput!.requirementItems![0]!.sourceMessageIds).toEqual(second.snapshot.requirements!.items.at(-1)!.sourceMessageIds);
  });

  it("attaches the actual report to both explicit revise and ordinary repair dialogue, then tracks stable issues", async () => {
    const root = await workspace();
    const first = await start(root, planner(async (input) => ({ kind: "draft", message: "Plan", plan: plan(undefined, []), requirementsUpdate: update(input, "requirement") })));
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const review = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "Dependency error", findings: [finding] }) });
    let repairInput: PlannerInput | undefined;
    const repaired = await revisePlannerDraft({ ...options, planner: planner(async (input) => {
      repairInput = input;
      return { kind: "draft", message: "Fix dependency", plan: plan(), requirementsUpdate: update(input, "operation") };
    }) });
    expect(repairInput!.reviewContext).toMatchObject({ current: true, review: { reviewId: review.review.reviewId, findings: [finding] } });
    expect(repaired.draft!.draftRevision).toBe(2);
    expect(effectiveRequirements(repaired.snapshot.requirements!)).toHaveLength(1);
    await expect(revisePlannerDraft(options)).rejects.toThrow("当前有效");
    let nextInput: PlanReviewInput | undefined;
    const second = await reviewPlannerDraft({ ...options, reviewer: { review: async (input) => {
      nextInput = input;
      return { summary: "Still incomplete", findings: [{ ...finding, findingId: "F9", priorFindingId: "F1" }], resolutions: [{ findingId: "F1", status: "unresolved", basis: "Test reviewer still reports the original issue" }] };
    } } });
    expect(nextInput!.previousReview!.reviewId).toBe(review.review.reviewId);
    expect(nextInput!.planChanges).toContainEqual(expect.objectContaining({ field: "dependsOn", after: ["implement"] }));
    expect(second.review.findings[0]!.issueId).toBe(review.review.findings[0]!.issueId);
    await replyToPlanner({ ...options, message: "Please repair the previous review", planner: planner(async (input) => {
      expect(input.reviewContext).toMatchObject({ current: true, review: { reviewId: second.review.reviewId } });
      return { kind: "draft", message: "Checked", plan: plan(), requirementsUpdate: update(input, "operation") };
    }) });
    const final = await reviewPlannerDraft({ ...options, reviewer: { review: async () => ({ summary: "Resolved", findings: [], resolutions: [{ findingId: "F9", status: "resolved", basis: "verify now depends on implement" }] }) } });
    expect(final.review.resolutions![0]!.issueId).toBe(review.review.findings[0]!.issueId);
    await approvePlannerDraft({ ...options, draftRevision: 2 });
  });

  it("rejects a stale report selection and incomplete issue resolution without replacing the valid report", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const review = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "Error", findings: [finding] }) });
    await expect(revisePlannerDraft({ ...options, reviewId: randomUUID() })).rejects.toThrow("当前有效");
    await expect(reviewPlannerDraft({ ...options, reviewer: { review: async () => ({ summary: "Looks fine", findings: [] }) } })).rejects.toThrow("逐项");
    expect((await loadCurrentPlanReview(options.planningId, root))!.reviewId).toBe(review.review.reviewId);
    await expect(reviewPlannerDraft({ ...options, reviewer: { review: async () => ({ summary: "Contradiction", findings: [], resolutions: [{ findingId: "F1", status: "unresolved", basis: "Not fixed" }] }) } })).rejects.toThrow("不一致");
    await replacePlannerDraft({ ...options, value: plan("Changed implementation") });
    await expect(revisePlannerDraft(options)).rejects.toThrow("当前有效");
  });

  it("repairs a missing prior finding resolution in the same review with a precise diagnostic", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const priorFindings = ["F1", "F2", "F3", "F4", "F5"].map((findingId) => ({
      ...finding, findingId, severity: findingId === "F4" ? "info" as const : "warning" as const,
      description: "Prior issue " + findingId,
    }));
    const previous = await reviewPlannerDraft({
      ...options, reviewer: new MockPlanReviewer({ summary: "Prior review", findings: priorFindings }),
    });
    const findingF4 = previous.review.findings.find(({ findingId }) => findingId === "F4")!;
    const missingF4 = {
      summary: "F4 remains open",
      findings: [{ findingId: "F4", severity: "info", category: "dependency", taskIds: ["verify"],
        description: findingF4.description, basis: findingF4.basis, suggestion: findingF4.suggestion, priorFindingId: "F4" }],
      resolutions: ["F1", "F2", "F3", "F5"].map((findingId) => ({ findingId, status: "resolved", basis: "The plan addresses " + findingId })),
    };
    const complete = {
      ...missingF4,
      resolutions: ["F1", "F2", "F3", "F4", "F5"].map((findingId) => ({
        findingId, status: findingId === "F4" ? "unresolved" : "resolved",
        basis: findingId === "F4" ? "The previous recommendation remains informational and is still tracked" : "The plan addresses " + findingId,
      })),
    };
    const requestBodies: Array<Record<string, unknown>> = [];
    const replies = ["Research complete", JSON.stringify(missingF4), JSON.stringify(complete)];
    const reviewer = new DeepSeekPlanner({
      model: "fake", baseUrl: "https://api.deepseek.com", apiKey: "fake-key",
      fetchImpl: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
        const content = replies.shift()!;
        return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
      },
    });
    const repaired = await reviewPlannerDraft({ ...options, reviewer });
    expect(repaired.review.status).toBe("succeeded");
    expect(repaired.review.resolutions).toHaveLength(5);
    expect(repaired.review.resolutions?.find(({ findingId }) => findingId === "F4")).toMatchObject({ status: "unresolved", issueId: findingF4.issueId });
    expect(repaired.review.findings.find(({ priorFindingId }) => priorFindingId === "F4")?.issueId).toBe(findingF4.issueId);
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies.slice(1).every((body) => body.tools === undefined)).toBe(true);
    expect(JSON.stringify(requestBodies[2]?.messages)).toContain("遗漏：F4");
  });

  it("replays the recorded closed-F1 failure, repairs it, and permits review/approve without changing the draft", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const recorded = JSON.parse(await readFile(new URL("./fixtures/phase6-closed-review.json", import.meta.url), "utf8"));
    await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "Optional suggestion", findings: [{ ...finding, severity: "info" }] }) });
    const closed = await reviewPlannerDraft({ ...options, reviewer: { review: async () => ({ ...recorded.previous,
      resolutions: recorded.previous.resolutions.map(({ findingId, status, basis }: { findingId: string; status: string; basis: string }) => ({ findingId, status, basis })),
    }) } });
    expect(closed.review.findings).toEqual([]);
    expect(closed.review.resolutions![0]!.findingId).toBe("F1");
    await replacePlannerDraft({ ...options, value: plan("Implement greeting and tests, with explicit output evidence") });
    await expect(approvePlannerDraft({ ...options, draftRevision: 2 })).rejects.toThrow("审查");
    expect(() => validateReviewReply(recorded.reply, ["implement", "verify"], ["R-stack"], closed.review)).toThrow('resolutions[0].findingId 引用了未知的上轮问题 "F1"');
    const bodies: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown }> = [];
    const replies = [recorded.reply, { summary: "Current plan reviewed; no previous open findings", findings: [], resolutions: [] }];
    const reviewer = new DeepSeekPlanner({ model: "fake", baseUrl: "https://api.deepseek.com", apiKey: "fake-key", fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(replies.shift()) } }] }));
    } });
    const result = await reviewPlannerDraft({ ...options, reviewer });
    expect(result.review.status).toBe("succeeded"); expect(result.review.resolutions).toEqual([]);
    expect(result.snapshot.draftRevision).toBe(2); expect(bodies).toHaveLength(2);
    const input = JSON.parse(bodies[0]!.messages[1]!.content);
    expect(input.previousReview.findings).toEqual([]); expect(input.previousReview.resolutions).toBeUndefined();
    expect(bodies[0]!.messages[0]!.content).toContain("本轮 resolutions 必须恰好覆盖的 findingId：[]");
    expect(JSON.stringify(bodies[1]!.messages)).toContain("本轮 resolutions 必须为 []");
    expect(bodies[1]!.tools).toBeUndefined();
    expect((await approvePlannerDraft({ ...options, draftRevision: 2 })).snapshot.status).toBe("approved");
    const stored = (await import("../src/review-store.js")).ReviewStore;
    expect((await new stored(root).load(options.planningId, closed.review.reviewId)).resolutions).toHaveLength(1);
  });

  it("reports the exact invalid resolution field and allows a new finding after the previous report cleared", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const review = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "Initial", findings: [finding] }) });
    const base = { findingId: "F1", status: "resolved", basis: "Fixed dependency" };
    for (const [entry, message] of [
      [{ ...base, status: "done" }, "resolutions[0].status"],
      [{ ...base, basis: " " }, "resolutions[0].basis"],
      [{ ...base, issueId: "invented" }, "未知字段：issueId"],
    ] as const) expect(() => validateReviewReply({ summary: "Checked", findings: [], resolutions: [entry] }, ["implement", "verify"], [], review.review)).toThrow(message);
    expect(() => validateReviewReply({ summary: "Checked", findings: [], resolutions: [base, base] }, ["implement", "verify"], [], review.review)).toThrow("resolutions[1].findingId 重复：F1");
    const cleared = await reviewPlannerDraft({ ...options, reviewer: { review: async () => ({ summary: "Cleared", findings: [], resolutions: [base] }) } });
    const next = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "New problem", findings: [finding], resolutions: [] }) });
    expect(next.review.findings[0]!.issueId).not.toBe(review.review.findings[0]!.issueId);
    expect(next.review.previousReviewId).toBe(cleared.review.reviewId);
    await expect(approvePlannerDraft({ ...options, draftRevision: 1 })).rejects.toThrow();
  });

  it("rejects invented provenance and does not publish partial updates after invalid responses", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const bad = await replyToPlanner({ ...options, message: "Use SQLite", planner: planner(async (input) => {
      const patch = update(input, "requirement", "Use SQLite");
      patch.changes[0]!.sourceMessageIds.push(randomUUID());
      return { kind: "draft", message: "Invalid", plan: plan(), requirementsUpdate: patch };
    }) });
    expect(bad.error).toContain("来源");
    expect(bad.snapshot.requirements).toEqual(first.snapshot.requirements);
    expect(bad.snapshot.messages.some(({ content }) => content === "Use SQLite")).toBe(true);
    const after = await replyToPlanner({ ...options, message: "Keep the original requirement", planner: planner(async (input) => {
      expect(input.messages).toEqual([{ role: "user", content: "Keep the original requirement" }]);
      return { kind: "draft", message: "Kept", plan: plan(), requirementsUpdate: update(input, "operation") };
    }) });
    expect(after.error).toBeUndefined();
    expect(effectiveRequirements(after.snapshot.requirements!)[0]!.text).toBe("Use MySQL");
  });

  it("keeps cancelled input available for retrieval without adopting it on the next turn", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const controller = new AbortController();
    const cancelled = await replyToPlanner({ ...options, message: "accidental-input", signal: controller.signal, planner: planner(async () => { controller.abort(); throw new Error("cancelled"); }) });
    expect(cancelled.snapshot.turns.at(-1)!.status).toBe("cancelled");
    const after = await replyToPlanner({ ...options, message: "Continue", planner: planner(async (input, context) => {
      expect(JSON.stringify(input.messages)).not.toContain("accidental-input");
      const id = input.historyIndex!.find((item) => item.turnStatuses.includes("cancelled"))!.messageId;
      expect(await context.readHistory!([id])).toContain("accidental-input");
      return { kind: "draft", message: "Continued", plan: plan(), requirementsUpdate: update(input, "operation") };
    }) });
    expect(after.error).toBeUndefined();
    expect(requirementsHash(after.snapshot)).toBe(requirementsHash(first.snapshot));
  });

  it("requires legacy reconciliation and blocks approval while requirements remain ambiguous", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const store = new PlannerStore(root);
    const { requirements: _requirements, ...legacy } = first.snapshot;
    await store.save({ ...legacy, revision: legacy.revision + 1 });
    await expect(reviewPlannerDraft(options)).rejects.toThrow("尚未整理");
    const refreshed = await refreshPlannerRequirements({ ...options, planner: planner(async (input) => {
      const source = input.pendingMessages!.find((item) => !input.operationMessageIds!.includes(item.messageId))!;
      return { kind: "draft", message: "Reconciled", plan: plan(), requirementsUpdate: {
        messageDecisions: input.pendingMessages!.map(({ messageId }) => ({ messageId, kind: messageId === source.messageId ? "requirement" : "operation", reason: "Legacy reconciliation" })),
        changes: [{ requirementId: "R-stack", text: "Database selection needs confirmation", status: "pending", sourceMessageIds: [source.messageId] }],
      } };
    }) });
    expect(refreshed.error).toBeUndefined();
    await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer() });
    await expect(approvePlannerDraft({ ...options, draftRevision: 1 })).rejects.toThrow("待澄清");
  });

  it("bounds exact-ID history retrieval and exposes it as a logged read-only model tool", async () => {
    const root = await workspace();
    const first = await start(root);
    const id = first.snapshot.messages[0]!.messageId;
    const read = createHistoryReader(first.snapshot);
    await expect(read([randomUUID()])).rejects.toThrow("不存在");
    await expect(read(Array.from({ length: 9 }, () => randomUUID()))).rejects.toThrow("1 到 8");
    const bodies: Array<Record<string, unknown>> = [];
    const toolMessages: unknown[] = [];
    const responses = [
      { role: "assistant", content: null, tool_calls: [{ id: "history-1", type: "function", function: { name: "conversation_read", arguments: JSON.stringify({ messageIds: [id] }) } }] },
      { role: "assistant", content: "Enough context" },
      { role: "assistant", content: JSON.stringify({ summary: "Reviewed", findings: [], resolutions: [] }) },
    ];
    const adapter = new DeepSeekPlanner({ model: "fake", baseUrl: "https://api.deepseek.com", apiKey: "fake-key", fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: responses.shift() }] }));
    } });
    let calls = 0;
    await adapter.review({ requirements: ["Use MySQL"], plan: plan(), executionDefaults }, {
      signal: new AbortController().signal, repository: new (await import("../src/repository-reader.js")).RepositoryReader(root),
      readHistory: read, consumeApiRequest: () => ++calls, consumeToolCall: () => undefined,
      record: async (event) => { if (event.type === "repository.tool") toolMessages.push(event); },
    });
    expect((bodies[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toContain("conversation_read");
    expect(JSON.stringify(bodies[1]!.messages)).toContain("Use MySQL");
    expect(toolMessages).toHaveLength(1);
    const large = { ...first.snapshot, messages: [{ messageId: id, role: "user" as const, content: "x".repeat(17 * 1024) }] };
    await expect(createHistoryReader(large)([id])).rejects.toThrow("预算");
  });

  it("preserves operation identity when a failed explicit revision is retried", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const review = await reviewPlannerDraft({ ...options, reviewer: new MockPlanReviewer({ summary: "Error", findings: [finding] }) });
    const failed = await revisePlannerDraft({ ...options, planner: planner(async () => { throw new Error("Simulated provider failure"); }) });
    expect(failed.snapshot.turns.at(-1)!.operation).toBe(true);
    const retried = await retryPlannerTurn({ ...options, planner: planner(async (input) => {
      expect(input.operationMessageIds).toEqual([failed.snapshot.turns.at(-1)!.messageId]);
      expect(input.reviewContext!.review.reviewId).toBe(review.review.reviewId);
      return { kind: "draft", message: "Retried", plan: plan(), requirementsUpdate: update(input, "operation") };
    }) });
    expect(retried.error).toBeUndefined();
    expect(requirementsHash(retried.snapshot)).toBe(requirementsHash(first.snapshot));
  });

  it("rejects noise-driven withdrawal and detects archive tampering", async () => {
    const root = await workspace();
    const first = await start(root);
    const options = { planningId: first.snapshot.planningId, workspace: root };
    const bad = await replyToPlanner({ ...options, message: "Noise", planner: planner(async (input) => {
      const patch = update(input, "noise");
      patch.changes = [{ requirementId: "R-stack", text: "Withdraw all requirements", status: "withdrawn", sourceMessageIds: [input.pendingMessages![0]!.messageId] }];
      return { kind: "draft", message: "Invalid", plan: plan(), requirementsUpdate: patch };
    }) });
    expect(bad.error).toContain("不能来自操作或噪声");
    expect(bad.snapshot.requirements).toEqual(first.snapshot.requirements);
    const archivePath = join(root, ".token-coupon", "planners", options.planningId, "requirements", "1.json");
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    archive.state.items[0].text = "Tampered";
    await writeFile(archivePath, JSON.stringify(archive));
    await expect(new PlannerStore(root).load(options.planningId)).rejects.toThrow("不可变需求版本不匹配");
  });
});
