import type { PlanDefinition } from "./plan.js";
import type {
  ConfirmationState, ConversationMessage, PlanningAssessment, PlanningDecision, PlanningDecisionId, PlanningProfile,
  RepositoryEvidence, RequirementsState,
} from "./planner-types.js";
import { PlannerReplyValidationError } from "./planner-reply.js";
import { validateRequirementsState } from "./requirements.js";
import { decisionValueHash } from "./plan.js";

export const REQUIRED_DECISIONS: Record<PlanningProfile, PlanningDecisionId[]> = {
  backend_crud: ["language_runtime", "web_framework", "database", "documentation", "testing", "business_rules"],
  documentation: ["document_scope", "audience", "source_of_truth", "acceptance"],
  script: ["language_runtime", "inputs_outputs", "side_effects", "testing"],
  existing_project: ["change_scope", "compatibility", "testing", "validation"],
  general: [],
};

const DECISION_IDS = new Set<PlanningDecisionId>(Object.values(REQUIRED_DECISIONS).flat());
const PROFILES = new Set<PlanningProfile>(Object.keys(REQUIRED_DECISIONS) as PlanningProfile[]);
const STATUSES = new Set(["confirmed", "repository", "defaulted", "pending"]);

function invalid(message: string): never {
  throw new PlannerReplyValidationError("planner_readiness_invalid", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(label + " 必须是对象");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(label + " 含未知字段");
}

function text(value: unknown, label: string, maxBytes = 4096): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) return invalid(label + " 必须是非空文本且不超过 " + maxBytes + " 字节");
  return value;
}

export function parsePlanningAssessment(value: unknown): PlanningAssessment {
  const raw = object(value, "planningAssessment");
  exactKeys(raw, ["profile", "classification", "decisions"], "planningAssessment");
  if (!PROFILES.has(raw.profile as PlanningProfile) || !Array.isArray(raw.decisions) || raw.decisions.length > 32) invalid("planningAssessment 的 profile 或 decisions 无效");
  const classification = object(raw.classification, "planningAssessment.classification");
  exactKeys(classification, ["rationale", "sourceMessageId", "quote"], "planningAssessment.classification");
  const parsedClassification = {
    rationale: text(classification.rationale, "planningAssessment.classification.rationale"),
    sourceMessageId: text(classification.sourceMessageId, "planningAssessment.classification.sourceMessageId", 64),
    quote: text(classification.quote, "planningAssessment.classification.quote", 2048),
  };
  const seen = new Set<string>();
  const decisions = raw.decisions.map((item, index): PlanningDecision => {
    const decision = object(item, "planningAssessment.decisions[" + index + "]");
    if (typeof decision.decisionId !== "string" || !DECISION_IDS.has(decision.decisionId as PlanningDecisionId) || !STATUSES.has(String(decision.status))) invalid("planningAssessment.decisions[" + index + "] 的 decisionId 或 status 无效");
    const id = decision.decisionId as PlanningDecisionId;
    if (seen.has(id)) invalid("planningAssessment 包含重复决策：" + id);
    seen.add(id);
    const fieldText = (value: unknown, field: string, maxBytes = 2048) => text(value, `planningAssessment.decisions[${index}](${id}).${field}`, maxBytes);
    const rationale = fieldText(decision.rationale, "rationale", 4096);
    const valueText = fieldText(decision.value, "value");
    const status = decision.status as PlanningDecision["status"];
    if (status === "confirmed") {
      exactKeys(decision, ["decisionId", "value", "status", "rationale", "requirementId", "sourceMessageId", "quote"], "confirmed decision");
      return { decisionId: id, value: valueText, status, rationale,
        requirementId: fieldText(decision.requirementId, "requirementId", 64),
        sourceMessageId: fieldText(decision.sourceMessageId, "sourceMessageId", 64),
        quote: fieldText(decision.quote, "quote") };
    }
    if (status === "repository") {
      exactKeys(decision, ["decisionId", "value", "status", "rationale", "evidence"], "repository decision");
      const evidence = object(decision.evidence, "decision.evidence");
      exactKeys(evidence, ["path", "sha256"], "decision.evidence");
      if (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)) invalid("decision.evidence.sha256 无效");
      return { decisionId: id, value: valueText, status, rationale,
        evidence: { path: text(evidence.path, "decision.evidence.path", 1024), sha256: evidence.sha256 } };
    }
    if (status === "defaulted") {
      exactKeys(decision, ["decisionId", "value", "status", "rationale", "sourceMessageId", "authorizationQuote"], "defaulted decision");
      return { decisionId: id, value: valueText, status, rationale,
        sourceMessageId: fieldText(decision.sourceMessageId, "sourceMessageId", 64),
        authorizationQuote: fieldText(decision.authorizationQuote, "authorizationQuote") };
    }
    exactKeys(decision, ["decisionId", "value", "status", "rationale", "question"], "pending decision");
    return { decisionId: id, value: valueText, status, rationale,
      question: fieldText(decision.question, "question") };
  });
  return { profile: raw.profile as PlanningProfile, classification: parsedClassification, decisions };
}

export function validatePlanningAssessment(
  value: unknown,
  input: {
    messages: ConversationMessage[];
    requirements: RequirementsState;
    evidence: RepositoryEvidence[];
    previous?: PlanningAssessment;
    currentMessageIds: string[];
    confirmationState?: ConfirmationState;
  },
): PlanningAssessment {
  const assessment = parsePlanningAssessment(value);
  const messages = new Map(input.messages.filter(({ role }) => role === "user").map((message) => [message.messageId, message.content]));
  const classMessage = messages.get(assessment.classification.sourceMessageId);
  if (!classMessage || !classMessage.includes(assessment.classification.quote)) invalid("规划类型的依据未引用真实用户输入");
  if (input.previous && input.previous.profile !== assessment.profile && !input.currentMessageIds.includes(assessment.classification.sourceMessageId)) {
    invalid("规划类型不能在没有新业务输入依据时改变");
  }
  const requirements = new Map(input.requirements.items.map((item) => [item.requirementId, item]));
  for (const decision of assessment.decisions) {
    if (decision.status === "confirmed") {
      const source = messages.get(decision.sourceMessageId!);
      const requirement = requirements.get(decision.requirementId!);
      if (!source || !source.includes(decision.quote!) || !requirement || requirement.status !== "active" || !requirement.sourceMessageIds.includes(decision.sourceMessageId!)) {
        invalid("决策 " + decision.decisionId + " 的需求或原始消息来源无效");
      }
      if (SHORT_CONSENT.test(source.trim())) {
        invalid("决策 " + decision.decisionId + " 的短句确认必须使用 defaulted 并核对前文提案，不能用 confirmed 绕过默认授权校验");
      }
    } else if (decision.status === "repository") {
      if (!input.evidence.some((item) => item.path === decision.evidence!.path && item.sha256 === decision.evidence!.sha256)) {
        invalid("决策 " + decision.decisionId + " 引用了未读取或已变化的仓库证据");
      }
    } else if (decision.status === "defaulted") {
      const source = messages.get(decision.sourceMessageId!);
      const committed = input.confirmationState?.events.filter((event) => event.decisionIds.includes(decision.decisionId) && event.sourceMessageId === decision.sourceMessageId).at(-1);
      const acceptedValue = committed?.values?.find(({ decisionId }) => decisionId === decision.decisionId)?.value;
      const protocolAuthorized = !!committed && source === committed.sourceText && source.includes(decision.authorizationQuote!) &&
        (committed.action === "delegate" || (committed.action === "accept" && acceptedValue === decision.value) ||
          (committed.action === "provide_value" && acceptedValue === decision.value));
      if (!source || !source.includes(decision.authorizationQuote!) ||
          (!protocolAuthorized && !hasDefaultAuthorization(source, decision, input.messages))) {
        invalid("决策 " + decision.decisionId + " 的默认方案缺少有效授权：需要明确委托，或承接上条澄清中该决策的具体默认值；短句确认必须原样使用上条该 decisionId 的完整具体 value，不能改写或改变提案取值。旧 value 未指定时才采用 question 中的具体默认值");
      }
    }
  }
  const decisions = new Set(assessment.decisions.map(({ decisionId }) => decisionId));
  const missing = REQUIRED_DECISIONS[assessment.profile].filter((id) => !decisions.has(id));
  if (missing.length) invalid("规划决策清单缺少必需项：" + missing.join(", "));
  return assessment;
}

export function assertPlanningReady(assessment: PlanningAssessment | undefined, plan: PlanDefinition): void {
  // Plans persisted before structured readiness was introduced remain usable under v1 rules.
  // New Planner replies require an assessment, and v2 cannot be validated without its registry.
  if (!assessment) {
    if (plan.schemaVersion === 1) return;
    invalid("缺少结构化规划决策记录，请先重新规划并补齐决策");
  }
  const pending = REQUIRED_DECISIONS[assessment.profile].map((id) => assessment.decisions.find((item) => item.decisionId === id)!)
    .filter((item) => item.status === "pending");
  if (pending.length) invalid("仍有关键决策待澄清：" + pending.map(({ decisionId }) => decisionId).join(", "));
  if (plan.schemaVersion === 2) {
    const context = plan.decisionContext;
    if (!context) invalid("Plan v2 缺少决策上下文");
    const expected = assessment.decisions.filter(({ status }) => status !== "pending");
    if (context.decisions.length !== expected.length) invalid("Plan 决策上下文与当前有效决策数量不一致");
    for (const decision of expected) {
      const selected = context.decisions.find(({ decisionId }) => decisionId === decision.decisionId);
      if (!selected || selected.value !== decision.value || selected.status !== decision.status ||
          selected.valueHash !== decisionValueHash(decision.decisionId, decision.value)) {
        invalid("Plan 决策上下文与当前有效选择不一致：" + decision.decisionId);
      }
    }
    if (context.globalDecisionIds.length !== expected.length || plan.tasks.some(({ decisionRefs }) =>
      !decisionRefs || decisionRefs.length !== expected.length || expected.some(({ decisionId }) =>
        !decisionRefs.some((ref) => ref.decisionId === decisionId && ref.valueHash === decisionValueHash(decisionId, assessment.decisions.find((item) => item.decisionId === decisionId)!.value))))) {
      invalid("Plan 任务没有完整引用全部全局决策");
    }
    return;
  }
  const text = [plan.title, ...plan.tasks.flatMap(({ task }) => [task.title, task.prompt])].join("\n").toLocaleLowerCase();
  const missingValues = REQUIRED_DECISIONS[assessment.profile].map((id) => assessment.decisions.find((item) => item.decisionId === id)!)
    .filter(({ value }) => !text.includes(value.toLocaleLowerCase()));
  if (missingValues.length) invalid("草案没有落实以下已确认决策，请修订草案：" + missingValues.map(({ decisionId }) => decisionId).join(", ") +
    "；请在最终验证 task.prompt 的独立‘执行约束’段落中逐字列出每项 planningAssessment.decisions 的完整 value，不改写或省略，不把正文写成 JSON 字符串");
}

export function hasPendingPlanningDecisions(assessment: PlanningAssessment | undefined): boolean {
  if (!assessment) return false;
  const required = new Set(REQUIRED_DECISIONS[assessment.profile]);
  return assessment.decisions.some(({ decisionId, status }) => status === "pending" && required.has(decisionId));
}

function isConcreteDefaultProposal(decision: PlanningDecision): boolean {
  return decision.status === "pending" && !/(未指定|待确认|尚未|仍未|未明确|未知|待定)/.test(decision.value) &&
    /(?:是否授权|是否采用|是否同意|请确认).*默认/.test(decision.question ?? "");
}

export function defaultPlanningProposals(assessment: PlanningAssessment): PlanningDecision[] {
  return assessment.decisions.filter(isConcreteDefaultProposal);
}

/** Live output check only: old snapshots may legitimately contain pending choices. */
export function assertClarificationNeeded(assessment: PlanningAssessment, messages: ConversationMessage[], currentRequirementMessageIds: string[]): void {
  for (const decision of assessment.decisions.filter(({ status }) => status === "pending")) {
    for (const message of messages.filter(({ role, messageId }) => role === "user" && currentRequirementMessageIds.includes(messageId))) {
      if (hasDefaultAuthorization(message.content, { ...decision, sourceMessageId: message.messageId, authorizationQuote: message.content }, messages)) {
        invalid("决策 " + decision.decisionId + " 已获得本轮明确委托或默认提案确认，不能再次要求相同授权；请采用授权范围内的具体值并使用 defaulted。没有其他未授权缺项时生成 draft，保留已有业务约束");
      }
    }
  }
}

/** Mirror required planning choices into versioned requirements so /requirements shows pending decisions. */
export function syncPlanningDecisionRequirements(
  state: RequirementsState,
  previous: RequirementsState,
  assessment: PlanningAssessment,
  messages: ConversationMessage[],
): RequirementsState {
  const items = state.items.map((item) => ({ ...item, sourceMessageIds: [...item.sourceMessageIds] }));
  const required = new Set(REQUIRED_DECISIONS[assessment.profile]);
  const decisionItems = new Set([...state.items, ...previous.items]
    .map(({ requirementId }) => requirementId)
    .filter((requirementId) => requirementId.startsWith("R-decision-")));
  const findLatest = (source: RequirementsState["items"], requirementId: string) =>
    source.filter((item) => item.requirementId === requirementId).sort((a, b) => b.revision - a.revision)[0];

  for (const decisionId of required) {
    const decision = assessment.decisions.find((item) => item.decisionId === decisionId);
    if (!decision) continue;
    const requirementId = "R-decision-" + decisionId;
    if (decision.status === "confirmed" && decision.requirementId === requirementId) {
      const source = messages.find(({ messageId, role }) => messageId === decision.sourceMessageId && role === "user");
      if (!source || !source.content.includes(decision.quote!) ||
          !state.messageDecisions.some(({ messageId, kind }) => messageId === decision.sourceMessageId && kind === "requirement")) {
        invalid(`决策 ${decisionId} 的来源 ${decision.sourceMessageId} 必须引用已分类的业务输入和真实原文，不能引用操作、噪声或未采用的失败输入`);
      }
    }
    decisionItems.add(requirementId);
    const previousLatest = findLatest(previous.items, requirementId);
    const currentLatest = findLatest(items, requirementId);
    const status = decision.status === "pending" ? "pending" : "active";
    const text = `关键实施决策 ${decisionId}：${status === "pending" ? decision.question : decision.value}`;
    const sourceMessageId = decision.status === "confirmed" || decision.status === "defaulted"
      ? decision.sourceMessageId!
      : currentLatest?.sourceMessageIds[0] ?? previousLatest?.sourceMessageIds[0] ?? assessment.classification.sourceMessageId;
    const sourceMessageIds = [sourceMessageId];

    if (currentLatest && currentLatest.revision > (previousLatest?.revision ?? 0)) {
      const candidate = items.find((item) => item.requirementId === requirementId && item.revision === currentLatest.revision)!;
      candidate.status = status;
      candidate.text = text;
      candidate.sourceMessageIds = sourceMessageIds;
      continue;
    }
    if (currentLatest?.status === status && currentLatest.text === text &&
        JSON.stringify(currentLatest.sourceMessageIds) === JSON.stringify(sourceMessageIds)) continue;
    if (currentLatest) currentLatest.status = "superseded";
    items.push({ requirementId, revision: (currentLatest?.revision ?? 0) + 1, text, status, sourceMessageIds });
  }

  for (const requirementId of decisionItems) {
    if (required.has(requirementId.slice("R-decision-".length) as PlanningDecisionId)) continue;
    const previousLatest = findLatest(previous.items, requirementId);
    const currentLatest = findLatest(items, requirementId);
    if (!currentLatest || currentLatest.status === "withdrawn") continue;
    if (currentLatest.revision > (previousLatest?.revision ?? 0)) {
      const candidate = items.find((item) => item.requirementId === requirementId && item.revision === currentLatest.revision)!;
      candidate.status = "withdrawn";
      continue;
    }
    currentLatest.status = "superseded";
    items.push({
      requirementId, revision: currentLatest.revision + 1,
      text: `关键实施决策 ${requirementId.slice("R-decision-".length)} 不再适用于当前规划类型`,
      status: "withdrawn", sourceMessageIds: [...currentLatest.sourceMessageIds],
    });
  }
  return validateRequirementsState({ ...state, items }, messages);
}

const SHORT_CONSENT = /^(同意(?:该|这个|上述|以上)?(?:默认)?方案|同意|可以|好的|确认|yes|ok|agree)[。.!！\s]*$/i;
const TECHNICAL_DECISIONS = new Set<PlanningDecisionId>(["language_runtime", "web_framework", "database"]);

function hasDefaultAuthorization(source: string, decision: PlanningDecision, messages: ConversationMessage[]): boolean {
  // Inspect the entire source, rather than a cherry-picked quote hiding a refusal.
  if (/(不同意|不接受|不授权|不要|不允许|不能|不得|禁止|do not|don'?t|disagree)/i.test(source)) return false;
  const quote = decision.authorizationQuote!;
  const delegate = /(?:由你|你来|你自行|你自己).{0,12}(?:决定|选择|确定|安排|处理|完成|模拟)/;
  if (delegate.test(source)) {
    if (/(全部|所有|一切|其余|剩下|都由你|都交给你)/.test(source)) return true;
    if (/(技术栈|技术选型|技术方案)/.test(source)) return TECHNICAL_DECISIONS.has(decision.decisionId);
    if (/(细节|默认)/.test(source)) return true;
  }
  if (/(按.{0,16}(推荐的?)?默认|授权.{0,16}默认|采用.{0,8}默认方案|use.{0,16}defaults?)/i.test(source) &&
      /(默认|defaults?)/i.test(quote)) {
    return !/(技术栈|技术选型|技术方案)/.test(source) || TECHNICAL_DECISIONS.has(decision.decisionId);
  }
  if (!SHORT_CONSENT.test(source.trim()) || !SHORT_CONSENT.test(quote.trim())) return false;

  // Only a persisted successful clarification may supply the proposal. Failed
  // confirmations can intervene, but unrelated user input cannot extend consent.
  const sourceIndex = messages.findIndex(({ messageId }) => messageId === decision.sourceMessageId);
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      if (SHORT_CONSENT.test(message.content.trim())) continue;
      return false;
    }
    try {
      const reply = JSON.parse(message.content) as { kind?: string; planningAssessment?: PlanningAssessment };
      if (reply.kind !== "clarification") return false;
      const proposal = reply.planningAssessment?.decisions.find(({ decisionId }) => decisionId === decision.decisionId);
      if (!proposal || proposal.status !== "pending" || !proposal.question) return false;
      const normalize = (value: string) => value.toLowerCase().replace(/[\s“”"'‘’，,、；;。.:：+（()）/？?]/g, "");
      const chosen = normalize(decision.value);
      if (!chosen) return false;
      // Freeze the structured proposal, rather than interpreting a paraphrased
      // question. formatPlanner shows these exact values before asking for consent.
      if (isConcreteDefaultProposal(proposal)) return chosen === normalize(proposal.value);
      // A concrete proposal must be identified as a default, not a list of alternatives.
      const suggested = /是否授权(?:我)?采用(.+?)(?:作为|的)默认/.exec(proposal.question)?.[1];
      return suggested !== undefined && normalize(suggested).includes(chosen);
    } catch { return false; }
  }
  return false;
}
