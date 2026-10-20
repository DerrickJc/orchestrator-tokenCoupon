import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnNative as spawn, resolveNativeExecutable } from "../native-command.js";
import type { Runner, RunnerContext, RunnerDiagnostics, RunnerInput, RunnerInteractionRequest, RunnerResult } from "../runner.js";

type JsonObject = Record<string, unknown>;

/** Drives the official DeepSeek Harness ACP profile over its JSON-RPC stdio interface. */
export class DeepSeekHarnessRunner implements Runner {
  readonly id = "dsh";
  readonly supportsModel = true;

  constructor(private readonly executable = "dsh") {}

  async checkAvailable(): Promise<void> {
    await runVersion(this.executable);
  }

  async diagnose(): Promise<RunnerDiagnostics> {
    const version = await runVersion(this.executable);
    return {
      ...(version ? { version } : {}),
      configurationSources: ["DeepSeek Harness ACP profile", "DSH_HOME / process environment"],
      authentication: "unknown",
      inference: "unverified",
    };
  }

  async run(input: RunnerInput, context: RunnerContext): Promise<RunnerResult> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(await resolveNativeExecutable(this.executable), ["--profile", "acp"], {
        cwd: input.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return startFailure(error);
    }

    const rpc = new DshAcpConnection(child, context);
    let started = false;
    let sessionId: string | undefined;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let nativeOutcome: RunnerResult["nativeOutcome"] = "unknown";
    let protocolError: string | undefined;
    let cleanupStatus: RunnerResult["cleanupStatus"] = "completed";
    let exitResolve!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { exitResolve = resolve; });
    child.once("error", (error) => { protocolError = error.message; exitResolve({ code: null, signal: null }); });
    child.once("exit", (code, childSignal) => { exitCode = code; signal = childSignal; exitResolve({ code, signal: childSignal }); });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      context.onActivity?.();
      const text = chunk.toString("utf8");
      stderr = appendBounded(stderr, text, 32 * 1024);
      context.onOutput({ stream: "stderr", text });
    });

    const abort = () => {
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      void stopChild(child);
      nativeOutcome = "cancelled";
    };
    context.signal.addEventListener("abort", abort, { once: true });

    try {
      const initialization = asObject(await rpc.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "orchestrator-token-coupon", version: "0.1.0" },
        clientCapabilities: {},
      }), "dsh ACP initialize");
      if (initialization.protocolVersion !== 1) throw new Error(`dsh ACP 协议版本不受支持：${String(initialization.protocolVersion)}`);

      rpc.notify("initialized", {});
      const created = asObject(await rpc.request("session/new", { cwd: input.cwd, mcpServers: [] }), "dsh ACP session/new");
      if (typeof created.sessionId !== "string" || !created.sessionId) throw new Error("dsh ACP 未返回 sessionId");
      sessionId = created.sessionId;
      await selectModel(rpc, sessionId, created.configOptions, input.execution.modelId);

      if (context.signal.aborted) {
        nativeOutcome = "cancelled";
        rpc.notify("session/cancel", { sessionId });
      } else {
        started = true;
        context.onStarted();
        await context.recordEvent?.({ type: "runner.native.started", threadId: sessionId, turnId: input.attemptId });
        const response = asObject(await rpc.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: input.prompt }],
        }, Number.POSITIVE_INFINITY), "dsh ACP session/prompt");
        const reason = typeof response.stopReason === "string" ? response.stopReason : "unknown";
        nativeOutcome = reason === "end_turn" ? "completed" : reason === "cancelled" ? "cancelled" : "incomplete";
        if (nativeOutcome !== "completed") protocolError = `dsh ACP prompt 结束原因：${reason}`;
      }
    } catch (error) {
      protocolError = error instanceof Error ? error.message : String(error);
      nativeOutcome = context.signal.aborted ? "cancelled" : "failed";
    } finally {
      context.signal.removeEventListener("abort", abort);
      if (sessionId && !child.killed) {
        try { await rpc.request("session/close", { sessionId }, 5_000); } catch { /* The process exit below remains authoritative. */ }
      }
      rpc.close();
      const gracefulExit = await Promise.race([
        exited.then(() => true),
        delay(250).then(() => false),
      ]);
      if (!gracefulExit) await stopChild(child);
      const termination = await Promise.race([
        exited.then(() => "exited" as const),
        new Promise<"timeout">((resolve) => { const timer = setTimeout(() => resolve("timeout"), 5_000); timer.unref(); }),
      ]);
      if (termination === "timeout") { cleanupStatus = "failed"; child.kill("SIGKILL"); }
      if (termination !== "exited") await Promise.race([exited, delay(1_000)]);
    }

    const childExit = await Promise.race([exited, delay(1_000).then(() => null)]);
    if (childExit) { exitCode = childExit.code; signal = childExit.signal; }
    if (protocolError) {
      await context.recordEvent?.({ type: "runner.diagnostic", severity: "error", code: "dsh_acp_error", message: protocolError });
      context.onOutput({ stream: "stderr", text: `dsh ACP: ${protocolError}\n` });
    }
    if (nativeOutcome === "completed" && exitCode === 0 && !protocolError) {
      await context.recordEvent?.({ type: "runner.native.finished", outcome: "completed" });
    } else {
      nativeOutcome ??= context.signal.aborted ? "cancelled" : "unknown";
      await context.recordEvent?.({ type: "runner.native.finished", outcome: nativeOutcome, ...(protocolError ? { reason: protocolError } : {}) });
    }
    return {
      started,
      exitCode,
      signal,
      transport: "app-server",
      nativeOutcome,
      cleanupStatus,
      ...(protocolError ? { executionError: protocolError, nativeError: { message: protocolError } } : {}),
      ...(stderr && !protocolError ? { nativeError: { message: "dsh ACP wrote diagnostics to stderr", details: stderr } } : {}),
    };
  }
}

class DshAcpConnection {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout | undefined }>();
  private pendingText = "";
  private eventQueue = Promise.resolve();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly context: RunnerContext) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.once("exit", () => this.failAll(new Error("dsh ACP 进程已退出")));
    child.once("error", (error) => this.failAll(error));
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("dsh ACP 连接已关闭"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dsh ACP 请求超时：${method}`));
      }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  async permissionRequest(message: JsonObject): Promise<void> {
    const id = message.id;
    const params = isObject(message.params) ? message.params : {};
    const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
    const allow = options.find((option) => option.kind === "allow_once" && typeof option.optionId === "string");
    const deny = options.find((option) => option.kind === "reject_once" && typeof option.optionId === "string");
    const operation = isObject(params.subject) ? params.subject : {};
    const tool = isObject(operation.toolCall) ? operation.toolCall : operation;
    const rawCommand = typeof tool.command === "string" ? tool.command : undefined;
    const cwd = typeof tool.cwd === "string" ? tool.cwd : undefined;
    const interaction: RunnerInteractionRequest = {
      kind: "approval",
      nativeRequestId: String(id),
      title: typeof params.title === "string" ? params.title : "dsh 请求执行操作",
      summary: typeof params.description === "string" ? params.description : rawCommand ?? "dsh 请求工具权限",
      ...(cwd ? { cwd } : {}),
      operation: { kind: rawCommand ? "command" : "other", ...(rawCommand ? { command: rawCommand } : {}) },
      decisions: [...(allow ? ["allow-once" as const] : []), ...(deny ? ["deny" as const] : [])],
    };
    let decision: "allow-once" | "deny" = "deny";
    if (contextHasInteraction(this.context)) {
      const reply = await this.context.requestInteraction!(interaction, this.context.signal);
      if (reply.kind === "approval") decision = reply.decision;
    }
    const selected = decision === "allow-once" ? allow : deny;
    const outcome = selected ? { outcome: "selected", optionId: selected.optionId as string } : { outcome: "cancelled" };
    if (id !== undefined) this.write({ jsonrpc: "2.0", id, result: { outcome } });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("dsh ACP 连接已关闭"));
  }

  private consume(chunk: string): void {
    this.pendingText += chunk;
    if (Buffer.byteLength(this.pendingText, "utf8") > 4 * 1024 * 1024 && !this.pendingText.includes("\n")) {
      this.failAll(new Error("dsh ACP JSON-RPC 行超过 4 MiB"));
      this.child.kill("SIGTERM");
      return;
    }
    const lines = this.pendingText.split("\n");
    this.pendingText = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonObject;
      try { message = asObject(JSON.parse(line), "dsh ACP message"); }
      catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))); this.child.kill("SIGTERM"); return; }
      this.context.onActivity?.();
      if ((typeof message.id === "number" || typeof message.id === "string") && ("result" in message || "error" in message)) {
        this.resolveResponse(message);
      } else if (message.method === "session/request_permission") {
        void this.permissionRequest(message).catch((error: unknown) => {
          this.failAll(error instanceof Error ? error : new Error(String(error)));
          this.child.kill("SIGTERM");
        });
      } else if (message.method === "session/update") {
        this.eventQueue = this.eventQueue.then(() => this.handleUpdate(message)).catch((error: unknown) => {
          this.failAll(error instanceof Error ? error : new Error(String(error)));
          this.child.kill("SIGTERM");
        });
      } else if (typeof message.method === "string" && message.id !== undefined) {
        this.write({ jsonrpc: "2.0", id: message.id as string | number, error: { code: -32601, message: `Unsupported ACP request: ${message.method}` } });
      }
    }
  }

  private async handleUpdate(message: JsonObject): Promise<void> {
    const params = isObject(message.params) ? message.params : {};
    const update = isObject(params.update) ? params.update : {};
    const kind = update.sessionUpdate;
    const content = isObject(update.content) ? update.content : {};
    const text = typeof content.text === "string" ? content.text : "";
    if (kind === "agent_message_chunk" && text) {
      await this.context.recordEvent?.({ type: "message.delta", text, root: true });
      this.context.onOutput({ stream: "stdout", text, agentText: text, displayText: text });
    } else if (kind === "agent_message" && text) {
      await this.context.recordEvent?.({ type: "message.completed", text, root: true });
      this.context.onOutput({ stream: "stdout", text: "", finalText: text, displayText: "" });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      const title = typeof update.title === "string" ? update.title : "dsh tool";
      const status = update.status;
      if (status === "completed" || status === "failed") {
        await this.context.recordEvent?.({ type: "tool.completed", ...(toolCallId ? { toolId: toolCallId } : {}), name: title });
      } else {
        await this.context.recordEvent?.({ type: "tool.started", ...(toolCallId ? { toolId: toolCallId } : {}), name: title });
      }
    }
  }

  private resolveResponse(message: JsonObject): void {
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (isObject(message.error)) pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "dsh ACP request failed"));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(message: JsonObject): void {
    if (!this.child.stdin.writable) throw new Error("dsh ACP stdin 已关闭");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

async function selectModel(rpc: DshAcpConnection, sessionId: string, rawOptions: unknown, requested: string | undefined): Promise<string | undefined> {
  if (!Array.isArray(rawOptions)) {
    if (requested) throw new Error("dsh ACP 未提供可验证的模型选项，不能保证按请求模型执行");
    return undefined;
  }
  const options = rawOptions.filter(isObject);
  const modelConfig = options.find((option) => (option.configId ?? option.id) === "model");
  if (!modelConfig || !Array.isArray(modelConfig.options)) {
    if (requested) throw new Error("当前 dsh ACP 会话未声明模型选择能力");
    return undefined;
  }
  const choices: JsonObject[] = [];
  for (const option of modelConfig.options.filter(isObject)) {
    if (Array.isArray(option.options)) choices.push(...option.options.filter(isObject));
    else choices.push(option);
  }
  const current = modelConfig.currentValue;
  const currentValue = typeof current === "string" ? current
    : isObject(current) ? typeof current.value === "string" ? current.value : typeof current.id === "string" ? current.id : undefined
    : undefined;
  const wanted = requested ?? currentValue;
  if (!wanted) throw new Error("dsh ACP 没有当前模型值，需先在 dsh profile 配置模型");
  const chosen = choices.find((option) => option.value === wanted || option.id === wanted);
  if (!chosen) throw new Error(`dsh 未提供请求的模型 ${wanted}；请在 dsh 配置页选择该模型`);
  const optionId = typeof chosen.value === "string" ? chosen.value : typeof chosen.id === "string" ? chosen.id : undefined;
  if (!optionId) throw new Error("dsh ACP 返回了无效模型选项");
  if (optionId !== currentValue) {
    const configId = typeof modelConfig.configId === "string" ? modelConfig.configId : modelConfig.id;
    if (typeof configId !== "string") throw new Error("dsh ACP 模型配置缺少 configId");
    await rpc.request("session/set_config_option", { sessionId, configId, type: "id", value: optionId });
  }
  return optionId;
}

async function runVersion(executable: string): Promise<string | undefined> {
  const child = spawn(await resolveNativeExecutable(executable), ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk, 4096); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk, 4096); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`无法启动 dsh（${executable}）：${error.message}`)));
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) throw new Error(`dsh --version 退出码 ${String(code)}：${stderr.trim()}`);
  return stdout.trim() || undefined;
}

function startFailure(error: unknown): RunnerResult {
  const value = error instanceof Error ? error : new Error(String(error));
  return { started: false, exitCode: null, signal: null, transport: "app-server", nativeOutcome: "failed", cleanupStatus: "completed", startError: { code: "dsh_spawn_failed", message: value.message } };
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(1_000).then(() => { child.kill("SIGKILL"); })]);
}

function contextHasInteraction(context: RunnerContext): boolean { return typeof context.requestInteraction === "function"; }
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function asObject(value: unknown, name: string): JsonObject { if (!isObject(value)) throw new Error(`${name} 必须是对象`); return value; }
function appendBounded(current: string, next: string, max: number): string { const value = current + next; return value.length > max ? value.slice(-max) : value; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
