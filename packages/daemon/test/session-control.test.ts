import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runGit, SessionStore, type Runner } from "@token-coupon/core";
import { ApplicationService, type JobRecord } from "../src/application-service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function settled(service: ApplicationService, job: JobRecord) {
  let result = job;
  await expect.poll(async () => { result = await service.getJob(job.jobId); return result.status; }, { timeout: 5000 }).not.toBe("running");
  return result;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tc-control-")), workspace = join(root, "repo"); await mkdir(workspace);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await runGit(workspace, ["init", "--initial-branch=main"]);
  await runGit(workspace, ["config", "user.name", "Control Fixture"]); await runGit(workspace, ["config", "user.email", "control@example.invalid"]);
  await writeFile(join(workspace, "README.md"), "Control regression fixture\n"); await runGit(workspace, ["add", "README.md"]); await runGit(workspace, ["commit", "-m", "fixture"]);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); const calls: string[] = [];
  const service = new ApplicationService({ dataDirectory: join(root, "state"), createRunner: () => ({ id: "codex", supportsModel: true, checkAvailable: async () => {}, run: async (input, context) => {
    context.onStarted(); calls.push(input.task.id);
    if (calls.length === 1) await Promise.race([gate, new Promise<void>(resolve => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); })]);
    if (context.signal.aborted) return { started: true, exitCode: null, signal: "ABORTED", transport: "app-server", nativeOutcome: "cancelled", cleanupStatus: "completed" };
    context.onOutput({ stream: "stdout", text: input.completionMarker + "\n", agentText: input.completionMarker + "\n" });
    return { started: true, exitCode: 0, signal: null, transport: "app-server", nativeOutcome: "completed", cleanupStatus: "completed" };
  } } satisfies Runner) });
  cleanups.push(() => service.shutdown()); cleanups.push(async () => release());
  await service.initialize(); const ws = await service.addWorkspace(workspace);
  const start = await settled(service, await service.startPlanning(ws.workspaceId, randomUUID(), { provider: "mock", request: "增加问候函数并补充测试", executionDefaults: { runnerId: "codex", mode: "managed" } }));
  const planningId = (start.result as any).planningId;
  await settled(service, await service.review(ws.workspaceId, planningId, randomUUID()));
  const view = await service.planningView(ws, planningId) as any;
  const errors = view.review.findings.filter((f: any) => f.severity === "error").map((f: any) => f.findingId);
  expect((await settled(service, await service.approve(ws.workspaceId, planningId, randomUUID(), view.draft.draftRevision, errors, "验证暂停机制"))).status).toBe("succeeded");
  const run = await service.run(ws.workspaceId, planningId, randomUUID(), { isolation: "git-worktree", maxParallel: 1, verificationTaskId: view.draft.plan.tasks.at(-1).task.id });
  await expect.poll(() => calls.length, { timeout: 5000 }).toBe(1);
  const running = await service.planningView(ws, planningId) as any;
  return { service, ws, planningId, run, calls, release, sessionId: running.session.sessionId, workspace };
}

it("returns a persisted pause receipt before the long task finishes, survives view refresh, and resumes only pending tasks", async () => {
  const h = await fixture();
  const accepted = await settled(h.service, await h.service.controlSession(h.ws.workspaceId, h.planningId, randomUUID(), "pause"));
  expect(accepted.status, accepted.error).toBe("succeeded"); expect(accepted.result).toMatchObject({ phase: "requested", kind: "pause" });
  expect(h.calls).toHaveLength(1); expect((await h.service.getJob(h.run.jobId)).status).toBe("running");
  const requestId = (accepted.result as any).requestId;
  const repeat = await settled(h.service, await h.service.controlSession(h.ws.workspaceId, h.planningId, randomUUID(), "pause"));
  expect((repeat.result as any).requestId).toBe(requestId);
  await expect.poll(async () => (await h.service.planningView(h.ws, h.planningId) as any).session.status).toBe("pausing");
  const pending = await h.service.planningView(h.ws, h.planningId) as any;
  expect(pending.session.pendingControl).toMatchObject({ requestId, kind: "pause" });
  h.release(); expect((await settled(h.service, h.run)).status).toBe("succeeded");
  const paused = await h.service.planningView(h.ws, h.planningId) as any;
  expect(paused.session.status).toBe("paused"); expect(paused.session.controlState.acknowledgedAt).toBeTruthy(); expect(paused.session.pendingControl).toBeUndefined();
  expect(h.calls).toHaveLength(1);
  expect((await settled(h.service, await h.service.resume(h.ws.workspaceId, h.planningId, randomUUID()))).status).toBe("succeeded");
  expect(new Set(h.calls).size).toBe(h.calls.length);
  expect((await h.service.planningView(h.ws, h.planningId) as any).session.status).toBe("succeeded");
}, 15000);

it("lets cancellation supersede a draining pause and fences the old CLI waiter", async () => {
  const h = await fixture(), store = new SessionStore(h.workspace);
  const pause = await settled(h.service, await h.service.controlSession(h.ws.workspaceId, h.planningId, randomUUID(), "pause"));
  const cliOutcome = store.requestControl(h.sessionId, "pause", 3000).then(() => "ack", error => String(error));
  await expect.poll(async () => (await store.load(h.sessionId)).snapshot.status).toBe("pausing");
  const cancel = await settled(h.service, await h.service.controlSession(h.ws.workspaceId, h.planningId, randomUUID(), "cancel"));
  expect(cancel.status, cancel.error).toBe("succeeded"); expect((cancel.result as any).requestId).not.toBe((pause.result as any).requestId);
  expect(await cliOutcome).toContain("session_control_superseded");
  await settled(h.service, h.run);
  const stopped = (await store.load(h.sessionId)).snapshot;
  expect(stopped.status).toBe("cancelled"); expect(stopped.controlState?.kind).toBe("cancel"); expect(stopped.controlState?.acknowledgedAt).toBeTruthy(); expect(h.calls).toHaveLength(1);
}, 15000);
