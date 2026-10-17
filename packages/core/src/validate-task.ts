import type { ExecutionConfig, TaskDefinition } from "./task.js";
import { renderTaskPrompt } from "./task.js";
import type { RequiredRunnerCapability } from "./task.js";
import {
  expectExactKeys,
  expectNonEmptyString,
  expectObject,
  expectOptionalNonEmptyString,
  expectPositiveInteger,
  InputValidationError,
  type JsonObject,
} from "./validation.js";

export function parseTask(value: unknown, path = "task"): TaskDefinition {
  const task = expectObject(value, path);
  if (task.schemaVersion !== 1 && task.schemaVersion !== 2) throw new InputValidationError(`${path}.schemaVersion`, "只支持版本 1 或 2");
  expectExactKeys(task, task.schemaVersion === 1
    ? ["schemaVersion", "id", "title", "prompt", "execution"]
    : ["schemaVersion", "id", "title", "prompt", "objective", "approach", "steps", "deliverables", "acceptanceCriteria", "constraints", "notes", "execution"], path);

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

  const id = expectNonEmptyString(task.id, `${path}.id`);
  const title = expectNonEmptyString(task.title, `${path}.title`);
  if (task.schemaVersion === 1) return {
    schemaVersion: 1,
    id,
    title,
    prompt: expectNonEmptyString(task.prompt, `${path}.prompt`),
    execution: executionConfig,
  };

  const objective = expectNonEmptyString(task.objective, `${path}.objective`);
  const approach = expectNonEmptyString(task.approach, `${path}.approach`);
  const steps = parseTextList(task.steps, `${path}.steps`, 1, 30);
  const deliverables = parseTextList(task.deliverables, `${path}.deliverables`, 1, 30);
  const acceptanceCriteria = parseTextList(task.acceptanceCriteria, `${path}.acceptanceCriteria`, 1, 30);
  const constraints = parseTextList(task.constraints, `${path}.constraints`, 0, 30);
  const notes = task.notes === undefined ? undefined : expectNonEmptyString(task.notes, `${path}.notes`);
  // prompt is retained as a serialized execution cache for compatibility with
  // existing Plan objects, but the structured fields below remain authoritative.
  if (task.prompt !== undefined && (typeof task.prompt !== "string" || Buffer.byteLength(task.prompt, "utf8") > 128 * 1024)) {
    throw new InputValidationError(`${path}.prompt`, "结构化任务的 prompt 缓存必须是文本且不超过 128 KiB");
  }
  const structured = { schemaVersion: 2 as const, id, title, objective, approach, steps, deliverables, acceptanceCriteria, constraints, ...(notes ? { notes } : {}), execution: executionConfig };
  return { ...structured, prompt: renderTaskPrompt({ ...structured, prompt: "" }) };
}

function parseTextList(value: unknown, path: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new InputValidationError(path, `必须是 ${minimum} 到 ${maximum} 项文本数组`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > 2048) throw new InputValidationError(`${path}[${index}]`, "必须是非空且不超过 2048 字节的文本");
    return item.trim();
  });
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
