import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { diagnoseNativeCli } from "../runner-diagnostics.js";
import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Runner, RunnerContext, RunnerInput, RunnerInteractionRequest, RunnerResult } from "../runner.js";

export interface ClaudeManagedSettings {
  permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk";
  allowedTools?: string[];
  disallowedTools?: string[];
}

async function findExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue PATH lookup */ }
  }
  throw new Error(`找不到 ${name} 可执行文件，请先安装并登录 Claude Code`);
}

export class ClaudeManagedRunner implements Runner {
  readonly id = "claude-code";
  readonly supportsModel = true;

  constructor(private readonly settings: ClaudeManagedSettings = {}) {}

  async checkAvailable(): Promise<void> { await findExecutable("claude"); }
  async diagnose(cwd: string) { return diagnoseNativeCli(await findExecutable("claude"), "claude-code", cwd); }

  async run(input: RunnerInput, context: RunnerContext): Promise<RunnerResult> {
    if (!context.requestInteraction) throw new Error("Claude managed 模式缺少人工交互 owner");
    await findExecutable("claude");
    const abortController = new AbortController();
    let started = false;
    let nativeOutcome: RunnerResult["nativeOutcome"] = "unknown";
    let resultSeen = false;
    let executionError: string | undefined;
    let cleanupStatus: RunnerResult["cleanupStatus"] = "completed";
    let query: ReturnType<typeof claudeQuery> | undefined;
    const closeQuery = () => {
      try { query?.close(); }
      catch (error) {
        cleanupStatus = "failed";
        executionError ??= `Claude SDK 清理失败：${error instanceof Error ? error.message : String(error)}`;
      }
    };
    const cancel = () => abortController.abort(context.signal.reason);
    const cancelAndClose = () => { cancel(); closeQuery(); };
    if (context.signal.aborted) cancelAndClose();
    else context.signal.addEventListener("abort", cancelAndClose, { once: true });
    const toolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
    const canUseTool: CanUseTool = async (toolName, toolInput, options): Promise<PermissionResult> => {
      if (abortController.signal.aborted) return { behavior: "deny", message: "Task cancelled", interrupt: true };
      const isQuestion = toolName === "AskUserQuestion";
      const request = isQuestion
        ? makeQuestionRequest(toolInput, options.toolUseID)
        : makeApprovalRequest(toolName, toolInput, options.toolUseID, input.cwd);
      if (isQuestion && request === undefined) return { behavior: "deny", message: "Unsupported AskUserQuestion payload", interrupt: false };
      if (!isQuestion && request === undefined) return { behavior: "deny", message: "Unsupported tool approval payload", interrupt: false };
      context.onActivity?.();
      await context.recordEvent?.({ type: "runner.diagnostic", severity: "info", code: isQuestion ? "user_input_requested" : "tool_approval_requested", message: request!.title });
      const answer = await context.requestInteraction!(request!, options.signal);
      if (abortController.signal.aborted) return { behavior: "deny", message: "Task cancelled", interrupt: true };
      await context.recordEvent?.({ type: "interaction.forwarded", requestId: answer.interactionId, evidence: "claude-sdk-can-use-tool" });
      if (answer.kind === "approval") {
        return answer.decision === "allow-once"
          ? { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID }
          : { behavior: "deny", message: "User denied this tool call", interrupt: false, toolUseID: options.toolUseID };
      }
      const answers: Record<string, string> = {};
      for (const item of answer.answers) answers[item.questionId] = item.text ?? item.optionIds?.join(", ") ?? "";
      return { behavior: "allow", updatedInput: { ...toolInput, answers }, toolUseID: options.toolUseID };
    };

    query = claudeQuery({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        ...(input.execution.modelId ? { model: input.execution.modelId } : {}),
        permissionMode: this.settings.permissionMode ?? "default",
        ...(this.settings.allowedTools ? { allowedTools: this.settings.allowedTools } : {}),
        ...(this.settings.disallowedTools ? { disallowedTools: this.settings.disallowedTools } : {}),
        settingSources: ["user", "project"],
        persistSession: false,
        abortController,
        canUseTool,
      },
    });
    if (abortController.signal.aborted) closeQuery();
    try {
      if (!abortController.signal.aborted) {
        for await (const message of query) {
          if (!started) { started = true; context.onStarted(); }
          await recordClaudeMessage(message, context, toolCalls, input.cwd);
          if (message.type === "result") {
            resultSeen = true;
            if (message.is_error || message.subtype !== "success") {
              nativeOutcome = "failed";
              executionError = message.subtype;
              await context.recordEvent?.({ type: "runner.native.finished", outcome: "failed", reason: message.subtype });
            } else {
              nativeOutcome = "completed";
              await context.recordEvent?.({ type: "runner.native.finished", outcome: "completed" });
            }
            if (Array.isArray(message.permission_denials) && message.permission_denials.length > 0) {
              await context.recordEvent?.({ type: "runner.diagnostic", severity: "warning", code: "tool_permission_denied", message: `${message.permission_denials.length} 个 Claude 工具请求被拒绝` });
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (abortController.signal.aborted) {
        nativeOutcome = "cancelled";
        await context.recordEvent?.({ type: "runner.native.finished", outcome: "cancelled", reason: "cancelled" });
      } else {
        nativeOutcome = "failed";
        executionError = message;
        await context.recordEvent?.({ type: "runner.native.finished", outcome: "failed", reason: redact(message) });
      }
    } finally {
      context.signal.removeEventListener("abort", cancelAndClose);
      closeQuery();
    }
    if (abortController.signal.aborted && nativeOutcome === "unknown") {
      nativeOutcome = "cancelled";
      await context.recordEvent?.({ type: "runner.native.finished", outcome: "cancelled", reason: "cancelled" });
    }
    if (!resultSeen && nativeOutcome === "unknown" && !abortController.signal.aborted) {
      nativeOutcome = "incomplete";
      executionError ??= "Claude SDK query ended without a final result";
      await context.recordEvent?.({ type: "runner.native.finished", outcome: "incomplete", reason: executionError });
    }
    if (!started) executionError ??= "Claude SDK query ended before its first event";
    return {
      started,
      exitCode: nativeOutcome === "completed" ? null : nativeOutcome === "failed" || nativeOutcome === "incomplete" ? 1 : null,
      signal: abortController.signal.aborted ? "ABORTED" : null,
      transport: "sdk", nativeOutcome, cleanupStatus,
      ...(executionError ? { executionError } : {}),
    };
  }
}

async function recordClaudeMessage(message: SDKMessage, context: RunnerContext, toolCalls: Map<string, { name: string; input: Record<string, unknown> }>, cwd: string): Promise<void> {
  if (message.type === "assistant") {
    const root = message.parent_tool_use_id === null;
    for (const block of message.message.content) {
      if (block.type === "text") {
        await context.recordEvent?.({ type: "message.completed", messageId: message.message.id, text: block.text, root });
        if (root) {
          context.onOutput({ stream: "stdout", text: block.text, agentText: block.text, displayText: block.text, structuredEvent: { type: "assistant", root, messageId: message.message.id } });
        }
      } else if (block.type === "tool_use") {
        toolCalls.set(block.id, { name: block.name, input: isObject(block.input) ? block.input : {} });
        const summary = summarizeToolInput(block.input);
        await context.recordEvent?.({ type: "tool.started", toolId: block.id, name: block.name, ...(summary ? { summary } : {}) });
      }
    }
    return;
  }
  if (message.type === "result") {
    context.onOutput({ stream: "stdout", text: "", ...(message.subtype === "success" ? { finalText: message.result } : {}), displayText: "", structuredEvent: { type: "result", subtype: message.subtype, isError: message.is_error } });
    return;
  }
  if (message.type === "user") {
    for (const block of message.message.content) {
      if (typeof block === "string") continue;
      if (block.type === "tool_result") {
        const call = toolCalls.get(block.tool_use_id);
        const result = isObject(message.tool_use_result) ? message.tool_use_result : undefined;
        const exitCode = result && typeof result.exitCode === "number" ? result.exitCode : result && typeof result.exit_code === "number" ? result.exit_code : undefined;
        const summary = summarizeToolOutput(block.content);
        await context.recordEvent?.({ type: "tool.completed", toolId: block.tool_use_id, name: call?.name ?? "unknown", ...(summary ? { summary } : {}), ...(exitCode === undefined ? {} : { exitCode }) });
        if (call?.name === "Bash") {
          const command = typeof call.input.command === "string" ? redact(call.input.command).slice(0, 2048) : undefined;
          await context.recordEvent?.({
            type: "command.completed", toolId: block.tool_use_id,
            ...(command ? { command } : {}), cwd: typeof call.input.cwd === "string" ? call.input.cwd : cwd,
            exitCode: exitCode ?? null,
            status: block.is_error ? "failed" : exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed",
            evidenceSource: "claude-sdk-tool-result", ...(summary ? { outputSummary: summary } : {}),
          });
        }
        toolCalls.delete(block.tool_use_id);
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeToolOutput(value: unknown): string | undefined {
  const text = typeof value === "string" ? value
    : Array.isArray(value) ? value.flatMap((item) => isObject(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n")
      : undefined;
  if (!text) return undefined;
  const safe = redact(text.replace(/\s+/g, " ").trim());
  return safe.length > 512 ? `${safe.slice(0, 512)}…` : safe;
}

function makeApprovalRequest(toolName: string, input: Record<string, unknown>, nativeRequestId: string, cwd: string): RunnerInteractionRequest | undefined {
  const command = typeof input.command === "string" ? input.command : undefined;
  const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  return {
    kind: "approval", nativeRequestId, title: `Claude 请求批准 ${toolName}`,
    summary: summarizeToolInput(input) ?? toolName, cwd,
    operation: { kind: command ? "command" : filePath ? "file-change" : "other", ...(command ? { command } : {}), ...(filePath ? { paths: [filePath] } : {}) },
    decisions: ["allow-once", "deny"],
  };
}

function makeQuestionRequest(input: Record<string, unknown>, nativeRequestId: string): RunnerInteractionRequest | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  const questions = input.questions.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.question !== "string") return [];
    const options = Array.isArray(item.options) ? item.options.flatMap((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) return [];
      const row = option as Record<string, unknown>;
      return typeof row.label === "string" ? [{ id: row.label, label: row.label }] : [];
    }) : undefined;
    return [{ id: item.question, text: item.question, ...(typeof item.header === "string" ? { header: item.header } : {}), ...(options?.length ? { options } : {}), multiple: item.multiSelect === true, required: true, allowFreeText: true }];
  });
  if (questions.length !== input.questions.length) return undefined;
  return { kind: "question", nativeRequestId, title: "Claude 需要补充信息", summary: "请回答以下问题", questions };
}

function summarizeToolInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  try {
    const text = JSON.stringify(redactUnknown(input));
    return text.length > 512 ? `${text.slice(0, 512)}…` : text;
  } catch { return undefined; }
}

function redactUnknown(value: unknown, key = ""): unknown {
  if (/api[-_]?key|token|secret|password|credential/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactUnknown(item, childKey)]));
  return value;
}

function redact(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[-_]?key|token|password|secret)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}
