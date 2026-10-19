import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type FunctionName = "planning" | "review" | "revision" | "diagnosis";
export interface FunctionPolicy {
  priority: "agent" | "web";
  agent: { runnerId: "codex" | "claude-code"; modelId?: string };
  webSource: "chatgpt" | "claude";
}
export interface SystemSettings {
  schemaVersion: 1;
  revision: number;
  initialized: boolean;
  mode: "unified" | "per-function";
  unified: FunctionPolicy;
  functions: Record<FunctionName, FunctionPolicy>;
}
export function defaultSystemSettings(): SystemSettings {
  const policy = (): FunctionPolicy => ({ priority: "web", agent: { runnerId: "codex" }, webSource: "chatgpt" });
  return { schemaVersion: 1, revision: 0, initialized: false, mode: "unified", unified: policy(), functions: { planning: policy(), review: policy(), revision: policy(), diagnosis: policy() } };
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("settings_invalid：设置包含不支持的字段");
  return value as Record<string, unknown>;
}
function policy(value: unknown): FunctionPolicy {
  const input = object(value, ["priority", "agent", "webSource"]), agent = object(input.agent, ["runnerId", "modelId"]);
  if (!["agent", "web"].includes(String(input.priority)) || !["chatgpt", "claude"].includes(String(input.webSource)) || !["codex", "claude-code"].includes(String(agent.runnerId))) throw new Error("settings_invalid：请选择有效的处理方式、网页来源和 Agent");
  if (agent.modelId !== undefined && (typeof agent.modelId !== "string" || !agent.modelId.trim() || agent.modelId.length > 120 || /[\x00-\x1f\x7f]/.test(agent.modelId))) throw new Error("settings_invalid：模型 ID 无效");
  return { priority: input.priority as FunctionPolicy["priority"], webSource: input.webSource as FunctionPolicy["webSource"], agent: { runnerId: agent.runnerId as FunctionPolicy["agent"]["runnerId"], ...(agent.modelId ? { modelId: (agent.modelId as string).trim() } : {}) } };
}
export function parseSystemSettings(value: unknown): SystemSettings {
  const input = object(value, ["schemaVersion", "revision", "initialized", "mode", "unified", "functions"]);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || typeof input.initialized !== "boolean" || !["unified", "per-function"].includes(String(input.mode))) throw new Error("settings_invalid：设置版本或模式无效");
  const functions = object(input.functions, ["planning", "review", "revision", "diagnosis"]);
  return { schemaVersion: 1, revision: input.revision as number, initialized: input.initialized, mode: input.mode as SystemSettings["mode"], unified: policy(input.unified), functions: { planning: policy(functions.planning), review: policy(functions.review), revision: policy(functions.revision ?? functions.planning), diagnosis: policy(functions.diagnosis) } };
}
export class SystemSettingsStore {
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<SystemSettings> {
    try { return parseSystemSettings(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSystemSettings(); throw error; }
  }
  update(value: unknown): Promise<SystemSettings> {
    const next = parseSystemSettings(value);
    const result = this.mutation.then(async () => {
      const current = await this.read();
      if (next.revision !== current.revision) throw new Error("settings_revision_conflict：设置已被其他页面更新，请重新加载后修改");
      const saved = { ...next, initialized: true, revision: current.revision + 1 };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, this.path); }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
      return saved;
    });
    this.mutation = result.catch(() => {}); return result;
  }
}
