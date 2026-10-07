import { decisionValueHash, type PlanDefinition, type PlannedTask } from "./plan.js";
import { parseTask } from "./validate-task.js";
import {
  expectExactKeys,
  expectNonEmptyString,
  expectObject,
  expectSchemaVersion,
  InputValidationError,
} from "./validation.js";

export function parsePlan(value: unknown): PlanDefinition {
  const plan = expectObject(value, "plan");
  if (plan.schemaVersion !== 1 && plan.schemaVersion !== 2) throw new InputValidationError("plan.schemaVersion", "只支持版本 1 或 2");
  expectExactKeys(plan, plan.schemaVersion === 1 ? ["schemaVersion", "id", "title", "tasks"] : ["schemaVersion", "id", "title", "tasks", "decisionContext"], "plan");

  if (!Array.isArray(plan.tasks)) {
    throw new InputValidationError("plan.tasks", "必须是数组");
  }

  const planId = expectNonEmptyString(plan.id, "plan.id");
  const title = expectNonEmptyString(plan.title, "plan.title");
  const tasks: PlannedTask[] = [];
  const taskIds = new Set<string>();

  for (const [index, rawEntry] of plan.tasks.entries()) {
    const path = `plan.tasks[${index}]`;
    const entry = expectObject(rawEntry, path);
    expectExactKeys(entry, plan.schemaVersion === 1 ? ["task", "dependsOn", "status"] : ["task", "dependsOn", "status", "decisionRefs"], path);

    const task = parseTask(entry.task, `${path}.task`);
    if (taskIds.has(task.id)) {
      throw new InputValidationError(`${path}.task.id`, `任务 ID 重复：${task.id}`);
    }
    taskIds.add(task.id);

    if (!Array.isArray(entry.dependsOn)) {
      throw new InputValidationError(`${path}.dependsOn`, "必须是字符串数组");
    }

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of entry.dependsOn.entries()) {
      const dependencyId = expectNonEmptyString(
        dependency,
        `${path}.dependsOn[${dependencyIndex}]`,
      );
      if (dependencies.has(dependencyId)) {
        throw new InputValidationError(
          `${path}.dependsOn[${dependencyIndex}]`,
          `依赖重复：${dependencyId}`,
        );
      }
      dependencies.add(dependencyId);
      dependsOn.push(dependencyId);
    }

    if (entry.status !== "planned") {
      throw new InputValidationError(`${path}.status`, "阶段 0 只支持 planned 状态");
    }

    const decisionRefs = plan.schemaVersion === 1 ? undefined : parseDecisionRefs(entry.decisionRefs, `${path}.decisionRefs`);
    tasks.push({ task, dependsOn, status: "planned", ...(decisionRefs ? { decisionRefs } : {}) });
  }

  for (const [index, plannedTask] of tasks.entries()) {
    for (const dependencyId of plannedTask.dependsOn) {
      if (!taskIds.has(dependencyId)) {
        throw new InputValidationError(
          `plan.tasks[${index}].dependsOn`,
          `找不到依赖任务：${dependencyId}`,
        );
      }
    }
    if (plannedTask.dependsOn.includes(plannedTask.task.id)) {
      throw new InputValidationError(`plan.tasks[${index}].dependsOn`, `任务不能依赖自身：${plannedTask.task.id}`);
    }
  }

  const byId = new Map(tasks.map((entry) => [entry.task.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string, path: string[]) => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      const cycle = [...path.slice(cycleStart), taskId].join(" -> ");
      throw new InputValidationError("plan.tasks", `依赖关系存在循环：${cycle}`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) visit(dependencyId, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const entry of tasks) visit(entry.task.id, []);

  if (plan.schemaVersion === 1) return { schemaVersion: 1, id: planId, title, tasks };
  const decisionContext = parseDecisionContext(plan.decisionContext);
  const known = new Map(decisionContext.decisions.map((item) => [item.decisionId, item]));
  for (const [index, task] of tasks.entries()) {
    if (!task.decisionRefs || task.decisionRefs.length !== known.size || task.decisionRefs.some((ref) => {
      const decision = known.get(ref.decisionId);
      return !decision || decision.revision !== ref.revision || decision.valueHash !== ref.valueHash;
    })) throw new InputValidationError(`plan.tasks[${index}].decisionRefs`, "必须完整引用计划中的已选决策，且版本和哈希一致");
  }
  return { schemaVersion: 2, id: planId, title, tasks, decisionContext };
}

function parseDecisionRefs(value: unknown, path: string): NonNullable<PlannedTask["decisionRefs"]> {
  if (!Array.isArray(value) || value.length > 32) throw new InputValidationError(path, "必须是最多 32 项的决策引用数组");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const ref = expectObject(entry, `${path}[${index}]`);
    expectExactKeys(ref, ["decisionId", "revision", "valueHash"], `${path}[${index}]`);
    if (typeof ref.decisionId !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(ref.decisionId) || seen.has(ref.decisionId) ||
        !Number.isSafeInteger(ref.revision) || (ref.revision as number) < 1 || typeof ref.valueHash !== "string" || !/^[a-f0-9]{64}$/.test(ref.valueHash)) {
      throw new InputValidationError(`${path}[${index}]`, "决策引用身份、版本或哈希无效");
    }
    seen.add(ref.decisionId);
    return { decisionId: ref.decisionId as NonNullable<PlannedTask["decisionRefs"]>[number]["decisionId"], revision: ref.revision as number, valueHash: ref.valueHash };
  });
}

function parseDecisionContext(value: unknown): NonNullable<PlanDefinition["decisionContext"]> {
  const context = expectObject(value, "plan.decisionContext");
  expectExactKeys(context, ["schemaVersion", "decisions", "globalDecisionIds"], "plan.decisionContext");
  if (context.schemaVersion !== 1 || !Array.isArray(context.decisions) || context.decisions.length > 32 || !Array.isArray(context.globalDecisionIds)) {
    throw new InputValidationError("plan.decisionContext", "决策上下文版本或字段无效");
  }
  const globalDecisionIds = context.globalDecisionIds as unknown[];
  const seen = new Set<string>();
  const decisions = context.decisions.map((entry, index) => {
    const path = `plan.decisionContext.decisions[${index}]`;
    const item = expectObject(entry, path);
    const optional = ["requirementId", "sourceMessageId", "quote", "authorizationQuote", "evidence", "preference", "confirmation"];
    expectExactKeys(item, ["decisionId", "revision", "value", "valueHash", "status", "rationale", ...optional], path);
    if (typeof item.decisionId !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item.decisionId) || seen.has(item.decisionId) ||
        !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || typeof item.value !== "string" || !item.value.trim() ||
        typeof item.valueHash !== "string" || !/^[a-f0-9]{64}$/.test(item.valueHash) || typeof item.status !== "string" ||
        !["confirmed", "repository", "defaulted"].includes(item.status) || typeof item.rationale !== "string" || !item.rationale.trim()) {
      throw new InputValidationError(path, "已选决策字段无效");
    }
    const id = item.decisionId as NonNullable<PlanDefinition["decisionContext"]>["decisions"][number]["decisionId"];
    if (decisionValueHash(id, item.value) !== item.valueHash) throw new InputValidationError(`${path}.valueHash`, "决策值哈希不匹配");
    for (const key of ["requirementId", "sourceMessageId", "quote", "authorizationQuote"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || !item[key])) throw new InputValidationError(`${path}.${key}`, "必须是非空文本");
    }
    if (item.preference !== undefined && (typeof item.preference !== "string" || !item.preference || Buffer.byteLength(item.preference, "utf8") > 512)) throw new InputValidationError(`${path}.preference`, "决策偏好无效");
    let evidence: { path: string; sha256: string } | undefined;
    if (item.evidence !== undefined) {
      const rawEvidence = expectObject(item.evidence, `${path}.evidence`);
      expectExactKeys(rawEvidence, ["path", "sha256"], `${path}.evidence`);
      if (typeof rawEvidence.path !== "string" || !rawEvidence.path || typeof rawEvidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(rawEvidence.sha256)) throw new InputValidationError(`${path}.evidence`, "证据无效");
      evidence = { path: rawEvidence.path, sha256: rawEvidence.sha256 };
    }
    if (item.status === "repository" && !evidence) throw new InputValidationError(`${path}.evidence`, "仓库决策必须引用文件证据");
    if (item.status === "confirmed" && (!item.requirementId || !item.sourceMessageId || !item.quote)) throw new InputValidationError(path, "confirmed 决策必须保留来源");
    if (item.status === "defaulted" && (!item.sourceMessageId || !item.authorizationQuote)) throw new InputValidationError(path, "defaulted 决策必须保留授权来源");
    let confirmation: NonNullable<NonNullable<PlanDefinition["decisionContext"]>["decisions"][number]["confirmation"]> | undefined;
    if (item.confirmation !== undefined) {
      const rawConfirmation = expectObject(item.confirmation, `${path}.confirmation`);
      expectExactKeys(rawConfirmation, ["action", "proposalId", "proposalRevision", "questionId", "sourceMessageId", "quote", "decisionIds"], `${path}.confirmation`);
      if (!["accept", "delegate", "provide_value"].includes(String(rawConfirmation.action)) || typeof rawConfirmation.proposalId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(rawConfirmation.proposalId) || !Number.isSafeInteger(rawConfirmation.proposalRevision) || (rawConfirmation.proposalRevision as number) < 1 ||
          typeof rawConfirmation.questionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rawConfirmation.questionId) ||
          typeof rawConfirmation.sourceMessageId !== "string" || !/^[0-9a-f-]{36}$/i.test(rawConfirmation.sourceMessageId) ||
          typeof rawConfirmation.quote !== "string" || !rawConfirmation.quote || !Array.isArray(rawConfirmation.decisionIds) ||
          rawConfirmation.decisionIds.some((entry) => typeof entry !== "string") || !rawConfirmation.decisionIds.includes(id)) {
        throw new InputValidationError(`${path}.confirmation`, "确认来源或授权范围无效");
      }
      if ((rawConfirmation.action === "provide_value") !== (item.status === "confirmed")) throw new InputValidationError(`${path}.confirmation.action`, "确认动作与决策状态不匹配");
      confirmation = rawConfirmation as NonNullable<NonNullable<PlanDefinition["decisionContext"]>["decisions"][number]["confirmation"]>;
    }
    seen.add(item.decisionId);
    return { decisionId: id, revision: item.revision as number, value: item.value, valueHash: item.valueHash, status: item.status as "confirmed" | "repository" | "defaulted", rationale: item.rationale,
      ...(item.requirementId ? { requirementId: item.requirementId as string } : {}), ...(item.sourceMessageId ? { sourceMessageId: item.sourceMessageId as string } : {}),
      ...(item.quote ? { quote: item.quote as string } : {}), ...(item.authorizationQuote ? { authorizationQuote: item.authorizationQuote as string } : {}), ...(evidence ? { evidence } : {}), ...(item.preference ? { preference: item.preference as string } : {}), ...(confirmation ? { confirmation } : {}) };
  });
  if (globalDecisionIds.some((id) => typeof id !== "string" || !seen.has(id)) || new Set(globalDecisionIds).size !== globalDecisionIds.length || decisions.some(({ decisionId }) => !globalDecisionIds.includes(decisionId))) {
    throw new InputValidationError("plan.decisionContext.globalDecisionIds", "全局决策列表必须唯一且覆盖所有选定决策");
  }
  return { schemaVersion: 1, decisions, globalDecisionIds: context.globalDecisionIds as NonNullable<PlanDefinition["decisionContext"]>["globalDecisionIds"] };
}
