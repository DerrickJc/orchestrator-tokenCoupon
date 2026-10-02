export class InputValidationError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "InputValidationError";
  }
}

export type JsonObject = Record<string, unknown>;

export function expectObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError(path, "必须是 JSON 对象");
  }

  return value as JsonObject;
}

export function expectExactKeys(
  value: JsonObject,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new InputValidationError(`${path}.${key}`, "不支持此字段");
    }
  }
}

export function expectSchemaVersion(value: JsonObject, path: string): void {
  if (value.schemaVersion !== 1) {
    throw new InputValidationError(`${path}.schemaVersion`, "当前只支持版本 1");
  }
}

export function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InputValidationError(path, "必须是非空字符串");
  }

  return value;
}

export function expectOptionalNonEmptyString(
  value: JsonObject,
  key: string,
  path: string,
): string | undefined {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }

  return expectNonEmptyString(value[key], `${path}.${key}`);
}

export function expectPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InputValidationError(path, "必须是正整数");
  }

  return value;
}
