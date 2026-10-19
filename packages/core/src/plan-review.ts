import { randomUUID } from "node:crypto";
import { DeepSeekPlanner } from "./planners/deepseek-planner.js";
import { MockPlanReviewer } from "./planners/mock-planner.js";
import { canonicalHash, PlannerStore } from "./planner-store.js";
import type { PlanReviewFinding, PlanReviewInput, PlanReviewRecord, PlanReviewer, PlannerConfig, PlannerContext, PlannerConversationSnapshot, PlannerEvent, RepositoryEvidence } from "./planner-types.js";
import { RepositoryReader, verifyRepositoryEvidence } from "./repository-reader.js";
import { ReviewStore, reviewReportPayload, validateReviewRecord } from "./review-store.js";
import { createHistoryReader, effectiveRequirements, requireReconciledRequirements } from "./requirements.js";
import { diffPlans } from "./plan-diff.js";
import { SessionStore } from "./session-store.js";
import { InputValidationError } from "./validation.js";
import { assertPlanningReady } from "./planning-readiness.js";
import { finalizeReviewReply, validateReviewReply } from "./review-reply.js";
import { plannerDeadline, plannerFailure, type PlannerEventObserver } from "./planner-runtime.js";

const API_REQUEST_LIMIT = 8;
const TOOL_CALL_LIMIT = 20;
const HISTORY_LIMIT = 256 * 1024;

export interface PlanReviewOperationResult {
  snapshot: PlannerConversationSnapshot;
  draft: NonNullable<Awaited<ReturnType<PlannerStore["loadDraft"]>>>;
  review: PlanReviewRecord;
}

export async function reviewPlannerDraft(options: {
  planningId: string;
  workspace: string;
  reviewer?: PlanReviewer;
  reviewerConfig?: PlannerConfig;
  signal?: AbortSignal;
  onEvent?: PlannerEventObserver;
  expectedRevision?: number;
  repositoryOutputBudgetBytes?: number;
  beforeCommit?: () => Promise<void>;
}): Promise<PlanReviewOperationResult> {
  const plannerStore = new PlannerStore(options.workspace);
  const release = await plannerStore.acquireLock(options.planningId);
  try {
    let snapshot = await plannerStore.load(options.planningId);
    if (options.expectedRevision !== undefined && snapshot.revision !== options.expectedRevision) throw new Error("external_context_stale：审查依据已变化，请重新准备上下文");
    if (snapshot.activeTurnId) throw new Error("规划轮次尚未完成，请先恢复规划对话");
    if (snapshot.execution) throw new Error("已关联执行 Session 的规划只允许查看历史审查");
    if (snapshot.draftRevision === null || !["draft_ready", "approved"].includes(snapshot.status)) throw new Error("当前没有可审查的计划草案");
    const draft = await plannerStore.loadDraft(options.planningId, snapshot.draftRevision);
    assertPlanningReady(snapshot.planningAssessment, draft.plan);
    const requirements = requireReconciledRequirements(snapshot);

    const existingEvidenceChanges = await verifyRepositoryEvidence(plannerStore.workspace, draft.context, options.signal);
    if (existingEvidenceChanges.length) throw new Error("workspace_changed：计划依据已变化，请重新调研并生成草案后再审查：" + existingEvidenceChanges.join(", "));

    const reviewStore = new ReviewStore(plannerStore.workspace);
    for (const prior of await reviewStore.list(options.planningId)) {
      if (prior.status === "running") {
        const interrupted: PlanReviewRecord = { ...prior, status: "interrupted", reasonCode: "review_interrupted", summary: "审查进程在写入完成报告前中断。", finishedAt: new Date().toISOString() };
        await reviewStore.save(interrupted);
        await reviewStore.appendEvent(options.planningId, prior.reviewId, "review.interrupted", {});
      }
    }

    const previousReview = (await reviewStore.list(options.planningId)).filter(({ status }) => status === "succeeded").at(-1);
    const input: PlanReviewInput = {
      requirements: effectiveRequirements(requirements).map(({ text }) => text),
      requirementItems: effectiveRequirements(requirements),
      ...(snapshot.planningAssessment ? { planningAssessment: snapshot.planningAssessment } : {}),
      plan: draft.plan, executionDefaults: snapshot.executionDefaults,
      ...(previousReview ? { previousReview, planChanges: diffPlans((await plannerStore.loadDraft(options.planningId, previousReview.draftRevision)).plan, draft.plan) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > HISTORY_LIMIT) throw new Error("有效需求与审查输入超过 256 KiB 上下文限制");

    const reviewId = randomUUID();
    const startedAt = new Date().toISOString();
    const record: PlanReviewRecord = {
      schemaVersion: 1, planningId: options.planningId, reviewId, status: "running", draftRevision: draft.draftRevision,
      planHash: draft.planHash, requirementsHash: requirementsHash(snapshot), reviewerConfigHash: reviewerConfigHash(options.reviewerConfig ?? snapshot.config, draft.plan.schemaVersion, !!snapshot.planningAssessment),
      ...(options.reviewerConfig ? { reviewerConfig: options.reviewerConfig } : {}),
      context: draft.context, findings: [], summary: "审查进行中", reportHash: null, reasonCode: null, createdAt: startedAt, finishedAt: null,
      ...(previousReview ? { previousReviewId: previousReview.reviewId } : {}), resolutions: [],
    };
    await reviewStore.create(record);

    const timed = plannerDeadline(options.reviewerConfig ?? snapshot.config, options.signal, "review");
    const notify = async (event: PlannerEvent) => { await options.onEvent?.({ ...event, planningId: options.planningId, reviewId }).catch(() => undefined); };
    const reader = new RepositoryReader(plannerStore.workspace, timed.signal, draft.context.reduce((sum, evidence) => sum + evidence.sizeBytes, 0), options.repositoryOutputBudgetBytes);
    const counters = { requests: 0, tools: 0 };
    const context: PlannerContext = {
      signal: timed.signal,
      repository: reader,
      readHistory: createHistoryReader(snapshot),
      validateReviewReply: (value) => validateReviewReply(value, draft.plan.tasks.map(({ task }) => task.id), input.requirementItems!.map(({ requirementId }) => requirementId), previousReview),
      consumeApiRequest: () => {
        counters.requests += 1;
        if (counters.requests > API_REQUEST_LIMIT) throw new Error("本轮审查 API 请求超过 8 次");
        return counters.requests;
      },
      consumeToolCall: () => {
        counters.tools += 1;
        if (counters.tools > TOOL_CALL_LIMIT) throw new Error("本轮审查仓库工具调用超过 20 次");
      },
      record: async (event: PlannerEvent) => {
        if (event.type === "agent.output" || event.type === "agent.heartbeat") { await notify(event); return; }
        if (event.type === "agent.response" && typeof event.payload.text === "string") {
          await reviewStore.writeProviderCall(options.planningId, reviewId, event.payload.requestId as number, "response", event.payload);
          const { text: _text, ...summary } = event.payload;
          event = { ...event, payload: summary };
        }
        if (event.type === "provider.request" || event.type === "provider.response") {
          const requestId = event.payload.requestId;
          if (typeof requestId !== "number") throw new Error("审查 API 日志缺少 requestId");
          const kind = event.type === "provider.request" ? "request" : "response";
          await reviewStore.writeProviderCall(options.planningId, reviewId, requestId, kind, event.payload);
          await reviewStore.appendEvent(options.planningId, reviewId, event.type, {
            requestId,
            model: event.payload.model,
            status: event.payload.status,
          });
        } else {
          await reviewStore.appendEvent(options.planningId, reviewId, event.type, event.payload);
        }
        await notify(event);
      },
    };
    try {
      await notify({ type: "planner.turn.started", payload: { role: "review", provider: (options.reviewerConfig ?? snapshot.config).provider, model: (options.reviewerConfig ?? snapshot.config).model } });
      const reviewer = options.reviewer ?? createPlanReviewer(options.reviewerConfig ?? snapshot.config);
      const raw = await reviewer.review(input, context);
      await notify({ type: "planner.validating", payload: {} });
      const reviewerReportedModel = (reviewer as PlanReviewer & { reportedModel?: string }).reportedModel;
      if (timed.signal.aborted) throw timed.signal.reason ?? new Error("审查已取消");
      const parsed = ensureTechnologySelectionFinding(
        parseReviewReply(raw, draft.plan.tasks.map(({ task }) => task.id), input.requirementItems!.map(({ requirementId }) => requirementId), previousReview),
        snapshot.planningAssessment,
      );
      const evidence = mergeEvidence(draft.context, reader.getEvidence());
      const changed = await verifyRepositoryEvidence(plannerStore.workspace, evidence, timed.signal);
      if (changed.length) throw new Error("workspace_changed：审查期间依据文件发生变化：" + changed.join(", "));
      const finishedAt = new Date().toISOString();
      const succeeded = validateReviewRecord({
        ...record, status: "succeeded", context: evidence, ...parsed,
        ...(reviewerReportedModel ? { reviewerReportedModel } : {}),
        reportHash: canonicalHash(reviewReportPayload({ ...record, ...parsed })), finishedAt,
      });
      await options.beforeCommit?.();
      await reviewStore.save(succeeded);
      await reviewStore.appendEvent(options.planningId, reviewId, "review.succeeded", { findings: succeeded.findings.length });

      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        updatedAt: finishedAt,
        status: "draft_ready",
        latestReviewId: reviewId,
        approval: null,
      };
      await plannerStore.save(snapshot);
      await notify({ type: "planner.turn.finished", payload: { status: "succeeded" } });
      timed.dispose();
      return { snapshot, draft, review: succeeded };
    } catch (error) {
      const timedOut = timed.timedOut();
      const cancelled = timed.signal.aborted && !timedOut;
      const finishedAt = new Date().toISOString();
      const failure = plannerFailure(error, timed, "review");
      const failed = validateReviewRecord({
        ...record,
        status: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
        context: mergeEvidence(draft.context, reader.getEvidence()), findings: [],
        summary: safeError(failure.message), reportHash: null,
        reasonCode: failure.code ?? (error instanceof Error ? error.name : "review_failed"),
        finishedAt,
      });
      await reviewStore.save(failed).catch(() => undefined);
      await reviewStore.appendEvent(options.planningId, reviewId, "review.failed", { status: failed.status, reasonCode: failed.reasonCode }).catch(() => undefined);
      await notify({ type: "planner.turn.finished", payload: { status: failed.status, reasonCode: failed.reasonCode, message: failed.summary } });
      timed.dispose();
      throw new Error(`${failed.summary}（审查记录：${reviewId}）`);
    }
  } finally {
    await release();
  }
}

export function createPlanReviewer(config: PlannerConfig, options: { fetchImpl?: typeof fetch } = {}): PlanReviewer {
  if (config.provider === "mock") return new MockPlanReviewer();
  if (["chatgpt-mcp", "web-mcp"].includes(config.provider)) throw new Error("external_review_required：请在网页中通过 MCP 准备并提交审查，当前没有发出 API 请求");
  if (["codex-agent", "claude-agent"].includes(config.provider)) throw new Error("local_agent_reviewer_requires_daemon：本机 Agent 审查需由 daemon 使用只读 Runner 适配器调用");
  return new DeepSeekPlanner({ model: config.model, baseUrl: config.baseUrl, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
}

/** Prepare under a short lock; no model request or running review is created. */
export async function prepareExternalReviewInput(planningId: string, workspace: string): Promise<{ expectedRevision: number; input: PlanReviewInput }> {
  const store = new PlannerStore(workspace);
  const release = await store.acquireLock(planningId);
  try {
    const snapshot = await store.load(planningId);
    if (snapshot.activeTurnId || snapshot.execution || snapshot.draftRevision === null) throw new Error("external_review_unavailable：当前没有可提交网页审查的草案");
    const draft = await store.loadDraft(planningId, snapshot.draftRevision);
    assertPlanningReady(snapshot.planningAssessment, draft.plan);
    const requirements = requireReconciledRequirements(snapshot);
    const previousReview = (await new ReviewStore(store.workspace).list(planningId)).filter(({ status }) => status === "succeeded").at(-1);
    const input: PlanReviewInput = {
      requirements: effectiveRequirements(requirements).map(({ text }) => text), requirementItems: effectiveRequirements(requirements),
      ...(snapshot.planningAssessment ? { planningAssessment: snapshot.planningAssessment } : {}),
      plan: draft.plan, executionDefaults: snapshot.executionDefaults,
      ...(previousReview ? { previousReview, planChanges: diffPlans((await store.loadDraft(planningId, previousReview.draftRevision)).plan, draft.plan) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > HISTORY_LIMIT) throw new Error("context_budget_exceeded：外部审查上下文超过 256 KiB");
    return { expectedRevision: snapshot.revision, input };
  } finally { await release(); }
}

export async function loadCurrentPlanReview(planningId: string, workspace: string): Promise<PlanReviewRecord | undefined> {
  const plannerStore = new PlannerStore(workspace);
  const snapshot = await plannerStore.load(planningId);
  if (!snapshot.latestReviewId || snapshot.draftRevision === null) return undefined;
  try { requireReconciledRequirements(snapshot); } catch { return undefined; }
  const [draft, record] = await Promise.all([
    plannerStore.loadDraft(planningId, snapshot.draftRevision),
    new ReviewStore(workspace).load(planningId, snapshot.latestReviewId),
  ]);
  if (record.status !== "succeeded" || record.draftRevision !== draft.draftRevision || record.planHash !== draft.planHash ||
      record.requirementsHash !== requirementsHash(snapshot) || record.reviewerConfigHash !== reviewerConfigHash(record.reviewerConfig ?? snapshot.config, draft.plan.schemaVersion, !!snapshot.planningAssessment)) return undefined;
  const changed = await verifyRepositoryEvidence(workspace, record.context);
  return changed.length ? undefined : record;
}

export function requirementsHash(snapshot: PlannerConversationSnapshot): string {
  const requirements = effectiveRequirements(requireReconciledRequirements(snapshot));
  if (!snapshot.planningAssessment) return canonicalHash(requirements);
  const decisions = snapshot.planningAssessment ? {
    profile: snapshot.planningAssessment.profile,
    decisions: [...snapshot.planningAssessment.decisions].sort((a, b) => a.decisionId.localeCompare(b.decisionId)),
  } : null;
  return canonicalHash({ requirements, planningAssessment: decisions });
}

export function reviewerConfigHash(config: PlannerConfig, planSchemaVersion: 1 | 2 = 1, hasStructuredAssessment = true): string {
  const reviewPromptVersion = planSchemaVersion === 2 ? 8 : hasStructuredAssessment ? 7 : 6;
  return canonicalHash({ provider: config.provider, model: config.model, baseUrl: config.baseUrl, reviewPromptVersion });
}

function ensureTechnologySelectionFinding(
  reply: { summary: string; findings: PlanReviewFinding[]; resolutions: import("./planner-types.js").ReviewResolution[] },
  assessment: PlannerConversationSnapshot["planningAssessment"],
) {
  if (assessment?.profile !== "existing_project" || assessment.schemaVersion === 2) return reply;
  if (reply.findings.length >= 100) throw new Error("review_findings_limit：缺少技术选型依据的系统门禁无法加入审查报告");
  const gateSummary = "系统门禁：此 existing_project 规划沿用旧版 assessment，未结构化记录 technology_selection。即使草案增加‘先核验、缺失则暂停’任务，也不能视为具体技术选择已确认；需重新规划并完成决策审查。";
  let summary = reply.summary;
  while (Buffer.byteLength(summary + "\n\n" + gateSummary, "utf8") > 16 * 1024) summary = summary.slice(0, -1);
  return {
    ...reply,
    summary: `${summary}\n\n${gateSummary}`,
    findings: [...reply.findings, {
      findingId: "SYS-TECH-SELECTION", severity: "error" as const, category: "technology" as const, taskIds: [], requirementIds: [],
      description: "缺少高影响技术选型的结构化授权或权威依据。新增核验门禁只定义了发现缺项后的处理方式，没有确认数据库、异步设施、检索实现及适用依赖版本。",
      basis: "程序检查发现 existing_project planningAssessment 未使用 schemaVersion 2，因而没有有效的 technology_selection 决策记录。",
      suggestion: "补充具体技术选择及其来源，或记录用户在明确范围内的选择授权；重新生成草案、复审后再批准。旧版批准入口也会被执行门禁拒绝。",
    }],
  };
}

function parseReviewReply(value: unknown, knownTaskIds: string[], knownRequirementIds: string[], previous?: PlanReviewRecord): { summary: string; findings: PlanReviewFinding[]; resolutions: import("./planner-types.js").ReviewResolution[] } {
  return finalizeReviewReply(validateReviewReply(value, knownTaskIds, knownRequirementIds, previous), previous);
}

function mergeEvidence(previous: RepositoryEvidence[], current: RepositoryEvidence[]): RepositoryEvidence[] {
  const values = new Map(previous.map((item) => [item.path, item]));
  for (const item of current) values.set(item.path, item);
  return [...values.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function safeError(error: unknown): string {
  const apiKey = process.env.TOKEN_COUPON_PLANNER_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return (apiKey ? message.replaceAll(apiKey, "[已隐藏]") : message).slice(0, 1024);
}
