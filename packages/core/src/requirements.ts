import type { ConversationMessage, PlannerConversationSnapshot, Requirement, RequirementsState, RequirementsUpdate } from "./planner-types.js";

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message: string): never { throw new Error("需求记录无效：" + message); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("必须是对象");
const text = (value: unknown, limit = 4096): string => typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= limit ? value : fail("文本为空或超限");
export const emptyRequirements = (): RequirementsState => ({ revision: 0, items: [], messageDecisions: [] });

export function effectiveRequirements(state: RequirementsState): Requirement[] {
  return state.items.filter(({ status }) => status === "active" || status === "pending");
}

/** Failed/cancelled input stays in the audit history, but is not silently adopted. */
export function pendingRequirementMessages(snapshot: PlannerConversationSnapshot): ConversationMessage[] {
  const classified = new Set(snapshot.requirements?.messageDecisions.map(({ messageId }) => messageId));
  return snapshot.messages.filter((message) => {
    if (message.role !== "user" || classified.has(message.messageId)) return false;
    const turns = snapshot.turns.filter(({ messageId }) => messageId === message.messageId);
    return !turns.length || turns.some(({ status, turnId }) => status === "succeeded" || turnId === snapshot.activeTurnId);
  });
}

export function requireReconciledRequirements(snapshot: PlannerConversationSnapshot): RequirementsState {
  if (!snapshot.requirements || pendingRequirementMessages(snapshot).length) {
    throw new Error("有效需求尚未整理，请运行 /requirements refresh 或 planner requirements --refresh");
  }
  return snapshot.requirements;
}

export function validateRequirementsState(value: unknown, messages: ConversationMessage[]): RequirementsState {
  const raw = object(value);
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !Array.isArray(raw.items) || raw.items.length > 1024 ||
      !Array.isArray(raw.messageDecisions) || raw.messageDecisions.length > 512 || Buffer.byteLength(JSON.stringify(raw), "utf8") > 512 * 1024) fail("状态字段或大小超限");
  const users = new Set(messages.filter(({ role }) => role === "user").map(({ messageId }) => messageId));
  const messageDecisions = raw.messageDecisions.map((value) => {
    const item = object(value);
    if (typeof item.messageId !== "string" || !users.has(item.messageId) || !["requirement", "operation", "noise"].includes(String(item.kind))) fail("消息分类来源不存在");
    return { messageId: item.messageId as string, kind: item.kind as RequirementsUpdate["messageDecisions"][number]["kind"], reason: text(item.reason, 2048) };
  });
  if (new Set(messageDecisions.map(({ messageId }) => messageId)).size !== messageDecisions.length) fail("消息分类重复");
  const items = raw.items.map((value) => {
    const item = object(value);
    if (typeof item.requirementId !== "string" || !ID.test(item.requirementId) || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 ||
        !["active", "pending", "withdrawn", "superseded"].includes(String(item.status)) || !Array.isArray(item.sourceMessageIds) || !item.sourceMessageIds.length ||
        item.sourceMessageIds.length > 64 || item.sourceMessageIds.some((id) => typeof id !== "string" || !users.has(id))) fail("需求身份或来源无效");
    if (new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length) fail("需求来源重复");
    return { requirementId: item.requirementId, revision: item.revision as number, text: text(item.text), status: item.status as Requirement["status"], sourceMessageIds: item.sourceMessageIds as string[] };
  });
  if (new Set(items.map((item) => `${item.requirementId}@${item.revision}`)).size !== items.length) fail("需求版本重复");
  for (const id of new Set(items.map(({ requirementId }) => requirementId))) {
    const versions = items.filter(({ requirementId }) => requirementId === id).sort((a, b) => a.revision - b.revision);
    if (versions.some((item, index) => item.revision !== index + 1 || (index < versions.length - 1 && item.status !== "superseded")) || versions.at(-1)?.status === "superseded") fail("需求版本链无效");
  }
  return { revision: raw.revision as number, items, messageDecisions };
}

export function applyRequirementsUpdate(snapshot: PlannerConversationSnapshot, value: unknown, operationMessageIds: string[] = [], confirmationMessageIds: string[] = []): RequirementsState {
  const raw = object(value);
  if (Object.keys(raw).some((key) => !["messageDecisions", "changes"].includes(key)) || !Array.isArray(raw.messageDecisions) || !Array.isArray(raw.changes) || raw.changes.length > 128) fail("更新字段无效");
  const initial = snapshot.requirements ?? emptyRequirements();
  const pending = pendingRequirementMessages(snapshot);
  const pendingIds = new Set(pending.map(({ messageId }) => messageId));
  const decisions = raw.messageDecisions.map((entry) => {
    const item = object(entry);
    if (typeof item.messageId !== "string" || !pendingIds.has(item.messageId) || !["requirement", "operation", "noise"].includes(String(item.kind))) fail("只能分类待整理输入");
    if (operationMessageIds.includes(item.messageId) && item.kind !== "operation") fail("显式修订/整理指令必须是 operation");
    return { messageId: item.messageId, kind: item.kind as RequirementsUpdate["messageDecisions"][number]["kind"], reason: text(item.reason, 2048) };
  });
  if (decisions.length !== pending.length || new Set(decisions.map(({ messageId }) => messageId)).size !== pending.length) fail("必须分类全部待整理输入");
  const items = initial.items.map((item) => ({ ...item, sourceMessageIds: [...item.sourceMessageIds] }));
  const changedIds = new Set<string>();
  for (const value of raw.changes) {
    const change = object(value);
    if (Object.keys(change).some((key) => !["requirementId", "text", "status", "sourceMessageIds"].includes(key)) || typeof change.requirementId !== "string" || !ID.test(change.requirementId) ||
        changedIds.has(change.requirementId) || !["active", "pending", "withdrawn"].includes(String(change.status)) || !Array.isArray(change.sourceMessageIds)) fail("更新需求字段或 ID 无效");
    const sources = change.sourceMessageIds as string[];
    if (!sources.some((id) => pendingIds.has(id))) fail("需求变更必须引用本轮整理输入");
    if (!sources.some((id) => decisions.some((item) => item.messageId === id && item.kind === "requirement"))) fail("需求变更必须来自业务输入，不能来自操作或噪声");
    const previous = items.find((item) => item.requirementId === change.requirementId && item.status !== "superseded");
    if (!previous && change.status === "withdrawn") fail("不能撤销不存在的需求");
    changedIds.add(change.requirementId);
    if (previous) previous.status = "superseded";
    items.push({ requirementId: change.requirementId, revision: (previous?.revision ?? 0) + 1, text: text(change.text), status: change.status as Requirement["status"], sourceMessageIds: sources });
  }
  for (const decision of decisions.filter(({ kind }) => kind === "requirement")) {
    if (!raw.changes.some((entry) => (object(entry).sourceMessageIds as string[]).includes(decision.messageId)) && !confirmationMessageIds.includes(decision.messageId)) fail("业务输入没有关联需求变化或已核验确认");
  }
  return validateRequirementsState({ revision: initial.revision + 1, items, messageDecisions: [...initial.messageDecisions, ...decisions] }, snapshot.messages);
}

/** Use only unclassified input and clarification questions, never replay old plans. */
export function planningMessages(snapshot: PlannerConversationSnapshot): Array<{ role: "user" | "assistant"; content: string }> {
  const pending = pendingRequirementMessages(snapshot);
  const ids = new Set(pending.map(({ messageId }) => messageId));
  const latestAssistant = snapshot.messages.filter(({ role }) => role === "assistant").at(-1);
  return snapshot.messages.flatMap((message) => {
    if (ids.has(message.messageId)) return [{ role: message.role, content: message.content }];
    if (message !== latestAssistant) return [];
    try {
      const reply = JSON.parse(message.content) as { kind?: string; message?: string; questions?: string[] };
      return reply.kind === "clarification" ? [{ role: message.role, content: JSON.stringify({ message: reply.message, questions: reply.questions }) }] : [];
    } catch { return []; }
  });
}

/** Exact-ID retrieval; no filesystem/tool access to the metadata directory. */
export function createHistoryReader(snapshot: PlannerConversationSnapshot): (ids: string[]) => Promise<string> {
  let bytes = 0;
  const classifiable = new Set(pendingRequirementMessages(snapshot).map(({ messageId }) => messageId));
  return async (ids) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length) throw new Error("conversation_read 需要 1 到 8 个不同的 messageId");
    const results = ids.map((id) => {
      const message = snapshot.messages.find(({ messageId }) => messageId === id);
      if (!message) throw new Error("conversation_read 消息不存在：" + id);
      const turns = snapshot.turns.filter(({ messageId }) => messageId === id).map(({ turnId, status }) => ({ turnId, status }));
      return { ...message, turns, classificationAllowed: classifiable.has(id) };
    });
    const output = JSON.stringify({ messages: results });
    const size = Buffer.byteLength(output, "utf8");
    if (size > 16 * 1024 || bytes + size > 64 * 1024) throw new Error("conversation_read 输出超过 16 KiB 或本轮 64 KiB 预算");
    bytes += size;
    return output;
  };
}

export function traceRequirement(snapshot: PlannerConversationSnapshot, requirementId: string, revision?: number) {
  const candidates = snapshot.requirements?.items.filter((item) => item.requirementId === requirementId) ?? [];
  const requirement = revision === undefined ? candidates.at(-1) : candidates.find((item) => item.revision === revision);
  if (!requirement) throw new Error("找不到需求或版本：" + requirementId);
  return { requirement, versions: candidates, sources: requirement.sourceMessageIds.map((id) => ({
    message: snapshot.messages.find(({ messageId }) => messageId === id)!,
    turns: snapshot.turns.filter(({ messageId }) => messageId === id),
  })) };
}
