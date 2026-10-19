import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MockPlanner, MockPlanReviewer, PlannerStore } from "@token-coupon/core";
import { ApplicationService, type JobRecord } from "../src/application-service.js";
import { defaultSystemSettings, parseSystemSettings } from "../src/system-settings.js";

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ role: string; config: any }> }));
vi.mock("../src/local-agent-planner.js", () => ({ LocalAgentPlanner: class {
  id: string;
  constructor(private config: any) { this.id = config.provider; }
  async generate(input: any, context: any) {
    calls.push({ role: "plan", config: this.config });
    const value: any = await new MockPlanner().generate(input, context);
    const source = input.pendingMessages.at(-1);
    value.planningAssessment = { schemaVersion: 2, profile: "general", classification: { rationale: "单函数示例", sourceMessageId: source.messageId, quote: source.content }, decisions: [] };
    value.requirementsUpdate = { messageDecisions: input.pendingMessages.map((item: any) => ({ messageId: item.messageId, kind: input.operationMessageIds.includes(item.messageId) ? "operation" : "requirement", reason: "用户输入" })), changes: input.pendingMessages.filter((item: any) => !input.operationMessageIds.includes(item.messageId)).map((item: any) => ({ requirementId: "R-" + item.messageId, text: item.content, status: "active", sourceMessageIds: [item.messageId] })) };
    return value;
  }
  async review(input: any, context: any) { calls.push({ role: "review", config: this.config }); return new MockPlanReviewer().review(input, context); }
} }));
const roots: string[] = [], services: ApplicationService[] = [];
beforeEach(() => calls.splice(0));
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function wait(service: ApplicationService, job: JobRecord) {
  let current = job;
  await expect.poll(async () => { current = await service.getJob(job.jobId); return current.status; }, { timeout: 5000 }).not.toBe("running");
  expect(current.status, current.error).toBe("succeeded"); return current;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tc-route-")); roots.push(root);
  const path = join(root, "project"); await mkdir(path);
  const service = new ApplicationService({ dataDirectory: join(root, "state") }); await service.initialize();
  services.push(service);
  const workspace = await service.addWorkspace(path, "routing");
  const created = await wait(service, await service.startPlanning(workspace.workspaceId, randomUUID(), { request: "增加问候函数并补充测试", provider: "mock", executionDefaults: { runnerId: "mock", mode: "managed" } }));
  const planningId = (created.result as any).planningId as string;
  const settings = defaultSystemSettings(); settings.unified.priority = "agent"; settings.unified.agent = { runnerId: "codex", modelId: "test-fast-model" };
  await service.saveSystemSettings(settings);
  return { service, workspace, planningId };
}

it("migrates old settings by inheriting revision policy from planning and keeps later revision choices independent", () => {
  const old: any = defaultSystemSettings(); delete old.functions.revision; old.mode = "per-function";
  old.functions.planning.priority = "agent";
  const current = parseSystemSettings(old);
  expect(current.functions.revision).toEqual(current.functions.planning);
  current.functions.revision.priority = "web";
  expect(current.functions.planning.priority).toBe("agent");
});

it("uses the configured Agent for review and a new revision turn, retaining earlier turn configuration", async () => {
  const h = await setup(), { service, workspace, planningId } = h;
  const reviewed = await wait(service, await service.review(workspace.workspaceId, planningId, randomUUID()));
  expect(calls).toContainEqual({ role: "review", config: { provider: "codex-agent", model: "test-fast-model", baseUrl: "agent://codex" } });
  const view = await service.planningView(workspace, planningId);
  expect(view.review?.reviewerConfig).toMatchObject({ provider: "codex-agent", model: "test-fast-model" });
  const store = new PlannerStore(workspace.path), before = await store.load(planningId), draft = await store.loadDraft(planningId, before.draftRevision!);
  expect((view as any).createdAt).toBe(before.createdAt);
  await wait(service, await service.revise(workspace.workspaceId, planningId, randomUUID(), { message: "补充验证说明", reviewId: (reviewed.result as any).reviewId, expectedDraftRevision: draft.draftRevision, expectedPlanHash: draft.planHash }));
  const after = await store.load(planningId);
  expect((await service.planningView(workspace, planningId) as any).createdAt).toBe(before.createdAt);
  expect(after.config.provider).toBe("codex-agent"); expect(calls.some(call => call.role === "plan")).toBe(true);
  const turn = JSON.parse(await readFile(join(after.turns.at(-1)!.artifactDir, "turn.json"), "utf8"));
  expect(turn.config).toMatchObject({ provider: "codex-agent", model: "test-fast-model" });
  expect(after.planningId).toBe(before.planningId); expect(after.messages.length).toBeGreaterThan(before.messages.length);
});

it("prepares webpage continuation for an Agent plan after policy changes without invoking another Agent", async () => {
  const { service, workspace, planningId } = await setup();
  await wait(service, await service.reply(workspace.workspaceId, planningId, randomUUID(), "补充问候函数的测试"));
  expect(calls.some(call => call.role === "plan")).toBe(true); calls.splice(0);
  const settings = await service.systemSettings(); settings.unified.priority = "web"; settings.unified.webSource = "claude"; await service.saveSystemSettings(settings);
  const job = await wait(service, await service.reply(workspace.workspaceId, planningId, randomUUID(), "继续完善当前计划"));
  expect(job.kind).toBe("external.prepare"); expect(calls).toHaveLength(0);
  const snapshot = await new PlannerStore(workspace.path).load(planningId);
  expect(snapshot.config.provider).toBe("web-mcp");
  const handoffs = await service.external.queryHandoffs(workspace.workspaceId, planningId) as any[];
  expect(handoffs.find(slot => slot.role === "plan")).toMatchObject({ target: "claude", pendingInputs: 1 });
});

it("invalidates an owned webpage review before Agent takeover and rejects the former owner's late submission", async () => {
  const { service, workspace, planningId } = await setup();
  const prepared = await wait(service, await service.review(workspace.workspaceId, planningId, randomUUID(), { mode: "web-chatgpt" }));
  const operationId = (prepared.result as any).operationId, actor = { grantId: "test-grant", clientId: "test-client", source: "chatgpt" as const };
  const claim: any = await service.external.claim(workspace.workspaceId, operationId, randomUUID(), actor);
  await expect(service.review(workspace.workspaceId, planningId, randomUUID())).rejects.toThrow("external_operation_pending");
  await service.external.cancel(workspace.workspaceId, operationId);
  await wait(service, await service.review(workspace.workspaceId, planningId, randomUUID()));
  expect(calls.filter(call => call.role === "review")).toHaveLength(1);
  const submission = await service.external.submit(workspace.workspaceId, operationId, randomUUID(), { summary: "late", findings: [], resolutions: [] }, actor, { claimToken: claim.claimToken, generation: claim.generation });
  await expect.poll(async () => (await service.getJob(submission.jobId)).status).toBe("failed");
});

it("uses revision's webpage preference independently of Agent planning and review", async () => {
  const { service, workspace, planningId } = await setup();
  const reviewed = await wait(service, await service.review(workspace.workspaceId, planningId, randomUUID()));
  const settings = await service.systemSettings(); settings.mode = "per-function";
  settings.functions.planning = structuredClone(settings.unified); settings.functions.review = structuredClone(settings.unified);
  settings.functions.revision.webSource = "claude"; await service.saveSystemSettings(settings);
  const store = new PlannerStore(workspace.path), before = await store.load(planningId), draft = await store.loadDraft(planningId, before.draftRevision!);
  const job = await wait(service, await service.revise(workspace.workspaceId, planningId, randomUUID(), { message: "补充验证说明", reviewId: (reviewed.result as any).reviewId, expectedDraftRevision: draft.draftRevision, expectedPlanHash: draft.planHash }));
  expect(job.kind).toBe("external.prepare"); expect(calls.filter(call => call.role === "plan")).toHaveLength(0);
  const handoffs = await service.external.queryHandoffs(workspace.workspaceId, planningId) as any[];
  expect(handoffs.find(slot => slot.role === "plan")).toMatchObject({ target: "claude", pendingInputs: 1 });
});

it("creates a linked revision using the configured Agent and preserves the original planning", async () => {
  const { service, workspace, planningId } = await setup(), store = new PlannerStore(workspace.path);
  const before = await store.load(planningId), draft = await store.loadDraft(planningId, before.draftRevision!);
  const job = await wait(service, await service.createRevisionPlanning(workspace.workspaceId, planningId, randomUUID(), before.revision, draft.planHash, "修订验证安排"));
  const created = await store.load((job.result as any).planningId);
  expect(created.planningId).not.toBe(planningId); expect(created.sourcePlanning).toMatchObject({ planningId, planHash: draft.planHash });
  expect(created.config.provider).toBe("codex-agent"); expect(await store.load(planningId)).toEqual(before);
  expect(calls.some(call => call.role === "plan")).toBe(true);
});

it("explicitly prepares webpage continuation of an Agent plan as an operation, retaining its planning identity", async () => {
  const { service, workspace, planningId } = await setup();
  await wait(service, await service.reply(workspace.workspaceId, planningId, randomUUID(), "补充问候函数测试"));
  const settings = await service.systemSettings(); settings.unified.priority = "web"; await service.saveSystemSettings(settings); calls.splice(0);
  const job = await wait(service, await service.prepareWebContinuation(workspace.workspaceId, planningId, randomUUID()));
  expect((job.result as any).planningId).toBe(planningId); expect(calls).toHaveLength(0);
  const op: any = await service.external.context(workspace.workspaceId, (job.result as any).operationId);
  expect(op.input.operationMessageIds).toContain(op.sourceMessageId);
  expect((await new PlannerStore(workspace.path).load(planningId)).config.provider).toBe("chatgpt-mcp");
});
