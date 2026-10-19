import type { PlannerEventObserver } from "@token-coupon/core";

export interface PlanningProgress {
  planningId: string;
  operationId: string;
  role: "plan" | "review";
  stage: string;
  startedAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastOutputAt?: string;
  runnerId?: string;
  configuredModel?: string;
  reportedModel?: string;
  requestId?: number;
  replyPreview?: string;
  rawPreview?: string;
  detail?: string;
  status?: string;
}

/** Only user-facing assistant text is eligible; reasoning and stderr never enter here. */
export function redactPlannerText(text: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value && value.length >= 8) text = text.replaceAll(value, "[已隐藏]");
  }
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [已隐藏]")
    .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)"\s*:\s*")[^"\n]*(")/gi, "$1[已隐藏]$2");
}

export function plannerReplyPreview(text: string): string {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(normalized);
    return typeof value.message === "string" ? value.message.slice(0, 4096) : typeof value.summary === "string" ? value.summary.slice(0, 4096) : "";
  } catch {
    // A complete quoted field may arrive before the rest of the JSON object.
    const match = /"(?:message|summary)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(normalized);
    if (match) { try { return String(JSON.parse(match[1]!)).slice(0, 4096); } catch { /* Wait for a complete field. */ } }
    return /^[{\[]/.test(normalized) ? "" : normalized.slice(0, 4096);
  }
}

export function projectPlanningProgress(previous: PlanningProgress | undefined, event: Parameters<PlannerEventObserver>[0], now = new Date().toISOString()): PlanningProgress {
  const payload = event.payload;
  const next: PlanningProgress = { ...(previous ?? { stage: "preparing", role: payload.role === "review" ? "review" : "plan", startedAt: now }), planningId: event.planningId, operationId: event.turnId ?? event.reviewId ?? event.planningId, updatedAt: now };
  if (event.type === "agent.request") {
    next.stage = "starting"; next.requestId = payload.requestId as number;
    next.runnerId = String(payload.runnerId); next.configuredModel = String(payload.model);
    delete next.reportedModel; delete next.replyPreview; delete next.rawPreview;
  } else if (event.type === "agent.process.started") next.stage = "initializing";
  else if (event.type === "agent.started") { next.stage = "waiting_model"; next.lastActivityAt = now; }
  else if (event.type === "agent.output") {
    next.stage = "receiving"; next.lastActivityAt = now; next.lastOutputAt = now;
    next.replyPreview = redactPlannerText(String(payload.preview || "")).slice(0, 4096);
    next.rawPreview = redactPlannerText(String(payload.text || "")).slice(0, 8192);
  } else if (event.type === "agent.response") { next.stage = "validating"; next.lastOutputAt = now; next.lastActivityAt = now; }
  else if (event.type === "planner.validating" || event.type === "agent.validating") next.stage = "validating";
  else if (["planner.validation_failed", "agent.review.validation_failed"].includes(event.type)) {
    const diagnostic = String(payload.message || "回复未通过校验").replace(/^上次回复未通过应用校验：/, "").split("。复用已有调研")[0]!;
    next.stage = "repairing"; next.detail = `第 ${payload.attempt || 1} 次自动修正：${redactPlannerText(diagnostic).slice(0, 1200)}`;
  } else if (event.type === "agent.diagnostic") next.detail = redactPlannerText(String(payload.message || "")).slice(0, 1400);
  else if (event.type === "planner.turn.finished") { next.status = String(payload.status); next.stage = next.status === "succeeded" ? "completed" : next.status === "cancelled" ? "cancelled" : "failed"; next.detail = String(payload.message || ""); }
  if (typeof payload.reportedModel === "string" && payload.reportedModel) next.reportedModel = payload.reportedModel.slice(0, 200);
  if (event.type === "agent.model.reported") next.lastActivityAt = now;
  return next;
}
