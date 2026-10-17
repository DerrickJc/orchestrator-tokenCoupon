import type { PlanningProfile } from "./planner-types.js";

export const PLANNING_DECISION_IDS = [
  "language_runtime", "web_framework", "database", "documentation", "testing", "business_rules",
  "document_scope", "audience", "source_of_truth", "acceptance", "inputs_outputs", "side_effects",
  "change_scope", "compatibility", "validation", "scope", "technology_selection",
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
export function requiredPlanningDecisions(profile: PlanningProfile, schemaVersion?: 2): Array<typeof PLANNING_DECISION_IDS[number]> {
  const required = [...REQUIRED_DECISIONS[profile]];
  if (schemaVersion === 2 && profile === "existing_project") required.push("technology_selection");
  return required;
}
export const PLANNING_PROTOCOL_PROMPT = "\n全部允许的 decisionId（不能自行创建编号）：" + JSON.stringify(PLANNING_DECISION_IDS) +
  "；status 只能是：" + JSON.stringify(PLANNING_STATUSES) + "。各 profile 必需清单：" + JSON.stringify(REQUIRED_DECISIONS) +
  "。planningAssessment.schemaVersion=2 时，existing_project 还必须包含 technology_selection，用于说明高影响技术选择是否有用户授权或仓库权威依据；只增加‘缺依据则暂停’门禁不等于已确认技术选择。缺少依据且用户未授权选择时，该项必须 pending 并提出澄清。历史未带 schemaVersion 的 assessment 按旧清单读取。" +
  "。普通业务内容缺失（例如具体任务是什么）直接用 questions 澄清，不创建 task_scope 等虚构决策；general 可以 decisions:[] 并省略 questionBindings。" +
  "questionBindings 只绑定真实 pending 决策，displayIndex 指向 questions 中的位置；普通业务问题不需要绑定，但所有 pending 决策必须恰好关联一次。";
