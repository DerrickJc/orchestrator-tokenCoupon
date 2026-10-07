import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface WorktreeSetupCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WorktreeSetupProfile {
  schemaVersion: 1;
  commands: WorktreeSetupCommand[];
}

export interface WorktreeSetupResult {
  commandIndex: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export function parseWorktreeSetupProfile(value: unknown): WorktreeSetupProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("setup 配置必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.commands) || raw.commands.length > 16) throw new Error("setup 配置必须使用 schemaVersion 1，且最多包含 16 条命令");
  const commands = raw.commands.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`setup.commands[${index}] 必须是对象`);
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["executable", "args", "env"].includes(key)) ||
        typeof item.executable !== "string" || !item.executable.trim() || item.executable.includes("\0") ||
        !Array.isArray(item.args) || item.args.length > 128 || item.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 8 * 1024)) {
      throw new Error(`setup.commands[${index}] 必须包含 executable 和 argv 数组；不支持 shell 字符串`);
    }
    let env: Record<string, string> | undefined;
    if (item.env !== undefined) {
      if (!item.env || typeof item.env !== "object" || Array.isArray(item.env)) throw new Error(`setup.commands[${index}].env 必须是对象`);
      env = {};
      for (const [key, entry] of Object.entries(item.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 8 * 1024) {
          throw new Error(`setup.commands[${index}].env 包含无效环境变量`);
        }
        env[key] = entry;
      }
    }
    return { executable: item.executable, args: item.args as string[], ...(env === undefined ? {} : { env }) };
  });
  return { schemaVersion: 1, commands };
}

export function worktreeSetupHash(profile: WorktreeSetupProfile): string {
  return createHash("sha256").update(JSON.stringify(profile), "utf8").digest("hex");
}

export async function runWorktreeSetup(profile: WorktreeSetupProfile, cwd: string, signal?: AbortSignal): Promise<WorktreeSetupResult[]> {
  const results: WorktreeSetupResult[] = [];
  for (const [commandIndex, command] of profile.commands.entries()) {
    if (signal?.aborted) throw new Error("setup_cancelled：环境准备已取消");
    const startedAt = new Date().toISOString();
    const result = await runSetupCommand(command, cwd, signal);
    const finishedAt = new Date().toISOString();
    const record = { commandIndex, ...result, startedAt, finishedAt };
    results.push(record);
    if (result.exitCode !== 0 || result.signal !== null) {
      throw Object.assign(new Error(`setup_command_failed：setup 命令 ${commandIndex + 1} 退出码 ${result.exitCode ?? "无"}（输出 ${result.stdoutBytes + result.stderrBytes} 字节）`), { setupResults: results });
    }
  }
  return results;
}

function runSetupCommand(command: WorktreeSetupCommand, cwd: string, signal?: AbortSignal): Promise<Omit<WorktreeSetupResult, "commandIndex" | "startedAt" | "finishedAt">> {
  return new Promise((resolveResult, reject) => {
    const child: ChildProcess = spawn(command.executable, command.args, {
      cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...command.env },
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`setup_command_spawn_failed：无法启动 ${command.executable}：${error.message}`));
    });
    child.once("close", (code, childSignal) => {
      signal?.removeEventListener("abort", abort);
      resolveResult({ exitCode: code, signal: childSignal, stdoutBytes, stderrBytes });
    });
  });
}
