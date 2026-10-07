import type { ExecutionConfig, TaskDefinition } from "./task.js";
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
  expectExactKeys(execution, ["runnerId", "modelId", "mode", "timeoutMs"], `${path}.execution`);

  const mode = expectNonEmptyString(execution.mode, `${path}.execution.mode`);
  if (mode !== "non_interactive") {
    throw new InputValidationError(`${path}.execution.mode`, "当前只支持 non_interactive");
  }

  const modelId = expectOptionalNonEmptyString(execution, "modelId", `${path}.execution`);
  const legacyTimeout = execution.timeoutMs === undefined ? undefined : expectPositiveInteger(execution.timeoutMs, `${path}.execution.timeoutMs`);
  const executionConfig: ExecutionConfig = {
    runnerId: expectNonEmptyString(execution.runnerId, `${path}.execution.runnerId`),
    mode: "non_interactive",
    ...(legacyTimeout === undefined ? {} : { timeoutMs: legacyTimeout }),
    ...(modelId === undefined ? {} : { modelId }),
  };

  return {
    schemaVersion: 1,
    id: expectNonEmptyString(task.id, `${path}.id`),
    title: expectNonEmptyString(task.title, `${path}.title`),
    prompt: expectNonEmptyString(task.prompt, `${path}.prompt`),
    execution: executionConfig,
  };
}
