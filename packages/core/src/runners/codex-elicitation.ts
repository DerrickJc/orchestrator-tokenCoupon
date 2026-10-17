import type { ElicitationFieldSchema, RunnerInteractionRequest } from "../runner.js";

type ObjectValue = Record<string, unknown>;

export type CodexElicitationParseResult =
  | { supported: true; request: RunnerInteractionRequest; mode: "form" | "url"; serverName: string }
  | { supported: false; mode: string; serverName: string; reason: string };

export function parseCodexElicitation(params: unknown, nativeRequestId: string): CodexElicitationParseResult {
  if (!isObject(params)) return { supported: false, mode: "unknown", serverName: "未知 MCP 服务", reason: "请求参数不是对象" };
  const serverName = safeText(params.serverName, 128) || "未知 MCP 服务";
  const mode = params.mode === undefined ? "form" : typeof params.mode === "string" ? params.mode : "unknown";
  const message = safeText(params.message, 4096);
  if (!message) return { supported: false, mode, serverName, reason: "请求说明缺失或过长" };

  if (mode === "form") {
    const schema = parseFormSchema(params.requestedSchema);
    if (!schema) return { supported: false, mode, serverName, reason: "表单字段超出当前支持的 JSON Schema 子集" };
    return { supported: true, mode, serverName, request: {
      kind: "elicitation", nativeRequestId, title: `Codex MCP 表单 · ${serverName}`, summary: message,
      elicitation: { mode, serverName, requestedSchema: schema },
    } };
  }

  if (mode === "url") {
    if (typeof params.url !== "string" || params.url.length > 4096) return { supported: false, mode, serverName, reason: "URL 缺失或过长" };
    let url: URL;
    try { url = new URL(params.url); } catch { return { supported: false, mode, serverName, reason: "URL 格式无效" }; }
    if (url.protocol !== "https:" || url.username || url.password) return { supported: false, mode, serverName, reason: "仅允许不含凭证的 HTTPS URL" };
    const elicitationId = safeText(params.elicitationId, 256);
    if (!elicitationId) return { supported: false, mode, serverName, reason: "elicitationId 缺失或过长" };
    return { supported: true, mode, serverName, request: {
      kind: "elicitation", nativeRequestId, title: `Codex MCP 网页确认 · ${serverName}`, summary: message,
      elicitation: { mode, serverName, elicitationId, url: url.toString() },
    } };
  }

  return { supported: false, mode: mode.slice(0, 64), serverName, reason: "当前 Runner 未启用此 elicitation 模式" };
}

export function validateElicitationContent(schema: NonNullable<RunnerInteractionRequest["elicitation"]>["requestedSchema"], input: unknown): Record<string, string | number | boolean | string[]> {
  if (!schema || !isObject(input)) throw new Error("表单回复必须是对象");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) throw new Error("表单回复超过 64 KiB 限制");
  const fields = schema.properties;
  for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) throw new Error(`表单回复包含未请求的字段：${key}`);
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const key of schema.required ?? []) if (!Object.hasOwn(input, key)) throw new Error(`缺少必填字段：${key}`);
  for (const [key, value] of Object.entries(input)) {
    const field = fields[key]!;
    if (field.type === "string") {
      if (typeof value !== "string") throw new Error(`字段 ${key} 必须是文本`);
      if (field.minLength !== undefined && value.length < field.minLength) throw new Error(`字段 ${key} 未达到最小长度`);
      if (field.maxLength !== undefined && value.length > field.maxLength) throw new Error(`字段 ${key} 超过最大长度`);
      const choices = field.enum ?? field.oneOf?.map((option) => option.const);
      if (choices && !choices.includes(value)) throw new Error(`字段 ${key} 不在允许选项中`);
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`字段 ${key} 邮箱格式无效`);
      if (field.format === "uri") { try { new URL(value); } catch { throw new Error(`字段 ${key} URL 格式无效`); } }
      if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`字段 ${key} 日期格式无效`);
      if (field.format === "date-time" && Number.isNaN(Date.parse(value))) throw new Error(`字段 ${key} 日期时间格式无效`);
      result[key] = value;
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value)) throw new Error(`字段 ${key} 必须是${field.type === "integer" ? "整数" : "数字"}`);
      if (field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum) throw new Error(`字段 ${key} 超出允许范围`);
      result[key] = value;
      continue;
    }
    if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`字段 ${key} 必须是布尔值`);
      result[key] = value;
      continue;
    }
    if (field.type !== "array") throw new Error("elicitation 字段 schema 类型无效");
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`字段 ${key} 必须是字符串数组`);
    if (field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) throw new Error(`字段 ${key} 选择数量不符合限制`);
    const choices = "enum" in field.items ? field.items.enum : field.items.anyOf.map((option) => option.const);
    if (value.some((entry) => !choices.includes(entry as string)) || new Set(value).size !== value.length) throw new Error(`字段 ${key} 包含无效或重复选项`);
    result[key] = [...value] as string[];
  }
  return result;
}

function parseFormSchema(value: unknown): NonNullable<RunnerInteractionRequest["elicitation"]>["requestedSchema"] | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, ["type", "properties", "required"]) || value.type !== "object" || !isObject(value.properties)) return undefined;
  const entries = Object.entries(value.properties);
  if (entries.length > 32) return undefined;
  const properties: Record<string, ElicitationFieldSchema> = {};
  for (const [name, raw] of entries) {
    if (!name || name.length > 128 || !isObject(raw)) return undefined;
    const text = (key: string, max: number) => raw[key] === undefined ? undefined : safeText(raw[key], max) || undefined;
    const title = text("title", 256), description = text("description", 1024);
    const fieldLabel = { ...(title ? { title } : {}), ...(description ? { description } : {}) };
    const bounded = (key: string, minimum: number, maximum: number) => raw[key] === undefined ? undefined : typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && (raw[key] as number) >= minimum && (raw[key] as number) <= maximum ? raw[key] as number : NaN;
    if (raw.type === "string") {
      if (!hasOnlyKeys(raw, ["type", "title", "description", "default", "minLength", "maxLength", "format", "enum", "enumNames", "oneOf"]) || raw.enum !== undefined && raw.oneOf !== undefined || raw.enumNames !== undefined && raw.enum === undefined || raw.default !== undefined && (typeof raw.default !== "string" || raw.default.length > 8192)) return undefined;
      const minLength = bounded("minLength", 0, 8192), maxLength = bounded("maxLength", 0, 8192);
      if (Number.isNaN(minLength) || Number.isNaN(maxLength) || minLength !== undefined && maxLength !== undefined && minLength > maxLength) return undefined;
      const format = raw.format;
      if (format !== undefined && !["date", "uri", "email", "date-time"].includes(String(format))) return undefined;
      const base = { type: "string" as const, ...fieldLabel, ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(format ? { format: format as "date" | "uri" | "email" | "date-time" } : {}), ...(typeof raw.default === "string" ? { default: raw.default } : {}) };
      if (raw.enum !== undefined) {
        if (!stringArray(raw.enum, 64, 1024) || raw.enum.length === 0) return undefined;
        if (raw.enumNames !== undefined && (!stringArray(raw.enumNames, 64, 256) || raw.enumNames.length !== raw.enum.length)) return undefined;
        properties[name] = { ...base, enum: [...raw.enum], ...(raw.enumNames ? { enumNames: [...raw.enumNames] } : {}) };
      } else if (raw.oneOf !== undefined) {
        if (!Array.isArray(raw.oneOf) || raw.oneOf.length === 0 || raw.oneOf.length > 64 || !raw.oneOf.every((item) => isObject(item) && hasOnlyKeys(item, ["const", "title"]) && typeof item.const === "string" && item.const.length <= 1024 && typeof item.title === "string" && item.title.length <= 256)) return undefined;
        properties[name] = { ...base, oneOf: raw.oneOf.map((item) => ({ const: String((item as ObjectValue).const), title: String((item as ObjectValue).title) })) };
      } else properties[name] = base;
      continue;
    }
    if (raw.type === "boolean") {
      if (!hasOnlyKeys(raw, ["type", "title", "description", "default"]) || raw.default !== undefined && typeof raw.default !== "boolean") return undefined;
      properties[name] = { type: "boolean", ...fieldLabel, ...(raw.default === undefined ? {} : { default: raw.default }) };
      continue;
    }
    if (raw.type === "number" || raw.type === "integer") {
      if (!hasOnlyKeys(raw, ["type", "title", "description", "default", "minimum", "maximum"])) return undefined;
      const minimum = raw.minimum, maximum = raw.maximum;
      if (minimum !== undefined && (typeof minimum !== "number" || !Number.isFinite(minimum)) || maximum !== undefined && (typeof maximum !== "number" || !Number.isFinite(maximum)) || typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) return undefined;
      if (raw.default !== undefined && (typeof raw.default !== "number" || !Number.isFinite(raw.default) || raw.type === "integer" && !Number.isInteger(raw.default))) return undefined;
      properties[name] = { type: raw.type, ...fieldLabel, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }), ...(raw.default === undefined ? {} : { default: raw.default }) };
      continue;
    }
    if (raw.type === "array") {
      if (!hasOnlyKeys(raw, ["type", "title", "description", "default", "minItems", "maxItems", "items"])) return undefined;
      const minItems = bounded("minItems", 0, 128), maxItems = bounded("maxItems", 0, 128);
      if (Number.isNaN(minItems) || Number.isNaN(maxItems) || minItems !== undefined && maxItems !== undefined && minItems > maxItems || !isObject(raw.items)) return undefined;
      let items: Extract<ElicitationFieldSchema, { type: "array" }>["items"];
      if (hasOnlyKeys(raw.items, ["enum"]) && stringArray(raw.items.enum, 64, 1024) && raw.items.enum.length > 0) items = { enum: [...raw.items.enum] };
      else if (hasOnlyKeys(raw.items, ["anyOf"]) && Array.isArray(raw.items.anyOf) && raw.items.anyOf.length > 0 && raw.items.anyOf.length <= 64 && raw.items.anyOf.every((item) => isObject(item) && hasOnlyKeys(item, ["const", "title"]) && typeof item.const === "string" && item.const.length <= 1024 && typeof item.title === "string" && item.title.length <= 256)) items = { anyOf: raw.items.anyOf.map((item) => ({ const: String((item as ObjectValue).const), title: String((item as ObjectValue).title) })) };
      else return undefined;
      if (raw.default !== undefined && (!stringArray(raw.default, 128, 1024) || raw.default.some((item) => !itemsValues(items).includes(item)) || minItems !== undefined && raw.default.length < minItems || maxItems !== undefined && raw.default.length > maxItems)) return undefined;
      properties[name] = { type: "array", ...fieldLabel, items, ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }), ...(raw.default === undefined ? {} : { default: [...raw.default] }) };
      continue;
    }
    return undefined;
  }
  if (value.required !== undefined && (!stringArray(value.required, 32, 128) || value.required.length > entries.length || new Set(value.required).size !== value.required.length || value.required.some((name) => !Object.hasOwn(properties, name)))) return undefined;
  for (const [name, field] of Object.entries(properties)) {
    if (!("default" in field) || field.default === undefined) continue;
    try { validateElicitationContent({ type: "object", properties: { [name]: field } }, { [name]: field.default }); }
    catch { return undefined; }
  }
  return { type: "object", properties, ...(value.required ? { required: [...value.required] } : {}) };
}

function itemsValues(items: { enum: string[] } | { anyOf: Array<{ const: string }> }): string[] { return "enum" in items ? items.enum : items.anyOf.map((item) => item.const); }
function stringArray(value: unknown, maximum = 128, itemLength = 8192): value is string[] { return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string" && item.length <= itemLength); }
function hasOnlyKeys(value: ObjectValue, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function safeText(value: unknown, max: number): string { return typeof value === "string" && value.length <= max ? value : ""; }
function isObject(value: unknown): value is ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
