import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { PlannerStore, type TaskRunnerFactory } from "@token-coupon/core";
import { ApplicationService, type JobRecord } from "../src/application-service.js";
import { createMcpServer, type RemoteMcpPrincipal } from "../src/mcp-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function settled(service: ApplicationService, job: JobRecord) {
  let current = job;
  for (let n = 0; n < 200 && current.status === "running"; n++) { await new Promise(resolve => setTimeout(resolve, 10)); current = await service.getJob(current.jobId); }
  expect(current.status).not.toBe("running"); return current;
}
async function fixture(needsInput = false, blockOnRetry = false) {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnosis-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project"); await mkdir(path);
  let calls = 0;
  const createRunner: TaskRunnerFactory = () => ({ id: "mock", supportsModel: false, checkAvailable: async () => undefined, run: async (input, context) => {
    context.onStarted(); calls++;
    const waiting = needsInput || blockOnRetry && calls === 2;
    const text = calls === 1 || waiting ? `缺少数据库决策，需要确认。${process.env.OPENAI_API_KEY || ""}${waiting ? `\n${input.needsInputMarker}` : ""}` : input.completionMarker;
    context.onOutput({ stream: "stdout", text, agentText: text, finalText: text });
    return { started: true, exitCode: 0, signal: null };
  } });
  const service = new ApplicationService({ dataDirectory: join(root, "state"), createRunner }); await service.initialize(); cleanups.push(() => service.shutdown());
  const ws = await service.addWorkspace(path);
  const started = await settled(service, await service.startPlanning(ws.workspaceId, randomUUID(), { provider: "mock", request: "维护现有项目，增加问候函数并验证", executionDefaults: { runnerId: "mock", mode: "managed" } }));
  const planningId = (started.result as any).planningId;
  await settled(service, await service.review(ws.workspaceId, planningId, randomUUID()));
  let view = await service.planningView(ws, planningId) as any;
  const errors = view.review.findings.filter((finding: any) => finding.severity === "error").map((finding: any) => finding.findingId);
  expect((await settled(service, await service.approve(ws.workspaceId, planningId, randomUUID(), view.draft.draftRevision, errors, "验证诊断与恢复机制"))).status).toBe("succeeded");
  const run = await settled(service, await service.run(ws.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 }));
  expect(run.status, run.error).toBe("succeeded");
  view = await service.planningView(ws, planningId) as any;
  const task = view.session.tasks[0], attemptId = task.attempts[0].attemptId;
  expect(task.status).toBe(needsInput ? "blocked" : "failed");
  return { root, path, service, ws, planningId, view, taskId: task.taskId, attemptId, calls: () => calls };
}
async function mcp(service: ApplicationService, principal: RemoteMcpPrincipal) {
  const server = createMcpServer(service, principal), client = new Client({ name: "diagnosis-web", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
  cleanups.push(async () => { await client.close(); await server.close(); }); return client;
}
it("saves short handoff prompts and exposes only explicitly exported evidence to the authorized MCP workspace", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-sensitive-evidence-12345");
  const h = await fixture();
  const principal: RemoteMcpPrincipal = { grantId: randomUUID(), clientId: randomUUID(), workspaceId: h.ws.workspaceId, scopes: ["session:read"], expiresAt: Date.now() + 60_000 };
  const client = await mcp(h.service, principal);
  const exported = await h.service.exportAttemptEvidence(h.ws.workspaceId, h.planningId, h.attemptId);
  expect(exported.absolutePath).toContain(join(h.path, ".token-coupon", "diagnostics"));
  expect(exported.prompt.length).toBeLessThan(1200); expect(exported.prompt).toContain("attempt_evidence_read");
  expect(exported.prompt).not.toContain("缺少数据库决策");
  const text = await readFile(exported.absolutePath, "utf8"); expect(text).toContain("缺少数据库决策"); expect(text).not.toContain("sk-test-sensitive-evidence-12345");
  expect((await h.service.exportAttemptEvidence(h.ws.workspaceId, h.planningId, h.attemptId)).absolutePath).toBe(exported.absolutePath);
  const args = { workspaceId: h.ws.workspaceId, planningId: h.planningId, attemptId: h.attemptId, evidenceHash: exported.evidenceHash };
  const result = await client.callTool({ name: "attempt_evidence_read", arguments: args });
  expect(result.isError).not.toBe(true); expect(JSON.parse((result.content as any)[0].text).evidence).toBe(text);
  const denied = await client.callTool({ name: "attempt_evidence_read", arguments: { ...args, workspaceId: "another-project" } });
  expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).not.toContain("缺少数据库决策");
  const limited = await mcp(h.service, { ...principal, scopes: ["planning:read"] });
  expect((await limited.listTools()).tools.some(tool => tool.name === "attempt_evidence_read")).toBe(false);
  await expect(h.service.readExportedAttemptEvidence(h.ws.workspaceId, h.planningId, randomUUID(), exported.evidenceHash)).rejects.toThrow("attempt_not_found");
  await writeFile(exported.absolutePath, "tampered evidence");
  await expect(h.service.readExportedAttemptEvidence(h.ws.workspaceId, h.planningId, h.attemptId, exported.evidenceHash)).rejects.toThrow("diagnostic_evidence_changed");
  await unlink(exported.absolutePath); const outside = join(h.root, "outside.txt"); await writeFile(outside, "private sentinel"); await symlink(outside, exported.absolutePath);
  await expect(h.service.readExportedAttemptEvidence(h.ws.workspaceId, h.planningId, h.attemptId, exported.evidenceHash)).rejects.toThrow("diagnostic_path_invalid");
  expect(h.calls()).toBe(1);
});
it("keeps explicit decision blockers and their dependents blocked when legacy recovery compatibility is enabled", async () => {
  const h = await fixture(true);
  expect(h.view.session.status).toBe("blocked");
  expect(h.view.session.tasks[0].reasonCode).toBe("user_input_required");
  expect(h.view.session.tasks.slice(1).every((task: any) => task.status !== "succeeded")).toBe(true);
  const retry = await settled(h.service, await h.service.retryTask(h.ws.workspaceId, h.planningId, randomUUID(), h.taskId));
  expect(retry.status).toBe("failed"); expect(retry.error).toContain("不允许重试");
  const resume = await settled(h.service, await h.service.resume(h.ws.workspaceId, h.planningId, randomUUID()));
  expect(resume.status).toBe("failed"); expect(resume.error).toContain("未解决的任务");
  const exported = await h.service.exportAttemptEvidence(h.ws.workspaceId, h.planningId, h.attemptId);
  expect(await readFile(exported.absolutePath, "utf8")).toContain("needs_input");
  expect(h.calls()).toBe(1);
});
it("returns actionable decision blockers when a retry stops for user input", async () => {
  const h = await fixture(false, true);
  const retried = await settled(h.service, await h.service.retryTask(h.ws.workspaceId, h.planningId, randomUUID(), h.taskId));
  expect(retried.status).toBe("succeeded");
  expect(retried.result).toMatchObject({ status: "blocked", waitingForUser: [h.taskId] });
  expect((await h.service.planningView(h.ws, h.planningId) as any).session.tasks[0]).toMatchObject({ status: "blocked", reasonCode: "user_input_required" });
  expect(h.calls()).toBe(2);
});
it("deduplicates diagnostic sends and records the selected model on every assistant reply", async () => {
  const h = await fixture(); let modelCalls = 0;
  (h.service as any).runAttemptDiagnosticModel = async (record: any) => { modelCalls++; return `只读诊断 ${record.runnerId}/${record.modelId}`; };
  const key = randomUUID();
  const first = await h.service.analyzeAttemptFailure(h.ws.workspaceId, h.planningId, h.attemptId, key, "codex", "fast", "为什么失败？");
  expect((await h.service.analyzeAttemptFailure(h.ws.workspaceId, h.planningId, h.attemptId, key, "codex", "fast", "为什么失败？")).jobId).toBe(first.jobId);
  expect((await settled(h.service, first)).status).toBe("succeeded");
  const second = await h.service.replyToAttemptDiagnosis(h.ws.workspaceId, h.planningId, h.attemptId, key, randomUUID(), "请比较处理方案", { runnerId: "claude-code", modelId: "other" });
  expect((await settled(h.service, second)).status).toBe("succeeded");
  const saved = await h.service.attemptDiagnostics(h.ws.workspaceId, h.planningId, h.attemptId);
  expect(saved.diagnostics).toHaveLength(1); expect(saved.diagnostics[0]?.messages).toHaveLength(4);
  expect(saved.diagnostics[0]?.messages[1]).toMatchObject({ role: "assistant", runnerId: "codex", modelId: "fast" });
  expect(saved.diagnostics[0]?.messages[3]).toMatchObject({ role: "assistant", runnerId: "claude-code", modelId: "other" });
  expect(modelCalls).toBe(2); expect(h.calls()).toBe(1);
});
it("recovers approved legacy Sessions without inventing missing decisions and creates an explicitly linked fresh revision", async () => {
  const h = await fixture(), store = new PlannerStore(h.path), snapshot = await store.load(h.planningId);
  const message = snapshot.messages.find(item => item.role === "user")!, requirement = snapshot.requirements!.items.find(item => item.status === "active")!;
  const legacy = { ...snapshot, planningAssessment: { profile: "existing_project", classification: { rationale: "历史现有项目", sourceMessageId: message.messageId, quote: message.content }, decisions: ["change_scope", "compatibility", "testing", "validation"].map(decisionId => ({ decisionId, status: "confirmed", value: "原批准约束", rationale: "历史用户确认", requirementId: requirement.requirementId, sourceMessageId: message.messageId, quote: message.content })) } };
  await writeFile(join(h.path, ".token-coupon", "planners", h.planningId, "conversation.json"), JSON.stringify(legacy));
  const before = await store.load(h.planningId); expect(before.planningAssessment?.schemaVersion).toBeUndefined();
  const retry = await settled(h.service, await h.service.retryTask(h.ws.workspaceId, h.planningId, randomUUID(), h.taskId)); expect(retry.status).toBe("succeeded");
  expect((await settled(h.service, await h.service.resume(h.ws.workspaceId, h.planningId, randomUUID()))).status).toBe("succeeded");
  const source = await store.load(h.planningId), draft = await store.loadDraft(h.planningId, source.draftRevision!);
  const requestKey = randomUUID(), revision = await settled(h.service, await h.service.createRevisionPlanning(h.ws.workspaceId, h.planningId, requestKey, source.revision, draft.planHash, "请先给技术选型选项"));
  expect(revision.status).toBe("succeeded");
  const result = revision.result as any, child = await store.load(result.planningId);
  expect(child.sourcePlanning).toEqual({ planningId: h.planningId, revision: source.revision, draftRevision: draft.draftRevision, planHash: draft.planHash, sessionId: source.execution!.sessionId });
  expect(child.approval).toBeNull(); expect(child.execution).toBeNull(); expect(child.draftRevision).toBeNull(); expect(child.requirements).toBeUndefined();
  const context = await h.service.external.context(h.ws.workspaceId, result.operationId) as any;
  expect(context.input.pendingMessages[0].content).toContain(h.planningId); expect(context.input.pendingMessages[0].content).toContain("不继承");
  expect((await h.service.createRevisionPlanning(h.ws.workspaceId, h.planningId, requestKey, source.revision, draft.planHash, "请先给技术选型选项")).jobId).toBe(revision.jobId);
  expect(await store.list()).toHaveLength(2);
  expect((await store.load(h.planningId)).approval).toEqual(source.approval);
  await expect(h.service.createRevisionPlanning(h.ws.workspaceId, h.planningId, randomUUID(), source.revision - 1, draft.planHash)).rejects.toThrow("revision_source_stale");
});
