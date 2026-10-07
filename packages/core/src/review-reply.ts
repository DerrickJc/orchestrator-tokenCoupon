import { randomUUID } from "node:crypto";
import type { PlanReviewFinding, PlanReviewRecord, ReviewResolution } from "./planner-types.js";

export class ReviewReplyValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReviewReplyValidationError";
  }
}

export interface ValidatedReviewReply {
  summary: string;
  findings: Array<Omit<PlanReviewFinding, "issueId">>;
  resolutions: Array<Omit<ReviewResolution, "issueId">>;
}

function invalid(message: string): never {
  throw new ReviewReplyValidationError("review_reply_invalid", message);
}

export function validateReviewReply(
  value: unknown,
  knownTaskIds: string[],
  knownRequirementIds: string[],
  previous?: PlanReviewRecord,
): ValidatedReviewReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("审查回复必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["summary", "findings", "resolutions"].includes(key)) || typeof raw.summary !== "string" || !raw.summary.trim() ||
      Buffer.byteLength(raw.summary, "utf8") > 16 * 1024 || !Array.isArray(raw.findings) || raw.findings.length > 100) return invalid("审查报告结构无效");
  const findings: ValidatedReviewReply["findings"] = raw.findings.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid("findings[" + index + "] 必须是对象");
    const finding = item as Record<string, unknown>;
    if (Object.keys(finding).some((key) => !["findingId", "severity", "category", "taskIds", "requirementIds", "description", "basis", "suggestion", "priorFindingId"].includes(key)) ||
        !["error", "warning", "info"].includes(String(finding.severity)) || !["requirements", "dependency", "technology", "contract", "testing"].includes(String(finding.category)) ||
        !Array.isArray(finding.taskIds) || finding.taskIds.some((id) => typeof id !== "string" || !knownTaskIds.includes(id)) ||
        typeof finding.description !== "string" || !finding.description.trim() || Buffer.byteLength(finding.description, "utf8") > 8192 ||
        typeof finding.basis !== "string" || !finding.basis.trim() || Buffer.byteLength(finding.basis, "utf8") > 8192 ||
        typeof finding.suggestion !== "string" || !finding.suggestion.trim() || Buffer.byteLength(finding.suggestion, "utf8") > 8192) {
      return invalid("findings[" + index + "] 字段无效或引用了未知任务");
    }
    const findingId = finding.findingId === undefined ? "F" + (index + 1) : finding.findingId;
    if (typeof findingId !== "string" || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(findingId)) return invalid("findings[" + index + "].findingId 无效");
    if (finding.priorFindingId !== undefined && (typeof finding.priorFindingId !== "string" || !previous?.findings.some(({ findingId: id }) => id === finding.priorFindingId))) {
      return invalid("priorFindingId 引用了未知的上轮问题");
    }
    if (finding.requirementIds !== undefined && (!Array.isArray(finding.requirementIds) || finding.requirementIds.some((id) => typeof id !== "string" || !knownRequirementIds.includes(id)))) {
      return invalid("审查引用了未知需求");
    }
    return {
      findingId, severity: finding.severity as PlanReviewFinding["severity"], category: finding.category as PlanReviewFinding["category"],
      taskIds: finding.taskIds as string[], description: finding.description, basis: finding.basis, suggestion: finding.suggestion,
      ...(finding.priorFindingId === undefined ? {} : { priorFindingId: finding.priorFindingId as string }),
      ...(finding.requirementIds === undefined ? {} : { requirementIds: finding.requirementIds as string[] }),
    };
  });
  if (new Set(findings.map(({ findingId }) => findingId)).size !== findings.length) return invalid("审查报告包含重复 findingId");
  const continuedIds = findings.flatMap(({ priorFindingId }) => priorFindingId ? [priorFindingId] : []);
  if (new Set(continuedIds).size !== continuedIds.length) return invalid("多个问题引用同一旧问题");
  const resolutions = parseResolutions(raw.resolutions, previous, findings);
  return { summary: raw.summary, findings, resolutions };
}

function parseResolutions(
  value: unknown,
  previous: PlanReviewRecord | undefined,
  findings: ValidatedReviewReply["findings"],
): ValidatedReviewReply["resolutions"] {
  const priorFindings = previous?.findings ?? [];
  if (value === undefined && priorFindings.length === 0) return [];
  if (!Array.isArray(value)) return invalid("复审必须逐项说明上轮问题的解决情况");
  const ids = value.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).findingId : undefined);
  const seen = new Set<string>();
  const resolutions = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid("问题解决记录无效");
    const item = entry as Record<string, unknown>;
    const prior = priorFindings.find(({ findingId }) => findingId === item.findingId);
    if (!prior || seen.has(prior.findingId) || Object.keys(item).some((key) => !["findingId", "status", "basis"].includes(key)) ||
        !["resolved", "unresolved"].includes(String(item.status)) || typeof item.basis !== "string" || !item.basis.trim() ||
        Buffer.byteLength(item.basis, "utf8") > 4096) return invalid("问题解决记录引用、状态或依据无效");
    seen.add(prior.findingId);
    const continued = findings.some(({ priorFindingId }) => priorFindingId === prior.findingId);
    if (continued !== (item.status === "unresolved")) return invalid("旧问题解决状态与本轮 findings 不一致");
    return { findingId: prior.findingId, status: item.status as "resolved" | "unresolved", basis: item.basis };
  });
  if (resolutions.length !== priorFindings.length) {
    const missing = priorFindings.filter(({ findingId }) => !seen.has(findingId)).map(({ findingId }) => findingId);
    const duplicates = ids.filter((id): id is string => typeof id === "string").filter((id, index, all) => all.indexOf(id) !== index);
    const detail = missing.length ? "遗漏：" + missing.join(", ") : duplicates.length ? "重复：" + [...new Set(duplicates)].join(", ") : "数量不匹配";
    return invalid("复审必须逐项说明上轮问题的解决情况（" + detail + "）");
  }
  return resolutions;
}

export function finalizeReviewReply(value: ValidatedReviewReply, previous?: PlanReviewRecord): {
  summary: string; findings: PlanReviewFinding[]; resolutions: ReviewResolution[];
} {
  const findings: PlanReviewFinding[] = value.findings.map((finding) => {
    const prior = finding.priorFindingId === undefined ? undefined : previous?.findings.find(({ findingId }) => findingId === finding.priorFindingId);
    return {
      ...finding,
      issueId: prior ? prior.issueId ?? ("issue-" + previous!.reviewId + "-" + prior.findingId) : "issue-" + randomUUID(),
    };
  });
  const resolutions: ReviewResolution[] = value.resolutions.map((resolution) => {
    const prior = previous?.findings.find(({ findingId }) => findingId === resolution.findingId);
    return { ...resolution, ...(prior ? { issueId: prior.issueId ?? ("issue-" + previous!.reviewId + "-" + prior.findingId) } : {}) };
  });
  return { summary: value.summary, findings, resolutions };
}
