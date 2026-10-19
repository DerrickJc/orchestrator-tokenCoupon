import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ApplicationService, type JobRecord } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";
import type { Runner } from "@token-coupon/core";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function settled(service: ApplicationService, job: JobRecord) {
  let result = job;
  await expect.poll(async () => { result = await service.getJob(job.jobId); return result.status; }, { timeout: 5000 }).not.toBe("running");
  return result;
}

it("uses unified and per-task choices from authenticated HTTP launch while retaining approved plan evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-run-choice-")), workspace = join(root, "project"); await mkdir(workspace);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ taskId: string; runnerId: string; modelId?: string }> = [];
  const service = new ApplicationService({ dataDirectory: join(root, "state"), createRunner: task => ({ id: task.execution.runnerId, supportsModel: true, checkAvailable: async () => {}, run: async (input, context) => {
    context.onStarted(); calls.push({ taskId: input.task.id, runnerId: input.execution.runnerId, modelId: input.execution.modelId });
    context.onOutput({ stream: "stdout", text: input.completionMarker + "\n", agentText: input.completionMarker + "\n" });
    return { started: true, exitCode: 0, signal: null };
  } } satisfies Runner) });
  cleanups.push(() => service.shutdown()); await service.initialize(); const ws = await service.addWorkspace(workspace);
  const started = await settled(service, await service.startPlanning(ws.workspaceId, randomUUID(), { provider: "mock", request: "增加问候函数并补充测试", executionDefaults: { runnerId: "codex", mode: "managed", modelId: "original" } }));
  const planningId = (started.result as any).planningId;
  await settled(service, await service.review(ws.workspaceId, planningId, randomUUID()));
  const draft = await service.planningView(ws, planningId) as any;
  const errors = draft.review.findings.filter((item: any) => item.severity === "error").map((item: any) => item.findingId);
  expect((await settled(service, await service.approve(ws.workspaceId, planningId, randomUUID(), draft.draft.draftRevision, errors, "独立运行配置测试"))).status).toBe("succeeded");
  const approved = await service.planningView(ws, planningId) as any;
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory: join(root, "state") });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${port}`, cookie = (await fetch(origin)).headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const health = await fetch(`${origin}/api/v1/health`, { headers: { Cookie: cookie } }).then(response => response.json()) as { capabilities: { executionSelection: number } };
  expect(health.capabilities.executionSelection).toBe(1);
  const post = async (fields: Record<string, unknown>) => fetch(`${origin}/api/v1/workspaces/${ws.workspaceId}/plannings/${planningId}/run`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID(), isolation: "shared", maxParallel: 1, expectedPlanHash: approved.draft.planHash, expectedDraftRevision: approved.draft.draftRevision, ...fields }) });
  const invalid = await post({ executionSelection: { defaults: { runnerId: "codex", prompt: "replace content" } } }); expect(invalid.status).toBe(400);
  const stale = await post({ expectedPlanHash: "stale" }); expect((await settled(service, await stale.json() as JobRecord)).status).toBe("failed"); expect(calls).toHaveLength(0);
  const taskId = approved.draft.plan.tasks.at(-1).task.id;
  const selection = { defaults: { runnerId: "claude-code", modelId: "deepseek-flash" }, tasks: [{ taskId, runnerId: "codex", modelId: "gpt-6-luna" }] };
  const response = await post({ executionSelection: selection }); expect(response.status).toBe(202);
  const completed = await settled(service, await response.json() as JobRecord); expect(completed.status, completed.error).toBe("succeeded");
  const result = await service.planningView(ws, planningId) as any;
  expect(result.draft).toEqual(approved.draft); expect(result.approval).toEqual(approved.approval);
  expect(result.session.status).toBe("succeeded"); expect(result.session.executionSelection).toEqual(selection);
  expect(calls).toHaveLength(approved.draft.plan.tasks.length);
  for (const task of result.session.tasks) {
    const expected = task.taskId === taskId ? selection.tasks[0] : selection.defaults;
    expect(task.execution).toMatchObject({ runnerId: expected!.runnerId, modelId: expected!.modelId });
    expect(task.currentAttempt.execution).toMatchObject({ runnerId: expected!.runnerId, modelId: expected!.modelId });
  }
}, 15_000);
