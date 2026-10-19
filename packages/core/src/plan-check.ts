import type { ExecutionConfig } from "./task.js";
import type { PlanDefinition } from "./plan.js";
import { canonicalHash } from "./planner-store.js";
import { InputValidationError } from "./validation.js";
import { parsePlan } from "./validate-plan.js";
import { parseTask } from "./validate-task.js";
import { createDefaultRunnerRegistry } from "./default-runner-registry.js";
import type { RunnerRegistry } from "./runner-registry.js";

export interface PlanDiagnostic {
  code: string;
  severity: "error" | "warning";
  path: string;
  taskIds: string[];
  message: string;
}

export interface PlanCheckResult {
  valid: boolean;
  plan?: PlanDefinition;
  planHash?: string;
  executionPolicyChecked: boolean;
  diagnostics: PlanDiagnostic[];
}

export function checkPlan(value: unknown, executionDefaults?: ExecutionConfig, registry: Pick<RunnerRegistry, "resolve"> = createDefaultRunnerRegistry()): PlanCheckResult {
  let taskId: string | undefined;
  let normalized = value;
  try {
    if (executionDefaults) {
      // Validate defaults separately, even when every task explicitly overrides them.
      parseTask({ schemaVersion: 1, id: "defaults", title: "defaults", prompt: "defaults", execution: executionDefaults }, "planner");
      normalized = withExecutionDefaults(value, executionDefaults);
    }
    const plan = parsePlan(normalized);
    if (plan.tasks.length === 0 || plan.tasks.length > 100) {
      throw new InputValidationError("plan.tasks", "计划必须包含 1 到 100 个任务");
    }
    if (Buffer.byteLength(JSON.stringify(plan), "utf8") > 48 * 1024) {
      throw new InputValidationError("plan", "计划 JSON 超过 48 KiB");
    }
    for (const [index, entry] of plan.tasks.entries()) {
      taskId = entry.task.id;
      try {
        // Resolving checks registration, mode, model support and required capabilities.
        // It does not start a Runner, probe credentials, or make provider requests.
        registry.resolve(entry.task);
      } catch (error) {
        throw new InputValidationError(`plan.tasks[${index}].task.execution`, `任务 ${entry.task.id}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { valid: true, plan, planHash: canonicalHash(plan), executionPolicyChecked: executionDefaults !== undefined, diagnostics: [] };
  } catch (error) {
    const path = error instanceof InputValidationError ? error.path : "plan";
    const message = error instanceof Error ? error.message : String(error);
    const index = /^plan\.tasks\[(\d+)\]/.exec(path)?.[1];
    if (index !== undefined && isObject(normalized) && Array.isArray(normalized.tasks)) {
      const entry = normalized.tasks[Number(index)];
      if (isObject(entry) && isObject(entry.task) && typeof entry.task.id === "string") taskId = entry.task.id;
    }
    return {
      valid: false,
      executionPolicyChecked: executionDefaults !== undefined,
      diagnostics: [{ code: error instanceof InputValidationError ? "plan_invalid" : "plan_check_failed", severity: "error", path, taskIds: taskId ? [taskId] : [], message }],
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Normalize only planning input; stored Task/Plan schemas still require complete execution. */
function withExecutionDefaults(value: unknown, defaults: ExecutionConfig): unknown {
  if (!isObject(value) || !Array.isArray(value.tasks)) return value;
  return { ...value, tasks: value.tasks.map((entry: unknown) => {
    if (!isObject(entry) || !isObject(entry.task)) return entry;
    const explicit = entry.task.execution;
    // Null, arrays and other malformed values must still fail normal schema validation.
    if (explicit !== undefined && !isObject(explicit)) return entry;
    // A different Runner must not inherit the previous Runner's model or task capabilities.
    const inherited = isObject(explicit) && explicit.runnerId !== undefined && explicit.runnerId !== defaults.runnerId
      ? { mode: defaults.mode }
      : defaults;
    const execution: Record<string, unknown> = { ...inherited, ...(isObject(explicit) ? explicit : {}) };
    if (Array.isArray(execution.requiredCapabilities)) execution.requiredCapabilities = [...execution.requiredCapabilities];
    return { ...entry, task: { ...entry.task, execution } };
  }) };
}
