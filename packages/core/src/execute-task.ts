import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AttemptRecord } from "./attempt.js";
import { createCompletionProtocol, CompletionMarkerDetector } from "./completion-marker.js";
import { RunRecorder } from "./run-recorder.js";
import type { Runner, RunnerOutput } from "./runner.js";
import type { TaskDefinition } from "./task.js";
import { determineVerdict } from "./verdict.js";

export interface ExecuteTaskOptions {
  task: TaskDefinition;
  cwd: string;
  runner: Runner;
  signal?: AbortSignal;
  onOutput?: (output: RunnerOutput) => void;
}

export interface ExecuteTaskResult {
  attempt: AttemptRecord;
  artifactDir: string;
}

export async function executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
  const cwd = resolve(options.cwd);
  const attemptId = randomUUID();
  const protocol = createCompletionProtocol(options.task);
  const now = new Date().toISOString();
  const attempt: AttemptRecord = {
    schemaVersion: 1,
    attemptId,
    taskId: options.task.id,
    status: "created",
    cwd,
    runnerId: options.runner.id,
    execution: options.task.execution,
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
  const recorder = await RunRecorder.create({ cwd, attemptId, task: options.task, prompt: protocol.prompt, initialAttempt: attempt });
  attempt.artifactDir = recorder.artifactDir;
  const detector = new CompletionMarkerDetector(protocol.marker);
  const controller = new AbortController();
  let stopReason: "timed_out" | "cancelled" | null = null;
  let started = false;
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
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) { stopReason = "timed_out"; controller.abort(); }
  }, options.task.execution.timeoutMs);
  timer.unref();

  const markStarted = () => {
    if (started) return;
    started = true;
    attempt.status = "running";
    attempt.startedAt = new Date().toISOString();
    enqueue(recorder.writeAttempt({ ...attempt }));
    enqueue(recorder.appendEvent("attempt.started", {}));
  };
  const onOutput = (output: RunnerOutput) => {
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
      attemptId, cwd, task: options.task, execution: options.task.execution,
      prompt: protocol.prompt, completionMarker: protocol.marker,
    }, { signal: controller.signal, onStarted: markStarted, onOutput });
  } catch (error) {
    processResult = { started, exitCode: null, signal: null, executionError: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
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
