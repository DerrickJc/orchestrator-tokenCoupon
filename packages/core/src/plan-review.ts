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

const REVIEW_TIMEOUT_MS = 120_000;
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
  signal?: AbortSignal;
}): Promise<PlanReviewOperationResult> {
  const plannerStore = new PlannerStore(options.workspace);
  const release = await plannerStore.acquireLock(options.planningId);
  try {
    let snapshot = await plannerStore.load(options.planningId);
    if (snapshot.activeTurnId) throw new Error("规划轮次尚未完成，请先恢复规划对话");
    if (snapshot.execution) throw new Error("已关联执行 Session 的规划只允许查看历史审查");
    if (snapshot.draftRevision === null || !["draft_ready", "approved"].includes(snapshot.status)) throw new Error("当前没有可审查的计划草案");
    const draft = await plannerStore.loadDraft(options.planningId, snapshot.draftRevision);
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
      plan: draft.plan, executionDefaults: snapshot.executionDefaults,
      ...(previousReview ? { previousReview, planChanges: diffPlans((await plannerStore.loadDraft(options.planningId, previousReview.draftRevision)).plan, draft.plan) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > HISTORY_LIMIT) throw new Error("有效需求与审查输入超过 256 KiB 上下文限制");

    const reviewId = randomUUID();
    const startedAt = new Date().toISOString();
    const record: PlanReviewRecord = {
      schemaVersion: 1, planningId: options.planningId, reviewId, status: "running", draftRevision: draft.draftRevision,
      planHash: draft.planHash, requirementsHash: requirementsHash(snapshot), reviewerConfigHash: reviewerConfigHash(snapshot.config),
      context: draft.context, findings: [], summary: "审查进行中", reportHash: null, reasonCode: null, createdAt: startedAt, finishedAt: null,
      ...(previousReview ? { previousReviewId: previousReview.reviewId } : {}), resolutions: [],
    };
    await reviewStore.create(record);

    const timed = makeTimeoutSignal(options.signal, REVIEW_TIMEOUT_MS);
    const reader = new RepositoryReader(plannerStore.workspace, timed.signal, draft.context.reduce((sum, evidence) => sum + evidence.sizeBytes, 0));
    const counters = { requests: 0, tools: 0 };
    const context: PlannerContext = {
      signal: timed.signal,
      repository: reader,
      readHistory: createHistoryReader(snapshot),
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
      },
    };
    try {
      const reviewer = options.reviewer ?? createPlanReviewer(snapshot.config);
      const raw = await reviewer.review(input, context);
      if (timed.signal.aborted) throw timed.signal.reason ?? new Error("审查已取消");
      const parsed = parseReviewReply(raw, draft.plan.tasks.map(({ task }) => task.id), input.requirementItems!.map(({ requirementId }) => requirementId), previousReview);
      const evidence = mergeEvidence(draft.context, reader.getEvidence());
      const changed = await verifyRepositoryEvidence(plannerStore.workspace, evidence, timed.signal);
      if (changed.length) throw new Error("workspace_changed：审查期间依据文件发生变化：" + changed.join(", "));
      const finishedAt = new Date().toISOString();
      const succeeded = validateReviewRecord({
        ...record, status: "succeeded", context: evidence, ...parsed,
        reportHash: canonicalHash(reviewReportPayload({ ...record, ...parsed })), finishedAt,
      });
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
      timed.dispose();
      return { snapshot, draft, review: succeeded };
    } catch (error) {
      const timedOut = timed.didTimeout();
      const cancelled = timed.signal.aborted && !timedOut;
      const finishedAt = new Date().toISOString();
      const failed = validateReviewRecord({
        ...record,
        status: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
        context: mergeEvidence(draft.context, reader.getEvidence()), findings: [],
        summary: safeError(error), reportHash: null,
        reasonCode: timedOut ? "review_timed_out" : cancelled ? "review_cancelled" : error instanceof Error ? error.name : "review_failed",
        finishedAt,
      });
      await reviewStore.save(failed).catch(() => undefined);
      await reviewStore.appendEvent(options.planningId, reviewId, "review.failed", { status: failed.status, reasonCode: failed.reasonCode }).catch(() => undefined);
      timed.dispose();
      throw new Error(`${safeError(error)}（审查记录：${reviewId}）`);
    }
  } finally {
    await release();
  }
}

export function createPlanReviewer(config: PlannerConfig, options: { fetchImpl?: typeof fetch } = {}): PlanReviewer {
  if (config.provider === "mock") return new MockPlanReviewer();
  return new DeepSeekPlanner({ model: config.model, baseUrl: config.baseUrl, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
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
      record.requirementsHash !== requirementsHash(snapshot) || record.reviewerConfigHash !== reviewerConfigHash(snapshot.config)) return undefined;
  const changed = await verifyRepositoryEvidence(workspace, record.context);
  return changed.length ? undefined : record;
}

export function requirementsHash(snapshot: PlannerConversationSnapshot): string {
  return canonicalHash(effectiveRequirements(requireReconciledRequirements(snapshot)));
}

export function reviewerConfigHash(config: PlannerConfig): string {
  return canonicalHash({ provider: config.provider, model: config.model, baseUrl: config.baseUrl, reviewPromptVersion: 2 });
}

function parseReviewReply(value: unknown, knownTaskIds: string[], knownRequirementIds: string[], previous?: PlanReviewRecord): { summary: string; findings: PlanReviewFinding[]; resolutions: import("./planner-types.js").ReviewResolution[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("审查回复必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["summary", "findings", "resolutions"].includes(key)) || typeof raw.summary !== "string" || !raw.summary.trim() ||
      Buffer.byteLength(raw.summary, "utf8") > 16 * 1024 || !Array.isArray(raw.findings) || raw.findings.length > 100) throw new Error("审查报告结构无效");
  const findings: PlanReviewFinding[] = raw.findings.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`findings[${index}] 必须是对象`);
    const finding = item as Record<string, unknown>;
    if (Object.keys(finding).some((key) => !["findingId", "severity", "category", "taskIds", "requirementIds", "description", "basis", "suggestion", "priorFindingId"].includes(key)) ||
        !["error", "warning", "info"].includes(String(finding.severity)) || !["requirements", "dependency", "technology", "contract", "testing"].includes(String(finding.category)) ||
        !Array.isArray(finding.taskIds) || finding.taskIds.some((id) => typeof id !== "string" || !knownTaskIds.includes(id)) ||
        typeof finding.description !== "string" || !finding.description.trim() || typeof finding.basis !== "string" || !finding.basis.trim() ||
        typeof finding.suggestion !== "string" || !finding.suggestion.trim()) throw new Error(`findings[${index}] 字段无效或引用了未知任务`);
    const findingId = typeof finding.findingId === "string" ? finding.findingId : `F${index + 1}`;
    const prior = finding.priorFindingId === undefined ? undefined : previous?.findings.find(({ findingId }) => findingId === finding.priorFindingId);
    if (finding.priorFindingId !== undefined && !prior) throw new Error("priorFindingId 引用了未知的上轮问题");
    if (finding.requirementIds !== undefined && (!Array.isArray(finding.requirementIds) || finding.requirementIds.some((id) => typeof id !== "string" || !knownRequirementIds.includes(id)))) throw new Error("审查引用了未知需求");
    return { findingId, severity: finding.severity as PlanReviewFinding["severity"], category: finding.category as PlanReviewFinding["category"],
      taskIds: finding.taskIds as string[], description: finding.description, basis: finding.basis, suggestion: finding.suggestion,
      issueId: prior ? prior.issueId ?? `issue-${previous!.reviewId}-${prior.findingId}` : "issue-" + randomUUID(),
      ...(prior ? { priorFindingId: prior.findingId } : {}), ...(finding.requirementIds ? { requirementIds: finding.requirementIds as string[] } : {}),
    };
  });
  if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) throw new Error("审查报告包含重复 findingId");
  if (new Set(findings.filter(({ priorFindingId }) => priorFindingId).map(({ priorFindingId }) => priorFindingId)).size !== findings.filter(({ priorFindingId }) => priorFindingId).length) throw new Error("多个问题引用同一旧问题");
  const resolutions = parseResolutions(raw.resolutions, previous, findings);
  return { summary: raw.summary, findings, resolutions };
}

function parseResolutions(value: unknown, previous: PlanReviewRecord | undefined, findings: PlanReviewFinding[]): import("./planner-types.js").ReviewResolution[] {
  if (value === undefined && !previous?.findings.length) return [];
  if (!Array.isArray(value) || value.length !== (previous?.findings.length ?? 0)) throw new Error("复审必须逐项说明上轮问题的解决情况");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("问题解决记录无效");
    const item = entry as Record<string, unknown>;
    const prior = previous?.findings.find(({ findingId }) => findingId === item.findingId);
    if (!prior || seen.has(prior.findingId) || Object.keys(item).some((key) => !["findingId", "status", "basis"].includes(key)) || !["resolved", "unresolved"].includes(String(item.status)) ||
        typeof item.basis !== "string" || !item.basis.trim() || Buffer.byteLength(item.basis, "utf8") > 4096) throw new Error("问题解决记录引用、状态或依据无效");
    seen.add(prior.findingId);
    const continued = findings.some(({ priorFindingId }) => priorFindingId === prior.findingId);
    if (continued !== (item.status === "unresolved")) throw new Error("旧问题解决状态与本轮 findings 不一致");
    return { findingId: prior.findingId, issueId: prior.issueId ?? `issue-${previous!.reviewId}-${prior.findingId}`, status: item.status as "resolved" | "unresolved", basis: item.basis };
  });
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

function makeTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; didTimeout: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; controller.abort(new Error("Planner 审查超过 120 秒")); }, timeoutMs);
  const abort = () => controller.abort(parent?.reason ?? new Error("Planner 审查已取消"));
  if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, didTimeout: () => timeout, dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}
