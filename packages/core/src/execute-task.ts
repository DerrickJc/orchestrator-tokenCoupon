import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AttemptRecord } from "./attempt.js";
import { createCompletionProtocol, CompletionMarkerDetector } from "./completion-marker.js";
import { RunRecorder } from "./run-recorder.js";
import type { Runner, RunnerOutput } from "./runner.js";
import type { TaskDefinition } from "./task.js";
import type { SelectedDecision } from "./plan.js";
import { decisionValueHash } from "./plan.js";
import { determineVerdict } from "./verdict.js";

export const IDLE_NOTICE_AFTER_MS = 60_000;

export interface ExecuteTaskOptions {
  task: TaskDefinition;
  cwd: string;
  runner: Runner;
  signal?: AbortSignal;
  onOutput?: (output: RunnerOutput) => void;
  onIdleState?: (state: { idle: boolean; idleSince: string | null; lastActivityAt: string }) => void | Promise<void>;
  /** Allows a persisted orchestrator reservation to own the attempt identity. */
  attemptId?: string;
  decisionConstraints?: SelectedDecision[];
}

export interface ExecuteTaskResult {
  attempt: AttemptRecord;
  artifactDir: string;
}

export async function executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
  const cwd = resolve(options.cwd);
  const attemptId = options.attemptId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    throw new Error("attemptId 必须是 UUID");
  }
  const task = withDecisionConstraints(options.task, options.decisionConstraints ?? []);
  const protocol = createCompletionProtocol(task);
  const now = new Date().toISOString();
  const attempt: AttemptRecord = {
    schemaVersion: 1,
    attemptId,
    taskId: options.task.id,
    status: "created",
    cwd,
    runnerId: options.runner.id,
    execution: options.task.execution,
    executionPolicy: { mode: "idle_notice", idleAfterMs: IDLE_NOTICE_AFTER_MS },
    completionToken: protocol.token,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    markerSeen: false,
    reasonCode: null,
    reason: null,
    artifactDir: "",
    inputBytes: Buffer.byteLength(protocol.prompt, "utf8"),
    outputBytes: 0,
  };
  const recorder = await RunRecorder.create({ cwd, attemptId, task, prompt: protocol.prompt, initialAttempt: attempt });
  attempt.artifactDir = recorder.artifactDir;
  if (options.decisionConstraints?.length) {
    const decisionContext = options.decisionConstraints.map(({ decisionId, revision, valueHash }) => ({ decisionId, revision, valueHash }));
    await recorder.appendEvent("attempt.decision_context", {
      decisionIds: decisionContext.map(({ decisionId }) => decisionId),
      contextHash: createHash("sha256").update(JSON.stringify(decisionContext), "utf8").digest("hex"),
      promptBytes: Buffer.byteLength(protocol.prompt, "utf8"),
    });
  }
  const detector = new CompletionMarkerDetector(protocol.marker);
  const controller = new AbortController();
  let stopReason: "cancelled" | null = null;
  let started = false;
  let lastActivityMs = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const writes: Promise<void>[] = [];
  const enqueue = (promise: Promise<void>) => {
    writes.push(promise.catch((error: unknown) => {
      if (!controller.signal.aborted) {
        stopReason = null;
        controller.abort(error);
      }
    }));
  };
  const externalAbort = () => { stopReason ??= "cancelled"; controller.abort(); };
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const scheduleIdleNotice = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!started || attempt.idleSince || controller.signal.aborted) return;
    const remaining = Math.max(1, IDLE_NOTICE_AFTER_MS - (Date.now() - lastActivityMs));
    idleTimer = setTimeout(checkIdle, remaining);
    idleTimer.unref();
  };
  const checkIdle = () => {
    idleTimer = undefined;
    if (!started || controller.signal.aborted || attempt.idleSince) return;
    const elapsed = Date.now() - lastActivityMs;
    if (elapsed < IDLE_NOTICE_AFTER_MS) { scheduleIdleNotice(); return; }
    const idleSince = new Date().toISOString();
    attempt.lastActivityAt = new Date(lastActivityMs).toISOString();
    attempt.idleSince = idleSince;
    enqueue(recorder.appendEvent("attempt.idle", { idleSince, lastActivityAt: attempt.lastActivityAt }));
    enqueue(recorder.writeAttempt({ ...attempt }));
    if (options.onIdleState) enqueue(Promise.resolve().then(() => options.onIdleState!({ idle: true, idleSince, lastActivityAt: attempt.lastActivityAt! })));
  };
  const markActivity = () => {
    if (!started || controller.signal.aborted) return;
    lastActivityMs = Date.now();
    if (attempt.idleSince) {
      const idleSince = attempt.idleSince;
      delete attempt.idleSince;
      attempt.lastActivityAt = new Date(lastActivityMs).toISOString();
      enqueue(recorder.appendEvent("attempt.active", { activeAt: attempt.lastActivityAt, idleSince }));
      enqueue(recorder.writeAttempt({ ...attempt }));
      if (options.onIdleState) enqueue(Promise.resolve().then(() => options.onIdleState!({ idle: false, idleSince: null, lastActivityAt: attempt.lastActivityAt! })));
    }
    scheduleIdleNotice();
  };

  const markStarted = () => {
    if (started) return;
    started = true;
    attempt.status = "running";
    attempt.startedAt = new Date().toISOString();
    lastActivityMs = Date.now();
    attempt.lastActivityAt = attempt.startedAt;
    enqueue(recorder.writeAttempt({ ...attempt }));
    enqueue(recorder.appendEvent("attempt.started", {}));
    scheduleIdleNotice();
  };
  const onOutput = (output: RunnerOutput) => {
    if (output.text || output.agentText) markActivity();
    attempt.outputBytes += Buffer.byteLength(output.text, "utf8");
    if (output.agentText !== undefined) attempt.markerSeen = detector.push(output.agentText) || attempt.markerSeen;
    enqueue(recorder.appendEvent("runner.output", {
      stream: output.stream,
      text: output.text,
      ...(output.structuredEvent === undefined ? {} : { structuredEvent: output.structuredEvent }),
    }));
    options.onOutput?.(output);
  };

  let processResult;
  try {
    processResult = await options.runner.run({
      attemptId, cwd, task, execution: task.execution,
      prompt: protocol.prompt, completionMarker: protocol.marker,
    }, { signal: controller.signal, onStarted: markStarted, onOutput, onActivity: markActivity });
  } catch (error) {
    processResult = { started, exitCode: null, signal: null, executionError: error instanceof Error ? error.message : String(error) };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
  if (processResult.started) markStarted();
  attempt.markerSeen = detector.finish() || attempt.markerSeen;
  attempt.exitCode = processResult.exitCode;
  attempt.signal = processResult.signal;
  await Promise.all(writes);
  try { await recorder.flush(); } catch { /* verdict below records the failure when possible */ }

  let verdict = determineVerdict({ markerSeen: attempt.markerSeen, process: processResult, stopReason, recordingFailed: recorder.recordingError !== undefined });
  attempt.status = verdict.status;
  attempt.reasonCode = verdict.reasonCode;
  attempt.reason = verdict.reason;
  attempt.finishedAt = new Date().toISOString();
  enqueue(recorder.appendEvent("attempt.finished", {
    status: attempt.status, reasonCode: attempt.reasonCode, exitCode: attempt.exitCode, signal: attempt.signal,
    markerSeen: attempt.markerSeen, outputBytes: attempt.outputBytes,
  }));
  await Promise.all(writes);
  try { await recorder.flush(); } catch {
    verdict = determineVerdict({ markerSeen: attempt.markerSeen, process: processResult, stopReason, recordingFailed: true });
    attempt.status = verdict.status;
    attempt.reasonCode = verdict.reasonCode;
    attempt.reason = verdict.reason;
  }
  try { await recorder.writeAttempt({ ...attempt }); } catch {
    attempt.status = "failed";
    attempt.reasonCode = "recording_failed";
    attempt.reason = "执行记录写入失败，记录可能不完整";
  }
  return { attempt, artifactDir: recorder.artifactDir };
}

function withDecisionConstraints(task: TaskDefinition, decisions: SelectedDecision[]): TaskDefinition {
  if (!decisions.length) return task;
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (ids.has(decision.decisionId) || decision.revision < 1 || decision.valueHash !== decisionValueHash(decision.decisionId, decision.value)) {
      throw new Error("decision_context_invalid：执行约束缺少有效且唯一的决策版本");
    }
    ids.add(decision.decisionId);
  }
  const rendered = decisions.map(({ decisionId, revision, value, status, preference }) => `- ${decisionId}@${revision} [${status}]：${value}${preference ? `；用户范围/偏好：${preference}` : ""}`).join("\n");
  return { ...task, prompt: `${task.prompt}\n\n已确认的全局执行约束（权威值；若任务正文与此处冲突，以此处为准）：\n${rendered}` };
}
