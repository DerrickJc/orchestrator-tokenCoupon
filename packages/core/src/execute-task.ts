import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AttemptRecord } from "./attempt.js";
import { createCompletionProtocol, CompletionMarkerDetector } from "./completion-marker.js";
import { RunRecorder } from "./run-recorder.js";
import type { Runner, RunnerEvent, RunnerInteractionOwner, RunnerInteractionReply, RunnerInteractionRequest, RunnerInteractionResolution, RunnerOutput } from "./runner.js";
import type { TaskDefinition } from "./task.js";
import type { SelectedDecision } from "./plan.js";
import { decisionValueHash } from "./plan.js";
import { determineVerdict } from "./verdict.js";
import { currentAttemptOwner } from "./attempt-recovery.js";

export const IDLE_NOTICE_AFTER_MS = 60_000;

export interface ExecuteTaskOptions {
  task: TaskDefinition;
  /** Runner working directory. */
  cwd: string;
  /** Stable Session workspace for attempt records when cwd is an isolated worktree. */
  artifactWorkspace?: string;
  runner: Runner;
  signal?: AbortSignal;
  onOutput?: (output: RunnerOutput) => void;
  onInteraction?: (requestId: string, request: RunnerInteractionRequest, owner: RunnerInteractionOwner, signal: AbortSignal) => Promise<RunnerInteractionReply>;
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
    owner: await currentAttemptOwner(),
    ...(options.runner.resolvedSpec ? { runnerSpec: options.runner.resolvedSpec } : {}),
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
  const artifactWorkspace = options.artifactWorkspace === undefined ? cwd : resolve(options.artifactWorkspace);
  const recorder = await RunRecorder.create({ cwd, artifactWorkspace, attemptId, task, prompt: protocol.prompt, initialAttempt: attempt });
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

  const recordRunnerEvent = async (event: RunnerEvent) => {
    const { type, ...payload } = event;
    const write = recorder.appendEvent(type, payload);
    enqueue(write);
    await write;
  };

  const requestInteraction = task.execution.mode === "managed"
    ? async (request: RunnerInteractionRequest, runnerSignal?: AbortSignal): Promise<RunnerInteractionResolution> => {
      if (controller.signal.aborted) throw new Error("交互请求所属 Attempt 已取消");
      const requestSignal = runnerSignal ? AbortSignal.any([controller.signal, runnerSignal]) : controller.signal;
      const requestId = randomUUID();
      const directory = join(recorder.artifactDir, "interactions");
      const responsesDirectory = join(directory, "responses");
      await mkdir(responsesDirectory, { recursive: true, mode: 0o700 });
      const now = new Date().toISOString();
      const record = {
        schemaVersion: 1,
        requestId,
        attemptId,
        taskId: task.id,
        runnerId: options.runner.id,
        cwd,
        request: redactInteractionRequest(request),
        requestHash: createHash("sha256").update(JSON.stringify(redactInteractionRequest(request)), "utf8").digest("hex"),
        status: "pending",
        createdAt: now,
        responseId: null as string | null,
      };
      const requestPath = join(directory, `${requestId}.json`);
      await writeFile(requestPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await recorder.appendEvent("interaction.requested", { requestId, taskId: task.id, runnerId: options.runner.id, kind: request.kind, requestHash: record.requestHash });
      if (!options.onInteraction) {
        record.status = "expired";
        await replaceInteractionRecord(requestPath, record);
        await recorder.appendEvent("interaction.expired", { requestId, reason: "interaction_owner_missing" });
        throw new Error("managed Runner 需要可用的人工交互 owner");
      }
      try {
        const owner: RunnerInteractionOwner = { attemptId, taskId: task.id, runnerId: options.runner.id, cwd };
        const reply = validateInteractionReply(request, await awaitInteractionReply(
          options.onInteraction(requestId, record.request as RunnerInteractionRequest, owner, requestSignal), requestSignal,
        ));
        if (requestSignal.aborted) throw new Error("交互回复所属 Runner 请求已失效");
        const responseId = randomUUID();
        const responsePath = join(responsesDirectory, `${responseId}.json`);
        const response = { schemaVersion: 1, responseId, requestId, attemptId, taskId: task.id, reply, submittedAt: new Date().toISOString() };
        await writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        record.status = "response_submitted";
        record.responseId = responseId;
        await replaceInteractionRecord(requestPath, record);
        await recorder.appendEvent("interaction.response_submitted", { requestId, responseId, kind: reply.kind });
        return { ...reply, interactionId: requestId };
      } catch (error) {
        record.status = controller.signal.aborted ? "cancelled" : "expired";
        await replaceInteractionRecord(requestPath, record).catch(() => undefined);
        await recorder.appendEvent(controller.signal.aborted ? "interaction.expired" : "interaction.failed", {
          requestId, reason: controller.signal.aborted ? "attempt_cancelled" : safeInteractionError(error),
        }).catch(() => undefined);
        throw error;
      }
    }
    : undefined;

  let processResult;
  try {
    processResult = await options.runner.run({
      attemptId, cwd, task, execution: task.execution,
      prompt: protocol.prompt, completionMarker: protocol.marker,
    }, { signal: controller.signal, onStarted: markStarted, onOutput, onActivity: markActivity, recordEvent: recordRunnerEvent, ...(requestInteraction ? { requestInteraction } : {}) });
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
  if (processResult.transport) attempt.transport = processResult.transport;
  if (processResult.nativeOutcome) attempt.nativeOutcome = processResult.nativeOutcome;
  if (processResult.cleanupStatus) attempt.cleanupStatus = processResult.cleanupStatus;
  if (processResult.reportedModel) attempt.reportedModel = processResult.reportedModel;
  if (processResult.nativeError) attempt.nativeError = processResult.nativeError;
  if (processResult.nativeThreadId) attempt.nativeThreadId = processResult.nativeThreadId;
  if (processResult.nativeTurnId) attempt.nativeTurnId = processResult.nativeTurnId;
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

async function replaceInteractionRecord(path: string, record: object): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function validateInteractionReply(request: RunnerInteractionRequest, reply: RunnerInteractionReply): RunnerInteractionReply {
  if (request.kind === "approval") {
    if (reply.kind !== "approval" || !(request.decisions ?? ["allow-once", "deny"]).includes(reply.decision)) throw new Error("审批回复与原生请求不匹配");
    return reply;
  }
  if (reply.kind !== "question" || !request.questions?.length) throw new Error("问题回复与原生请求不匹配");
  const questions = new Map(request.questions.map((item) => [item.id, item]));
  const answers = new Map<string, (typeof reply.answers)[number]>();
  for (const answer of reply.answers) {
    const question = questions.get(answer.questionId);
    if (!question || answers.has(answer.questionId)) throw new Error("问题回复包含未知或重复的题目 ID");
    if (answer.optionIds?.length) {
      if (!question.options || answer.optionIds.some((id) => !question.options!.some((option) => option.id === id))) throw new Error("问题回复包含无效选项");
      if (!question.multiple && answer.optionIds.length !== 1) throw new Error("单选问题只能选择一个选项");
    }
    if (answer.text !== undefined && (!question.allowFreeText || !answer.text.trim() || Buffer.byteLength(answer.text, "utf8") > 8192)) throw new Error("问题回复的自由文本无效");
    if (!answer.optionIds?.length && answer.text === undefined && question.required !== false) throw new Error("必填问题没有答案");
    answers.set(answer.questionId, answer);
  }
  for (const question of questions.values()) if (question.required !== false && !answers.has(question.id)) throw new Error(`缺少必填问题的答案：${question.id}`);
  return { kind: "question", answers: [...answers.values()] };
}

function redactInteractionRequest(request: RunnerInteractionRequest): RunnerInteractionRequest {
  return {
    ...request,
    title: redactInteractionText(request.title),
    summary: redactInteractionText(request.summary),
    ...(request.operation?.command ? { operation: { ...request.operation, command: redactInteractionText(request.operation.command) } } : {}),
    ...(request.questions ? { questions: request.questions.map((question) => ({
      ...question, text: redactInteractionText(question.text),
      ...(question.header ? { header: redactInteractionText(question.header) } : {}),
      ...(question.options ? { options: question.options.map((option) => ({ ...option, label: redactInteractionText(option.label) })) } : {}),
    })) } : {}),
  };
}

async function awaitInteractionReply(reply: Promise<RunnerInteractionReply>, signal: AbortSignal): Promise<RunnerInteractionReply> {
  if (signal.aborted) throw new Error("Attempt 已取消，不能处理交互回复");
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Attempt 已取消，不能处理交互回复"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([reply, cancelled]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

function redactInteractionText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

function safeInteractionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactInteractionText(message).slice(0, 512);
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
