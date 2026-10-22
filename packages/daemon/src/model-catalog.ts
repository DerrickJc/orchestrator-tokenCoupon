import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnNative as spawn, resolveNativeExecutable, resolveAgentExecutable } from "@token-coupon/core";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { networkFetch } from "./network-fetch.js";

export interface ModelOption { id: string; label: string; description?: string; isDefault?: boolean; }
export interface ModelCatalogResult { source: string; models: ModelOption[]; customAllowed: boolean; error?: string; }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/** Model metadata only: never starts a turn or sends a prompt. */
export class ModelCatalog {
  private readonly cache = new Map<string, { expires: number; result: Promise<ModelCatalogResult> }>();
  constructor(private readonly loader = discoverRunnerModels) {}
  async runner(id: string, cwd: string, refresh = false): Promise<ModelCatalogResult> {
    if (!["codex", "claude-code", "dsh", "mock"].includes(id)) throw new Error("runnerId_invalid：请选择已支持的 Runner");
    const key = `${id}:${cwd}`, previous = this.cache.get(key);
    if (previous && previous.expires > Date.now() && !refresh) return previous.result;
    const result = this.loader(id, cwd).catch(() => ({ source: "unavailable", models: [], customAllowed: id !== "mock", error: "model_catalog_unavailable：无法读取本机模型目录，可沿用默认配置或自定义模型 ID" }));
    this.cache.set(key, { expires: Date.now() + 60_000, result });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}

export async function discoverRunnerModels(id: string, cwd: string, command?: { executable: string; args?: string[] }): Promise<ModelCatalogResult> {
  if (id === "mock") return { source: "mock", models: [], customAllowed: false };
  if (id === "claude-code" && !command) return claudeModels(cwd);
  const executable = !command && id === "codex" ? await resolveAgentExecutable("codex") : await resolveNativeExecutable(command?.executable ?? "dsh");
  const rpc = new CatalogRpc(executable, [...(command?.args ?? []), ...(id === "codex" ? ["app-server", "--stdio"] : ["--profile", "acp"])], cwd);
  let sessionId: string | undefined;
  try {
    await rpc.request("initialize", id === "codex" ? { clientInfo: { name: "token-coupon-model-catalog", version: "1" }, capabilities: {} } : { protocolVersion: 1, clientInfo: { name: "token-coupon-model-catalog", version: "1" }, clientCapabilities: {} });
    rpc.notify("initialized", {});
    if (id === "codex") {
      const models: unknown[] = []; let cursor: string | undefined; const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const reply = object(await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(reply.data)) throw new Error("invalid model catalog");
        models.push(...reply.data.map((entry) => { const item = object(entry); return { id: item.model ?? item.id, label: item.displayName ?? item.model, description: item.description, isDefault: item.isDefault, hidden: item.hidden }; }));
        if (typeof reply.nextCursor !== "string" || !reply.nextCursor) break;
        if (seen.has(reply.nextCursor)) throw new Error("repeated model cursor"); seen.add(reply.nextCursor); cursor = reply.nextCursor;
      }
      return { source: "codex_app_server", models: normalizeModels(models), customAllowed: true };
    }
    const session = object(await rpc.request("session/new", { cwd, mcpServers: [] }));
    if (typeof session.sessionId !== "string") throw new Error("invalid ACP session"); sessionId = session.sessionId;
    const configs = Array.isArray(session.configOptions) ? session.configOptions.map(object) : [];
    const modelConfig = configs.find((item) => (item.configId ?? item.id) === "model");
    const choices: unknown[] = [];
    for (const option of Array.isArray(modelConfig?.options) ? modelConfig.options : []) {
      const item = object(option);
      for (const child of Array.isArray(item.options) ? item.options : [item]) { const row = object(child); choices.push({ id: row.value, label: row.name ?? row.label ?? row.value, description: row.description, isDefault: row.value === modelConfig?.currentValue }); }
    }
    return { source: "dsh_acp", models: normalizeModels(choices), customAllowed: true };
  } finally {
    if (sessionId) await rpc.request("session/close", { sessionId }, 2000).catch(() => undefined);
    await rpc.close();
  }
}

async function claudeModels(cwd: string): Promise<ModelCatalogResult> {
  const executable = await resolveAgentExecutable("claude-code");
  const controller = new AbortController();
  async function* idle(): AsyncGenerator<never> { await new Promise<void>((resolve) => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener("abort", () => resolve(), { once: true }); }); }
  const session = query({ prompt: idle(), options: { cwd, pathToClaudeCodeExecutable: executable, abortController: controller, persistSession: false, settingSources: ["user", "project"], permissionMode: "dontAsk", allowedTools: [], canUseTool: async () => ({ behavior: "deny", message: "Model discovery cannot execute tools" }),
    ...(process.platform === "win32" ? { spawnClaudeCodeProcess: options => spawn(options.command, options.args, { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) } : {}),
  } });
  const close = () => { controller.abort(); try { session.close(); } catch { /* Already closed. */ } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { close(); reject(new Error("model catalog timeout")); }, 10_000); });
    const models = await Promise.race([session.supportedModels(), timeout]);
    return { source: "claude_sdk", models: normalizeModels(models.map((item) => ({ id: item.value, label: item.displayName, description: item.description }))), customAllowed: true };
  } finally { clearTimeout(timer); close(); }
}

export async function discoverPlannerModels(fetcher: typeof fetch = networkFetch, environment: NodeJS.ProcessEnv = process.env): Promise<ModelCatalogResult> {
  const configured = environment.TOKEN_COUPON_PLANNER_MODEL ?? "deepseek-flash";
  const fallback = normalizeModels([{ id: configured, label: `${configured}（已配置）`, isDefault: true }]);
  if (!environment.TOKEN_COUPON_PLANNER_API_KEY) return { source: "configured", models: fallback, customAllowed: true, error: "planner_api_key_missing：请先配置 Planner API Key" };
  try {
    const endpoint = new URL(environment.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("invalid endpoint");
    endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "") + "/models";
    const response = await fetcher(endpoint, { headers: { Authorization: `Bearer ${environment.TOKEN_COUPON_PLANNER_API_KEY}` }, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error("unavailable"); }
    const reply = object(await response.json());
    if (!Array.isArray(reply.data)) throw new Error("invalid model catalog");
    const models = normalizeModels([...fallback, ...reply.data.map((entry) => { const row = object(entry); return { id: row.id, label: row.id }; })]);
    return { source: "planner_api", models, customAllowed: true };
  } catch { return { source: "configured", models: fallback, customAllowed: true, error: "model_catalog_unavailable：接口模型目录不可读，保留已配置模型，也可自定义 ID" }; }
}

export function normalizeModels(entries: unknown[]): ModelOption[] {
  const result = new Map<string, ModelOption>();
  for (const entry of entries.slice(0, 1000)) {
    const item = object(entry);
    if (item.hidden === true || typeof item.id !== "string" || !item.id.trim() || Buffer.byteLength(item.id, "utf8") > 120 || /[\x00-\x1f\x7f]/.test(item.id)) continue;
    if (!result.has(item.id)) result.set(item.id, { id: item.id, label: typeof item.label === "string" ? item.label.slice(0, 160) : item.id, ...(typeof item.description === "string" ? { description: item.description.slice(0, 500) } : {}), ...(typeof item.isDefault === "boolean" ? { isDefault: item.isDefault } : {}) });
  }
  return [...result.values()];
}

/** Bounded JSON-RPC reader for catalog control calls. No tool calls or task input. */
class CatalogRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private buffer = "";
  private ended = false;
  private readonly done: Promise<void>;
  constructor(executable: string, args: string[], cwd: string) {
    this.child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.done = new Promise((resolve) => this.child.once("close", () => { this.ended = true; this.fail(); resolve(); }));
    this.child.on("error", () => this.fail()); this.child.stdin.on("error", () => this.fail());
    this.child.stderr.on("data", () => undefined);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, "utf8") > 2 * 1024 * 1024) { this.fail(); this.child.kill(); return; }
      for (;;) {
        const end = this.buffer.indexOf("\n"); if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); if (!line.trim()) continue;
        let message: ObjectValue; try { message = object(JSON.parse(line)); } catch { this.fail(); this.child.kill(); return; }
        if (typeof message.method === "string") {
          if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Model discovery does not execute tools" } });
          continue;
        }
        if (typeof message.id !== "number") continue;
        const entry = this.pending.get(message.id); if (!entry) continue;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error("model catalog request failed")); else entry.resolve(message.result);
      }
    });
  }
  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("model catalog process closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("model catalog timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
  private write(message: unknown) { if (this.child.stdin.writable && !this.ended) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  private fail() { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("model catalog unavailable")); } this.pending.clear(); }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 250);
    const force = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    try { await this.done; } finally { clearTimeout(timer); clearTimeout(force); }
  }
}
