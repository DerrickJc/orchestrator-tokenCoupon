import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Runner, RunnerInput, RunnerContext, RunnerOutput } from "../runner.js";
import { runChildProcess } from "./child-process.js";

async function findExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue PATH lookup */ }
  }
  throw new Error(`找不到 ${name} 可执行文件，请先安装并登录 Claude Code`);
}

export class ClaudeCodeRunner implements Runner {
  readonly id = "claude-code";
  readonly supportsModel = true;

  constructor(private readonly permissionMode?: "acceptEdits") {}

  async checkAvailable(): Promise<void> { await findExecutable("claude"); }

  async run(input: RunnerInput, context: RunnerContext) {
    const executable = await findExecutable("claude");
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence"];
    if (this.permissionMode) args.push("--permission-mode", this.permissionMode);
    if (input.execution.modelId) args.push("--model", input.execution.modelId);
    const maxEventLineChars = 4 * 1024 * 1024;
    let pending = "";
    let discardingLongLine = false;
    const output = (line: string, stream: "stdout" | "stderr") => {
      if (stream === "stderr") { if (line) context.onOutput({ stream, text: `${line}\n` }); return; }
      let event: unknown;
      try { event = JSON.parse(line) as unknown; } catch {
        context.onOutput({ stream, text: `${line}\n` });
        return;
      }
      const record = event as { type?: string; subtype?: string; result?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
      const deltaText = record.type === "stream_event" && record.event?.type === "content_block_delta" && record.event.delta?.type === "text_delta"
        ? record.event.delta.text
        : undefined;
      const isTextDelta = deltaText !== undefined;
      const text = isTextDelta
        ? deltaText
        : record.type === "result" ? record.result ?? "" : "";
      const out: RunnerOutput = {
        stream,
        text: `${line}\n`,
        structuredEvent: event,
        ...(text ? { agentText: text } : {}),
        ...(record.type === "result" ? { displayText: "" } : isTextDelta ? { displayText: text } : {}),
      };
      context.onOutput(out);
    };
    const parseStdout = (text: string) => {
      let remaining = text;
      while (remaining.length > 0) {
        if (discardingLongLine) {
          const newline = remaining.indexOf("\n");
          if (newline === -1) {
            context.onOutput({ stream: "stdout", text: remaining });
            return;
          }
          context.onOutput({ stream: "stdout", text: `${remaining.slice(0, newline + 1)}` });
          remaining = remaining.slice(newline + 1);
          discardingLongLine = false;
          continue;
        }

        const newline = remaining.indexOf("\n");
        if (newline === -1) {
          if (pending.length + remaining.length > maxEventLineChars) {
            context.onOutput({ stream: "stdout", text: pending + remaining });
            pending = "";
            discardingLongLine = true;
          } else pending += remaining;
          return;
        }
        const segment = remaining.slice(0, newline);
        if (pending.length + segment.length > maxEventLineChars) {
          context.onOutput({ stream: "stdout", text: `${pending}${segment}\n` });
        } else output(`${pending}${segment}`.replace(/\r$/, ""), "stdout");
        pending = "";
        remaining = remaining.slice(newline + 1);
      }
    };

    return runChildProcess({
      executable, args, cwd: input.cwd, input: input.prompt, context,
      onOutput: (chunk) => {
        if (chunk.stream === "stderr") { context.onOutput(chunk); return; }
        parseStdout(chunk.text);
      },
    }).then((result) => {
      if (pending) output(pending, "stdout");
      return result;
    });
  }
}
