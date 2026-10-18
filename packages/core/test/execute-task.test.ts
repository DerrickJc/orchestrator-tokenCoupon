import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTask } from "../src/execute-task.js";
import { MockRunner } from "../src/runners/mock-runner.js";
import type { Runner } from "../src/runner.js";
import type { TaskDefinition } from "../src/task.js";
import { parseTask } from "../src/validate-task.js";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "token-coupon-phase1-"));
  roots.push(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function task(timeoutMs = 2000): TaskDefinition {
  return {
    schemaVersion: 1,
    id: "test-task",
    title: "test",
    prompt: "Do the test task",
    execution: { runnerId: "mock", mode: "non_interactive", timeoutMs },
  };
}

describe("executeTask", () => {
  it("keeps the BIZ-01 approved task intact while supplying host-owned execution identity and preserving real approvals", async () => {
    const definition = parseTask(JSON.parse(await readFile(new URL("./fixtures/biz01-design-task.json", import.meta.url), "utf8")));
    const original = JSON.stringify(definition), cwd = await workspace();
    let approvalCalls = 0;
    const runner: Runner = { id: "codex", supportsModel: true, checkAvailable: async () => undefined, run: async (input, context) => {
      expect(input.executionInstructions).toContain("你就是编排器已经启动的本机 Runner");
      expect(input.executionInstructions).toContain(input.attemptId);
      expect(input.executionInstructions).toContain(cwd);
      expect(input.prompt.indexOf(input.executionInstructions!)).toBe(0);
      expect(input.prompt).toContain("须经 4177 批准后由本机 Runner 执行");
      expect(input.prompt).toContain("本上下文不授予额外工具权限");
      expect(input.prompt).toContain("只完成当前任务的目标");
      context.onStarted();
      const decision = await context.requestInteraction!({ kind: "approval", title: "命令审批", summary: "写入文档", operation: { kind: "command", command: "write design" } });
      expect(decision).toMatchObject({ kind: "approval", decision: "deny" });
      context.onOutput({ stream: "stdout", text: `缺少实际操作批准\n${input.needsInputMarker}\n`, agentText: `缺少实际操作批准\n${input.needsInputMarker}\n` });
      return { started: true, exitCode: 0, signal: null };
    } };
    const result = await executeTask({ task: definition, cwd, runner, onInteraction: async () => { approvalCalls++; return { kind: "approval", decision: "deny" }; } });
    expect(approvalCalls).toBe(1);
    expect(result.attempt).toMatchObject({ status: "needs_input", reasonCode: "user_input_required" });
    expect(JSON.stringify(definition)).toBe(original);
    expect(await readFile(join(result.artifactDir, "prompt.txt"), "utf8")).toContain("不要调用 workspace_query");
  });
  it("persists readable deltas and final text even when displayText suppresses duplicate console output", async () => {
    const runner: Runner = { id: "mock", supportsModel: false, checkAvailable: async () => undefined, run: async (input, context) => {
      context.onStarted();
      context.onOutput({ stream: "stdout", text: "raw protocol", agentText: "完整正文\n", displayText: "完整正文" });
      context.onOutput({ stream: "stdout", text: "", displayText: "", finalText: "最终返回".repeat(2000) });
      context.onOutput({ stream: "stdout", text: input.completionMarker, agentText: input.completionMarker });
      return { started: true, exitCode: 0, signal: null };
    } };
    const result = await executeTask({ task: task(), cwd: await workspace(), runner });
    const events = (await readFile(join(result.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.payload?.finalText)?.payload).toMatchObject({ text: "", displayText: "", finalText: "最终返回".repeat(2000) });
    expect(events.find(event => event.payload?.agentText === "完整正文\n")?.payload.text).toBe("raw protocol");
    expect(result.attempt.status).toBe("succeeded");
  });
  it("records one successful attempt with isolated artifacts", async () => {
    const cwd = await workspace();
    const result = await executeTask({ task: task(), cwd, runner: new MockRunner() });
    expect(result.attempt.status).toBe("succeeded");
    expect(result.attempt.markerSeen).toBe(true);
    expect(result.attempt.exitCode).toBe(0);
    expect(result.attempt.startedAt).not.toBeNull();
    const snapshot = JSON.parse(await readFile(join(result.artifactDir, "attempt.json"), "utf8")) as { status: string };
    expect(snapshot.status).toBe("succeeded");
    const events = (await readFile(join(result.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; type: string });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)?.type).toBe("attempt.finished");
  });

  it.each([
    ["missing-marker", "completion_marker_missing"],
    ["old-marker", "completion_marker_missing"],
    ["stderr-marker", "completion_marker_missing"],
    ["quoted-marker", "completion_marker_missing"],
    ["marker-nonzero", "process_exit_nonzero"],
  ])("rejects %s (%s)", async (scenario, reasonCode) => {
    const result = await executeTask({ task: task(), cwd: await workspace(), runner: new MockRunner(scenario) });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.reasonCode).toBe(reasonCode);
  });

  it("does not terminate an attempt when its legacy total-time field elapses", async () => {
    const runner: Runner = {
      id: "mock", supportsModel: false, checkAvailable: async () => undefined,
      run: async (input, context) => {
        context.onStarted();
        await new Promise((resolve) => setTimeout(resolve, 120));
        context.onOutput({ stream: "stdout", text: input.completionMarker, agentText: input.completionMarker });
        return { started: true, exitCode: 0, signal: null };
      },
    };
    const result = await executeTask({ task: task(40), cwd: await workspace(), runner });
    expect(result.attempt.status).toBe("succeeded");
    expect(result.attempt.executionPolicy).toEqual({ mode: "idle_notice", idleAfterMs: 60_000 });
  });

  it("records idle and active transitions without stopping the attempt", async () => {
    vi.useFakeTimers();
    try {
      let ready!: (context: import("../src/runner.js").RunnerContext) => void;
      let finish!: (result: import("../src/runner.js").ProcessResult) => void;
      let marker = "";
      const contextReady = new Promise<import("../src/runner.js").RunnerContext>((resolve) => { ready = resolve; });
      const idleTransitions: Array<{ idle: boolean; idleSince: string | null }> = [];
      const runner: Runner = {
        id: "mock", supportsModel: false, checkAvailable: async () => undefined,
        run: (input, context) => {
          marker = input.completionMarker;
          context.onStarted();
          ready(context);
          return new Promise((resolve) => { finish = resolve; });
        },
      };
      const execution = executeTask({
        task: task(80), cwd: await workspace(), runner,
        onIdleState: ({ idle, idleSince }) => idleTransitions.push({ idle, idleSince }),
      });
      const context = await contextReady;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(idleTransitions).toHaveLength(1);
      expect(idleTransitions[0]?.idle).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(idleTransitions).toHaveLength(1);
      context.onActivity?.();
      await Promise.resolve();
      expect(idleTransitions[1]).toMatchObject({ idle: false, idleSince: null });
      context.onOutput({ stream: "stdout", text: marker, agentText: marker });
      finish({ started: true, exitCode: 0, signal: null });
      const result = await execution;
      expect(result.attempt.status).toBe("succeeded");
      const events = (await readFile(join(result.artifactDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
      expect(events.filter(({ type }) => type === "attempt.idle")).toHaveLength(1);
      expect(events.filter(({ type }) => type === "attempt.active")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("cancels a running runner and records the cancelled terminal state", async () => {
    const controller = new AbortController();
    const execution = executeTask({ task: task(), cwd: await workspace(), runner: new MockRunner("hang"), signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    const result = await execution;
    expect(result.attempt.status).toBe("cancelled");
    expect(result.attempt.reasonCode).toBe("user_cancelled");
  });

  it("does not treat a completion marker as success if cancellation follows it", async () => {
    const controller = new AbortController();
    const result = await executeTask({ task: task(), cwd: await workspace(), runner: new MockRunner("marker-then-hang"), signal: controller.signal,
      // Observe the prerequisite instead of assuming the child starts within 80 ms.
      onOutput: output => { if (output.agentText?.includes("<<<TOKEN_COUPON_DONE:")) controller.abort(); },
    });
    expect(result.attempt.markerSeen).toBe(true);
    expect(result.attempt.status).toBe("cancelled");
  });

  it("records a runner start failure without hanging", async () => {
    const runner: Runner = {
      id: "missing-runner", supportsModel: false, checkAvailable: async () => undefined,
      run: async () => ({ started: false, exitCode: null, signal: null, startError: { code: "ENOENT", message: "runner missing" } }),
    };
    const result = await executeTask({ task: task(), cwd: await workspace(), runner });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.reasonCode).toBe("runner_start_failed");
    expect(result.attempt.startedAt).toBeNull();
  });

  it("stops execution when the bounded event log queue is exceeded", async () => {
    const runner: Runner = {
      id: "mock", supportsModel: false, checkAvailable: async () => undefined,
      run: async (_input, context) => {
        context.onStarted();
        const stopped = new Promise<import("../src/runner.js").ProcessResult>((resolve) => {
          context.signal.addEventListener("abort", () => resolve({ started: true, exitCode: null, signal: "SIGTERM" }), { once: true });
        });
        for (let index = 0; index < 20; index += 1) {
          context.onOutput({ stream: "stdout", text: "x".repeat(64 * 1024), agentText: "x".repeat(64 * 1024) });
        }
        return stopped;
      },
    };
    const result = await executeTask({ task: task(), cwd: await workspace(), runner });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.reasonCode).toBe("recording_failed");
  });

  it("stops the mock runner child process group on cancellation", async () => {
    const controller = new AbortController();
    let childPid: number | undefined;
    const execution = executeTask({
      task: task(), cwd: await workspace(), runner: new MockRunner("spawn-child"), signal: controller.signal,
      onOutput: ({ text }) => { childPid ??= Number(/child:(\d+)/.exec(text)?.[1]); },
    });
    const cancelTimer = setTimeout(() => controller.abort(), 100);
    const result = await execution;
    clearTimeout(cancelTimer);
    expect(result.attempt.status).toBe("cancelled");
    expect(childPid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(() => process.kill(childPid!, 0)).toThrow();
  });

  it("does not start the runner when artifact creation fails", async () => {
    const cwd = await workspace();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(cwd, ".token-coupon"), "block directory creation"));
    let invoked = false;
    const runner = new MockRunner();
    const wrapped: Runner = {
      id: runner.id,
      supportsModel: runner.supportsModel,
      checkAvailable: () => runner.checkAvailable(),
      run: (input, context) => { invoked = true; return runner.run(input, context); },
    };
    await expect(executeTask({ task: task(), cwd, runner: wrapped })).rejects.toThrow();
    expect(invoked).toBe(false);
  });
});
