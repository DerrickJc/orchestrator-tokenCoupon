import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApplicationService } from "../packages/daemon/dist/application-service.js";
import { createMcpServer } from "../packages/daemon/dist/mcp-server.js";

const root = resolve("demo-workspace", `phase7-web-handoff-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const project = join(root, "project"), dataDirectory = join(root, "daemon-state");
await mkdir(project, { recursive: true });
const service = new ApplicationService({ dataDirectory }); await service.initialize();
const workspace = await service.addWorkspace(project, "跨网页演示项目");
const clients = [], servers = [];
const browser = async source => {
  const principal = { grantId: randomUUID(), clientId: randomUUID(), source, workspaceId: workspace.workspaceId,
    scopes: ["repository:read", "planning:read", "planning:write", "session:read"], expiresAt: Date.now() + 3600_000 };
  const server = createMcpServer(service, principal), client = new Client({ name: `${source}-protocol-simulation`, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a); clients.push(client); servers.push(server);
  const call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args }), data = JSON.parse(reply.content[0].text);
    if (reply.isError) throw new Error(data.error); return data;
  };
  return { call, principal };
};
const wait = async job => {
  while (job.status === "running") { await new Promise(resolve => setTimeout(resolve, 10)); job = await service.getJob(job.jobId); }
  return job;
};
const proof = owner => ({ workspaceId: workspace.workspaceId, operationId: owner.context.operationId, generation: owner.generation, claimToken: owner.claimToken });
try {
  const gpt = await browser("chatgpt"), claude = await browser("claude");
  const prepared = await gpt.call("planning_prepare", { workspaceId: workspace.workspaceId, requestKey: randomUUID(), role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } });
  const owner = await gpt.call("handoff_claim", { workspaceId: workspace.workspaceId, operationId: prepared.operation.operationId, requestKey: randomUUID() });
  const planningId = owner.context.planningId;
  const transferred = await wait(await service.external.handoff(workspace.workspaceId, planningId, randomUUID(), "plan", "claude", "模拟 ChatGPT 网页额度不足"));
  assert.equal(transferred.status, "succeeded");
  const late = await gpt.call("external_submit", { ...proof(owner), requestKey: randomUUID(), reply: { kind: "draft" } });
  assert.match(late.job.error, /handoff_superseded/);
  const next = await claude.call("handoff_claim", { workspaceId: workspace.workspaceId, operationId: transferred.result.operationId, requestKey: randomUUID() });
  const messageId = next.context.sourceMessageId;
  const task = id => ({ schemaVersion: 1, id, title: id, prompt: "增加问候函数，并补充测试", execution: { runnerId: "mock", mode: "managed" } });
  const reply = { kind: "draft", message: "生成实现与测试草案", plan: { schemaVersion: 1, id: "web-handoff-demo", title: "跨网页问候函数", tasks: [
    { task: task("implement"), dependsOn: [], status: "planned" }, { task: task("verify"), dependsOn: ["implement"], status: "planned" } ] },
    requirementsUpdate: { messageDecisions: [{ messageId, kind: "requirement", reason: "业务需求" }], changes: [{ requirementId: "R-greet", text: "增加问候函数，并补充测试", status: "active", sourceMessageIds: [messageId] }] },
    planningAssessment: { profile: "general", classification: { rationale: "单功能模拟", sourceMessageId: messageId, quote: "增加问候函数，并补充测试" }, decisions: [] } };
  const planReceipt = await claude.call("external_submit", { ...proof(next), requestKey: randomUUID(), reply });
  assert.equal(planReceipt.job.status, "succeeded"); assert.match(planReceipt.nextAction, /本轮默认继续审查一次/);
  const reviewJob = await wait(await service.external.handoff(workspace.workspaceId, planningId, randomUUID(), "review", "chatgpt"));
  const continuedReview = await wait(await service.review(workspace.workspaceId, planningId, randomUUID()));
  assert.equal(continuedReview.result.operationId, reviewJob.result.operationId);
  assert.equal((await service.planningView(workspace, planningId)).workflow.stage, "review_prepared");
  const reviewer = await gpt.call("handoff_claim", { workspaceId: workspace.workspaceId, operationId: reviewJob.result.operationId, requestKey: randomUUID() });
  assert.equal((await gpt.call("external_submit", { ...proof(reviewer), requestKey: randomUUID(), reply: { summary: "需求与测试覆盖完整", findings: [], resolutions: [] } })).job.status, "succeeded");
  const view = await service.planningView(workspace, planningId);
  assert.equal((await wait(await service.approve(workspace.workspaceId, planningId, randomUUID(), view.draft.draftRevision, []))).status, "succeeded");
  const approvedView = await service.planningView(workspace, planningId);
  assert.equal(approvedView.workflow.stage, "approved"); assert.equal(approvedView.approval.draftRevision, view.draft.draftRevision);
  assert.equal(approvedView.execution, null);
  assert.equal((await wait(await service.run(workspace.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 }))).status, "succeeded");
  const observed = await gpt.call("session_query", { workspaceId: workspace.workspaceId, planningId }); assert.equal(observed.status, "succeeded");
  const report = { simulatedWebAccounts: true, transport: "MCP SDK in-memory (HTTP OAuth covered separately by regression tests)", runner: "mock",
    workspaceId: workspace.workspaceId, planningId, reviewContinuation: { reusedOperation: continuedReview.result.operationId === reviewJob.result.operationId, preparedIsNotCompleted: true }, approval: { draftRevision: approvedView.approval.draftRevision, stage: approvedView.workflow.stage, sessionCreatedOnlyOnRun: true }, continuousReviewInstruction: planReceipt.nextAction, lateSubmission: "handoff_superseded", status: observed.status,
    handoffs: await service.external.queryHandoffs(workspace.workspaceId), accountVerification: "ChatGPT / Claude real webpage configuration remains a user step" };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`协议演示通过：ChatGPT → Claude 接手规划 → ChatGPT 审查 → 本地批准 → mock 执行成功。\n真实网页账号：未在本演示中调用。\n报告：${join(root, "report.json")}`);
} finally { await Promise.all(clients.map(client => client.close())); await Promise.all(servers.map(server => server.close())); }
