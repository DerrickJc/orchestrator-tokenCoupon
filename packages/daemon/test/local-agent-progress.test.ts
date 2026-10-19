import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { MockPlanner, PlannerStore } from "@token-coupon/core";
import { ApplicationService } from "../src/application-service.js";
import { LocalAgentPlanner } from "../src/local-agent-planner.js";
import { createLocalServer } from "../src/http-server.js";
import { plannerReplyPreview, redactPlannerText } from "../src/planning-progress.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";

const control = vi.hoisted(() => ({ run: null as any, settings: [] as any[], calls: 0 }));
vi.mock("@token-coupon/core", async importOriginal => ({ ...await importOriginal<any>(), createDefaultRunnerRegistry: () => ({ resolve: (_task: any, _profile: any, settings: any) => {
  control.settings.push(settings);
  return { runner: { checkAvailable: async () => undefined, run: async (input: any, context: any) => { control.calls++; return control.run(input, context); } } };
} }) }));
const roots: string[] = [], services: ApplicationService[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(services.splice(0).map(service => service.shutdown())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); control.calls = 0; control.settings = []; });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tc-agent-progress-")); roots.push(root); const path = join(root, "project"); await mkdir(path);
  const service = new ApplicationService({ dataDirectory: join(root, "state") }); services.push(service); await service.initialize();
  const workspace = await service.addWorkspace(path, "Agent progress"); return { root, service, workspace };
}
async function finish(service: ApplicationService, jobId: string) {
  await expect.poll(async () => (await service.getJob(jobId)).status).not.toBe("running"); return service.getJob(jobId);
}
function success() { return { started: true, exitCode: 0, signal: null, nativeOutcome: "completed", cleanupStatus: "completed", reportedModel: "fixture-fast" }; }
async function validReply(runnerInput: any) {
  const input = JSON.parse(runnerInput.prompt.split("\n").find((line: string) => line.startsWith('{"messages":')));
  const source = input.pendingMessages.at(-1), value: any = await new MockPlanner().generate(input, {} as any);
  value.planningAssessment = { schemaVersion: 2, profile: "general", classification: { rationale: "简单问候函数", sourceMessageId: source.messageId, quote: source.content }, decisions: [] };
  value.requirementsUpdate = { messageDecisions: [{ messageId: source.messageId, kind: "requirement", reason: "用户需求" }], changes: [{ requirementId: "R-greet", text: source.content, status: "active", sourceMessageIds: [source.messageId] }] };
  return value;
}

it("publishes bounded live output, persists its model and raw reply, and exposes progress through the Plan", async () => {
  const { root, service, workspace } = await setup(), events: any[] = []; service.subscribe(event => events.push(event));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  control.run = async (input: any, context: any) => {
    context.onStarted(); await context.recordEvent({ type: "runner.native.started", threadId: "t", turnId: "r", reportedModel: "fixture-fast", modelProvider: "test" });
    const value = await validReply(input), text = JSON.stringify(value);
    for (const fragment of [text.slice(0, 160), text.slice(160, 300), text.slice(300)]) context.onOutput({ stream: "stdout", text: fragment, agentText: fragment });
    await held; context.onOutput({ stream: "stdout", text: "", finalText: text }); return success();
  };
  const job = await service.startPlanning(workspace.workspaceId, randomUUID(), { request: "增加问候函数和测试", provider: "codex-agent", model: "fixture-fast", executionDefaults: { runnerId: "mock", mode: "managed" } });
  await expect.poll(async () => (await service.getJob(job.jobId)).progress?.stage).toBe("receiving");
  const active = await service.getJob(job.jobId); expect(active.progress?.reportedModel).toBe("fixture-fast"); expect(active.planningId).toBeTruthy();
  expect((JSON.parse(await readFile(join(root, "state", "jobs", `${job.jobId}.json`), "utf8"))).progress.stage).toBe("receiving");
  expect((await service.planningView(workspace, active.planningId!) as any).localOperation.jobId).toBe(job.jobId);
  release(); const done = await finish(service, job.jobId);
  expect(done.status, done.error).toBe("succeeded"); expect(done.progress?.stage).toBe("completed");
  const snapshot = await new PlannerStore(workspace.path).load(done.planningId!);
  const raw = JSON.parse(await readFile(join(snapshot.turns[0]!.artifactDir, "calls", "0001.response.json"), "utf8"));
  expect(raw.text).toContain('"kind":"draft"');
  const mcp = createMcpServer(service), client = new Client({ name: "progress-privacy-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await mcp.connect(remote); await client.connect(local);
  try {
    const plan = await client.callTool({ name: "planning_query", arguments: { workspaceId: workspace.workspaceId, planningId: done.planningId } });
    const operation = await client.callTool({ name: "operation_query", arguments: { workspaceId: workspace.workspaceId, jobId: job.jobId } });
    expect(JSON.parse((plan.content as any[])[0].text)).not.toHaveProperty("localOperation");
    expect(JSON.parse((operation.content as any[])[0].text)).not.toHaveProperty("progress");
  } finally { await client.close(); await mcp.close(); }
  expect(events.filter(event => event.type === "planning.progress" && event.payload.progress.stage === "receiving").length).toBeLessThan(5);
  expect(control.settings[0]).toMatchObject({ sandbox: "read-only", disableMcp: true });
});

it("does not retry initialization faults as JSON and preserves failure identity", async () => {
  const { service, workspace } = await setup();
  control.run = async () => ({ ...success(), nativeOutcome: "failed", executionError: "Codex app-server 请求超时：initialize" });
  const job = await service.startPlanning(workspace.workspaceId, randomUUID(), { request: "增加问候函数", provider: "codex-agent", executionDefaults: { runnerId: "mock", mode: "managed" } });
  const failed = await finish(service, job.jobId);
  expect(control.calls).toBe(1); expect(failed.status).toBe("failed"); expect(failed.planningId).toBeTruthy(); expect(failed.progress?.stage).toBe("failed");
  const snapshot = await new PlannerStore(workspace.path).load(failed.planningId!);
  expect(snapshot.turns.at(-1)?.reasonCode).toBe("local_agent_initialization_failed");
});

it("retains only readable assistant content, redacts secrets and denies interactive tools during planning", async () => {
  const { service, workspace } = await setup(); const old = process.env.TOKEN_COUPON_PROGRESS_TEST_SECRET; process.env.TOKEN_COUPON_PROGRESS_TEST_SECRET = "private-fixture-key";
  try {
    control.run = async (input: any, context: any) => {
      context.onStarted();
      expect(await context.requestInteraction({ kind: "approval", title: "write", summary: "write" })).toMatchObject({ kind: "approval", decision: "deny" });
      context.onOutput({ stream: "stderr", text: "stderr is not a model reply" });
      const value = await validReply(input); value.message = "只读规划已完成 private-fixture-key";
      context.onOutput({ stream: "stdout", text: "", finalText: JSON.stringify(value) }); return success();
    };
    const job = await service.startPlanning(workspace.workspaceId, randomUUID(), { request: "增加问候函数", provider: "claude-agent", model: "fixture-fast", executionDefaults: { runnerId: "mock", mode: "managed" } });
    const done = await finish(service, job.jobId);
    expect(done.status, done.error).toBe("succeeded"); expect(done.progress?.replyPreview).toContain("[已隐藏]");
    expect(JSON.stringify(done.progress)).not.toContain("private-fixture-key"); expect(JSON.stringify(done.progress)).not.toContain("stderr is not");
    expect(control.settings[0]).toMatchObject({ permissionMode: "plan", allowedTools: [], strictMcpConfig: true });
    expect(plannerReplyPreview('{"message":"先确认范围"')).toBe("先确认范围");
    expect(redactPlannerText('{"access_token":"abc"}')).not.toContain("abc");
  } finally { if (old === undefined) delete process.env.TOKEN_COUPON_PROGRESS_TEST_SECRET; else process.env.TOKEN_COUPON_PROGRESS_TEST_SECRET = old; }
});

it("reports silent-call heartbeats without pretending they are model output and stops them after cancellation", async () => {
  let entered!: () => void; const running = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController(), events: any[] = [];
  control.run = async (_input: any, context: any) => {
    context.onStarted(); entered();
    return new Promise(resolve => context.signal.addEventListener("abort", () => resolve({ ...success(), nativeOutcome: "cancelled" }), { once: true }));
  };
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const adapter = new LocalAgentPlanner({ provider: "codex-agent", model: "runner-default", baseUrl: "agent://codex" }, process.cwd());
  const pending = adapter.generate({ messages: [{ role: "user", content: "增加问候函数" }], executionDefaults: { runnerId: "mock", mode: "managed" } }, {
    signal: controller.signal, repository: {} as any, consumeApiRequest: () => 1, consumeToolCall() {}, record: async event => { events.push(event); },
  }).then(() => "unexpected success", error => error.message);
  await running; await vi.advanceTimersByTimeAsync(75_000);
  expect(events.filter(event => event.type === "agent.heartbeat")).toHaveLength(5);
  expect(events.some(event => event.type === "agent.output")).toBe(false);
  controller.abort(new Error("用户取消静默规划")); expect(await pending).toContain("用户取消静默规划");
  const count = events.length; await vi.advanceTimersByTimeAsync(60_000); expect(events).toHaveLength(count);
});

it("serves authenticated progress, cancels a held call and preserves its record across restart", async () => {
  const { root, service, workspace } = await setup();
  control.run = async (_input: any, context: any) => {
    context.onStarted(); await context.recordEvent({ type: "runner.native.started", threadId: "t", turnId: "r" });
    return new Promise(resolve => context.signal.addEventListener("abort", () => resolve({ ...success(), nativeOutcome: "cancelled" }), { once: true }));
  };
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as any).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory: join(root, "state") });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`, landing = await fetch(origin), cookie = landing.headers.getSetCookie()[0]!.split(";")[0]!;
    const job = await service.startPlanning(workspace.workspaceId, randomUUID(), { request: "增加问候函数", provider: "codex-agent", executionDefaults: { runnerId: "mock", mode: "managed" } });
    await expect.poll(async () => (await service.getJob(job.jobId)).progress?.stage).toBe("waiting_model");
    expect((await fetch(`${origin}/api/v1/jobs/${job.jobId}`)).status).toBe(403);
    const remote = await fetch(`${origin}/api/v1/jobs/${job.jobId}`, { headers: { Cookie: cookie } }).then(r => r.json());
    expect(remote.progress.stage).toBe("waiting_model");
    const response = await fetch(`${origin}/api/v1/jobs/${job.jobId}/cancel`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.workspaceId }) });
    expect(response.status).toBe(200);
    const cancelled = await finish(service, job.jobId); expect(cancelled.status).toBe("cancelled"); expect(cancelled.error).toContain("由用户在控制台取消");
    await service.shutdown();
    const crashedId = randomUUID();
    await writeFile(join(root, "state", "jobs", `${crashedId}.json`), JSON.stringify({ ...cancelled, jobId: crashedId, status: "running", progress: { ...cancelled.progress, stage: "waiting_model" } }));
    const restored = new ApplicationService({ dataDirectory: join(root, "state") }); services.push(restored); await restored.initialize();
    expect((await restored.getJob(job.jobId)).planningId).toBe(cancelled.planningId); expect(control.calls).toBe(1);
    expect((await restored.getJob(job.jobId)).status).toBe("cancelled");
    expect((await restored.getJob(crashedId)).status).toBe("interrupted"); expect((await restored.getJob(crashedId)).error).toContain("不会自动重放");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
