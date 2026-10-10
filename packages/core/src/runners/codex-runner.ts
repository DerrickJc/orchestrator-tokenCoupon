import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { diagnoseNativeCli } from "../runner-diagnostics.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Runner, RunnerContext, RunnerInput, RunnerInteractionRequest, RunnerResult, RunnerNativeError } from "../runner.js";

export interface CodexRunnerSettings {
  sandbox?: "read-only" | "workspace-write";
  approvalPolicy?: "on-request" | "untrusted";
}

interface InternalSpawnOptions { executable?: string; args?: string[]; }
type JsonObject = Record<string, unknown>;
type RpcId = string | number;

export class CodexRunner implements Runner {
  readonly id = "codex";
  readonly supportsModel = true;

  constructor(private readonly settings: CodexRunnerSettings = {}, private readonly internalSpawn: InternalSpawnOptions = {}) {}

  async checkAvailable(): Promise<void> { await findExecutable(this.internalSpawn.executable ?? "codex"); }
  async diagnose(cwd: string) { return diagnoseNativeCli(await findExecutable(this.internalSpawn.executable ?? "codex"), "codex", cwd); }

  async run(input: RunnerInput, context: RunnerContext): Promise<RunnerResult> {
    if (!context.requestInteraction) throw new Error("Codex managed 模式缺少人工交互 owner");
    const executable = await findExecutable(this.internalSpawn.executable ?? "codex");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...(this.internalSpawn.args ?? []), "app-server", "--stdio"], {
        cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      });
    } catch (error) {
      return { started: false, exitCode: null, signal: null, transport: "app-server", nativeOutcome: "unknown", cleanupStatus: "completed", startError: { code: errorCode(error), message: errorMessage(error) } };
    }

    const rpc = new CodexRpcConnection(child, context);
    const abort = () => { void rpc.interruptAndTerminate(); };
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    let started = false;
    let outcome: RunnerResult["nativeOutcome"] = "unknown";
    let reason: string | undefined;
    let fatal: string | undefined;
    let cleanupStatus: RunnerResult["cleanupStatus"] = "unknown";
    let completed = false;
    let nativeError: RunnerNativeError | undefined;
    let lastError: RunnerNativeError | undefined;
    let nativeThreadId: string | undefined;
    let nativeTurnId: string | undefined;
    let reportedModel: string | undefined;
    const pendingInteractions = new Map<string, string>();
    const asyncQuestions = new Set<Promise<void>>();
    const asyncQuestionAbort = new AbortController();
    const followUpAnswers: Array<{ text: string; interactionId: string }> = [];
    const messageParts = new Map<string, string>();

    rpc.onServerRequest = async (message) => {
      const method = message.method;
      const id = message.id;
      const params = isObject(message.params) ? message.params : {};
      if (typeof method !== "string" || (typeof id !== "string" && typeof id !== "number")) throw new Error("Codex app-server 发来格式无效的服务端请求");
      const nativeId = String(id);
      if (method === "item/tool/requestUserInput") {
        const request = makeCodexQuestion(params, nativeId);
        const answer = await context.requestInteraction!(request, rpc.endedSignal);
        if (context.signal.aborted) throw new Error("Codex 提问已随 Attempt 取消");
        await context.recordEvent?.({ type: "interaction.forwarded", requestId: answer.interactionId, evidence: "codex-app-server-user-input" });
        const answers: Record<string, { answers: string[] }> = {};
        if (answer.kind !== "question") throw new Error("Codex 问题请求收到了审批回复");
        for (const item of answer.answers) answers[item.questionId] = { answers: item.optionIds?.length ? item.optionIds : [item.text ?? ""] };
        pendingInteractions.set(String(params.itemId ?? nativeId), answer.interactionId);
        await rpc.respond(id, { answers });
        return;
      }
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const command = typeof params.command === "string" ? params.command : undefined;
        const broad = method.endsWith("commandExecution/requestApproval")
          ? hasPermissionExpansion(params.additionalPermissions)
          : typeof params.grantRoot === "string" && params.grantRoot.length > 0;
        if (broad) {
          await context.recordEvent?.({ type: "runner.diagnostic", severity: "warning", code: "approval_scope_unsupported", message: "Codex 请求扩大本次工具调用以外的权限；本版本拒绝此类请求" });
          await rpc.respond(id, { decision: "decline" });
          return;
        }
        const request: RunnerInteractionRequest = {
          kind: "approval", nativeRequestId: nativeId,
          title: method.endsWith("commandExecution/requestApproval") ? "Codex 请求批准命令" : "Codex 请求批准文件变更",
          summary: [command, typeof params.reason === "string" ? params.reason : undefined].filter(Boolean).join("\n") || "Codex 请求一次性操作批准",
          cwd: typeof params.cwd === "string" ? params.cwd : input.cwd,
          operation: method.endsWith("commandExecution/requestApproval")
            ? { kind: "command", ...(command ? { command } : {}) }
            : { kind: "file-change" },
          decisions: ["allow-once", "deny"],
        };
        const answer = await context.requestInteraction!(request, rpc.endedSignal);
        if (context.signal.aborted) throw new Error("Codex 工具审批已随 Attempt 取消");
        if (answer.kind !== "approval") throw new Error("Codex 审批请求收到了问题答案");
        await context.recordEvent?.({ type: "interaction.forwarded", requestId: answer.interactionId, evidence: "codex-app-server-approval" });
        pendingInteractions.set(String(params.itemId ?? nativeId), answer.interactionId);
        await rpc.respond(id, { decision: answer.decision === "allow-once" ? "accept" : "decline" });
        return;
      }
      if (method === "item/permissions/requestApproval") {
        await context.recordEvent?.({ type: "runner.diagnostic", severity: "warning", code: "permission_expansion_unsupported", message: "Codex 请求扩大文件系统或网络权限；本版本拒绝此类请求" });
        await rpc.respondError(id, -32000, "Permission expansion is not supported by this Runner profile");
        return;
      }
      await rpc.respondError(id, -32601, `Unsupported app-server request: ${method}`);
      fatal = `不支持的 Codex app-server 请求：${method}`;
      throw new Error(fatal);
    };

    rpc.onNotification = async (message) => {
      const params = isObject(message.params) ? message.params : {};
      if (message.method === "error") {
        const error = normalizeNativeError(params.error);
        if (error) {
          lastError = error;
          await context.recordEvent?.({ type: "runner.diagnostic", severity: params.willRetry === true ? "warning" : "error",
            code: "codex_native_error", message: error.message, nativeError: error,
            ...(typeof params.willRetry === "boolean" ? { willRetry: params.willRetry } : {}),
            ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
            ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          });
        }
        return;
      }
      if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
        if (itemId) messageParts.set(itemId, `${messageParts.get(itemId) ?? ""}${params.delta}`);
        await context.recordEvent?.({ type: "message.delta", ...(itemId ? { messageId: itemId } : {}), text: params.delta, root: true });
        context.onOutput({ stream: "stdout", text: params.delta, agentText: params.delta, displayText: params.delta, structuredEvent: { type: "codex.message.delta", itemId } });
        return;
      }
      if (message.method === "item/started" || message.method === "item/completed") {
        const item = isObject(params.item) ? params.item : {};
        const itemId = typeof item.id === "string" ? item.id : undefined;
        if (typeof item.type === "string" && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item.type)) {
          const name = item.type;
          const command = typeof item.command === "string" ? item.command : undefined;
          const summary = command ?? (typeof item.title === "string" ? item.title : undefined);
          if (message.method === "item/started") await context.recordEvent?.({ type: "tool.started", ...(itemId ? { toolId: itemId } : {}), name, ...(summary ? { summary: redactInline(summary) } : {}) });
          else {
            const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
            await context.recordEvent?.({ type: "tool.completed", ...(itemId ? { toolId: itemId } : {}), name, ...(summary ? { summary: redactInline(summary) } : {}), ...(exitCode === undefined ? {} : { exitCode }) });
            if (item.type === "commandExecution") {
              await context.recordEvent?.({
                type: "command.completed", ...(itemId ? { toolId: itemId } : {}),
                ...(command ? { command: redactInline(command) } : {}),
                cwd: typeof item.cwd === "string" ? item.cwd : input.cwd,
                exitCode: exitCode ?? null,
                status: exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed",
                evidenceSource: "codex-app-server-item",
              });
            }
            const interactionId = itemId ? pendingInteractions.get(itemId) : undefined;
            if (interactionId) {
              await context.recordEvent?.({ type: "interaction.resolved", requestId: interactionId, evidence: typeof item.exitCode === "number" ? `tool_exit_${item.exitCode}` : "native_item_completed" });
              pendingInteractions.delete(itemId!);
            }
          }
        }
        if (message.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
          await context.recordEvent?.({ type: "message.completed", ...(itemId ? { messageId: itemId } : {}), text: item.text, root: true });
          context.onOutput({ stream: "stdout", text: "", finalText: item.text, displayText: "", structuredEvent: { type: "codex.message.completed", itemId } });
          if (Array.isArray(item.questions) && item.questions.length > 0) {
            const request = makeAsyncCodexQuestion(item.questions, itemId ?? "async-question");
            // Async questions are message items, not blocking JSON-RPC requests. Keep draining
            // notifications so a completed turn can be continued with the same Attempt owner.
            const answerTurnId = nativeTurnId;
            const pending = (async () => {
              const answer = await context.requestInteraction!(request, AbortSignal.any([rpc.endedSignal, asyncQuestionAbort.signal]));
              if (context.signal.aborted || asyncQuestionAbort.signal.aborted) throw new Error("Codex 异步问题已失效");
              if (answer.kind !== "question") throw new Error("Codex 异步问题收到了审批回复");
              const text = JSON.stringify({ answers: answer.answers.map((entry) => ({ question: request.questions!.find((q) => q.id === entry.questionId)!.text, answer: entry.text ?? entry.optionIds?.join(", ") ?? "" })) });
              if (!completed) {
                try {
                  await rpc.request("turn/steer", { threadId: nativeThreadId!, expectedTurnId: answerTurnId!, input: [{ type: "text", text }] });
                  await context.recordEvent?.({ type: "interaction.forwarded", requestId: answer.interactionId, evidence: "codex-app-server-turn-steer" });
                  await context.recordEvent?.({ type: "interaction.resolved", requestId: answer.interactionId, evidence: "native_turn_steered" });
                  return;
                } catch (error) {
                  await rpc.drainNotifications();
                  if (!completed) throw error;
                }
              }
              followUpAnswers.push({ text, interactionId: answer.interactionId });
            })().catch((error) => { if (!context.signal.aborted && !asyncQuestionAbort.signal.aborted) fatal ??= errorMessage(error); });
            asyncQuestions.add(pending);
          }
        }
        return;
      }
      if (message.method === "turn/completed") {
        const turn = isObject(params.turn) ? params.turn : {};
        const status = turn.status;
        nativeError = normalizeNativeError(turn.error) ?? (status === "failed" ? lastError : undefined);
        reason = nativeError?.message;
        outcome = status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : status === "failed" ? "failed" : "unknown";
        completed = true;
        await context.recordEvent?.({ type: "runner.native.finished", outcome, ...(reason ? { reason: redactInline(reason) } : {}) });
        rpc.markTurnCompleted({ outcome, ...(reason ? { reason } : {}) });
      }
    };

    try {
      rpc.onStarted = () => { started = true; context.onStarted(); };
      await rpc.start();
      await rpc.request("initialize", {
        clientInfo: { name: "token-coupon", title: "Token Coupon", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      await rpc.notify("initialized", {});
      const thread = await rpc.request("thread/start", {
        cwd: input.cwd,
        ephemeral: true,
        approvalPolicy: this.settings.approvalPolicy ?? "on-request",
        sandbox: this.settings.sandbox ?? "workspace-write",
        ...(input.execution.modelId ? { model: input.execution.modelId } : {}),
      });
      const threadInfo = isObject(thread.thread) ? thread.thread : {};
      if (typeof threadInfo.id !== "string") throw new Error("Codex app-server thread/start 没有返回 thread ID");
      const threadId = threadInfo.id;
      nativeThreadId = threadId;
      reportedModel = typeof thread.model === "string" ? thread.model : undefined;
      let nextInput = input.prompt;
      let pendingForwards: string[] = [];
      let followUpCount = 0;
      while (true) {
        completed = false;
        reason = undefined;
        nativeError = undefined;
        lastError = undefined;
        rpc.prepareTurn();
        const turnStart = await rpc.request("turn/start", { threadId, cwd: input.cwd, input: [{ type: "text", text: nextInput }] });
        const turn = isObject(turnStart.turn) ? turnStart.turn : {};
        if (typeof turn.id !== "string") throw new Error("Codex app-server turn/start 没有返回 turn ID");
        rpc.setActiveTurn(threadId, turn.id);
        nativeTurnId = turn.id;
        await context.recordEvent?.({ type: "runner.native.started", threadId, turnId: turn.id,
          ...(reportedModel ? { reportedModel } : {}),
          ...(typeof thread.modelProvider === "string" ? { modelProvider: thread.modelProvider } : {}),
        });
        for (const requestId of pendingForwards) {
          await context.recordEvent?.({ type: "interaction.forwarded", requestId, evidence: "codex-app-server-follow-up-turn" });
          await context.recordEvent?.({ type: "interaction.resolved", requestId, evidence: "native_follow_up_started" });
        }
        const nativeResult = await rpc.waitForTurn();
        outcome = nativeResult.outcome;
        reason ??= nativeResult.reason;
        if (!completed) await context.recordEvent?.({ type: "runner.native.finished", outcome, ...(reason ? { reason: redactInline(reason) } : {}) });
        if (outcome !== "completed") asyncQuestionAbort.abort(new Error("Codex 原生执行已失败或取消"));
        await Promise.all(asyncQuestions);
        asyncQuestions.clear();
        if (fatal) throw new Error(fatal);
        if (outcome !== "completed" || followUpAnswers.length === 0 || context.signal.aborted) break;
        if (++followUpCount > 8) throw new Error("Codex 异步问题续轮超过 8 次上限");
        const answers = followUpAnswers.splice(0);
        pendingForwards = answers.map((answer) => answer.interactionId);
        nextInput = `用户已回答本轮问题：\n${answers.map((answer) => answer.text).join("\n")}\n继续原任务；完成时精确输出标记：\n${input.completionMarker}`;
      }
      const closed = await rpc.closeAfterTurn();
      cleanupStatus = closed ? "completed" : "failed";
      if (!closed) fatal ??= "Codex app-server 未能在正常收尾期限内退出";
      if (closed && !await rpc.drainNotifications()) {
        fatal ??= "Codex app-server 语义事件队列未能排空";
        if (outcome === "completed") outcome = "failed";
      }
    } catch (error) {
      const message = errorMessage(error);
      fatal ??= message;
      if (context.signal.aborted) outcome = "cancelled";
      else if (outcome === "unknown") outcome = "failed";
      await context.recordEvent?.({ type: "runner.native.finished", outcome, reason: redactInline(message) }).catch(() => undefined);
      await context.recordEvent?.({ type: "runner.diagnostic", severity: "error", code: "codex_protocol_error", message: redactInline(message) }).catch(() => undefined);
      await rpc.terminate();
      cleanupStatus = await rpc.didClose() ? "completed" : "failed";
    } finally {
      asyncQuestionAbort.abort(new Error("Attempt 已结束"));
      context.signal.removeEventListener("abort", abort);
    }
    if (context.signal.aborted) outcome = "cancelled";
    const closedResult = await rpc.exitResult();
    return {
      started, exitCode: closedResult.exitCode, signal: closedResult.signal,
      transport: "app-server", nativeOutcome: outcome, cleanupStatus,
      ...(nativeThreadId ? { nativeThreadId } : {}), ...(nativeTurnId ? { nativeTurnId } : {}),
      ...(reportedModel ? { reportedModel } : {}), ...(nativeError ? { nativeError } : {}),
      ...(!started && closedResult.startError ? { startError: closedResult.startError } : {}),
      ...(fatal ? { executionError: fatal } : {}), ...(outcome === "failed" && reason ? { executionError: reason } : {}),
    };
  }
}

class CodexRpcConnection {
  onServerRequest?: (message: JsonObject) => Promise<void>;
  onNotification?: (message: JsonObject) => Promise<void>;
  onStarted?: () => void;
  private readonly decoder = new StringDecoder("utf8");
  private pendingText = "";
  private nextId = 1;
  private readonly responses = new Map<RpcId, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly turnWaiters: Array<{ resolve: (value: { outcome: NonNullable<RunnerResult["nativeOutcome"]>; reason?: string }) => void }> = [];
  private notificationQueue = Promise.resolve();
  private readonly endedController = new AbortController();
  private turnResult?: { outcome: NonNullable<RunnerResult["nativeOutcome"]>; reason?: string };
  private closed = false;
  private startError?: ProcessResultStartError;
  private exit?: { exitCode: number | null; signal: string | null };
  private fatal?: string;
  private activeThreadId?: string;
  private activeTurnId?: string;
  private closePromise: Promise<void>;
  private closeResolve!: () => void;
  private maxLineBytes = 4 * 1024 * 1024;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly context: RunnerContext) {
    this.closePromise = new Promise((resolve) => { this.closeResolve = resolve; });
    child.once("spawn", () => this.onStarted?.());
    child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text) context.onOutput({ stream: "stderr", text });
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (!this.exit) this.startError = { code: error.code ?? null, message: error.message };
      this.fail(error.message);
    });
    child.once("close", (exitCode, signal) => {
      const tail = this.decoder.end();
      if (tail) this.consume(tail);
      if (this.pendingText.trim()) { const finalLine = this.pendingText.replace(/\r$/, ""); this.pendingText = ""; this.dispatch(finalLine); }
      this.closed = true;
      this.endedController.abort(new Error("Codex app-server connection ended"));
      this.exit = { exitCode, signal };
      this.closeResolve();
      for (const [id, pending] of this.responses) { clearTimeout(pending.timer); pending.reject(new Error(`Codex app-server 连接已关闭（等待 RPC ${String(id)}）`)); }
      this.responses.clear();
      void this.drainNotifications().then((drained) => {
        if (!drained) this.fail("Codex app-server semantic event queue did not drain before connection close");
        if (!this.turnResult) this.finishTurn({ outcome: this.context.signal.aborted ? "cancelled" : "incomplete", ...(this.fatal ? { reason: this.fatal } : { reason: "app-server connection closed before turn/completed" }) });
      });
    });
  }

  get endedSignal(): AbortSignal { return this.endedController.signal; }

  async start(): Promise<void> {
    await this.waitSpawn();
  }

  async request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.closed) throw new Error("Codex app-server 已关闭");
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => { this.responses.delete(id); reject(new Error(`Codex app-server 请求超时：${method}`)); }, timeoutMs);
      timer.unref();
      this.responses.set(id, { resolve, reject, timer });
    });
    await this.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  async notify(method: string, params: JsonObject): Promise<void> { await this.send({ jsonrpc: "2.0", method, params }); }

  async respond(id: RpcId, result: JsonObject): Promise<void> { await this.send({ jsonrpc: "2.0", id, result }); }
  async respondError(id: RpcId, code: number, message: string): Promise<void> { await this.send({ jsonrpc: "2.0", id, error: { code, message } }); }

  async waitForTurn(): Promise<{ outcome: NonNullable<RunnerResult["nativeOutcome"]>; reason?: string }> {
    if (this.turnResult) return this.turnResult;
    return new Promise((resolve) => this.turnWaiters.push({ resolve }));
  }

  markTurnCompleted(result: { outcome: NonNullable<RunnerResult["nativeOutcome"]>; reason?: string }): void { this.finishTurn(result); }
  prepareTurn(): void { delete this.turnResult; delete this.activeTurnId; }
  setActiveTurn(threadId: string, turnId: string): void { this.activeThreadId = threadId; this.activeTurnId = turnId; }

  async closeAfterTurn(): Promise<boolean> {
    this.child.stdin.end();
    const exited = await waitFor(this.closePromise, 5_000);
    if (exited) return true;
    await this.terminate();
    return waitFor(this.closePromise, 2_000);
  }

  async drainNotifications(timeoutMs = 2_000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const drained = await Promise.race([this.notificationQueue.then(() => true as const), timeout]);
    if (timer) clearTimeout(timer);
    return drained;
  }

  async interruptAndTerminate(): Promise<void> {
    try {
      if (!this.closed && this.activeThreadId && this.activeTurnId) {
        await this.request("turn/interrupt", { threadId: this.activeThreadId, turnId: this.activeTurnId }, 1_000).catch(() => undefined);
      }
    } finally {
      await this.terminate();
    }
  }

  async terminate(): Promise<void> {
    if (this.closed) return;
    try {
      if (process.platform !== "win32" && this.child.pid !== undefined) process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch { /* already exited */ }
    if (await waitFor(this.closePromise, 1_000)) return;
    try {
      if (process.platform !== "win32" && this.child.pid !== undefined) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch { /* already exited */ }
  }

  async didClose(): Promise<boolean> { return this.closed || waitFor(this.closePromise, 100); }
  async exitResult(): Promise<{ exitCode: number | null; signal: string | null; startError?: ProcessResultStartError }> { await waitFor(this.closePromise, 100); return { ...(this.exit ?? { exitCode: null, signal: null }), ...(this.startError ? { startError: this.startError } : {}) }; }

  private async send(value: JsonObject): Promise<void> {
    if (this.closed || !this.child.stdin.writable) throw new Error("Codex app-server stdin 已关闭");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(value)}\n`, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  private consume(text: string): void {
    this.pendingText += text;
    let newline: number;
    while ((newline = this.pendingText.indexOf("\n")) >= 0) {
      const line = this.pendingText.slice(0, newline).replace(/\r$/, "");
      this.pendingText = this.pendingText.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) { this.fail("Codex app-server JSONL 行超过 4 MiB"); return; }
      if (line) this.dispatch(line);
    }
    if (Buffer.byteLength(this.pendingText, "utf8") > this.maxLineBytes) this.fail("Codex app-server JSONL 行超过 4 MiB");
  }

  private dispatch(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line) as unknown; } catch { this.fail("Codex app-server 返回非法 JSON"); return; }
    if (!isObject(raw)) { this.fail("Codex app-server 返回的 JSON 根值不是对象"); return; }
    if ("id" in raw && ("result" in raw || "error" in raw) && !("method" in raw)) {
      const pending = this.responses.get(raw.id as RpcId);
      if (!pending) return;
      this.responses.delete(raw.id as RpcId);
      clearTimeout(pending.timer);
      if (isObject(raw.error)) pending.reject(new Error(typeof raw.error.message === "string" ? raw.error.message : "Codex app-server 请求失败"));
      else pending.resolve(isObject(raw.result) ? raw.result : {});
      return;
    }
    if ("method" in raw && "id" in raw) {
      void Promise.resolve(this.onServerRequest?.(raw)).catch(async (error) => {
        const message = errorMessage(error);
        this.fail(message);
        await this.respond(raw.id as RpcId, { error: { code: -32000, message: "Request handling failed" } }).catch(() => undefined);
      });
      return;
    }
    if (typeof raw.method === "string") {
      this.notificationQueue = this.notificationQueue.then(() => this.onNotification?.(raw)).then(() => undefined).catch((error) => { this.fail(errorMessage(error)); });
    }
  }

  private fail(message: string): void {
    this.fatal ??= message;
    this.finishTurn({ outcome: "failed", reason: message });
    if (!this.closed) void this.terminate();
  }

  private finishTurn(result: { outcome: NonNullable<RunnerResult["nativeOutcome"]>; reason?: string }): void {
    if (this.turnResult) return;
    this.turnResult = result;
    for (const waiter of this.turnWaiters.splice(0)) waiter.resolve(result);
  }

  private waitSpawn(): Promise<void> {
    if (this.child.pid !== undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.child.once("spawn", () => resolve());
      this.child.once("error", (error) => reject(error));
    });
  }
}

type ProcessResultStartError = { code: string | null; message: string };

function makeCodexQuestion(params: JsonObject, nativeRequestId: string): RunnerInteractionRequest {
  if (!Array.isArray(params.questions) || params.questions.length === 0) throw new Error("Codex request_user_input 没有问题列表");
  const questions = params.questions.map((raw, index) => {
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.question !== "string") throw new Error(`Codex 问题 ${index + 1} 结构无效`);
    const options = Array.isArray(raw.options) ? raw.options.flatMap((option) => isObject(option) && typeof option.label === "string"
      ? [{ id: option.label, label: option.label }] : []) : [];
    return {
      id: raw.id, text: raw.question, ...(typeof raw.header === "string" ? { header: raw.header } : {}),
      ...(options.length ? { options } : {}), required: true, multiple: false,
      allowFreeText: raw.isOther === true, ...(raw.isSecret === true ? { secret: true } : {}),
    };
  });
  return { kind: "question", nativeRequestId, title: "Codex 需要补充信息", summary: questions.map((item) => item.text).join("\n"), questions };
}

function makeAsyncCodexQuestion(rawQuestions: unknown[], nativeRequestId: string): RunnerInteractionRequest {
  const questions = rawQuestions.map((raw, index) => {
    if (!isObject(raw) || typeof raw.title !== "string" || !raw.title.trim()) throw new Error("Codex 异步问题格式无效");
    const options = Array.isArray(raw.options) ? raw.options.filter((value): value is string => typeof value === "string").map((label) => ({ id: label, label })) : [];
    return { id: `${nativeRequestId}:${index + 1}`, text: raw.title, required: true, allowFreeText: true, ...(options.length ? { options } : {}) };
  });
  return { kind: "question", nativeRequestId, title: "Codex 需要补充信息", summary: questions.map((q) => q.text).join("\n"), questions };
}

async function findExecutable(name: string): Promise<string> {
  if (name.includes("/") || name.includes("\\")) {
    await access(name, constants.X_OK);
    return name;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue PATH lookup */ }
  }
  throw new Error(`找不到 ${name} 可执行文件，请先安装并登录 Codex CLI`);
}

function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function errorCode(error: unknown): string | null { return isObject(error) && typeof error.code === "string" ? error.code : null; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redactInline(value: string): string { return value.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]").replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)["']?\s*[:=]\s*["']?)\S+/gi, "$1[REDACTED]").slice(0, 2048); }
function normalizeNativeError(value: unknown): RunnerNativeError | undefined {
  if (typeof value === "string") return { message: redactInline(value) };
  if (!isObject(value) || typeof value.message !== "string") return undefined;
  const info = value.codexErrorInfo;
  const code = typeof info === "string" ? info : isObject(info) ? Object.keys(info)[0] : undefined;
  const details = typeof value.additionalDetails === "string" ? redactInline(value.additionalDetails) : undefined;
  const variant = code && isObject(info) && isObject(info[code]) ? info[code] : undefined;
  const httpStatus = variant && typeof variant.httpStatusCode === "number" ? variant.httpStatusCode : undefined;
  return { message: redactInline(value.message), ...(code ? { code: redactInline(code) } : {}), ...(details ? { details } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}) };
}
function hasPermissionExpansion(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(hasPermissionExpansion);
  return true;
}
async function waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref(); });
  const result = await Promise.race([promise.then(() => true as const), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
