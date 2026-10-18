import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { PlannerStore } from "@token-coupon/core";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";
import { acquireDaemonOwner } from "../src/daemon-owner.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-mcp-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "项目目录"); await mkdir(path);
  const dataDirectory = join(root, "state");
  const service = new ApplicationService({ dataDirectory }); await service.initialize();
  const workspace = await service.addWorkspace(path);
  const port = await freePort();
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${port}`;
  const token = (await readFile(join(dataDirectory, "mcp-access-token"), "utf8")).trim();
  const client = new Client({ name: "phase7-integration-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport as Transport); cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    const data = JSON.parse((reply.content as Array<{ text: string }>)[0]!.text);
    if (reply.isError) throw new Error(data.error); return data;
  };
  const wait = async (jobId: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const job = await call("operation_query", { workspaceId: workspace.workspaceId, jobId });
      if (job.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("job did not finish");
  };
  const prepare = async () => call("planning_prepare", { workspaceId: workspace.workspaceId, requestKey: randomUUID(), role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } });
  return { root, service, workspace, origin, client, call, wait, prepare };
}

function candidate(messageId: string) {
  const execution = { runnerId: "mock", mode: "managed" };
  const task = (id: string) => ({ schemaVersion: 1, id, title: id, prompt: "实现问候函数或验证其测试", execution });
  return { kind: "draft", message: "准备了实现和验证计划。", plan: { schemaVersion: 1, id: "mcp-demo", title: "问候函数", tasks: [
    { task: task("implement"), dependsOn: [], status: "planned" }, { task: task("verify"), dependsOn: ["implement"], status: "planned" },
  ] }, requirementsUpdate: { messageDecisions: [{ messageId, kind: "requirement", reason: "用户提出功能和测试要求" }], changes: [{ requirementId: "R-greet", text: "增加问候函数，并补充测试", status: "active", sourceMessageIds: [messageId] }] },
  planningAssessment: { profile: "general", classification: { rationale: "简单单功能演示", sourceMessageId: messageId, quote: "增加问候函数，并补充测试" }, decisions: [] } };
}

describe("ChatGPT-direction MCP and local human controls", () => {
  it("accepts the BIZ-04 mixed Runner matrix in one Planning while rejecting unsupported modes", async () => {
    const h = await harness();
    const prepared = await h.call("planning_prepare", { workspaceId: h.workspace.workspaceId, requestKey: randomUUID(), role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "codex", modelId: "gpt-6-luna", mode: "managed" } });
    const { operationId, planningId, sourceMessageId } = prepared.operation;
    const context = await h.call("external_context", { workspaceId: h.workspace.workspaceId, operationId });
    expect(context.protocol).toContain("executionDefaults 仅为缺省配置");
    const matrix = JSON.parse(await readFile(new URL("../../core/test/fixtures/biz04-task-matrix.json", import.meta.url), "utf8"));
    // Transport/application regression only: no real webpage or Runner is invoked.
    const reply = candidate(sourceMessageId);
    reply.plan = { schemaVersion: 1, id: "biz04-mixed", title: "BIZ-04 mixed execution", tasks: matrix.tasks.map((item: any) => ({
      task: { schemaVersion: 1, id: item.id, title: item.title, prompt: item.title, execution: item.execution }, dependsOn: item.dependsOn, status: "planned",
    })) };
    const invalid = structuredClone(reply);
    invalid.plan.tasks[2]!.task.execution = { runnerId: "codex", mode: "non_interactive" };
    const rejected = await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId, requestKey: randomUUID(), reply: invalid });
    expect(rejected.job.status).toBe("failed");
    expect(rejected.job.error).toContain("不支持 non_interactive");
    expect((await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId })).draft).toBeUndefined();

    const submitted = await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId, requestKey: randomUUID(), reply });
    expect(submitted.job.status).toBe("succeeded");
    const view = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId });
    expect(view.planningId).toBe(planningId);
    expect(view.draft.plan.tasks.map((entry: any) => ({ id: entry.task.id, execution: entry.task.execution }))).toEqual(matrix.tasks.map((item: any) => ({ id: item.id, execution: item.execution })));
    const stored = await new PlannerStore(h.workspace.path).load(planningId);
    expect(stored.executionDefaults).toEqual({ runnerId: "codex", modelId: "gpt-6-luna", mode: "managed" });
    expect(stored.turns.map(turn => turn.status)).toEqual(["failed", "succeeded"]);
    expect(stored.approval).toBeNull(); expect(stored.execution).toBeNull();
  }, 30_000);

  it("registers a local reply, exposes its pending input, accepts a web result, and validates draft edits", async () => {
    const h = await harness(); const initial = await h.prepare();
    const { operationId, planningId, sourceMessageId } = initial.operation;
    expect((await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId, requestKey: randomUUID(), reply: candidate(sourceMessageId) })).job.status).toBe("succeeded");
    const landing = await fetch(h.origin); const cookie = landing.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const path = `/api/v1/workspaces/${h.workspace.workspaceId}/plannings/${planningId}`;
    const post = async (action: string, body: Record<string, unknown>) => {
      const response = await fetch(`${h.origin}${path}/${action}`, { method: "POST", headers: { Origin: h.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID(), ...body }) });
      expect(response.status).toBe(202); return h.wait((await response.json() as { jobId: string }).jobId);
    };
    const message = "增加问候函数，并补充测试";
    const registered = await post("replies", { message }); expect(registered.status).toBe("succeeded"); expect(registered.result.nextAction).toBe("external_context");
    const waiting = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId });
    expect(waiting.workspace).toEqual({ workspaceId: h.workspace.workspaceId, label: h.workspace.label });
    expect(waiting.handoffs).toBeInstanceOf(Array);
    expect(waiting.messages).toBeUndefined(); expect(waiting.turns).toBeUndefined();
    const pending = waiting.externalOperations.find((item: { operationId: string }) => item.operationId === registered.result.operationId);
    expect(pending).toMatchObject({ state: "prepared", message, expectedRevision: waiting.revision }); expect(pending.sourceMessageId).toBeTypeOf("string");
    expect((await new PlannerStore(h.workspace.path).load(planningId)).messages.some((item) => item.messageId === pending.sourceMessageId)).toBe(false);
    const completed = await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: pending.operationId, requestKey: randomUUID(), reply: candidate(pending.sourceMessageId) });
    expect(completed.job.status).toBe("succeeded");
    const view = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId });
    expect(view.verificationTasks).toEqual([
      { taskId: "implement", title: "implement", valid: false, reason: expect.any(String) },
      { taskId: "verify", title: "verify", valid: true },
    ]);
    const localView = await fetch(`${h.origin}${path}`, { headers: { Cookie: cookie } }).then(response => response.json()) as { messages: Array<{ messageId: string }> };
    expect(localView.messages.filter((item) => item.messageId === pending.sourceMessageId)).toHaveLength(1);
    const invalid = structuredClone(view.draft.plan); invalid.tasks[0].dependsOn = ["missing"];
    const base = { expectedDraftRevision: view.draft.draftRevision, expectedPlanHash: view.draft.planHash };
    expect((await post("draft", { ...base, plan: invalid })).status).toBe("failed");
    expect((await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId })).draft.planHash).toBe(base.expectedPlanHash);
    const edited = { title: "保存后的新标题", tasks: [{ taskId: "implement", fields: { prompt: "实现问候函数，并覆盖空姓名场景。" } }] };
    expect((await post("draft", { ...base, edits: edited })).status).toBe("succeeded");
    const saved = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId });
    expect(saved.draft.plan.title).toBe("保存后的新标题"); expect(saved.draft.draftRevision).toBe(base.expectedDraftRevision + 1);
    expect(saved.draft.plan.tasks[0].task.prompt).toBe("实现问候函数，并覆盖空姓名场景。");
  }, 30_000);

  it("reports the cumulative 256 KiB research budget and only expands after local confirmation", async () => {
    const h = await harness(), prepared = await h.prepare();
    const { operationId } = prepared.operation, workspaceId = h.workspace.workspaceId;
    const context = await h.call("external_context", { workspaceId, operationId });
    expect(context.readBudget).toMatchObject({ limitBytes: 256 * 1024, usedBytes: 0, remainingBytes: 256 * 1024, maximumBytes: 1024 * 1024 });
    await writeFile(join(h.workspace.path, "first.txt"), "one\n", "utf8");
    await writeFile(join(h.workspace.path, "second.txt"), "two\n", "utf8");
    const first = await h.call("repository_query", { workspaceId, operationId, tool: "repo_read", args: { path: "first.txt" } });
    const second = await h.call("repository_query", { workspaceId, operationId, tool: "repo_read", args: { path: "second.txt" } });
    expect(first.readBudget.remainingBytes).toBeLessThan(context.readBudget.remainingBytes);
    expect(second.readBudget.usedBytes).toBeGreaterThan(first.readBudget.usedBytes);
    await expect(h.service.external.extendReadBudget(workspaceId, operationId, false)).rejects.toThrow("必须由本机页面明确确认");
    let expanded = await h.service.external.extendReadBudget(workspaceId, operationId, true) as { readBudget: { limitBytes: number } };
    expect(expanded.readBudget.limitBytes).toBe(512 * 1024);
    expanded = await h.service.external.extendReadBudget(workspaceId, operationId, true) as { readBudget: { limitBytes: number } };
    expect(expanded.readBudget.limitBytes).toBe(768 * 1024);
    expanded = await h.service.external.extendReadBudget(workspaceId, operationId, true) as { readBudget: { limitBytes: number } };
    expect(expanded.readBudget.limitBytes).toBe(1024 * 1024);
    await expect(h.service.external.extendReadBudget(workspaceId, operationId, true)).rejects.toThrow("已达到 1 MiB 上限");
  });
  it("runs real SDK initialize/list/call, external planning repair, local approval and background Session without a Planner API", async () => {
    const h = await harness();
    const tools = await h.client.listTools();
    expect(tools.tools.find((tool) => tool.name === "workspace_query")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "planning_query")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "handoff_claim")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.some((tool) => /approve|answer_interaction|force_unlock/.test(tool.name))).toBe(false);
    expect((await h.call("workspace_query")).workspaces[0].path).toBe(h.workspace.path);
    const unauth = await fetch(`${h.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }); expect(unauth.status).toBe(401);
    const prepared = await h.prepare();
    const { operationId, planningId, sourceMessageId } = prepared.operation;
    expect(prepared.operation.protocol).toContain("requirementsUpdate");
    const stored = await new PlannerStore(h.workspace.path).load(planningId);
    expect(stored.config.provider).toBe("chatgpt-mcp"); expect(stored.turns).toHaveLength(0); expect(stored.activeTurnId).toBe(null);
    const bad = await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId, requestKey: randomUUID(), reply: { kind: "draft" } });
    expect(bad.job.status).toBe("failed"); expect(bad.operation.state).toBe("prepared"); expect(bad.operation.remainingAttempts).toBe(2);
    const requestKey = randomUUID();
    const args = { workspaceId: h.workspace.workspaceId, operationId, requestKey, reply: candidate(sourceMessageId) };
    const committed = await h.call("external_submit", args); expect(committed.job.status, committed.job.error).toBe("succeeded");
    expect((await h.call("external_submit", args)).job.jobId).toBe(committed.job.jobId);
    await expect(h.call("external_submit", { ...args, reply: { kind: "clarification" } })).rejects.toThrow("idempotency_conflict");
    const current = await new PlannerStore(h.workspace.path).load(planningId);
    expect(current.turns).toHaveLength(2); expect(current.messages.filter(({ role }) => role === "user")).toHaveLength(1);
    expect(current.turns.at(-1)?.status).toBe("succeeded");
    const review = await h.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId, requestKey: randomUUID(), role: "review" });
    const reviewed = await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: review.operation.operationId, requestKey: randomUUID(), reply: { summary: "计划覆盖需求，验证依赖完整。", findings: [], resolutions: [] } });
    expect(reviewed.job.status).toBe("succeeded");
    const rejectedRun = await h.call("session_control", { workspaceId: h.workspace.workspaceId, planningId, requestKey: randomUUID(), action: "run", isolation: "shared" });
    expect((await h.wait(rejectedRun.jobId)).status).toBe("failed");
    await expect(h.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId, requestKey: randomUUID(), role: "plan", userApproved: true })).rejects.toThrow();
    const landing = await fetch(h.origin); const cookie = landing.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const view = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId });
    const approval = await fetch(`${h.origin}/api/v1/workspaces/${h.workspace.workspaceId}/plannings/${planningId}/approve`, { method: "POST", headers: { Origin: h.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID(), draftRevision: view.draft.draftRevision }) });
    expect(approval.status).toBe(202); expect((await h.wait((await approval.json() as { jobId: string }).jobId)).status).toBe("succeeded");
    const run = await h.call("session_control", { workspaceId: h.workspace.workspaceId, planningId, requestKey: randomUUID(), action: "run", isolation: "shared", maxParallel: 1 });
    expect((await h.wait(run.jobId)).status).toBe("succeeded");
    const observed = await h.call("session_query", { workspaceId: h.workspace.workspaceId, planningId });
    expect(observed.status).toBe("succeeded"); expect(observed.session).toBeUndefined();
    const unchanged = await h.call("session_query", { workspaceId: h.workspace.workspaceId, planningId, knownRevision: observed.revision, waitMs: 10, includeResult: true });
    expect(unchanged.unchanged).toBe(true); expect(unchanged.session.tasks.every((task: { status: string }) => task.status === "succeeded")).toBe(true);
  }, 30_000);

  it("binds repository reads to workspace, refuses stale file evidence and preserves cancellation", async () => {
    const h = await harness(), prepared = await h.prepare();
    const otherPath = join(h.root, "other"); await mkdir(otherPath); const other = await h.service.addWorkspace(otherPath);
    const args = { workspaceId: h.workspace.workspaceId, operationId: prepared.operation.operationId };
    await expect(h.call("external_context", { ...args, workspaceId: other.workspaceId })).rejects.toThrow("不属于当前项目");
    const denied = await h.call("repository_query", { ...args, tool: "repo_read", args: { path: "../outside.txt" } });
    expect(denied.result.error).toBe("invalid_path");
    await writeFile(join(h.workspace.path, "README.md"), "version one");
    const file = await h.call("repository_query", { ...args, tool: "repo_read", args: { path: "README.md" } }); expect(file.result).toHaveProperty("sha256");
    await writeFile(join(h.workspace.path, "README.md"), "version two");
    const stale = await h.call("external_submit", { ...args, requestKey: randomUUID(), reply: candidate(prepared.operation.sourceMessageId) });
    expect(stale.job.status).toBe("failed"); expect(stale.operation.state).toBe("stale");
    expect((await new PlannerStore(h.workspace.path).load(prepared.operation.planningId)).draftRevision).toBe(null);
    const next = await h.prepare(); const nextArgs = { workspaceId: h.workspace.workspaceId, operationId: next.operation.operationId };
    await h.call("external_cancel", nextArgs);
    const late = await h.call("external_submit", { ...nextArgs, requestKey: randomUUID(), reply: candidate(next.operation.sourceMessageId) });
    expect(late.job.status).toBe("failed"); expect(late.operation.state).toBe("cancelled");
  }, 15_000);

  it("rejects a stale review after local draft editing and bounds correction attempts", async () => {
    const h = await harness(), prepared = await h.prepare();
    const args = { workspaceId: h.workspace.workspaceId, operationId: prepared.operation.operationId };
    for (let attempt = 0; attempt < 3; attempt++) await h.call("external_submit", { ...args, requestKey: randomUUID(), reply: { kind: "draft" } });
    expect((await h.call("external_context", { ...args, includeContext: false })).state).toBe("failed");
    const next = await h.prepare(); const planningId = next.operation.planningId;
    await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: next.operation.operationId, requestKey: randomUUID(), reply: candidate(next.operation.sourceMessageId) });
    const review = await h.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId, role: "review", requestKey: randomUUID() });
    const view = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId });
    const plan = structuredClone(view.draft.plan); plan.title = "用户编辑后的草案";
    const job = await h.service.saveDraft(h.workspace.workspaceId, planningId, randomUUID(), { plan, expectedDraftRevision: view.draft.draftRevision, expectedPlanHash: view.draft.planHash });
    expect((await h.wait(job.jobId)).status).toBe("succeeded");
    const late = await h.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: review.operation.operationId, requestKey: randomUUID(), reply: { summary: "旧计划审查", findings: [], resolutions: [] } });
    expect(late.operation.state).toBe("stale");
    const edited = await h.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId }); expect(edited.review).toBeUndefined();
  }, 15_000);

  it("exposes MCP over stdio with a clean stdout channel and the same local console process", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-mcp-stdio-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const port = await freePort();
    const client = new Client({ name: "stdio-smoke", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["packages/daemon/dist/main.js", "--mcp-stdio", "--data-dir", root, "--port", String(port)], stderr: "pipe" });
    transport.stderr?.on("data", () => undefined);
    await client.connect(transport); cleanups.push(() => client.close());
    const result = await client.callTool({ name: "workspace_query", arguments: {} }); expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).workspaces).toEqual([]);
    const landing = await fetch(`http://127.0.0.1:${port}`);
    const cookie = landing.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`, { headers: { Cookie: cookie } })).status).toBe(200);
  }, 15_000);

  it("rejects concurrent daemon owners and preserves a prepared operation across service restart", async () => {
    const h = await harness(); const directory = join(h.root, "exclusive-owner");
    const release = await acquireDaemonOwner(directory);
    await expect(acquireDaemonOwner(directory)).rejects.toThrow("daemon_owner_conflict"); await release();
    const again = await acquireDaemonOwner(directory); await again();
    const prepared = await h.prepare();
    const restarted = new ApplicationService({ dataDirectory: join(h.root, "state") }); await restarted.initialize();
    expect((await restarted.external.context(h.workspace.workspaceId, prepared.operation.operationId, false) as { state: string }).state).toBe("prepared");
  }, 15_000);
});

async function freePort() {
  const server = createServer(); await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
