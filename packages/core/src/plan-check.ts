import type { ExecutionConfig } from "./task.js";
import type { PlanDefinition } from "./plan.js";
import { canonicalHash } from "./planner-store.js";
import { InputValidationError } from "./validation.js";
import { parsePlan } from "./validate-plan.js";

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

export function checkPlan(value: unknown, executionDefaults?: ExecutionConfig): PlanCheckResult {
  try {
    const plan = parsePlan(value);
    if (plan.tasks.length === 0 || plan.tasks.length > 100) {
      throw new InputValidationError("plan.tasks", "计划必须包含 1 到 100 个任务");
    }
    if (Buffer.byteLength(JSON.stringify(plan), "utf8") > 48 * 1024) {
      throw new InputValidationError("plan", "计划 JSON 超过 48 KiB");
    }
    if (executionDefaults) {
      for (const [index, entry] of plan.tasks.entries()) {
        if (!sameExecution(entry.task.execution, executionDefaults)) {
          throw new InputValidationError(`plan.tasks[${index}].task.execution`, `任务 ${entry.task.id} 必须使用本次指定的 Runner、模型和模式`);
        }
      }
    }
    return { valid: true, plan, planHash: canonicalHash(plan), executionPolicyChecked: executionDefaults !== undefined, diagnostics: [] };
  } catch (error) {
    const path = error instanceof InputValidationError ? error.path : "plan";
    const message = error instanceof Error ? error.message : String(error);
    const task = /任务 ([a-z0-9-]+)/i.exec(message);
    return {
      valid: false,
      executionPolicyChecked: executionDefaults !== undefined,
      diagnostics: [{ code: error instanceof InputValidationError ? "plan_invalid" : "plan_check_failed", severity: "error", path, taskIds: task?.[2] ? [task[2]] : [], message }],
    };
  }
}

function sameExecution(left: ExecutionConfig, right: ExecutionConfig): boolean {
  return left.runnerId === right.runnerId && left.mode === right.mode && left.modelId === right.modelId;
}
