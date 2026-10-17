import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PlannerStore } from "@token-coupon/core";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "../src/application-service.js";
import { createMcpServer } from "../src/mcp-server.js";
import type { RemoteMcpPrincipal } from "../src/mcp-server.js";
import type { HandoffSlot } from "../src/web-handoff.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "tc-handoff-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "排课项目"); await mkdir(path);
  const dataDirectory = join(root, "state"); const service = new ApplicationService({ dataDirectory }); await service.initialize();
  const workspace = await service.addWorkspace(path, "排课后端");
  const principals = ["chatgpt", "claude"].map(source => ({ grantId: randomUUID(), clientId: randomUUID(), source,
    workspaceId: workspace.workspaceId, scopes: ["repository:read", "planning:read", "planning:write", "session:read", "session:control"], expiresAt: Date.now() + 60_000 } as RemoteMcpPrincipal));
  const connect = async (principal: RemoteMcpPrincipal, observer?: Parameters<typeof createMcpServer>[2]) => {
    const server = createMcpServer(service, principal, observer), client = new Client({ name: "web-simulation", version: "1" });
    const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args }); const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      if (result.isError) throw new Error(data.error); return data;
    };
    return { client, call, principal };
  };
  const [gpt, claude] = await Promise.all(principals.map(connect));
  const wait = async (job: { jobId: string }) => {
    for (let i = 0; i < 250; i++) { const current = await service.getJob(job.jobId); if (current.status !== "running") return current as any; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("job timeout");
  };
  const prepare = async () => gpt!.call("planning_prepare", { workspaceId: workspace.workspaceId, requestKey: randomUUID(), role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } });
  const claim = async (browser: typeof gpt, operationId: string, requestKey = randomUUID()) => browser!.call("handoff_claim", { workspaceId: workspace.workspaceId, operationId, requestKey });
  const args = (ownership: any) => ({ workspaceId: workspace.workspaceId, operationId: ownership.context.operationId, claimToken: ownership.claimToken, generation: ownership.generation });
  return { root, dataDirectory, service, workspace, gpt: gpt!, claude: claude!, wait, prepare, claim, args, connect };
}
function candidate(context: any) {
  const messages = context.input.pendingMessages as Array<{ messageId: string; content: string }>;
  const source = messages.find(item => item.content === "增加问候函数，并补充测试") ?? messages[0]!;
  const task = (id: string) => ({ schemaVersion: 1, id, title: id, prompt: "实现问候函数并验证测试", execution: { runnerId: "mock", mode: "managed" } });
  return { kind: "draft", message: "已生成实现与验证计划。", plan: { schemaVersion: 1, id: "web-demo", title: "问候函数", tasks: [
    { task: task("implement"), dependsOn: [], status: "planned" }, { task: task("verify"), dependsOn: ["implement"], status: "planned" } ] },
    requirementsUpdate: { messageDecisions: messages.map(item => ({ messageId: item.messageId, kind: "requirement", reason: "用户功能需求" })),
      changes: [{ requirementId: "R-greet", text: "增加问候函数，并补充测试", status: "active", sourceMessageIds: messages.map(item => item.messageId) }] },
    planningAssessment: { profile: "general", classification: { rationale: "单功能示例", sourceMessageId: source.messageId, quote: source.content }, decisions: [] } };
}

describe("cross-web ownership and handoff", () => {
  it("returns trace IDs even when audit persistence fails and never replays a business mutation", async () => {
    const h = await harness(), traceId = randomUUID(); let observations = 0;
    const browser = await h.connect(h.gpt.principal, { traceId, record: async () => { observations++; throw new Error("audit unavailable"); } });
    const result = await browser.client.callTool({ name: "workspace_query", arguments: {} });
    expect(result.isError).not.toBe(true); expect(result._meta?.["token-coupon/traceId"]).toBe(traceId);
    const prepared = await browser.call("planning_prepare", { workspaceId: h.workspace.workspaceId, requestKey: randomUUID(), role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } });
    expect(prepared.operation.planningId).toBeTruthy();
    expect(await h.service.listPlannings(h.workspace.workspaceId)).toHaveLength(1);
    expect(observations).toBe(2);
    const expired = await h.connect({ ...h.gpt.principal, expiresAt: Date.now() - 1 }, { traceId, record: async () => { throw new Error("audit unavailable"); } });
    const denied = await expired.client.callTool({ name: "workspace_query", arguments: {} });
    expect(denied.isError).toBe(true); expect(denied._meta?.["token-coupon/traceId"]).toBe(traceId);
    expect(JSON.parse((denied.content as Array<{ text: string }>)[0]!.text).traceId).toBe(traceId);
  });

  it("ChatGPT Plan -> Claude Review -> local approval/execution, with independent identities and idempotent commits", async () => {
    const h = await harness(), prepared = await h.prepare(), operationId = prepared.operation.operationId;
    expect(h.gpt.client.getInstructions()).toContain("需求中的实现、测试和交付应写入待批准计划");
    expect(h.claude.client.getInstructions()).toContain("工具不可用或授权/连接失败时报告阻断");
    expect(prepared.operation.input).toBeUndefined();
    const key = randomUUID(), owner = await h.claim(h.gpt, operationId, key);
    expect((await h.claim(h.gpt, operationId, key)).claimToken).toBe(owner.claimToken);
    await expect(h.claim(h.gpt, operationId)).rejects.toThrow("handoff_owned");
    await expect(h.claim(h.claude, operationId)).rejects.toThrow("handoff_target_forbidden");
    const requestKey = randomUUID(), submit = { ...h.args(owner), requestKey, reply: candidate(owner.context) };
    const committed = await h.gpt.call("external_submit", submit); expect(committed.job.status).toBe("succeeded");
    expect((await h.gpt.call("external_submit", submit)).job.jobId).toBe(committed.job.jobId);
    const planningId = owner.context.planningId;
    const handed = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, planningId, randomUUID(), "review", "claude"));
    expect(handed.status).toBe("succeeded");
    const review = await h.claim(h.claude, handed.result.operationId);
    expect(review.context.input).toHaveProperty("plan");
    const reviewed = await h.claude.call("external_submit", { ...h.args(review), requestKey: randomUUID(), reply: { summary: "需求、依赖和验证完整", findings: [], resolutions: [] } });
    expect(reviewed.job.status).toBe("succeeded");
    const view = await h.service.planningView(h.workspace, planningId) as any;
    expect(view.review.current).toBe(true);
    expect((await h.wait(await h.service.approve(h.workspace.workspaceId, planningId, randomUUID(), view.draft.draftRevision, []))).status).toBe("succeeded");
    const run = await h.wait(await h.service.run(h.workspace.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 })); expect(run.status, run.error).toBe("succeeded");
    const session = await h.claude.call("session_query", { workspaceId: h.workspace.workspaceId, planningId }); expect(session.status).toBe("succeeded");
    const delivery = await h.gpt.call("delivery_query", { workspaceId: h.workspace.workspaceId, planningId }); expect(delivery.available).toBe(false);
    const tools = await h.gpt.client.listTools(); expect(tools.tools.some(item => item.name === "session_control" || item.name === "delivery_prepare")).toBe(false);
    expect(JSON.stringify(await h.service.external.queryHandoffs(h.workspace.workspaceId))).not.toContain(owner.claimToken);
  }, 30_000);

  it("fences a late ChatGPT response after transfer; preserves code, result and core revision", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    const planningId = owner.context.planningId, key = randomUUID();
    const transferred = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, planningId, key, "plan", "claude", "额度不足"));
    expect((await h.wait(await h.service.external.handoff(h.workspace.workspaceId, planningId, key, "plan", "claude", "额度不足"))).jobId).toBe(transferred.jobId);
    const late = await h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: candidate(owner.context) });
    expect(late.job.status).toBe("failed"); expect(late.job.error).toContain("handoff_superseded");
    expect((await new PlannerStore(h.workspace.path).load(planningId)).turns).toHaveLength(0);
    const next = await h.claim(h.claude, prepared.operation.operationId);
    expect(next.generation).toBeGreaterThan(owner.generation);
    const success = await h.claude.call("external_submit", { ...h.args(next), requestKey: randomUUID(), reply: candidate(next.context) }); expect(success.job.status).toBe("succeeded");
    await expect(h.claim(h.claude, prepared.operation.operationId)).rejects.toThrow("handoff_unavailable");
  });

  it("batches all pending inputs with stable IDs and fences old operation IDs and review preparation", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId), planningId = owner.context.planningId;
    expect((await h.wait(await h.service.reply(h.workspace.workspaceId, planningId, randomUUID(), "使用 Python，简单实现"))).status).toBe("succeeded");
    const latest = await h.wait(await h.service.reply(h.workspace.workspaceId, planningId, randomUUID(), "不安装第三方依赖"));
    expect(latest.status).toBe("succeeded");
    const transferred = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, planningId, randomUUID(), "plan", "claude"));
    const next = await h.claim(h.claude, transferred.result.operationId);
    expect(next.context.input.pendingMessages.map((item: any) => item.content)).toEqual(["增加问候函数，并补充测试", "使用 Python，简单实现", "不安装第三方依赖"]);
    await expect(h.gpt.call("repository_query", { ...h.args(owner), tool: "repo_list", args: {} })).rejects.toThrow("handoff_superseded");
    expect((await h.wait(await h.service.external.prepare(h.workspace.workspaceId, randomUUID(), { role: "review", planningId, coordinated: true }))).error).toContain("pending_inputs_require_plan");
    const response = candidate(next.context);
    const success = await h.claude.call("external_submit", { ...h.args(next), requestKey: randomUUID(), reply: response }); expect(success.job.status).toBe("succeeded");
    const snapshot = await new PlannerStore(h.workspace.path).load(planningId);
    expect(snapshot.messages.filter(item => item.role === "user")).toHaveLength(3);
    expect(new Set(snapshot.messages.map(item => item.messageId)).size).toBe(snapshot.messages.length);
  });

  it("migrates legacy pending replies once and continues using coordination for later local replies", async () => {
    const h = await harness();
    const legacy = await h.wait(await h.service.external.prepare(h.workspace.workspaceId, randomUUID(), { role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } }));
    const planningId = legacy.result.planningId;
    await h.wait(await h.service.reply(h.workspace.workspaceId, planningId, randomUUID(), "使用 Python"));
    await h.wait(await h.service.reply(h.workspace.workspaceId, planningId, randomUUID(), "不安装第三方依赖"));
    const transfer = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, planningId, randomUUID(), "plan", "claude"));
    expect(transfer.status, transfer.error).toBe("succeeded");
    const owner = await h.claim(h.claude, transfer.result.operationId);
    expect(owner.context.input.pendingMessages.map((item: any) => item.content)).toEqual(["增加问候函数，并补充测试", "使用 Python", "不安装第三方依赖"]);
    const extra = await h.wait(await h.service.reply(h.workspace.workspaceId, planningId, randomUUID(), "测试覆盖空姓名"));
    const next = await h.claim(h.claude, extra.result.operationId);
    expect(next.context.input.pendingMessages).toHaveLength(4);
  });

  it("re-prepares an exhausted invalid reply without duplicating canonical messages", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    for (let i = 0; i < 3; i++) expect((await h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: { kind: "draft" } })).job.status).toBe("failed");
    const transfer = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, owner.context.planningId, randomUUID(), "plan", "claude"));
    expect(transfer.status, transfer.error).toBe("succeeded");
    const next = await h.claim(h.claude, transfer.result.operationId);
    const committed = await h.claude.call("external_submit", { ...h.args(next), requestKey: randomUUID(), reply: candidate(next.context) });
    expect(committed.job.status, committed.job.error).toBe("succeeded");
    expect((await new PlannerStore(h.workspace.path).load(owner.context.planningId)).messages.filter(item => item.role === "user")).toHaveLength(1);
  });

  it("reconciles an interrupted response only from an operation-linked authoritative success", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    expect((await h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: candidate(owner.context) })).job.status).toBe("succeeded");
    const operationPath = join(h.dataDirectory, "external-operations", `${prepared.operation.operationId}.json`);
    const persisted = JSON.parse(await readFile(operationPath, "utf8")); persisted.state = "submitting"; delete persisted.result;
    await writeFile(operationPath, JSON.stringify(persisted));
    const restarted = new ApplicationService({ dataDirectory: h.dataDirectory }); await restarted.initialize();
    expect((await restarted.external.reconcile(h.workspace.workspaceId, prepared.operation.operationId) as any).state).toBe("succeeded");
    expect((await new PlannerStore(h.workspace.path).load(owner.context.planningId)).turns).toHaveLength(1);
    const other = await h.prepare();
    const otherPath = join(h.dataDirectory, "external-operations", `${other.operation.operationId}.json`);
    const unknown = JSON.parse(await readFile(otherPath, "utf8")); unknown.state = "interrupted"; await writeFile(otherPath, JSON.stringify(unknown));
    await expect(restarted.external.reconcile(h.workspace.workspaceId, other.operation.operationId)).rejects.toThrow("reconciliation_unknown");
  });

  it("serializes concurrent claims and forbids bypass by omitted proof or a new operationId", async () => {
    const h = await harness(), prepared = await h.prepare();
    await h.wait(await h.service.external.handoff(h.workspace.workspaceId, prepared.operation.planningId, randomUUID(), "plan", "any"));
    const attempts = await Promise.allSettled([h.claim(h.gpt, prepared.operation.operationId), h.claim(h.claude, prepared.operation.operationId)]);
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const ownership = (attempts.find(item => item.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    const browser = attempts[0]!.status === "fulfilled" ? h.gpt : h.claude;
    const missing = await browser.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: prepared.operation.operationId, requestKey: randomUUID(), reply: candidate(ownership.context) });
    expect(missing.job.error).toContain("handoff_superseded");
    await expect(browser.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId: prepared.operation.planningId, requestKey: randomUUID(), role: "plan", message: "抢占" })).rejects.toThrow("handoff_owned");
    await browser.call("handoff_release", h.args(ownership));
    const renewed = await h.claim(browser, prepared.operation.operationId);
    expect(renewed.generation).toBeGreaterThan(ownership.generation);
  });

  it("transfer versus submission either commits once or rejects the old generation", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    const [submitted, handed] = await Promise.all([
      h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: candidate(owner.context) }),
      h.wait(await h.service.external.handoff(h.workspace.workspaceId, owner.context.planningId, randomUUID(), "plan", "claude")),
    ]);
    const snapshot = await new PlannerStore(h.workspace.path).load(owner.context.planningId);
    if (submitted.job.status === "succeeded") expect(snapshot.turns).toHaveLength(1);
    else { expect(submitted.job.error).toContain("handoff_superseded"); expect(snapshot.turns).toHaveLength(0); }
    expect(handed.status).toBe("succeeded");
    expect((await h.service.external.queryHandoffs(h.workspace.workspaceId))).toHaveLength(1);
  });

  it("holds ownership until the authoritative commit when a transfer arrives during submission", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    let ready!: () => void, release!: () => void, checks = 0;
    const reachedCommit = new Promise<void>(resolve => { ready = resolve; });
    const commitGate = new Promise<void>(resolve => { release = resolve; });
    h.gpt.principal.assertActive = async () => { if (++checks === 3) { ready(); await commitGate; } };
    const submitted = h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: candidate(owner.context) });
    await reachedCommit;
    const transfer = await h.service.external.handoff(h.workspace.workspaceId, owner.context.planningId, randomUUID(), "plan", "claude");
    await new Promise(resolve => setTimeout(resolve, 20)); release();
    const [result, handed] = await Promise.all([submitted, h.wait(transfer)]);
    expect(result.job.status).toBe("succeeded"); expect(handed.result.state).toBe("succeeded");
    expect((await new PlannerStore(h.workspace.path).load(owner.context.planningId)).turns).toHaveLength(1);
  });

  it("expires leases, distinguishes same-grant tabs, rejects revoked identities, and fences restart claims", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId), planningId = owner.context.planningId;
    const slot = (await h.service.external.handoffs.load(h.workspace.workspaceId, planningId, "plan"))!;
    slot.claim!.expiresAt = Date.now() - 1; await h.service.external.handoffs.save(slot);
    await expect(h.gpt.call("repository_query", { ...h.args(owner), tool: "repo_list", args: {} })).rejects.toThrow("handoff_lease_expired");
    const next = await h.claim(h.gpt, prepared.operation.operationId);
    expect(next.generation).toBeGreaterThan(owner.generation);
    const otherTab = await h.connect(h.gpt.principal);
    await expect(h.claim(otherTab, prepared.operation.operationId)).rejects.toThrow("handoff_owned");
    const restarted = new ApplicationService({ dataDirectory: h.dataDirectory }); await restarted.initialize();
    await expect(restarted.external.read(h.workspace.workspaceId, prepared.operation.operationId, "repo_list", {}, h.gpt.principal, h.args(next))).rejects.toThrow("handoff_superseded");
    h.gpt.principal.assertActive = async () => { throw new Error("revoked"); };
    await expect(h.gpt.call("handoff_query", { workspaceId: h.workspace.workspaceId })).rejects.toThrow("revoked");
  });

  it("preserves evidence on handoff, rejects changed files and stale edited reviews", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    await writeFile(join(h.workspace.path, "README.md"), "v1");
    await h.gpt.call("repository_query", { ...h.args(owner), tool: "repo_read", args: { path: "README.md" } });
    await h.wait(await h.service.external.handoff(h.workspace.workspaceId, owner.context.planningId, randomUUID(), "plan", "claude"));
    const next = await h.claim(h.claude, prepared.operation.operationId); expect(next.context.evidence).toHaveLength(1);
    await writeFile(join(h.workspace.path, "README.md"), "v2");
    const stale = await h.claude.call("external_submit", { ...h.args(next), requestKey: randomUUID(), reply: candidate(next.context) });
    expect(stale.job.error).toContain("workspace_changed");
    const handed = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, owner.context.planningId, randomUUID(), "plan", "claude"));
    const renewed = await h.claim(h.claude, handed.result.operationId);
    expect((await h.claude.call("external_submit", { ...h.args(renewed), requestKey: randomUUID(), reply: candidate(renewed.context) })).job.status).toBe("succeeded");
    const reviewJob = await h.wait(await h.service.external.handoff(h.workspace.workspaceId, owner.context.planningId, randomUUID(), "review", "chatgpt"));
    const view = await h.service.planningView(h.workspace, owner.context.planningId) as any;
    const plan = structuredClone(view.draft.plan); plan.title = "用户修改";
    await h.wait(await h.service.saveDraft(h.workspace.workspaceId, owner.context.planningId, randomUUID(), { plan, expectedDraftRevision: view.draft.draftRevision, expectedPlanHash: view.draft.planHash }));
    await expect(h.claim(h.gpt, reviewJob.result.operationId)).rejects.toThrow("external_context_stale");
  });
  it("continues the current review without replacing an owner; a revised draft cannot reuse old approval", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    const submitted = await h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: candidate(owner.context) });
    expect(submitted.job.status, submitted.job.error).toBe("succeeded");
    expect(submitted.nextAction).toContain("本轮默认继续审查一次");
    const planningId = owner.context.planningId;
    const reviewJob = await h.wait(await h.service.review(h.workspace.workspaceId, planningId, randomUUID()));
    const repeat = await h.wait(await h.service.review(h.workspace.workspaceId, planningId, randomUUID()));
    expect(repeat.result.operationId).toBe(reviewJob.result.operationId);
    let view = await h.service.planningView(h.workspace, planningId) as any;
    expect(view.workflow.stage).toBe("review_prepared"); expect(view.review).toBeUndefined();
    const reviewing = await h.claim(h.gpt, reviewJob.result.operationId);
    view = await h.service.planningView(h.workspace, planningId) as any; expect(view.workflow.stage).toBe("review_owned");
    const invalidReport = await h.gpt.call("external_submit", { ...h.args(reviewing), requestKey: randomUUID(), reply: { summary: "缺少字段的报告" } });
    expect(invalidReport.job.status).toBe("failed");
    view = await h.service.planningView(h.workspace, planningId) as any;
    expect(view.workflow.label).toContain("提交校验未通过"); expect(view.workflow.operationId).toBe(reviewJob.result.operationId);
    expect(view.review).toBeUndefined(); expect(view.workflow.detail).toContain("复用当前操作");
    // Another authorized web client can discover the operation, but cannot replace/claim it.
    const other = await h.claude.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId, role: "review", requestKey: randomUUID() });
    expect(other.operation.operationId).toBe(reviewJob.result.operationId);
    await expect(h.claim(h.claude, reviewJob.result.operationId)).rejects.toThrow("handoff_owned");
    const reviewed = await h.gpt.call("external_submit", { ...h.args(reviewing), requestKey: randomUUID(), reply: { summary: "审查通过", findings: [], resolutions: [] } });
    expect(reviewed.job.status, reviewed.job.error).toBe("succeeded");
    view = await h.service.planningView(h.workspace, planningId) as any; expect(view.workflow.stage).toBe("awaiting_approval");
    expect((await h.wait(await h.service.approve(h.workspace.workspaceId, planningId, randomUUID(), view.draft.draftRevision))).status).toBe("succeeded");
    view = await h.service.planningView(h.workspace, planningId) as any;
    expect(view.workflow.stage).toBe("approved"); expect(view.approval.draftRevision).toBe(1); expect(view.execution).toBeNull();
    const edited = structuredClone(view.draft.plan); edited.tasks[0].task.prompt += "，覆盖空姓名";
    const saved = await h.wait(await h.service.saveDraft(h.workspace.workspaceId, planningId, randomUUID(), { plan: edited, expectedDraftRevision: 1, expectedPlanHash: view.draft.planHash }));
    expect(saved.status, saved.error).toBe("succeeded");
    view = await h.service.planningView(h.workspace, planningId) as any;
    expect(view.draft.draftRevision).toBe(2); expect(view.approval).toBeNull(); expect(view.review).toBeUndefined();
    expect(view.workflow.approvalNotice).toContain("旧版审查或批准不适用"); expect(view.reviewHistory).toHaveLength(1); expect(view.approvalHistory).toHaveLength(1);
    const denied = await h.wait(await h.service.run(h.workspace.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 }));
    expect(denied.status).toBe("failed");
    const invalid = structuredClone(edited); invalid.id = "forged";
    const forbidden = await h.wait(await h.service.saveDraft(h.workspace.workspaceId, planningId, randomUUID(), { plan: invalid, expectedDraftRevision: 2, expectedPlanHash: view.draft.planHash }));
    expect(forbidden.error).toContain("draft_readonly_field");
    const next = await h.wait(await h.service.review(h.workspace.workspaceId, planningId, randomUUID()));
    expect(next.result.operationId).not.toBe(reviewJob.result.operationId);
    const nextReview = await h.claim(h.gpt, next.result.operationId);
    const again = await h.gpt.call("external_submit", { ...h.args(nextReview), requestKey: randomUUID(), reply: { summary: "新版本复审通过", findings: [], resolutions: [] } });
    expect(again.job.status, again.job.error).toBe("succeeded");
    view = await h.service.planningView(h.workspace, planningId) as any;
    const reportPath = join(h.workspace.path, ".token-coupon", "planners", planningId, "reviews", view.review.reviewId, "review.json");
    const report = await readFile(reportPath, "utf8"); await writeFile(reportPath, "{}");
    const unreadable = await h.service.planningView(h.workspace, planningId) as any;
    expect(unreadable.workflow.stage).toBe("review_unreadable"); expect(unreadable.reviewReadError).toBeTruthy();
    await writeFile(reportPath, report);
    expect((await h.wait(await h.service.approve(h.workspace.workspaceId, planningId, randomUUID(), 2))).status).toBe("succeeded");
    const run = await h.wait(await h.service.run(h.workspace.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 })); expect(run.status, run.error).toBe("succeeded");
  });

  it("keeps approval visible but blocks starting old work while new inputs await the web", async () => {
    const h = await harness(), prepared = await h.prepare(), owner = await h.claim(h.gpt, prepared.operation.operationId);
    const planningId = owner.context.planningId;
    await h.gpt.call("external_submit", { ...h.args(owner), requestKey: randomUUID(), reply: candidate(owner.context) });
    const review = await h.wait(await h.service.review(h.workspace.workspaceId, planningId, randomUUID()));
    const reviewer = await h.claim(h.gpt, review.result.operationId);
    await h.gpt.call("external_submit", { ...h.args(reviewer), requestKey: randomUUID(), reply: { summary: "通过", findings: [], resolutions: [] } });
    const approved = await h.wait(await h.service.approve(h.workspace.workspaceId, planningId, randomUUID(), 1)); expect(approved.status).toBe("succeeded");
    const input = await h.wait(await h.service.reply(h.workspace.workspaceId, planningId, randomUUID(), "补充空姓名测试")); expect(input.status, input.error).toBe("succeeded");
    const view = await h.service.planningView(h.workspace, planningId) as any;
    expect(view.approval).toBeTruthy(); expect(view.workflow.role).toBe("plan"); expect(view.workflow.stage).toBe("plan_prepared");
    const run = await h.wait(await h.service.run(h.workspace.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 })); expect(run.error).toContain("pending_inputs_require_plan");
    const denied = await h.wait(await h.service.approve(h.workspace.workspaceId, planningId, randomUUID(), 1)); expect(denied.error).toContain("pending_inputs_require_plan");
    expect((await h.service.planningView(h.workspace, planningId) as any).execution).toBeNull();
  });

});
