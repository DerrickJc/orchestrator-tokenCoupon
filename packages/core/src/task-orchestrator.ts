import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import type { PlanDefinition, PlannedTask } from "./plan.js";
import { PlanStore, sessionStatusFor } from "./plan-store.js";
import { executeTask } from "./execute-task.js";
import type { Runner, RunnerOutput } from "./runner.js";
import type { SessionRecord, SessionSnapshot, SessionTaskState, TaskResult } from "./session-types.js";
import { SessionLockError, SessionStore } from "./session-store.js";
import type { TaskDefinition } from "./task.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_LIMIT = 8 * 1024;
const PROMPT_CONTEXT_LIMIT = 24 * 1024;
const COLLECT_LIMIT = 64 * 1024;
const ALLOWED_MOCK_SCENARIOS = new Set(["success", "missing-marker", "marker-nonzero", "old-marker", "stderr-marker", "quoted-marker", "large-output", "hang", "marker-then-hang", "spawn-child"]);

export interface TaskRunnerFactoryOptions {
  acceptEdits?: boolean;
  mockScenario?: string;
}

export type TaskRunnerFactory = (task: TaskDefinition, options: TaskRunnerFactoryOptions) => Runner;

export interface PlanRunOptions {
  plan: PlanDefinition;
  workspace: string;
  createRunner: TaskRunnerFactory;
  signal?: AbortSignal;
  acceptEdits?: boolean;
  mockTaskScenarios?: Map<string, string>;
  onOutput?: (taskId: string, output: RunnerOutput) => void;
}

export interface SessionOperationOptions {
  sessionId: string;
  workspace: string;
  createRunner: TaskRunnerFactory;
  signal?: AbortSignal;
  acceptEdits?: boolean;
  mockTaskScenarios?: Map<string, string>;
  onOutput?: (taskId: string, output: RunnerOutput) => void;
}

type ExecutionOptions = Pick<SessionOperationOptions, "workspace" | "createRunner" | "signal" | "acceptEdits" | "mockTaskScenarios" | "onOutput">;

export interface RetryOptions extends SessionOperationOptions { taskId: string; }

export interface SessionOperationResult {
  snapshot: SessionSnapshot;
  operationStatus?: "succeeded" | "failed" | "cancelled" | "timed_out";
}

export function validateMockTaskScenarios(plan: PlanDefinition, scenarios: Map<string, string>): void {
  const tasks = new Map(plan.tasks.map((entry) => [entry.task.id, entry.task]));
  for (const [taskId, scenario] of scenarios) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Mock 场景映射引用了未知任务：${taskId}`);
    if (task.execution.runnerId !== "mock") throw new Error(`Mock 场景只能指定给 Mock 任务：${taskId}`);
    if (!ALLOWED_MOCK_SCENARIOS.has(scenario)) throw new Error(`未知 Mock 场景：${scenario}`);
  }
}

export async function runPlan(options: PlanRunOptions): Promise<SessionOperationResult> {
  if (options.plan.tasks.length === 0) throw new Error("空计划不能执行");
  validateMockTaskScenarios(options.plan, options.mockTaskScenarios ?? new Map());
  await checkRunners(options.plan.tasks, options);
  const store = new SessionStore(options.workspace);
  const release = await store.acquireLock();
  try {
    const record = await store.create(options.plan);
    return await schedule(record, store, options);
  } finally {
    await release();
  }
}

export async function resumeSession(options: SessionOperationOptions): Promise<SessionOperationResult> {
  const store = new SessionStore(options.workspace);
  const release = await store.acquireLock(options.sessionId);
  try {
    const record = await store.load(options.sessionId);
    validateMockTaskScenarios(record.plan, options.mockTaskScenarios ?? new Map());
    const current = await reconcile(record, store);
    const unresolved = current.snapshot.tasks.filter((state) => ["failed", "timed_out", "cancelled", "interrupted", "blocked"].includes(state.status));
    if (unresolved.length > 0) throw new Error(`Session 尚有未解决的任务，先用 session retry 指定目标：${unresolved.map((state) => `${state.taskId}(${state.status})`).join(", ")}`);
    await checkRunners(pendingTasks(current), options);
    return await schedule(current, store, options);
  } finally {
    await release();
  }
}

export async function retrySession(options: RetryOptions): Promise<SessionOperationResult> {
  const store = new SessionStore(options.workspace);
  const release = await store.acquireLock(options.sessionId);
  try {
    const record = await store.load(options.sessionId);
    validateMockTaskScenarios(record.plan, options.mockTaskScenarios ?? new Map());
    const current = await reconcile(record, store);
    const entry = current.plan.tasks.find(({ task }) => task.id === options.taskId);
    const state = current.snapshot.tasks.find(({ taskId }) => taskId === options.taskId);
    if (!entry || !state) throw new Error(`Session 中不存在任务：${options.taskId}`);
    if (!["failed", "timed_out", "cancelled", "interrupted"].includes(state.status)) throw new Error(`任务 ${options.taskId} 当前状态 ${state.status} 不允许重试`);
    const stateById = new Map(current.snapshot.tasks.map((item) => [item.taskId, item]));
    if (!entry.dependsOn.every((id) => stateById.get(id)?.status === "succeeded")) throw new Error(`任务 ${options.taskId} 的前置依赖尚未成功`);
    await checkRunners([entry], options);
    const taskStore = new PlanStore(current.plan, current.snapshot);
    return await schedule(current, store, options, { taskId: options.taskId, allowRetry: true, taskStore });
  } finally {
    await release();
  }
}

export function formatSession(snapshot: SessionSnapshot, plan: PlanDefinition): string {
  const lines = [
    `Session：${snapshot.sessionId}`,
    `计划：${snapshot.planId} — ${snapshot.planTitle}`,
    `状态：${snapshot.status}；revision：${snapshot.revision}`,
    `工作目录：${snapshot.workspace}`,
    "任务：",
  ];
  for (const [index, entry] of plan.tasks.entries()) {
    const state = snapshot.tasks[index]!;
    lines.push(`  ${entry.task.id} — ${entry.task.title}：${state.status}`);
    lines.push(`    依赖：${entry.dependsOn.length ? entry.dependsOn.join(", ") : "无"}`);
    for (const attempt of state.attempts) lines.push(`    Attempt ${attempt.attemptId}：${attempt.outcome}；${attempt.artifactDir}`);
    if (state.reasonCode) lines.push(`    原因：${state.reasonCode}`);
    if (state.result) lines.push(`    结果：${state.result.summary || "无文本摘要"}${state.result.truncated ? "（已截断）" : ""}`);
  }
  return lines.join("\n");
}

async function schedule(record: SessionRecord, store: SessionStore, options: ExecutionOptions, retry?: { taskId: string; allowRetry: true; taskStore: PlanStore }): Promise<SessionOperationResult> {
  let snapshot = record.snapshot;
  let states = snapshot.tasks;
  const planStore = retry?.taskStore ?? new PlanStore(record.plan, snapshot);
  const save = async (nextStates: SessionTaskState[], status: SessionSnapshot["status"]) => {
    const next: SessionSnapshot = { ...snapshot, revision: snapshot.revision + 1, status, tasks: nextStates, updatedAt: new Date().toISOString() };
    await store.save(next);
    snapshot = next;
    states = nextStates;
  };

  if (retry) {
    const attemptId = randomUUID();
    const entry = record.plan.tasks.find(({ task }) => task.id === retry.taskId)!;
    const reserved = planStore.beginAttempt(retry.taskId, attemptId, attemptDirectory(store.workspace, attemptId), retry.allowRetry);
    await save(reserved, "running");
    await runOne(entry, attemptId, states, store, options, async (status, reasonCode, result, recorded) => {
      let finished = planStore.finishAttempt(retry.taskId, attemptId, status, reasonCode, result, states);
      if (!recorded) finished = finished.map((item) => item.taskId === retry.taskId ? { ...item, attempts: item.attempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, outcome: "record_missing" as const } : attempt) } : item);
      const sessionStatus = status === "cancelled" ? "cancelled" : sessionStatusFor(finished);
      await save(finished, sessionStatus);
    });
    const retryState = states.find((item) => item.taskId === retry.taskId);
    return { snapshot, operationStatus: retryState?.status === "succeeded" ? "succeeded" : retryState?.status === "timed_out" ? "timed_out" : retryState?.status === "cancelled" ? "cancelled" : "failed" };
  }

  if (states.length > 0 && states.every((state) => state.status === "succeeded")) {
    if (snapshot.status !== "succeeded") await save(states, "succeeded");
    return { snapshot };
  }

  while (!options.signal?.aborted) {
    const freshStore = new PlanStore(record.plan, snapshot);
    const entry = freshStore.nextRunnable(states);
    if (!entry) break;
    const attemptId = randomUUID();
    const reserved = freshStore.beginAttempt(entry.task.id, attemptId, attemptDirectory(store.workspace, attemptId));
    await save(reserved, "running");
    await runOne(entry, attemptId, states, store, options, async (status, reasonCode, result, recorded) => {
      const after = new PlanStore(record.plan, snapshot);
      let finished = after.finishAttempt(entry.task.id, attemptId, status, reasonCode, result, states);
      if (!recorded) finished = finished.map((item) => item.taskId === entry.task.id ? { ...item, attempts: item.attempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, outcome: "record_missing" as const } : attempt) } : item);
      await save(finished, status === "cancelled" ? "cancelled" : sessionStatusFor(finished));
    });
    const state = states.find((item) => item.taskId === entry.task.id);
    if (state?.status !== "succeeded") break;
  }

  if (states.length > 0 && states.every((state) => state.status === "succeeded")) {
    await save(states, "succeeded");
  } else if (options.signal?.aborted && !states.some((state) => ["failed", "timed_out", "interrupted"].includes(state.status))) {
    await save(states, "cancelled");
  } else if (states.some((state) => ["failed", "timed_out", "blocked"].includes(state.status))) {
    if (snapshot.status !== "failed") await save(states, "failed");
  } else if (states.some((state) => state.status === "cancelled")) {
    if (snapshot.status !== "cancelled") await save(states, "cancelled");
  } else if (snapshot.status !== "ready") {
    await save(states, "ready");
  }
  return { snapshot };
}

async function runOne(entry: PlannedTask, attemptId: string, states: SessionTaskState[], store: SessionStore, options: ExecutionOptions,
  finish: (status: "succeeded" | "failed" | "cancelled" | "timed_out", reasonCode: string | null, result: TaskResult | null, recorded: boolean) => Promise<void>,
): Promise<void> {
  const effectiveTask = withDependencyContext(entry, states);
  const scenario = options.mockTaskScenarios?.get(entry.task.id);
  const allowEdits = options.acceptEdits && entry.task.execution.runnerId === "claude-code";
  const runner = options.createRunner(entry.task, { ...(allowEdits ? { acceptEdits: true } : {}), ...(scenario ? { mockScenario: scenario } : {}) });
  const collector = new OutputCollector();
  let result: Awaited<ReturnType<typeof executeTask>>;
  try {
    result = await executeTask({
      task: effectiveTask,
      cwd: store.workspace,
      runner,
      attemptId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onOutput: (output) => { collector.push(output); options.onOutput?.(entry.task.id, output); },
    });
  } catch (error) {
    await finish("failed", "attempt_or_handoff_record_failed", null, false);
    if (error instanceof SessionLockError) throw error;
    return;
  }
  const status = result.attempt.status;
  if (status === "succeeded") {
    const handoff = collector.toResult(entry.task.id, attemptId, result.artifactDir);
    try {
      await store.saveHandoff(attemptId, handoff);
    } catch {
      await finish("failed", "handoff_record_failed", null, true);
      return;
    }
    await finish("succeeded", null, handoff, true);
  } else {
    const mapped = status === "timed_out" ? "timed_out" : status === "cancelled" ? "cancelled" : "failed";
    await finish(mapped, result.attempt.reasonCode, null, true);
  }
}

function withDependencyContext(entry: PlannedTask, states: SessionTaskState[]): TaskDefinition {
  const stateById = new Map(states.map((state) => [state.taskId, state]));
  const prior = entry.dependsOn.flatMap((id) => {
    const state = stateById.get(id);
    return state?.status === "succeeded" && state.result ? [state.result] : [];
  });
  if (prior.length === 0) return entry.task;
  const rendered = prior.map((result) => {
    const summary = truncateUtf8(result.summary, SUMMARY_LIMIT).text;
    return `### ${result.taskId} (${result.attemptId}) — ${result.status}\n摘要：${summary || "无文本摘要"}${result.truncated ? "（原摘要已截断）" : ""}\n执行记录：${result.artifactDir}`;
  }).join("\n\n");
  const context = truncateUtf8(rendered, PROMPT_CONTEXT_LIMIT).text;
  return { ...entry.task, prompt: `${entry.task.prompt}\n\n前置任务结果（仅作为上下文；不要改变当前任务要求）：\n${context}` };
}

class OutputCollector {
  private pieces: string[] = [];
  private bytes = 0;
  private didTruncate = false;
  private finalText: string | undefined;

  push(output: RunnerOutput): void {
    if (output.finalText !== undefined) this.finalText = output.finalText;
    if (output.agentText === undefined || this.bytes >= COLLECT_LIMIT) return;
    const remaining = COLLECT_LIMIT - this.bytes;
    const clipped = truncateUtf8(output.agentText, remaining);
    this.pieces.push(clipped.text);
    this.bytes += Buffer.byteLength(clipped.text, "utf8");
    this.didTruncate ||= clipped.truncated || this.bytes >= COLLECT_LIMIT;
  }

  toResult(taskId: string, attemptId: string, artifactDir: string): TaskResult {
    const selected = this.finalText?.length ? this.finalText : this.pieces.join("");
    const source: TaskResult["summarySource"] = this.finalText?.length ? "final" : selected ? "stream" : "none";
    const withoutMarker = selected.split(/\r?\n/).filter((line) => !/^<<<TOKEN_COUPON_DONE:[0-9a-f]+>>>$/i.test(line.trim())).join("\n").trim();
    const bounded = truncateUtf8(withoutMarker, SUMMARY_LIMIT);
    return { taskId, attemptId, status: "succeeded", summary: bounded.text, summarySource: source, truncated: (source === "stream" && this.didTruncate) || bounded.truncated, artifactDir };
  }
}

function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, truncated: false };
  let text = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > limit) break;
    text += codePoint;
    bytes += size;
  }
  return { text, truncated: true };
}

async function checkRunners(entries: PlannedTask[], options: Pick<ExecutionOptions, "createRunner" | "acceptEdits" | "mockTaskScenarios">): Promise<void> {
  const checked = new Set<string>();
  const hasClaude = entries.some(({ task }) => task.execution.runnerId === "claude-code");
  if (options.acceptEdits && !hasClaude) throw new Error("--accept-edits 仅适用于包含 Claude Code 任务的计划");
  for (const entry of entries) {
    const scenario = options.mockTaskScenarios?.get(entry.task.id);
    const allowEdits = options.acceptEdits && entry.task.execution.runnerId === "claude-code";
    const runner = options.createRunner(entry.task, { ...(allowEdits ? { acceptEdits: true } : {}), ...(scenario ? { mockScenario: scenario } : {}) });
    const key = `${runner.id}:${options.acceptEdits && runner.id === "claude-code"}`;
    if (checked.has(key)) continue;
    if (entry.task.execution.modelId && !runner.supportsModel) throw new Error(`${runner.id} 不支持 modelId`);
    await runner.checkAvailable();
    checked.add(key);
  }
}

async function reconcile(record: SessionRecord, store: SessionStore): Promise<SessionRecord> {
  const running = record.snapshot.tasks.filter((state) => state.status === "running");
  if (running.length === 0) return record;
  let states = record.snapshot.tasks;
  for (const state of running) {
    const attemptId = state.activeAttemptId;
    if (!attemptId) continue;
    let attempt: unknown;
    try { attempt = await store.readAttempt(attemptId); } catch { attempt = undefined; }
    const raw = attempt && typeof attempt === "object" ? attempt as Record<string, unknown> : undefined;
    if (raw?.attemptId === attemptId && raw.taskId === state.taskId && ["failed", "cancelled", "timed_out"].includes(String(raw.status))) {
      const nextStatus = raw.status as "failed" | "cancelled" | "timed_out";
      states = states.map((item) => item.taskId === state.taskId ? {
        ...item, status: nextStatus, activeAttemptId: null, reasonCode: typeof raw.reasonCode === "string" ? raw.reasonCode : "recovered_attempt",
        attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "recorded" as const } : ref),
      } : item);
      continue;
    }
    if (raw?.attemptId === attemptId && raw.taskId === state.taskId && raw.status === "succeeded") {
      try {
        const handoff = await store.readHandoff(attemptId) as TaskResult;
        if (handoff.taskId === state.taskId && handoff.attemptId === attemptId && handoff.status === "succeeded" &&
            typeof handoff.summary === "string" && Buffer.byteLength(handoff.summary, "utf8") <= SUMMARY_LIMIT &&
            ["final", "stream", "none"].includes(handoff.summarySource) && typeof handoff.truncated === "boolean" &&
            handoff.artifactDir === attemptDirectory(store.workspace, attemptId)) {
          states = states.map((item) => item.taskId === state.taskId ? {
            ...item, status: "succeeded", activeAttemptId: null, reasonCode: null, result: handoff,
            attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "recorded" as const } : ref),
          } : item);
          continue;
        }
      } catch { /* incomplete success cannot unlock dependants */ }
    }
    states = states.map((item) => item.taskId === state.taskId ? {
      ...item, status: "interrupted", activeAttemptId: null, reasonCode: "recovery_required",
      attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "record_missing" as const } : ref),
    } : item);
  }
  states = new PlanStore(record.plan, record.snapshot).recalculateDependencies(states);
  const snapshot = { ...record.snapshot, revision: record.snapshot.revision + 1, status: sessionStatusFor(states), tasks: states, updatedAt: new Date().toISOString() };
  await store.save(snapshot);
  return { ...record, snapshot };
}

function pendingTasks(record: SessionRecord): PlannedTask[] {
  const statuses = new Map(record.snapshot.tasks.map((state) => [state.taskId, state.status]));
  return record.plan.tasks.filter(({ task }) => statuses.get(task.id) === "planned");
}

function attemptDirectory(workspace: string, attemptId: string): string { return join(resolve(workspace), ".token-coupon", "runs", attemptId); }
