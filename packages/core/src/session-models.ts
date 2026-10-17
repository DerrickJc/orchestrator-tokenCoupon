import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLockCoordination } from "./owner-lock.js";
import { SessionStore } from "./session-store.js";
import type { TaskDefinition } from "./task.js";

export interface SessionModels {
  schemaVersion: 1; sessionId: string; planDigest: string; revision: number;
  overrides: Record<string, { runnerId: string; modelId: string | null; updatedAt: string }>;
  history: Array<{ requestKey: string; taskId: string; modelId: string | null; at: string }>;
}
const binding = (record: Awaited<ReturnType<SessionStore["load"]>>) => record.snapshot.planDigest || createHash("sha256").update(JSON.stringify(record.plan)).digest("hex");
export async function readSessionModels(workspace: string, sessionId: string): Promise<SessionModels> {
  const store = new SessionStore(workspace), record = await store.load(sessionId), path = join(store.sessionDirectory(sessionId), "models.json");
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (!info) return { schemaVersion: 1, sessionId, planDigest: binding(record), revision: 0, overrides: {}, history: [] };
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("session_models_invalid：模型配置记录不安全或过大");
  const data = JSON.parse(await readFile(path, "utf8")) as SessionModels;
  if (data.schemaVersion !== 1 || data.sessionId !== sessionId || data.planDigest !== binding(record) || !Number.isSafeInteger(data.revision) || data.revision < 0 || !data.overrides || typeof data.overrides !== "object" || Array.isArray(data.overrides) || !Array.isArray(data.history) || data.history.length > 1000) throw new Error("session_models_invalid：模型配置与 Session 不匹配");
  for (const [id, override] of Object.entries(data.overrides)) {
    if (!record.plan.tasks.some(entry => entry.task.id === id && entry.task.execution.runnerId === override?.runnerId) || !validModel(override.modelId)) throw new Error("session_models_invalid：任务模型配置无效");
  }
  return data;
}
function validModel(model: unknown): model is string | null { return model === null || typeof model === "string" && !!model.trim() && model.length <= 200 && !/[\x00-\x1f\x7f]/.test(model); }
export async function updateSessionModel(input: { workspace: string; sessionId: string; taskId: string; modelId: string | null; expectedRevision: number; requestKey: string }) {
  if (!validModel(input.modelId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9-]{36}$/i.test(input.requestKey)) throw new Error("session_model_input_invalid");
  const store = new SessionStore(input.workspace), record = await store.load(input.sessionId);
  const entry = record.plan.tasks.find(item => item.task.id === input.taskId);
  if (!entry) throw new Error("session_model_task_invalid：任务不属于当前 Session");
  if (record.snapshot.tasks.find(task => task.taskId === input.taskId)?.status === "succeeded") throw new Error("session_model_task_completed：已完成任务保持不变");
  const path = join(store.sessionDirectory(input.sessionId), "models.json"), release = await acquireLockCoordination([`${path}.lock`], 2);
  try {
    const previous = await readSessionModels(input.workspace, input.sessionId), existing = previous.history.find(item => item.requestKey === input.requestKey);
    if (existing) { if (existing.taskId !== input.taskId || existing.modelId !== input.modelId) throw new Error("idempotency_conflict"); return previous; }
    if (previous.revision !== input.expectedRevision) throw new Error("session_models_changed：模型配置已更新，请刷新后重新确认");
    if (previous.history.length >= 1000) throw new Error("session_models_limit：模型变更历史已达上限");
    const at = new Date().toISOString(), next: SessionModels = { ...previous, revision: previous.revision + 1, overrides: { ...previous.overrides, [input.taskId]: { runnerId: entry.task.execution.runnerId, modelId: input.modelId, updatedAt: at } }, history: [...previous.history, { requestKey: input.requestKey, taskId: input.taskId, modelId: input.modelId, at }] };
    const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, path);
    return next;
  } finally { await release(); }
}
export async function taskWithSessionModel(task: TaskDefinition, workspace: string, sessionId: string): Promise<TaskDefinition> {
  const override = (await readSessionModels(workspace, sessionId)).overrides[task.id];
  if (!override || override.modelId === null) return task;
  return { ...task, execution: { ...task.execution, modelId: override.modelId } };
}
