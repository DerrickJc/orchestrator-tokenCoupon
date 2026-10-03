import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RunnerContext, ProcessResult, RunnerOutput } from "../runner.js";

export interface ChildProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  input: string;
  context: RunnerContext;
  onOutput?: (output: RunnerOutput) => void;
  terminationGraceMs?: number;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

export function runChildProcess(options: ChildProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ started: false, exitCode: null, signal: null, startError: { code: errorCode(error), message: String(error) } });
      return;
    }

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let started = false;
    let settled = false;
    let startError: ProcessResult["startError"];
    let executionError: string | undefined;
    let terminationError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const emit = (stream: "stdout" | "stderr", text: string) => {
      if (!text) return;
      try {
        options.onOutput?.({ stream, text });
      } catch (error) {
        executionError ??= `输出处理失败：${String(error)}`;
      }
    };
    const flushDecoders = () => {
      emit("stdout", stdoutDecoder.end());
      emit("stderr", stderrDecoder.end());
    };
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (errorCode(error) !== "ESRCH") terminationError ??= `发送 ${signal} 失败：${String(error)}`;
      }
    };

    child.once("spawn", () => {
      started = true;
      options.context.onStarted();
      if (options.context.signal.aborted) abortListener?.();
    });
    child.stdout?.on("data", (chunk: Buffer) => emit("stdout", stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => emit("stderr", stderrDecoder.write(chunk)));
    child.stdin?.on("error", (error: Error) => { executionError ??= `写入 Runner stdin 失败：${error.message}`; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (!started) startError = { code: error.code ?? null, message: error.message };
      else executionError ??= error.message;
    });

    abortListener = () => {
      if (settled || killTimer !== undefined) return;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), options.terminationGraceMs ?? 1000);
      killTimer.unref();
    };
    options.context.signal.addEventListener("abort", abortListener, { once: true });
    if (options.context.signal.aborted) abortListener();

    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (abortListener !== undefined) options.context.signal.removeEventListener("abort", abortListener);
      flushDecoders();
      resolve({ started, exitCode, signal, ...(startError ? { startError } : {}), ...(executionError ? { executionError } : {}), ...(terminationError ? { terminationError } : {}) });
    });

    child.stdin?.end(options.input, "utf8");
  });
}
