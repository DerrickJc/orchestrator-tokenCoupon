import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { ApplicationService, type JobRecord } from "../src/application-service.js";
import { SessionStore, type Runner, type TaskRunnerFactory } from "@token-coupon/core";
const roots: string[] = [], services: ApplicationService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function waitJob(service: ApplicationService, job: JobRecord) { for (let n = 0; n < 200; n++) { const state = await service.getJob(job.jobId); if (state.status !== "running") return state; await delay(20); } throw new Error("job did not settle"); }
async function fixture(cleanup: "completed" | "unknown" = "completed") {
  const root = await mkdtemp(join(tmpdir(), "model-switch-")); roots.push(root); const workspace = join(root, "project"); await mkdir(workspace);
  const calls: Array<{ id: string; model?: string; attemptId: string }> = []; let first = true;
  const createRunner: TaskRunnerFactory = () => ({ id: "codex", supportsModel: true, checkAvailable: async () => undefined,
    run: async (input, context) => {
      context.onStarted(); calls.push({ id: input.task.id, model: input.execution.modelId, attemptId: input.attemptId });
      if (first) { first = false; await writeFile(join(input.cwd, "partial.txt"), "preserve this work"); await new Promise<void>(resolve => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); }); return { started: true, exitCode: null, signal: null, transport: "app-server", nativeOutcome: "cancelled", cleanupStatus: cleanup }; }
      context.onOutput({ stream: "stdout", text: `完成结论：使用 ${input.execution.modelId}\n${input.completionMarker}\n`, agentText: `${input.completionMarker}\n`, finalText: `完成结论：使用 ${input.execution.modelId}` });
      return { started: true, exitCode: 0, signal: null, transport: "app-server", nativeOutcome: "completed", cleanupStatus: "completed" };
    },
  } satisfies Runner);
  const service = new ApplicationService({ dataDirectory: join(root, "daemon"), createRunner }); services.push(service); await service.initialize();
  const ws = await service.addWorkspace(workspace), started = await waitJob(service, await service.startPlanning(ws.workspaceId, randomUUID(), { provider: "mock", request: "增加问候函数和测试", executionDefaults: { runnerId: "codex", mode: "managed", modelId: "fast" } }));
  expect(started.status).toBe("succeeded"); const planningId = (started.result as any).planningId;
  await waitJob(service, await service.review(ws.workspaceId, planningId, randomUUID()));
  const plan = await service.planningView(ws, planningId) as any;
  const errors = plan.review.findings.filter((finding: any) => finding.severity === "error").map((finding: any) => finding.findingId);
  expect((await waitJob(service, await service.approve(ws.workspaceId, planningId, randomUUID(), plan.draft.draftRevision, errors, "测试验证执行机制"))).status).toBe("succeeded");
  const run = await service.run(ws.workspaceId, planningId, randomUUID(), { isolation: "shared", maxParallel: 1 });
  await expect.poll(() => calls.length).toBe(1);
  const view = await service.planningView(ws, planningId) as any;
  return { service, ws, root, workspace, planningId, run, view, calls };
}
it("changes a running task through a confirmed stop and new Attempt, preserving work, draft and later resume", async () => {
  const h = await fixture(), task = h.view.session.tasks[0];
  const request = randomUUID(), input = { taskId: task.taskId, modelId: "smart", expectedRevision: 0, stopAndRetry: true, expectedAttemptId: task.activeAttemptId };
  const switchJob = await h.service.changeTaskModel(h.ws.workspaceId, h.planningId, request, input);
  const switched = await waitJob(h.service, switchJob); expect(switched.status).toBe("succeeded"); expect((switched.result as any).status).toBe("succeeded");
  expect((await h.service.changeTaskModel(h.ws.workspaceId, h.planningId, request, input)).jobId).toBe(switchJob.jobId);
  expect(h.calls.map(call => call.model)).toEqual(["fast", "smart"]); expect(h.calls[0]!.attemptId).not.toBe(h.calls[1]!.attemptId);
  expect(await readFile(join(h.workspace, "partial.txt"), "utf8")).toBe("preserve this work");
  const after = await h.service.planningView(h.ws, h.planningId) as any;
  expect(after.draft.planHash).toBe(h.view.draft.planHash); expect(after.approval).toEqual(h.view.approval); expect(after.session.models.revision).toBe(1);
  const original = await new SessionStore(h.workspace).readAttempt(task.activeAttemptId) as any; expect(original.status).toBe("cancelled");
  expect((await waitJob(h.service, await h.service.resume(h.ws.workspaceId, h.planningId, randomUUID()))).status).toBe("succeeded");
  expect(h.calls.map(call => call.model)).toEqual(["fast", "smart", "fast"]);
  expect((await h.service.planningView(h.ws, h.planningId) as any).session.status).toBe("succeeded");
});
it("rejects a stale Attempt target and does not stop the actual task", async () => {
  const h = await fixture();
  const result = await waitJob(h.service, await h.service.changeTaskModel(h.ws.workspaceId, h.planningId, randomUUID(), { taskId: h.view.session.tasks[0].taskId, modelId: "smart", expectedRevision: 0, stopAndRetry: true, expectedAttemptId: randomUUID() }));
  expect(result.status).toBe("failed"); expect(result.error).toContain("owner_unavailable"); expect(h.calls).toHaveLength(1);
  expect((await h.service.planningView(h.ws, h.planningId) as any).session.status).toBe("running");
});
it("records a future model without interrupting the current Attempt and refuses stale configuration", async () => {
  const h = await fixture(), taskId = h.view.session.tasks[0].taskId;
  expect((await waitJob(h.service, await h.service.changeTaskModel(h.ws.workspaceId, h.planningId, randomUUID(), { taskId, modelId: "smart", expectedRevision: 0, stopAndRetry: false }))).status).toBe("succeeded");
  expect(h.calls).toHaveLength(1); expect((await h.service.planningView(h.ws, h.planningId) as any).session.status).toBe("running");
  const stale = await waitJob(h.service, await h.service.changeTaskModel(h.ws.workspaceId, h.planningId, randomUUID(), { taskId, modelId: "other", expectedRevision: 0, stopAndRetry: false }));
  expect(stale.status).toBe("failed"); expect(stale.error).toContain("session_models_changed");
});
it("stops but does not automatically retry when native cleanup is unconfirmed", async () => {
  const h = await fixture("unknown"), task = h.view.session.tasks[0];
  const result = await waitJob(h.service, await h.service.changeTaskModel(h.ws.workspaceId, h.planningId, randomUUID(), { taskId: task.taskId, modelId: "smart", expectedRevision: 0, stopAndRetry: true, expectedAttemptId: task.activeAttemptId }));
  expect(result.status).toBe("failed"); expect(result.error).toContain("cleanup_unconfirmed"); expect(h.calls).toHaveLength(1);
  expect((await h.service.planningView(h.ws, h.planningId) as any).session.models.overrides[task.taskId].modelId).toBe("smart");
});
