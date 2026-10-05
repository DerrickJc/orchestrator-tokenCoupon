import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { PlanDefinition } from "./plan.js";
import { DeepSeekPlanner, PlannerApiError } from "./planners/deepseek-planner.js";
import { MockPlanner } from "./planners/mock-planner.js";
import { canonicalHash, PlannerStore, readJson } from "./planner-store.js";
import type { ExecutionReference, Planner, PlannerConfig, PlannerConversationSnapshot, PlannerDraft, PlannerEvent, PlannerInput, PlannerReply, PlannerTurnRef, RepositoryEvidence } from "./planner-types.js";
import { RepositoryReader, verifyRepositoryEvidence } from "./repository-reader.js";
import type { ExecutionConfig } from "./task.js";
import { InputValidationError } from "./validation.js";
import type { TaskRunnerFactory } from "./task-orchestrator.js";
import { runPlan } from "./task-orchestrator.js";
import { SessionStore } from "./session-store.js";
import { checkPlan } from "./plan-check.js";
import { loadCurrentPlanReview } from "./plan-review.js";
import { ReviewStore } from "./review-store.js";
import type { PlanReviewRecord } from "./planner-types.js";

const USER_MESSAGE_LIMIT = 8 * 1024;
const REQUEST_CONTEXT_LIMIT = 256 * 1024;
const PLAN_LIMIT = 48 * 1024;
const API_REQUEST_LIMIT = 8;
const TOOL_CALL_LIMIT = 20;
const TURN_TIMEOUT_MS = 120_000;

export interface PlannerStartOptions {
  workspace: string;
  request: string;
  config: PlannerConfig;
  executionDefaults: ExecutionConfig;
  planner?: Planner;
  signal?: AbortSignal;
}

export interface PlannerOperationResult {
  snapshot: PlannerConversationSnapshot;
  draft?: PlannerDraft;
  /** False means a newly generated response reused the current immutable draft unchanged. */
  draftChanged?: boolean;
  reply?: PlannerReply;
  error?: string;
  review?: PlanReviewRecord;
  reviewIsCurrent?: boolean;
}

export interface PlannerRunOptions {
  planningId: string;
  workspace: string;
  createRunner: TaskRunnerFactory;
  signal?: AbortSignal;
  acceptEdits?: boolean;
  onOutput?: Parameters<typeof runPlan>[0]["onOutput"];
}

export function createPlanner(config: PlannerConfig, options: { fetchImpl?: typeof fetch } = {}): Planner {
  if (config.provider === "mock") return new MockPlanner();
  if (config.provider === "deepseek") return new DeepSeekPlanner({ model: config.model, baseUrl: config.baseUrl, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  throw new InputValidationError("planner.provider", "不支持的 Planner");
}

export async function startPlannerConversation(options: PlannerStartOptions): Promise<PlannerOperationResult> {
  validateRequest(options.request);
  validateExecutionDefaults(options.executionDefaults);
  validateConfig(options.config);
  const store = new PlannerStore(options.workspace);
  const now = new Date().toISOString();
  const snapshot: PlannerConversationSnapshot = {
    schemaVersion: 1, planningId: randomUUID(), workspace: store.workspace, revision: 1, status: "collecting",
    config: options.config, executionDefaults: options.executionDefaults, messages: [], turns: [], context: [],
    activeTurnId: null, draftRevision: null, approval: null, latestReviewId: null, execution: null, createdAt: now, updatedAt: now,
  };
  await store.create(snapshot);
  return mutateWithTurn(store, snapshot.planningId, options.planner ?? createPlanner(options.config), options.request, options.signal, false);
}

export async function replyToPlanner(options: { planningId: string; workspace: string; message: string; planner?: Planner; signal?: AbortSignal }): Promise<PlannerOperationResult> {
  validateRequest(options.message);
  const store = new PlannerStore(options.workspace);
  const initial = await store.load(options.planningId);
  return mutateWithTurn(store, options.planningId, options.planner ?? createPlanner(initial.config), options.message, options.signal, false);
}

export async function retryPlannerTurn(options: { planningId: string; workspace: string; planner?: Planner; signal?: AbortSignal }): Promise<PlannerOperationResult> {
  const store = new PlannerStore(options.workspace);
  const release = await store.acquireLock(options.planningId);
  try {
    let snapshot = await store.load(options.planningId);
    snapshot = await recoverActiveTurn(store, snapshot);
    if (snapshot.execution) throw new Error("规划已关联执行 Session，不能重试规划轮次");
    const previous = snapshot.turns.at(-1);
    if (!previous || !["failed", "cancelled", "timed_out", "interrupted"].includes(previous.status)) throw new Error("没有可重试的失败规划轮次");
    const message = snapshot.messages.find((entry) => entry.messageId === previous.messageId);
    if (!message || message.role !== "user") throw new Error("规划轮次缺少原始用户输入");
    const result = await executeTurn(store, snapshot, options.planner ?? createPlanner(snapshot.config), message.messageId, message.content, options.signal, true);
    return result;
  } finally { await release(); }
}

export async function loadPlannerConversation(planningId: string, workspace: string): Promise<PlannerOperationResult> {
  const store = new PlannerStore(workspace);
  const snapshot = await store.load(planningId);
  const draft = snapshot.draftRevision === null ? undefined : await store.loadDraft(planningId, snapshot.draftRevision);
  const review = snapshot.latestReviewId ? await new ReviewStore(workspace).load(planningId, snapshot.latestReviewId).catch(() => undefined) : undefined;
  const reviewIsCurrent = review?.status === "succeeded" && (await loadCurrentPlanReview(planningId, workspace))?.reviewId === review.reviewId;
  const lastTurn = snapshot.turns.at(-1);
  let reply: PlannerReply | undefined;
  if (lastTurn?.status === "succeeded") {
    try {
      const value = await readJson(join(store.turnDirectory(planningId, lastTurn.turnId), "turn.json")) as Record<string, unknown>;
      if (value.reply) reply = parsePlannerReply(value.reply);
    } catch { /* A complete conversation snapshot remains readable without optional display data. */ }
  }
  return { snapshot, ...(draft ? { draft } : {}), ...(reply ? { reply } : {}), ...(review ? { review, reviewIsCurrent } : {}) };
}

export async function replacePlannerDraft(options: { planningId: string; workspace: string; value: unknown; expectedDraftRevision?: number; expectedPlanHash?: string }): Promise<PlannerOperationResult> {
  const store = new PlannerStore(options.workspace);
  const release = await store.acquireLock(options.planningId);
  try {
    let snapshot = await store.load(options.planningId);
    if (options.expectedDraftRevision !== undefined && snapshot.draftRevision !== options.expectedDraftRevision) throw new Error("草案已变化，编辑文件未导入；请先查看最新差异");
    if (options.expectedPlanHash !== undefined && snapshot.draftRevision !== null && (await store.loadDraft(options.planningId, snapshot.draftRevision)).planHash !== options.expectedPlanHash) {
      throw new Error("草案哈希已变化，编辑文件未导入；请先查看最新差异");
    }
    const hadActiveTurn = snapshot.activeTurnId !== null;
    snapshot = await recoverActiveTurn(store, snapshot);
    if (hadActiveTurn) throw new Error("发现中断的规划轮次，请先使用 planner retry");
    if (snapshot.activeTurnId) throw new Error("规划轮次已中断，请先使用 planner retry");
    if (snapshot.execution) throw new Error("规划已关联执行 Session，不能替换计划");
    const plan = parsePlanWithPolicy(options.value, snapshot.executionDefaults);
    ensurePlanSize(plan);
    const previous = snapshot.draftRevision === null ? undefined : await store.loadDraft(options.planningId, snapshot.draftRevision);
    const hash = canonicalHash(plan);
    if (previous?.planHash === hash) return { snapshot, draft: previous, draftChanged: false };
    const draft: PlannerDraft = {
      schemaVersion: 1, planningId: options.planningId, draftRevision: (snapshot.draftRevision ?? 0) + 1,
      plan, message: "用户导入并编辑了计划。", source: "user", context: snapshot.context, planHash: hash, createdAt: new Date().toISOString(),
    };
    await store.writeDraft(draft);
    snapshot = nextSnapshot(snapshot, {
      status: "draft_ready", draftRevision: draft.draftRevision, approval: null, latestReviewId: null, execution: null,
    });
    await store.save(snapshot);
    return { snapshot, draft, draftChanged: true };
  } finally { await release(); }
}

export async function approvePlannerDraft(options: { planningId: string; workspace: string; draftRevision: number; reviewId?: string; waivedFindingIds?: string[]; waiverReason?: string; signal?: AbortSignal }): Promise<PlannerOperationResult> {
  const store = new PlannerStore(options.workspace);
  const release = await store.acquireLock(options.planningId);
  try {
    let snapshot = await store.load(options.planningId);
    snapshot = await recoverActiveTurn(store, snapshot);
    if (snapshot.activeTurnId) throw new Error("规划轮次已中断，请先使用 planner retry");
    if (snapshot.execution) throw new Error("规划已关联执行 Session，不能重新批准");
    if (snapshot.status !== "draft_ready" && snapshot.status !== "approved") throw new Error("当前没有等待批准的计划草案");
    if (snapshot.draftRevision !== options.draftRevision) throw new Error("批准版本不是当前草案版本");
    const draft = await store.loadDraft(options.planningId, options.draftRevision);
    const reviewId = options.reviewId ?? snapshot.latestReviewId;
    if (!reviewId || reviewId !== snapshot.latestReviewId) throw new Error("批准前必须完成当前草案的审查，请运行 planner review");
    const changed = await verifyRepositoryEvidence(store.workspace, snapshot.context, options.signal);
    if (changed.length) throw new Error("workspace_changed：调研文件已变化，请重新调研后再批准：" + changed.join(", "));
    const review = await loadCurrentPlanReview(options.planningId, store.workspace);
    if (!review || review.reviewId !== reviewId) throw new Error("审查报告已过期或无效，请重新审查当前草案");
    const waivedIds = new Set(options.waivedFindingIds ?? []);
    const errorIds = review.findings.filter((finding) => finding.severity === "error").map((finding) => finding.findingId);
    const unknownWaivers = [...waivedIds].filter((id) => !errorIds.includes(id));
    if (unknownWaivers.length) throw new Error("豁免只能引用当前审查中的 error 问题：" + unknownWaivers.join(", "));
    const unhandled = errorIds.filter((id) => !waivedIds.has(id));
    if (unhandled.length) throw new Error("审查发现严重问题，需修订或显式豁免：" + unhandled.join(", "));
    if (waivedIds.size && (!options.waiverReason?.trim() || Buffer.byteLength(options.waiverReason, "utf8") > 1024)) throw new Error("豁免严重问题时必须提供不超过 1 KiB 的原因");
    const approval = snapshot.approval?.reviewId === review.reviewId ? snapshot.approval : {
      approvalId: randomUUID(), draftRevision: draft.draftRevision, planHash: draft.planHash, approvedAt: new Date().toISOString(),
      reviewId: review.reviewId, reportHash: review.reportHash!,
      waivedFindings: [...waivedIds].map((findingId) => ({ findingId, reason: options.waiverReason!.trim(), waivedAt: new Date().toISOString() })),
    };
    if (snapshot.status !== "approved" || snapshot.approval?.reviewId !== approval.reviewId || snapshot.approval?.reportHash !== approval.reportHash) {
      snapshot = nextSnapshot(snapshot, { status: "approved", approval });
      await store.save(snapshot);
    }
    return { snapshot, draft, review, reviewIsCurrent: true };
  } finally { await release(); }
}

export async function runApprovedPlanner(options: PlannerRunOptions): Promise<PlannerOperationResult & { sessionStatus?: string }> {
  const store = new PlannerStore(options.workspace);
  const release = await store.acquireLock(options.planningId);
  try {
    let snapshot = await store.load(options.planningId);
    let retryReservation: ExecutionReference | null = null;
    if (snapshot.execution) {
      const execution = snapshot.execution;
      const sessionStore = new SessionStore(store.workspace);
      try {
        const record = await sessionStore.load(execution.sessionId);
        if (canonicalHash(record.plan) !== execution.planHash) throw new Error("已关联 Session 的计划哈希不匹配");
        if (execution.state === "reserved") {
          snapshot = nextSnapshot(snapshot, { status: "execution_created", execution: { ...execution, state: "created" } });
          await store.save(snapshot);
        }
        return { snapshot, draft: await store.loadDraft(options.planningId, execution.draftRevision), sessionStatus: record.snapshot.status };
      } catch (error) {
        const sessionDirectory = sessionStore.sessionDirectory(execution.sessionId);
        const exists = await access(sessionDirectory).then(() => true).catch(() => false);
        if (execution.state !== "reserved" || exists) throw error;
        retryReservation = execution;
      }
    }
    if (snapshot.status !== "approved" || !snapshot.approval || snapshot.draftRevision === null) throw new Error("执行前必须批准当前草案版本");
    const draft = await store.loadDraft(options.planningId, snapshot.draftRevision);
    if (draft.planHash !== snapshot.approval.planHash || canonicalHash(draft.plan) !== snapshot.approval.planHash) throw new Error("批准草案哈希校验失败");
    const review = await loadCurrentPlanReview(options.planningId, store.workspace);
    if (!snapshot.approval.reviewId || !snapshot.approval.reportHash || !review || review.reviewId !== snapshot.approval.reviewId || review.reportHash !== snapshot.approval.reportHash) {
      throw new Error("执行前必须确认当前草案的有效审查报告");
    }
    const execution: ExecutionReference = retryReservation ?? {
      sessionId: randomUUID(), approvalId: snapshot.approval.approvalId, draftRevision: draft.draftRevision,
      planHash: draft.planHash, state: "reserved" as const,
    };
    if (!retryReservation) {
      snapshot = nextSnapshot(snapshot, { status: "approved", execution });
      await store.save(snapshot);
    }

    const sessions = new SessionStore(store.workspace);
    try {
      const result = await runPlan({
        plan: draft.plan, workspace: store.workspace, createRunner: options.createRunner, sessionId: execution.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.acceptEdits ? { acceptEdits: true } : {}),
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
        beforeCreateSession: async () => {
          const current = await store.load(options.planningId);
          if (current.status !== "approved" || current.approval?.approvalId !== execution.approvalId ||
            current.draftRevision !== execution.draftRevision || current.execution?.sessionId !== execution.sessionId || current.approval?.reviewId !== review.reviewId) {
            throw new Error("planner_approval_changed：批准记录已变化");
          }
          const changed = await verifyRepositoryEvidence(store.workspace, draft.context, options.signal);
          if (changed.length) throw new Error("workspace_changed：调研文件已变化，拒绝启动执行：" + changed.join(", "));
        },
      });
      snapshot = nextSnapshot(snapshot, { status: "execution_created", execution: { ...execution, state: "created" } });
      await store.save(snapshot);
      return { snapshot, draft, sessionStatus: result.snapshot.status };
    } catch (error) {
      try {
        const record = await sessions.load(execution.sessionId);
        if (canonicalHash(record.plan) === draft.planHash) {
          snapshot = nextSnapshot(snapshot, { status: "execution_created", execution: { ...execution, state: "created" } });
          await store.save(snapshot);
        }
      } catch {
        const sessionDirectory = sessions.sessionDirectory(execution.sessionId);
        const exists = await access(sessionDirectory).then(() => true).catch(() => false);
        if (!exists) {
          snapshot = nextSnapshot(snapshot, { status: "approved", execution: null });
          await store.save(snapshot);
        }
      }
      throw error;
    }
  } finally { await release(); }
}

export function formatPlanner(result: PlannerOperationResult & { sessionStatus?: string }): string {
  const { snapshot, draft } = result;
  const lines = [
    "Planning：" + snapshot.planningId,
    "状态：" + snapshot.status + "；revision：" + snapshot.revision,
    "工作目录：" + snapshot.workspace,
    "Planner：" + snapshot.config.provider + " / " + snapshot.config.model,
    "规划轮次：" + snapshot.turns.length,
  ];
  for (const turn of snapshot.turns) lines.push("  " + turn.turnId + "：" + turn.status + (turn.reasonCode ? "（" + turn.reasonCode + "）" : ""));
  if (snapshot.messages.length) {
    const recentMessages = snapshot.messages.slice(-20);
    lines.push("对话记录（最近 " + recentMessages.length + " 条）：");
    for (const message of recentMessages) lines.push(...formatConversationMessage(message.role, message.content));
  }
  if (draft) {
    lines.push("草案版本：draft-" + draft.draftRevision + "；SHA-256：" + draft.planHash);
    lines.push("Plan：" + draft.plan.id + " — " + draft.plan.title);
    for (const entry of draft.plan.tasks) {
      lines.push("  " + entry.task.id + " — " + entry.task.title + "；依赖：" + (entry.dependsOn.join(", ") || "无"));
      lines.push("    Runner：" + entry.task.execution.runnerId + "；模型：" + (entry.task.execution.modelId ?? "未指定") + "；超时：" + entry.task.execution.timeoutMs + " ms");
      lines.push("    描述：" + entry.task.prompt);
    }
    lines.push("调研文件：" + (draft.context.length ? draft.context.map((item) => item.path).join(", ") : "无"));
  }
  if (result.review) lines.push("最近审查：" + result.review.reviewId + "（" + result.review.status + (result.review.status === "succeeded" ? `；${result.review.findings.length} 个问题${result.reviewIsCurrent ? "；适用于当前草案" : "；已过期"}` : "") + "）");
  else if (snapshot.latestReviewId) lines.push("审查报告：" + snapshot.latestReviewId + "（当前记录不可读）");
  if (snapshot.approval) {
    lines.push("批准：" + snapshot.approval.approvalId + "（draft-" + snapshot.approval.draftRevision + `；review-${snapshot.approval.reviewId ?? "缺失"}` + "）");
    for (const waiver of snapshot.approval.waivedFindings ?? []) lines.push(`  豁免 ${waiver.findingId}：${waiver.reason}`);
  }
  if (snapshot.execution) lines.push("执行 Session：" + snapshot.execution.sessionId + "（" + snapshot.execution.state + "）");
  if (result.sessionStatus) lines.push("Session 状态：" + result.sessionStatus);
  if (result.error) lines.push("错误：" + result.error);
  return lines.join("\n");
}

function formatConversationMessage(role: "user" | "assistant", content: string): string[] {
  if (role === "user") return ["用户：" + shorten(content, 2000)];
  try {
    const value = JSON.parse(content) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const reply = value as Record<string, unknown>;
      if (typeof reply.message === "string" && reply.kind === "clarification" && Array.isArray(reply.questions)) {
        return [
          "Planner：" + shorten(reply.message, 2000),
          ...reply.questions.filter((question): question is string => typeof question === "string").map((question, index) => "  " + (index + 1) + ". " + shorten(question, 1000)),
        ];
      }
      if (typeof reply.message === "string" && reply.kind === "draft") return ["Planner：" + shorten(reply.message, 2000)];
    }
  } catch { /* Legacy or diagnostic message content is displayed as plain text. */ }
  return ["Planner：" + shorten(content, 2000)];
}

function shorten(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}

async function mutateWithTurn(store: PlannerStore, planningId: string, planner: Planner, userText: string, signal: AbortSignal | undefined, retry: boolean): Promise<PlannerOperationResult> {
  const release = await store.acquireLock(planningId);
  try {
    let snapshot = await store.load(planningId);
    const hadActiveTurn = snapshot.activeTurnId !== null;
    snapshot = await recoverActiveTurn(store, snapshot);
    if (hadActiveTurn) throw new Error("发现中断的规划轮次，请先使用 planner retry");
    if (snapshot.activeTurnId) throw new Error("规划轮次已中断，请先使用 planner retry");
    if (snapshot.execution) throw new Error("规划已关联执行 Session，不能继续修改对话");
    if (retry) throw new Error("内部错误：不支持重复追加用户消息的 retry");
    if (snapshot.status === "execution_created") throw new Error("规划已开始执行");
    const messageId = randomUUID();
    return await executeTurn(store, snapshot, planner, messageId, userText, signal, false);
  } finally { await release(); }
}

async function executeTurn(store: PlannerStore, initial: PlannerConversationSnapshot, planner: Planner, messageId: string, userText: string, signal: AbortSignal | undefined, retry: boolean): Promise<PlannerOperationResult> {
  validateRequest(userText);
  if (planner.id !== initial.config.provider) throw new Error("规划记录的 Planner provider 与当前适配器不匹配");
  const now = new Date().toISOString();
  const turnId = randomUUID();
  const previousTurn = retry ? initial.turns.at(-1) : undefined;
  const turn: PlannerTurnRef = {
    turnId, messageId, status: "running", artifactDir: store.turnDirectory(initial.planningId, turnId),
    reasonCode: null, createdAt: now, finishedAt: null,
  };
  let snapshot = nextSnapshot(initial, {
    status: "collecting", messages: retry ? initial.messages : [...initial.messages, { messageId, role: "user", content: userText }],
    turns: [...initial.turns, turn], activeTurnId: turnId, approval: null, execution: null,
  });
  if (previousTurn && retry && previousTurn.messageId !== messageId) throw new Error("规划重试输入身份不匹配");
  await store.save(snapshot);
  await store.writeTurn(turn, { schemaVersion: 1, planningId: snapshot.planningId, turnId, messageId, status: "running", input: userText, createdAt: now });

  const counters = { requests: 0, tools: 0 };
  const events: PlannerEvent[] = [];
  const timed = timeoutSignal(signal, TURN_TIMEOUT_MS);
  const initialEvidenceBytes = snapshot.context.reduce((sum, item) => sum + item.sizeBytes, 0);
  const reader = new RepositoryReader(store.workspace, timed.signal, initialEvidenceBytes);
  try {
    const previouslyChanged = await verifyRepositoryEvidence(store.workspace, snapshot.context, timed.signal);
    const contextNotice = previouslyChanged.length
      ? "以下先前调研过的文件已变化，生成新草案前必须重新读取这些路径；不要只更新哈希：" + previouslyChanged.join(", ")
      : undefined;
    const currentDraft = snapshot.draftRevision === null ? undefined : await store.loadDraft(snapshot.planningId, snapshot.draftRevision);
    const historyBytes = snapshot.messages.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0) +
      (currentDraft ? Buffer.byteLength(JSON.stringify(currentDraft.plan), "utf8") : 0);
    if (historyBytes > REQUEST_CONTEXT_LIMIT) throw new PlannerOperationError("context_budget_exceeded", "规划历史超过 256 KiB，请创建新的规划记录");
    const context = {
      signal: timed.signal, repository: reader,
      consumeApiRequest: () => { counters.requests += 1; if (counters.requests > API_REQUEST_LIMIT) throw new PlannerOperationError("planner_request_limit", "本轮 Planner API 请求超过 8 次"); return counters.requests; },
      consumeToolCall: () => { counters.tools += 1; if (counters.tools > TOOL_CALL_LIMIT) throw new PlannerOperationError("planner_tool_call_limit", "本轮只读工具调用超过 20 次"); },
      record: async (event: PlannerEvent) => {
        if (event.type === "provider.request" || event.type === "provider.response") {
          const requestId = event.payload.requestId;
          if (typeof requestId !== "number") throw new PlannerOperationError("planner_record_invalid", "API 请求记录缺少 requestId");
          const kind = event.type === "provider.request" ? "request" : "response";
          await store.writeProviderCall(snapshot.planningId, turnId, requestId, kind, event.payload);
          const summary = { type: event.type, payload: { requestId, model: event.payload.model, status: event.payload.status } };
          events.push(summary);
          await store.appendEvent(snapshot.planningId, turnId, summary);
          return;
        }
        events.push(event);
        await store.appendEvent(snapshot.planningId, turnId, event);
      },
    };
    let reply: PlannerReply | undefined;
    let repairMessage: string | undefined;
    let validationError: unknown;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      let output: unknown;
      try {
        output = await planner.generate({
          messages: snapshot.messages.map(({ role, content }) => ({ role, content })),
          executionDefaults: snapshot.executionDefaults,
          ...(currentDraft ? { currentDraft } : {}),
          ...(repairMessage ? { repairMessage } : {}),
          ...(contextNotice ? { repositoryNotice: contextNotice } : {}),
        }, context);
        if (timed.signal.aborted) throw timed.signal.reason ?? new Error("规划轮次已取消");
        reply = parsePlannerReply(output);
        if (reply.kind === "draft") {
          const plan = parsePlanWithPolicy(reply.plan, snapshot.executionDefaults);
          ensurePlanSize(plan);
          reply = { ...reply, plan };
        }
        break;
      } catch (error) {
        validationError = error;
        const repairable = !(error instanceof PlannerApiError) && !(error instanceof PlannerOperationError) && !timed.signal.aborted;
        if (!repairable || attempt === 2) throw error;
        repairMessage = "上次回复未通过应用校验：" + (error instanceof Error ? error.message : String(error)) +
          "。请只修正这些结构或执行配置问题，不要扩大仓库访问范围，并重新输出完整 JSON 结果。";
        await context.record({ type: "planner.validation_failed", payload: { attempt: attempt + 1, message: repairMessage } });
      }
    }
    if (!reply) throw validationError ?? new PlannerOperationError("planner_invalid_reply", "Planner 没有返回有效结果");
    const evidence = mergeEvidence(snapshot.context, reader.getEvidence());
    if (reply.kind === "draft") {
      const changed = await verifyRepositoryEvidence(store.workspace, evidence, timed.signal);
      if (changed.length) throw new PlannerOperationError("workspace_changed", "生成计划期间调研文件发生变化，请重新调研：" + changed.join(", "));
    }
    const assistant = { messageId: randomUUID(), role: "assistant" as const, content: JSON.stringify(reply) };
    if (Buffer.byteLength(assistant.content, "utf8") > 64 * 1024) throw new PlannerOperationError("planner_reply_too_large", "Planner 最终回复超过 64 KiB");
    const newDraft = reply.kind === "draft" && (!currentDraft || currentDraft.planHash !== canonicalHash(reply.plan))
      ? makeDraft(snapshot, reply, evidence)
      : undefined;
    const returnedDraft = reply.kind === "draft" ? newDraft ?? currentDraft : undefined;
    if (newDraft) await store.writeDraft(newDraft);
    const finishedAt = new Date().toISOString();
    const doneTurn: PlannerTurnRef = { ...turn, status: "succeeded", reasonCode: null, finishedAt };
    await store.writeTurn(doneTurn, { schemaVersion: 1, planningId: snapshot.planningId, turnId, messageId, status: "succeeded", input: userText, reply, evidence, apiRequests: counters.requests, toolCalls: counters.tools, events, createdAt: now, finishedAt });
    snapshot = nextSnapshot(snapshot, {
      status: reply.kind === "draft" ? "draft_ready" : "collecting",
      messages: [...snapshot.messages, assistant], turns: [...snapshot.turns.slice(0, -1), doneTurn],
      context: evidence, activeTurnId: null, ...(newDraft ? { draftRevision: newDraft.draftRevision, latestReviewId: null } : {}),
      approval: null, execution: null,
    });
    await store.save(snapshot);
    return { snapshot, ...(returnedDraft ? { draft: returnedDraft } : {}), ...(reply.kind === "draft" ? { draftChanged: newDraft !== undefined } : {}), reply };
  } catch (error) {
    const code = timed.timedOut() ? "planner_timed_out"
      : timed.signal.aborted ? "planner_cancelled"
        : error instanceof PlannerApiError || error instanceof PlannerOperationError ? error.code
          : "planner_failed";
    const failedTurn: PlannerTurnRef = { ...turn, status: timed.timedOut() ? "timed_out" : timed.signal.aborted ? "cancelled" : "failed", reasonCode: code, finishedAt: new Date().toISOString() };
    await store.writeTurn(failedTurn, { schemaVersion: 1, planningId: snapshot.planningId, turnId, messageId, status: failedTurn.status, input: userText, reasonCode: code, error: safeError(error), context: reader.getEvidence(), apiRequests: counters.requests, toolCalls: counters.tools, events, createdAt: now, finishedAt: failedTurn.finishedAt });
    snapshot = nextSnapshot(snapshot, {
      status: "collecting", turns: [...snapshot.turns.slice(0, -1), failedTurn], context: mergeEvidence(snapshot.context, reader.getEvidence()),
      activeTurnId: null, approval: null, execution: null,
    });
    await store.save(snapshot);
    return { snapshot, error: safeError(error) };
  } finally { timed.dispose(); }
}

async function recoverActiveTurn(store: PlannerStore, snapshot: PlannerConversationSnapshot): Promise<PlannerConversationSnapshot> {
  if (!snapshot.activeTurnId) return snapshot;
  const active = snapshot.turns.find((turn) => turn.turnId === snapshot.activeTurnId);
  if (!active) throw new Error("Planner activeTurnId 没有关联轮次");
  const recovered: PlannerTurnRef = { ...active, status: "interrupted", reasonCode: "planner_process_interrupted", finishedAt: new Date().toISOString() };
  await store.writeTurn(recovered, { schemaVersion: 1, planningId: snapshot.planningId, turnId: active.turnId, messageId: active.messageId, status: "interrupted", reasonCode: recovered.reasonCode, finishedAt: recovered.finishedAt });
  const next = nextSnapshot(snapshot, { status: "collecting", turns: snapshot.turns.map((turn) => turn.turnId === active.turnId ? recovered : turn), activeTurnId: null, approval: null });
  await store.save(next);
  return next;
}

function parsePlannerReply(value: unknown): PlannerReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlannerOperationError("planner_invalid_reply", "Planner 回复必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (typeof raw.message !== "string" || !raw.message.trim() || Buffer.byteLength(raw.message, "utf8") > 16 * 1024) throw new PlannerOperationError("planner_invalid_reply", "Planner message 必须是非空文本且不超过 16 KiB");
  if (raw.kind === "clarification") {
    if (Object.keys(raw).some((key) => !["kind", "message", "questions"].includes(key)) || !Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 3 ||
        raw.questions.some((question) => typeof question !== "string" || !question.trim() || Buffer.byteLength(question, "utf8") > 2048)) {
      throw new PlannerOperationError("planner_invalid_reply", "clarification 必须包含 1 到 3 个具体问题，且不能附带 plan");
    }
    return { kind: "clarification", message: raw.message, questions: raw.questions as string[] };
  }
  if (raw.kind === "draft" && Object.keys(raw).every((key) => ["kind", "message", "plan"].includes(key)) && raw.plan !== undefined) {
    return { kind: "draft", message: raw.message, plan: raw.plan as PlanDefinition };
  }
  throw new PlannerOperationError("planner_invalid_reply", "Planner kind 必须是 clarification 或 draft，字段不能混用");
}

function parsePlanWithPolicy(value: unknown, execution: ExecutionConfig): PlanDefinition {
  const result = checkPlan(value, execution);
  if (!result.valid || !result.plan) throw new PlannerOperationError("planner_invalid_plan", result.diagnostics[0]?.message ?? "计划校验失败");
  return result.plan;
}

function ensurePlanSize(plan: PlanDefinition): void {
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > PLAN_LIMIT) throw new PlannerOperationError("planner_plan_size", "计划 JSON 超过 48 KiB");
}

function makeDraft(snapshot: PlannerConversationSnapshot, reply: PlannerReply, evidence: RepositoryEvidence[]): PlannerDraft {
  if (reply.kind !== "draft" || !reply.plan) throw new Error("内部错误：draft 缺少计划");
  const previousRevision = snapshot.draftRevision ?? 0;
  const hash = canonicalHash(reply.plan);
  return {
    schemaVersion: 1, planningId: snapshot.planningId, draftRevision: previousRevision + 1,
    plan: reply.plan, message: reply.message, source: "model", context: evidence, planHash: hash, createdAt: new Date().toISOString(),
  };
}

function mergeEvidence(previous: RepositoryEvidence[], current: RepositoryEvidence[]): RepositoryEvidence[] {
  const items = new Map(previous.map((item) => [item.path, item]));
  for (const item of current) items.set(item.path, item);
  return [...items.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function nextSnapshot(snapshot: PlannerConversationSnapshot, update: Partial<PlannerConversationSnapshot>): PlannerConversationSnapshot {
  return { ...snapshot, ...update, revision: snapshot.revision + 1, updatedAt: new Date().toISOString() };
}

function validateRequest(value: string): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > USER_MESSAGE_LIMIT) throw new InputValidationError("planner.message", "需求必须是非空文本且不超过 8 KiB");
}

function validateExecutionDefaults(value: ExecutionConfig): void {
  if (!value || !["mock", "claude-code"].includes(value.runnerId) || value.mode !== "non_interactive" ||
      !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 3_600_000 ||
      (value.runnerId === "mock" && value.modelId !== undefined)) throw new InputValidationError("planner.execution", "执行默认配置无效");
}

function validateConfig(config: PlannerConfig): void {
  if (config.provider === "mock") {
    if (config.model !== "mock" || config.baseUrl !== "mock://local") throw new InputValidationError("planner.config", "Mock Planner 配置无效");
    return;
  }
  if (config.provider !== "deepseek" || !config.model || Buffer.byteLength(config.model, "utf8") > 256) throw new InputValidationError("planner.config", "Planner provider/model 无效");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new InputValidationError("planner.config", "Planner endpoint 不是有效 URL"); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new InputValidationError("planner.config", "Planner endpoint 必须使用 HTTPS（本机回环可用 HTTP），且不能包含凭证");
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const apiKey = process.env.TOKEN_COUPON_PLANNER_API_KEY;
  return (apiKey ? message.replaceAll(apiKey, "[已隐藏]") : message).slice(0, 1024);
}

class PlannerOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PlannerOperationError"; }
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => { didTimeout = true; controller.abort(new Error("Planner 规划轮次超过 120 秒")); }, timeoutMs);
  const onAbort = () => controller.abort(parent?.reason ?? new Error("Planner 规划轮次已取消"));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => { clearTimeout(timeout); parent?.removeEventListener("abort", onAbort); },
  };
}
