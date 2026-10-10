import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlannerStore } from "./planner-store.js";
import { loadCurrentPlanReview } from "./plan-review.js";
import { revisePlannerDraft } from "./planner-conversation.js";
import type { PlanReviewRecord, Planner } from "./planner-types.js";
import type { PlannerOperationResult } from "./planner-conversation.js";

export interface ReviewAction { findingId: string; action: "suggestion" | "custom" | "keep"; text?: string; }
/** Collecting UI choices is separate from declaring findings resolved or waived. */
export async function applyReviewActions(options: { workspace: string; review: PlanReviewRecord; actions: ReviewAction[]; planner?: Planner; signal?: AbortSignal }): Promise<{ actionId: string; revised?: PlannerOperationResult }> {
  const store = new PlannerStore(options.workspace);
  const release = await store.acquireLock(options.review.planningId);
  const actionId = randomUUID();
  let message = "";
  try {
    const current = await loadCurrentPlanReview(options.review.planningId, store.workspace);
    if (!current || current.reviewId !== options.review.reviewId || current.planHash !== options.review.planHash || current.draftRevision !== options.review.draftRevision) throw new Error("review_actions_stale：草案或报告已变化，请重新审查");
    if (options.actions.length !== current.findings.length || new Set(options.actions.map((a) => a.findingId)).size !== current.findings.length) throw new Error("必须完成全部问题的唯一选择");
    const decisions = options.actions.map((action) => {
      const finding = current.findings.find((f) => f.findingId === action.findingId);
      if (!finding || !["suggestion", "custom", "keep"].includes(action.action)) throw new Error("审查选择引用未知问题或动作");
      const text = action.action === "suggestion" ? finding.suggestion : action.action === "custom" ? action.text?.trim() : undefined;
      if (action.action !== "keep" && !text) throw new Error("自定义修订说明不能为空");
      return { findingId: finding.findingId, issueId: finding.issueId, taskIds: finding.taskIds, action: action.action, ...(text ? { text } : {}) };
    });
    const directory = join(store.workspace, ".token-coupon", "planners", current.planningId, "review-actions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${actionId}.json`), JSON.stringify({ schemaVersion: 1, actionId, planningId: current.planningId, reviewId: current.reviewId, draftRevision: current.draftRevision, planHash: current.planHash, decisions, createdAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (decisions.some((d) => d.action !== "keep")) message = "仅按以下选择修订；keep 保留为未解决，不表示解决或豁免。只有明确改变业务需求的自定义内容更新有效需求，其余是修订操作。\n" + JSON.stringify(decisions);
  } finally { await release(); }
  if (!message) return { actionId };
  const revised = await revisePlannerDraft({ workspace: options.workspace, planningId: options.review.planningId, reviewId: options.review.reviewId, expectedPlanHash: options.review.planHash, expectedDraftRevision: options.review.draftRevision, message, classifyRevision: true,
    ...(options.planner ? { planner: options.planner } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  return { actionId, revised };
}
