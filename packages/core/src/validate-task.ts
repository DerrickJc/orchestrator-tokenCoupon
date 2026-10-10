import type { ExecutionConfig, TaskDefinition } from "./task.js";
import type { RequiredRunnerCapability } from "./task.js";
import {
  expectExactKeys,
  expectNonEmptyString,
  expectObject,
  expectOptionalNonEmptyString,
  expectPositiveInteger,
  expectSchemaVersion,
  InputValidationError,
  type JsonObject,
} from "./validation.js";

export function parseTask(value: unknown, path = "task"): TaskDefinition {
  const task = expectObject(value, path);
  expectExactKeys(task, ["schemaVersion", "id", "title", "prompt", "execution"], path);
  expectSchemaVersion(task, path);

  const execution = expectObject(task.execution, `${path}.execution`);
  expectExactKeys(execution, ["runnerId", "modelId", "mode", "timeoutMs", "requiredCapabilities"], `${path}.execution`);

  const mode = expectNonEmptyString(execution.mode, `${path}.execution.mode`);
  if (mode !== "non_interactive" && mode !== "managed") {
    throw new InputValidationError(`${path}.execution.mode`, "必须是 non_interactive 或 managed");
  }

  const modelId = expectOptionalNonEmptyString(execution, "modelId", `${path}.execution`);
  const legacyTimeout = execution.timeoutMs === undefined ? undefined : expectPositiveInteger(execution.timeoutMs, `${path}.execution.timeoutMs`);
  const requiredCapabilities = execution.requiredCapabilities === undefined ? undefined : parseRequiredCapabilities(execution.requiredCapabilities, `${path}.execution.requiredCapabilities`);
  const executionConfig: ExecutionConfig = {
    runnerId: expectNonEmptyString(execution.runnerId, `${path}.execution.runnerId`),
    mode,
    ...(legacyTimeout === undefined ? {} : { timeoutMs: legacyTimeout }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
  };

  return {
    schemaVersion: 1,
    id: expectNonEmptyString(task.id, `${path}.id`),
    title: expectNonEmptyString(task.title, `${path}.title`),
    prompt: expectNonEmptyString(task.prompt, `${path}.prompt`),
    execution: executionConfig,
  };
}

function parseRequiredCapabilities(value: unknown, path: string): RequiredRunnerCapability[] {
  if (!Array.isArray(value) || value.length > 2) throw new InputValidationError(path, "必须是 userInput/toolApproval 的数组");
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (item !== "userInput" && item !== "toolApproval") throw new InputValidationError(`${path}[${index}]`, "能力必须是 userInput 或 toolApproval");
    if (seen.has(item)) throw new InputValidationError(`${path}[${index}]`, "能力不能重复");
    seen.add(item);
  }
  return [...seen] as RequiredRunnerCapability[];
}
