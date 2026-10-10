import type { PlanningProfile } from "./planner-types.js";

export const PLANNING_DECISION_IDS = [
  "language_runtime", "web_framework", "database", "documentation", "testing", "business_rules",
  "document_scope", "audience", "source_of_truth", "acceptance", "inputs_outputs", "side_effects",
  "change_scope", "compatibility", "validation", "scope",
] as const;
export const PLANNING_STATUSES = ["confirmed", "repository", "defaulted", "pending"] as const;

/** The provider contract and local validation must use the same vocabulary. */
export const REQUIRED_DECISIONS: Record<PlanningProfile, Array<typeof PLANNING_DECISION_IDS[number]>> = {
  backend_crud: ["language_runtime", "web_framework", "database", "documentation", "testing", "business_rules"],
  documentation: ["document_scope", "audience", "source_of_truth", "acceptance"],
  script: ["language_runtime", "inputs_outputs", "side_effects", "testing"],
  existing_project: ["change_scope", "compatibility", "testing", "validation"],
  general: [],
};
export const PLANNING_PROTOCOL_PROMPT = "\n全部允许的 decisionId（不能自行创建编号）：" + JSON.stringify(PLANNING_DECISION_IDS) +
  "；status 只能是：" + JSON.stringify(PLANNING_STATUSES) + "。各 profile 必需清单：" + JSON.stringify(REQUIRED_DECISIONS) +
  "。普通业务内容缺失（例如具体任务是什么）直接用 questions 澄清，不创建 task_scope 等虚构决策；general 可以 decisions:[] 并省略 questionBindings。" +
  "questionBindings 只绑定真实 pending 决策，displayIndex 指向 questions 中的位置；普通业务问题不需要绑定，但所有 pending 决策必须恰好关联一次。";
