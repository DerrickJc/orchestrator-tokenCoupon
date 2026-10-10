import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "@token-coupon/core";

const INITIAL_READ_LIMIT = 2 * 1024 * 1024;
const FOLLOW_READ_LIMIT = 256 * 1024;
const DISPLAY_EVENT_LIMIT = 200;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
interface LogEvent extends Record<string, unknown> {
  sequence: number;
  timestamp: string;
  attemptId: string;
  type: string;
  payload: unknown;
}

interface LogReader {
  taskId: string;
  attemptId: string;
  path: string;
  position: number;
  carry: Buffer;
}

export interface SessionLogsOptions {
  workspace: string;
  sessionId: string;
  taskId?: string;
  attemptId?: string;
  follow?: boolean;
  raw?: boolean;
  json?: boolean;
  signal?: AbortSignal;
  output: (line: string) => void;
}

export async function showSessionLogs(options: SessionLogsOptions): Promise<void> {
  if (options.follow && !options.signal) throw new Error("session logs --follow 需要可取消的 owner signal");
  const session = await new SessionStore(options.workspace).load(options.sessionId);
  const taskStates = options.taskId
    ? session.snapshot.tasks.filter((task) => task.taskId === options.taskId)
    : session.snapshot.tasks;
  if (options.taskId && taskStates.length === 0) throw new Error(`Session 不包含任务：${options.taskId}`);
  const refs = taskStates.flatMap((task) => task.attempts.map((attempt) => ({ taskId: task.taskId, attempt })));
  const selected = options.attemptId ? refs.filter(({ attempt }) => attempt.attemptId === options.attemptId) : refs;
  if (options.attemptId && selected.length === 0) throw new Error("Attempt 不属于该 Session 或所选任务");
  if (selected.length === 0) {
    options.output("当前 Session 尚无可读取的 Attempt 日志。");
    return;
  }

  const readers = selected.map(({ taskId, attempt }) => ({
    taskId,
    attemptId: attempt.attemptId,
    path: join(attempt.artifactDir, "events.jsonl"),
    position: 0,
    carry: Buffer.alloc(0),
  } satisfies LogReader));
  if (options.json) options.output(JSON.stringify({ sessionId: options.sessionId, attempts: readers.map(({ taskId, attemptId }) => ({ taskId, attemptId })) }));
  else options.output(`Session ${options.sessionId} · ${readers.length} 个 Attempt 日志${options.follow ? "（跟随中，Ctrl-C 退出）" : ""}`);

  for (const reader of readers) {
    const initial = await readInitialEvents(reader);
    if (options.json) {
      for (const event of initial.events) emitJson(options.output, event, options.raw === true);
    } else {
      options.output(`\n[${reader.taskId}#${reader.attemptId.slice(0, 8)}]`);
      for (const event of initial.events) emitHuman(options.output, event, options.raw === true);
      if (initial.damagedLines > 0) options.output(`  [${initial.damagedLines} 条日志行无法解析]`);
      if (initial.partialLine && !options.follow) options.output("  [日志末行尚未写完；使用 --follow 等待其完成]");
    }
  }
  if (!options.follow) return;

  while (!options.signal?.aborted) {
    await sleep(300, options.signal);
    for (const reader of readers) {
      const events = await readAppendedEvents(reader);
      for (const event of events) {
        if (options.json) emitJson(options.output, event, options.raw === true);
        else emitHuman(options.output, event, options.raw === true, `[${reader.taskId}#${reader.attemptId.slice(0, 8)}]`);
      }
    }
  }
}

async function readInitialEvents(reader: LogReader): Promise<{ events: LogEvent[]; damagedLines: number; partialLine: boolean }> {
  const info = await safeStat(reader.path);
  if (!info) return { events: [], damagedLines: 0, partialLine: false };
  const start = Math.max(0, info.size - INITIAL_READ_LIMIT);
  const handle = await open(reader.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    reader.position = info.size;
    let bytes = buffer.subarray(0, bytesRead);
    if (start > 0) {
      const firstNewline = bytes.indexOf(0x0a);
      bytes = firstNewline === -1 ? Buffer.alloc(0) : bytes.subarray(firstNewline + 1);
    }
    const lines = splitLines(bytes);
    reader.carry = lines.carry;
    if (reader.carry.length > MAX_LINE_BYTES) throw new Error("Attempt 日志单行超过 4 MiB 上限");
    const parsed = parseLines(lines.complete, reader.attemptId);
    return { events: parsed.events.slice(-DISPLAY_EVENT_LIMIT), damagedLines: parsed.damagedLines, partialLine: reader.carry.length > 0 };
  } finally { await handle.close(); }
}

async function readAppendedEvents(reader: LogReader): Promise<LogEvent[]> {
  const info = await safeStat(reader.path);
  if (!info || info.size === reader.position) return [];
  if (info.size < reader.position) {
    reader.position = 0;
    reader.carry = Buffer.alloc(0);
  }
  const handle = await open(reader.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const length = Math.min(FOLLOW_READ_LIMIT, Math.max(0, info.size - reader.position));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, reader.position);
    reader.position += bytesRead;
    const lines = splitLines(Buffer.concat([reader.carry, buffer.subarray(0, bytesRead)]));
    reader.carry = lines.carry;
    if (reader.carry.length > MAX_LINE_BYTES) throw new Error("Attempt 日志单行超过 4 MiB 上限");
    return parseLines(lines.complete, reader.attemptId).events;
  } finally { await handle.close(); }
}

async function safeStat(path: string) {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Attempt 日志不是普通文件或为符号链接");
  return info;
}

function splitLines(buffer: Buffer): { complete: Buffer[]; carry: Buffer } {
  const complete: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    complete.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return { complete, carry: buffer.subarray(start) };
}

function parseLines(lines: Buffer[], attemptId: string): { events: LogEvent[]; damagedLines: number } {
  const events: LogEvent[] = [];
  let damagedLines = 0;
  for (const line of lines) {
    if (!line.length) continue;
    try {
      const value = JSON.parse(line.toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) { damagedLines += 1; continue; }
      const event = value as Record<string, unknown>;
      if (!Number.isSafeInteger(event.sequence) || typeof event.timestamp !== "string" || event.attemptId !== attemptId || typeof event.type !== "string") { damagedLines += 1; continue; }
      events.push({ ...event, sequence: event.sequence as number, timestamp: event.timestamp, attemptId, type: event.type, payload: event.payload });
    } catch { damagedLines += 1; }
  }
  return { events, damagedLines };
}

function emitJson(output: (line: string) => void, event: LogEvent, raw: boolean): void {
  if (event.type === "runner.output" && !raw) return;
  output(JSON.stringify(event));
}

function emitHuman(output: (line: string) => void, event: LogEvent, raw: boolean, prefix = ""): void {
  if (event.type === "runner.output" && !raw) return;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
  const suffix = event.type === "attempt.finished" || event.type === "attempt.recovered" ? ` ${String(payload.status ?? "")}${payload.reasonCode ? ` (${String(payload.reasonCode)})` : ""}`
    : event.type === "runner.diagnostic" ? ` ${String(payload.severity ?? "")}: ${String(payload.message ?? "")}`
      : event.type === "message.completed" ? ` ${truncate(String(payload.text ?? ""), 280)}`
        : event.type === "runner.native.started" ? ` thread=${String(payload.threadId ?? "unknown")} turn=${String(payload.turnId ?? "unknown")} model=${String(payload.reportedModel ?? "unknown")}`
          : event.type === "runner.native.finished" ? ` ${String(payload.outcome ?? "unknown")}${payload.reason ? ` ${String(payload.reason)}` : ""}`
        : event.type.startsWith("interaction.") ? ` ${String(payload.requestId ?? "")} ${String(payload.kind ?? payload.reason ?? "")}`
          : event.type.startsWith("tool.") ? ` ${String(payload.name ?? "")} ${truncate(String(payload.summary ?? ""), 180)}${payload.exitCode === undefined ? "" : ` exit=${String(payload.exitCode)}`}`
            : event.type === "command.completed" ? ` ${String(payload.command ?? "命令未知")} cwd=${String(payload.cwd ?? "未知")} exit=${payload.exitCode === null || payload.exitCode === undefined ? "unknown" : String(payload.exitCode)} status=${String(payload.status ?? "unknown")}`
              : event.type === "runner.output" ? ` ${String(payload.stream ?? "")} ${truncate(String(payload.text ?? ""), 280)}`
                : "";
  output(`${prefix} ${event.sequence} ${event.timestamp} ${event.type}${suffix}`.trim());
}

function truncate(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}…` : value; }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
