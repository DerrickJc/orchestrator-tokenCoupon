import { createHash, randomUUID } from "node:crypto";
import type {
  ConfirmationEvent, ConfirmationProposalSet, ConfirmationQuestion, ConfirmationState,
  ConversationMessage, PlanningAssessment, PlanningDecisionId, PlannerReply,
} from "./planner-types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const NON_CONCRETE = /(未指定|待确认|尚未|仍未|未明确|未知|待定)/;
type ConfirmationAnswer = { questionId: string; action: ConfirmationEvent["action"]; preference?: string; value?: string };

export function makeConfirmationProposal(
  reply: PlannerReply,
  sourceMessageId: string,
  revision: number,
): ConfirmationProposalSet | undefined {
  if (reply.kind !== "clarification" || !reply.questions || !reply.questionBindings?.length || !reply.planningAssessment) return undefined;
  const pending = new Map(reply.planningAssessment.decisions.filter(({ status }) => status === "pending").map((item) => [item.decisionId, item]));
  const seenIds = new Set<string>();
  const seenDecisions = new Set<PlanningDecisionId>();
  const questions: ConfirmationQuestion[] = reply.questionBindings.map((binding) => {
    if (!Number.isSafeInteger(binding.displayIndex) || binding.displayIndex < 1 || binding.displayIndex > reply.questions!.length ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(binding.questionId) || seenIds.has(binding.questionId) ||
        !Array.isArray(binding.decisionIds) || binding.decisionIds.length < 1 ||
        !["accept_proposal", "delegate_choice", "provide_value"].includes(binding.answerMode)) {
      throw new Error("Planner 澄清的问题与决策关联无效");
    }
    seenIds.add(binding.questionId);
    for (const decisionId of binding.decisionIds) {
      if (!pending.has(decisionId) || seenDecisions.has(decisionId)) throw new Error("Planner 澄清重复关联或引用了非待确认决策：" + decisionId);
      seenDecisions.add(decisionId);
      if (binding.answerMode === "accept_proposal") {
        const decision = pending.get(decisionId)!;
        if (NON_CONCRETE.test(decision.value) || !/(默认|建议|是否采用|是否同意|是否授权采用)/.test(decision.question ?? "")) {
          throw new Error("Planner 将没有具体默认值的决策标成了可接受提案：" + decisionId);
        }
      } else if (binding.answerMode === "provide_value" && isConcreteDefault(pending.get(decisionId)!)) {
        throw new Error("决策 " + decisionId + " 已有具体默认提案，回答模式应为 accept_proposal；provide_value 只用于没有具体候选值的问题");
      }
    }
    return {
      questionId: binding.questionId,
      displayIndex: binding.displayIndex,
      text: reply.questions![binding.displayIndex - 1]!,
      decisionIds: [...binding.decisionIds],
      answerMode: binding.answerMode,
    };
  });
  if (questions.length !== reply.questions.length) throw new Error("Planner 必须为每个澄清问题提供唯一 questionBinding");
  const missingDecisionIds = [...pending.keys()].filter((decisionId) => !seenDecisions.has(decisionId));
  if (missingDecisionIds.length) throw new Error("questionBindings 未覆盖所有待确认决策，缺少：" + missingDecisionIds.join(", "));
  const proposalId = randomUUID();
  const base = {
    schemaVersion: 1 as const,
    proposalId,
    revision,
    sourceMessageId,
    questions: questions.sort((a, b) => a.displayIndex - b.displayIndex),
    candidates: [...pending.values()].map(({ decisionId, value, question }) => ({
      decisionId,
      value,
      concrete: isConcreteDefault({ value, question }),
    })),
    createdAt: new Date().toISOString(),
  };
  return { ...base, hash: confirmationHash(base) };
}

function isConcreteDefault(decision: { value: string; question?: string | undefined }): boolean {
  return !NON_CONCRETE.test(decision.value) && /(?:默认|建议|是否采用|是否同意|是否授权采用)/.test(decision.question ?? "");
}

export function parseConfirmationInput(
  text: string,
  sourceMessageId: string,
  state: ConfirmationState | undefined,
): ConfirmationEvent[] | undefined {
  const proposal = state?.activeProposal;
  if (state?.events.some(({ sourceMessageId: id }) => id === sourceMessageId)) return undefined;
  const trimmed = text.trim();
  const revoke = parseRevokeCommand(trimmed, sourceMessageId, state);
  if (revoke) return revoke;
  if (!proposal) return undefined;
  const explicit = parseCommand(trimmed, proposal);
  const answers: ConfirmationAnswer[] | undefined = explicit ?? parseNumberedAnswers(trimmed, proposal) ?? parseGlobalAnswer(trimmed, proposal);
  if (!answers || !answers.length) return undefined;
  const events: ConfirmationEvent[] = [];
  for (const answer of answers) {
    const question = proposal.questions.find(({ questionId }) => questionId === answer.questionId)!;
    const values = answer.action === "accept" || answer.action === "reject"
      ? question.decisionIds.map((decisionId) => ({ decisionId, value: proposal.candidates.find((item) => item.decisionId === decisionId)!.value }))
      : answer.action === "provide_value" && answer.value && question.decisionIds.length === 1
        ? [{ decisionId: question.decisionIds[0]!, value: answer.value }]
      : undefined;
    if (answer.action === "provide_value" && question.decisionIds.length !== 1) throw new Error("一个澄清问题关联多项决策，无法安全地把单个新值分配给它们；请逐项回答");
    events.push({
      schemaVersion: 1,
      eventId: randomUUID(),
      sourceMessageId,
      sourceText: text,
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      proposalHash: proposal.hash,
      questionId: question.questionId,
      decisionIds: [...question.decisionIds],
      action: answer.action,
      quote: text,
      ...(answer.preference ? { preference: answer.preference } : {}),
      ...(values ? { values } : {}),
      createdAt: new Date().toISOString(),
    });
  }
  return events;
}

function parseCommand(text: string, proposal: ConfirmationProposalSet): ConfirmationAnswer[]|undefined {
  const match = /^\/(confirm|delegate|reject)\s+(all|[1-9]\d*(?:\s*,\s*[1-9]\d*)*)$/i.exec(text);
  if (!match) return undefined;
  const command = match[1]!.toLowerCase();
  const selected = match[2]!.toLowerCase() === "all"
    ? proposal.questions
    : match[2]!.split(",").map((value) => proposal.questions.find(({ displayIndex }) => displayIndex === Number(value.trim())));
  if (selected.some((question) => !question)) throw new Error("确认指令引用了当前提案中不存在的问题编号");
  const action = command === "confirm" ? "accept" : command === "delegate" ? "delegate" : "reject";
  return selected.map((question) => {
    if (action === "accept" && question!.answerMode !== "accept_proposal") throw new Error(`问题 ${question!.displayIndex} 没有可直接接受的具体提案；请使用 /delegate ${question!.displayIndex} 或自然语言回答`);
    return { questionId: question!.questionId, action };
  });
}

function parseRevokeCommand(text: string, sourceMessageId: string, state: ConfirmationState | undefined): ConfirmationEvent[] | undefined {
  const match = /^\/revoke\s+(all|[a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)*)$/i.exec(text);
  if (!match) return undefined;
  if (!state?.events.length) throw new Error("当前没有可撤回的已接受或已委托决策");
  const latest = new Map<PlanningDecisionId, ConfirmationEvent>();
  for (const event of state.events) for (const id of event.decisionIds) latest.set(id, event);
  const ids = match[1]!.toLowerCase() === "all"
    ? [...latest].filter(([, event]) => ["accept", "delegate", "provide_value"].includes(event.action)).map(([id]) => id)
    : match[1]!.split(",").map((id) => id.trim() as PlanningDecisionId);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !latest.has(id))) {
    throw new Error("撤回指令包含未知或重复的 decisionId；可用 /requirements 查看当前决策");
  }
  return ids.map((decisionId) => {
    const prior = latest.get(decisionId)!;
    if (!["accept", "delegate", "provide_value"].includes(prior.action)) throw new Error(`决策 ${decisionId} 当前没有可撤回的有效确认`);
    return {
      schemaVersion: 1, eventId: randomUUID(), sourceMessageId, sourceText: text,
      proposalId: prior.proposalId, proposalRevision: prior.proposalRevision, proposalHash: prior.proposalHash,
      questionId: prior.questionId, decisionIds: [decisionId], action: "revoke", quote: text,
      createdAt: new Date().toISOString(),
    };
  });
}

function parseNumberedAnswers(text: string, proposal: ConfirmationProposalSet): ConfirmationAnswer[]|undefined {
  const matches = [...text.matchAll(/(?:^|[.、;；。])\s*(\d+)\s*[.、:：]\s*([\s\S]*?)(?=(?:[.、;；。]\s*)\d+\s*[.、:：]|$)/g)];
  if (!matches.length) return undefined;
  const answers: Array<{ questionId: string; action: ConfirmationEvent["action"]; preference?: string }> = [];
  const seen = new Set<number>();
  for (const match of matches) {
    const index = Number(match[1]);
    const body = match[2]!.trim();
    const question = proposal.questions.find(({ displayIndex }) => displayIndex === index);
    if (!question || seen.has(index)) throw new Error("确认回答包含未知或重复的问题编号：" + index);
    seen.add(index);
    const classified = classifyAnswer(body, question.answerMode);
    if (!classified) return undefined;
    const preference = body
      .replace(/不授权|不接受|不采用|拒绝|授权|委托|接受|同意|采用|确认|由你(?:来)?(?:决定|选择)?|你自行(?:决定|选择)?|你(?:来)?(?:决定|选择)?|可以/g, "")
      .replace(/^[，,。；;\s]+|[，,。；;\s]+$/g, "").trim();
    if (preference && Buffer.byteLength(preference, "utf8") > 512) throw new Error(`问题 ${index} 的补充偏好超过 512 字节，请拆分为单独的需求消息`);
    answers.push({ questionId: question.questionId, ...classified, ...(preference ? { preference } : {}) });
  }
  return answers;
}

function classifyAnswer(text: string, mode: ConfirmationQuestion["answerMode"]): Pick<ConfirmationAnswer, "action" | "value">|undefined {
  if (/(不同意|不接受|不授权|不采用|拒绝|不要|不允许)/.test(text)) return { action: "reject" };
  if (/(授权|委托|由你|你来|你自行|你自己|你决定|你选)/.test(text)) return { action: "delegate" };
  if (mode === "accept_proposal" && /(采用|采纳|接受|同意|确认|可以)/.test(text)) return { action: "accept" };
  if (mode === "provide_value" && /^(?:改为|改用|使用|采用|选择|指定|值为)\s*\S/.test(text)) {
    const value = text.replace(/^(?:改为|改用|使用|采用|选择|指定|值为)\s*/, "").trim().replace(/[。；;]+$/, "");
    if (value && Buffer.byteLength(value, "utf8") <= 2048) return { action: "provide_value", value };
  }
  return undefined;
}

function parseGlobalAnswer(text: string, proposal: ConfirmationProposalSet): ConfirmationAnswer[]|undefined {
  const allDelegate = /^(全部授权|全部委托|都交给你|全部由你决定)[。.!！\s]*$/.test(text);
  const allAgree = /^(全部同意|都同意|都可以|全部采用)[。.!！\s]*$/.test(text);
  const proposalAgree = /^(同意(?:该|这个|上述|以上)?(?:默认)?方案|同意|可以|好的|确认|yes|ok|agree)[。.!！\s]*$/i.test(text);
  if (!allDelegate && !allAgree && !proposalAgree) return undefined;
  if (allAgree && proposal.questions.some(({ answerMode }) => answerMode === "provide_value")) {
    throw new Error("当前提案包含需要具体取值的问题；请使用编号回答该项，其余问题可单独确认");
  }
  const result: ConfirmationAnswer[] = proposal.questions.flatMap((question): ConfirmationAnswer[] => {
    if (question.answerMode === "accept_proposal" && (allDelegate || allAgree || proposalAgree)) return [{ questionId: question.questionId, action: "accept" as const }];
    if ((question.answerMode === "delegate_choice" || question.answerMode === "provide_value") && (allDelegate || allAgree)) return [{ questionId: question.questionId, action: "delegate" as const }];
    return [];
  });
  return result.length ? result : undefined;
}

export function mergeConfirmationEvents(state: ConfirmationState | undefined, events: ConfirmationEvent[]): ConfirmationState {
  return { schemaVersion: 1, activeProposal: state?.activeProposal ?? null, events: [...(state?.events ?? []), ...events] };
}

export function latestDecisionConfirmation(state: ConfirmationState | undefined, decisionId: PlanningDecisionId): ConfirmationEvent | undefined {
  return state?.events.filter((event) => event.decisionIds.includes(decisionId)).at(-1);
}

export function applyCommittedConfirmations(
  assessment: PlanningAssessment,
  state: ConfirmationState | undefined,
  currentMessageIds: string[],
): PlanningAssessment {
  if (!state) return assessment;
  const decisions = assessment.decisions.map((decision) => {
    const event = latestDecisionConfirmation(state, decision.decisionId);
    if (!event) return decision;
    const currentExplicit = currentMessageIds.includes(decision.sourceMessageId ?? "") &&
      state.events.some((item) => item.sourceMessageId === decision.sourceMessageId && item.decisionIds.includes(decision.decisionId));
    if (event.action === "revoke" || event.action === "reject") {
      if (currentMessageIds.includes(decision.sourceMessageId ?? "") && !currentExplicit) return decision;
      const rejected = event.action === "reject" ? event.values?.find((item) => item.decisionId === decision.decisionId)?.value : undefined;
      return { decisionId: decision.decisionId, value: decision.value, status: "pending" as const,
        rationale: event.action === "revoke" ? "用户撤回了此前的决策授权" : "用户拒绝了提案，需要新的取值或提案",
        question: event.action === "revoke" ? `请重新确认 ${decision.decisionId} 的具体取值或授权范围` : `请为 ${decision.decisionId} 提出不同于 ${rejected ?? decision.value} 的方案` };
    }
    if (event.action !== "accept" && event.action !== "delegate" && event.action !== "provide_value") return decision;
    if (!currentExplicit && currentMessageIds.includes(decision.sourceMessageId ?? "")) return decision;
    if (event.action === "delegate" && decision.status === "pending") return decision;
    const value = event.action === "accept" ? event.values?.find((item) => item.decisionId === decision.decisionId)?.value : decision.value;
    if (event.action === "provide_value") {
      const selected = event.values?.find((item) => item.decisionId === decision.decisionId)?.value;
      if (!selected) return decision;
      const { question: _question, ...base } = decision;
      return { ...base, value: selected, status: "confirmed" as const, requirementId: "R-decision-" + decision.decisionId,
        sourceMessageId: event.sourceMessageId, quote: event.quote, rationale: "用户明确指定决策值" };
    }
    if (!value) return decision;
    const { question: _question, ...base } = decision;
    return {
      ...base,
      value,
      status: "defaulted" as const,
      sourceMessageId: event.sourceMessageId,
      authorizationQuote: event.quote,
      rationale: decision.rationale,
    };
  });
  return { ...assessment, decisions };
}

export function assertNoRepeatedConfirmationClarification(
  assessment: PlanningAssessment,
  reply: PlannerReply,
  state: ConfirmationState | undefined,
): void {
  if (reply.kind !== "clarification" || !reply.questionBindings || !state) return;
  for (const binding of reply.questionBindings) {
    const question = reply.questions?.[binding.displayIndex - 1] ?? "";
    for (const decisionId of binding.decisionIds) {
      const event = latestDecisionConfirmation(state, decisionId);
      if (!event) continue;
      if (event.action === "delegate") {
        throw new Error(`问题 ${binding.displayIndex} 重复询问已委托的决策 ${decisionId}；请在授权范围内给出具体选择，或仅澄清新的实质业务歧义`);
      }
      if (event.action === "accept") {
        const current = assessment.decisions.find((item) => item.decisionId === decisionId)?.value;
        const accepted = event.values?.find((item) => item.decisionId === decisionId)?.value;
        if (current === accepted) throw new Error(`问题 ${binding.displayIndex} 重复询问已接受的决策 ${decisionId}；请采用现有确认，或仅澄清新的实质业务歧义`);
      }
      if (event.action === "reject" && binding.answerMode === "accept_proposal") {
        const current = assessment.decisions.find((item) => item.decisionId === decisionId);
        const rejected = event.values?.find((item) => item.decisionId === decisionId)?.value;
        if (current?.value === rejected) throw new Error(`问题 ${binding.displayIndex} 再次提出已拒绝的决策 ${decisionId}；请给出不同候选值`);
      }
      void question;
    }
  }
}

export function validateConfirmationState(value: unknown, messages: ConversationMessage[]): ConfirmationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("确认状态必须是对象");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.events) || raw.events.length > 512 || !(raw.activeProposal === null || typeof raw.activeProposal === "object")) throw new Error("确认状态字段无效");
  const userIds = new Set(messages.filter(({ role }) => role === "user").map(({ messageId }) => messageId));
  const allIds = new Set(messages.map(({ messageId }) => messageId));
  const events = raw.events.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("确认事件必须是对象");
    const event = entry as Record<string, unknown>;
      if (event.schemaVersion !== 1 || typeof event.eventId !== "string" || !UUID.test(event.eventId) || typeof event.sourceMessageId !== "string" ||
        typeof event.sourceText !== "string" || !userIds.has(event.sourceMessageId) || !event.sourceText || !event.sourceText.includes(String(event.quote)) ||
        typeof event.proposalId !== "string" || !UUID.test(event.proposalId) || !Number.isSafeInteger(event.proposalRevision) ||
        typeof event.proposalHash !== "string" || !HASH.test(event.proposalHash) || typeof event.questionId !== "string" ||
        !Array.isArray(event.decisionIds) || !event.decisionIds.length || !["accept", "delegate", "reject", "provide_value", "revoke"].includes(String(event.action)) || typeof event.createdAt !== "string") {
      throw new Error("确认事件字段或来源无效");
    }
    if (event.preference !== undefined && (typeof event.preference !== "string" || Buffer.byteLength(event.preference, "utf8") > 512)) throw new Error("确认偏好文本无效");
    if (event.values !== undefined && (!Array.isArray(event.values) || event.values.some((item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).decisionId !== "string" || typeof (item as Record<string, unknown>).value !== "string"))) throw new Error("确认决策值无效");
    return event as unknown as ConfirmationEvent;
  });
  if (new Set(events.map(({ eventId }) => eventId)).size !== events.length) throw new Error("确认事件重复");
  const activeProposal = raw.activeProposal === null ? null : validateProposal(raw.activeProposal, allIds);
  return { schemaVersion: 1, activeProposal, events };
}

function validateProposal(value: unknown, messageIds: Set<string>): ConfirmationProposalSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("确认提案必须是对象");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.proposalId !== "string" || !UUID.test(raw.proposalId) || !Number.isSafeInteger(raw.revision) ||
      typeof raw.hash !== "string" || !HASH.test(raw.hash) || typeof raw.sourceMessageId !== "string" || !messageIds.has(raw.sourceMessageId) ||
      !Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 3 || !Array.isArray(raw.candidates) || typeof raw.createdAt !== "string") throw new Error("确认提案字段无效");
  if (confirmationHash({ schemaVersion: 1, proposalId: raw.proposalId, revision: raw.revision, sourceMessageId: raw.sourceMessageId,
    questions: raw.questions, candidates: raw.candidates, createdAt: raw.createdAt }) !== raw.hash) throw new Error("确认提案哈希不匹配");
  const questions = raw.questions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("确认问题无效");
    const question = entry as Record<string, unknown>;
    if (typeof question.questionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(question.questionId) || !Number.isSafeInteger(question.displayIndex) ||
        typeof question.text !== "string" || !question.text || !Array.isArray(question.decisionIds) || !question.decisionIds.length ||
        !["accept_proposal", "delegate_choice", "provide_value"].includes(String(question.answerMode))) throw new Error("确认问题字段无效");
    return question as unknown as ConfirmationQuestion;
  });
  const candidates = raw.candidates.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("确认候选值无效");
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.decisionId !== "string" || typeof candidate.value !== "string" || typeof candidate.concrete !== "boolean") throw new Error("确认候选值字段无效");
    return candidate as ConfirmationProposalSet["candidates"][number];
  });
  return raw as unknown as ConfirmationProposalSet;
}

function confirmationHash(value: unknown): string {
  const stable = (item: unknown): string => Array.isArray(item) ? "[" + item.map(stable).join(",") + "]" : item && typeof item === "object"
    ? "{" + Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ":" + stable(entry)).join(",") + "}"
    : JSON.stringify(item);
  return createHash("sha256").update(stable(value)).digest("hex");
}
