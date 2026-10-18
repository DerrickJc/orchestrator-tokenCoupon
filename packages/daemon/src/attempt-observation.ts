import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function attemptDirectory(workspace: string, attemptId: string) {
  if (!UUID.test(attemptId)) throw new Error("attempt_id_invalid");
  let path = workspace;
  for (const segment of [".token-coupon", "runs", attemptId]) {
    path = join(path, segment);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("attempt_path_invalid：运行记录目录不可为符号链接");
  }
  return path;
}

export async function readAttemptInfo(workspace: string, attemptId: string) {
  const path = join(await attemptDirectory(workspace, attemptId), "attempt.json");
  if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error("attempt_path_invalid");
  if ((await lstat(path)).size > 256 * 1024) throw new Error("attempt_record_invalid");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.attemptId !== attemptId) throw new Error("attempt_record_invalid");
  const { status, runnerId, execution, reportedModel, reportedModelSource, startedAt, finishedAt, lastActivityAt, reasonCode, reason, exitCode, nativeOutcome, nativeError, cleanupStatus } = value;
  let activity: string | undefined, lastReply: string | undefined, latestAt = lastActivityAt;
  let partial = "", partialId = "", semantic = false;
  const summary = (text: string) => text.replace(/<<<TOKEN_COUPON_DONE:[^>]+>>>/g, "").trim().slice(0, 360);
  // Only inspect a bounded tail for task cards. Full messages use the paged endpoint below.
  const log = await open(join(await attemptDirectory(workspace, attemptId), "events.jsonl"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (log) try {
    const info = await log.stat(), offset = Math.max(0, info.size - 64 * 1024), bytes = Buffer.alloc(Math.min(info.size, 64 * 1024));
    await log.read(bytes, 0, bytes.length, offset);
    const lines = bytes.toString("utf8").split("\n"); if (offset) lines.shift();
    for (const line of lines) try {
      const event = JSON.parse(line), p = event.payload || {};
      if (event.timestamp) latestAt = event.timestamp;
      if (["tool.started", "tool.completed", "command.completed", "interaction.requested", "interaction.resolved", "runner.diagnostic"].includes(event.type)) activity = `${event.type}：${p.summary || p.command || p.name || p.message || p.requestId || ""}`.slice(0, 240);
      if (["message.delta", "message.completed"].includes(event.type) && p.root !== false && typeof p.text === "string") {
        semantic = true;
        const id = p.messageId || "stream";
        partial = event.type === "message.completed" ? p.text : `${partialId === id ? partial : ""}${p.text}`.slice(-1800);
        partialId = id;
        const text = summary(partial); if (text) lastReply = text;
      }
      if (event.type === "runner.output") {
        if (typeof p.finalText === "string" && summary(p.finalText)) lastReply = summary(p.finalText);
        else if (!semantic && !p.structuredEvent?.type?.startsWith("codex.message.") && p.structuredEvent?.type !== "assistant") {
          const text = p.agentText ?? p.displayText;
          if (typeof text === "string" && text) { partial = (partial + text).slice(-1800); const value = summary(partial); if (value) lastReply = value; }
        }
      }
    } catch { /* A partial tail line does not invalidate the Attempt snapshot. */ }
  } finally { await log.close(); }
  return { attemptId, status, runnerId, execution, reportedModel, reportedModelSource, startedAt, finishedAt, lastActivityAt: latestAt, reasonCode, reason, exitCode, nativeOutcome, nativeError, cleanupStatus, activity, lastReply };
}

/** Bounded, tail-biased evidence for an explicitly requested failure diagnosis. */
export async function readAttemptDiagnosticEvidence(workspace: string, attemptId: string, maxBytes = 48 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 96 * 1024) throw new Error("diagnostic_budget_invalid");
  const path = join(await attemptDirectory(workspace, attemptId), "events.jsonl");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    const tailBytes = Math.min(info.size, 128 * 1024);
    let offset = info.size - tailBytes;
    const bytes = Buffer.alloc(tailBytes);
    await file.read(bytes, 0, tailBytes, offset);
    if (offset > 0) {
      const newline = bytes.indexOf(10);
      if (newline < 0) return { events: [], truncated: true, bytesRead: tailBytes };
      offset += newline + 1;
    }
    const lines = bytes.toString("utf8").split("\n").slice(offset > info.size - tailBytes ? 1 : 0).filter(Boolean);
    const allowed = new Set(["message.completed", "runner.output", "runner.diagnostic", "command.completed", "tool.started", "tool.completed", "interaction.requested", "interaction.resolved"]);
    const candidates: Array<{ timestamp?: string; type: string; summary: string }> = [];
    let truncated = info.size > tailBytes;
    for (const line of lines) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (typeof event.type !== "string" || !allowed.has(event.type)) continue;
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      let summary = "";
      if (event.type === "message.completed" && payload.root !== false && typeof payload.text === "string") summary = payload.text;
      else if (event.type === "runner.output") summary = typeof payload.finalText === "string" ? payload.finalText : typeof payload.agentText === "string" ? payload.agentText : typeof payload.displayText === "string" ? payload.displayText : "";
      else summary = [payload.code, payload.message, payload.command, payload.outputSummary, payload.summary, payload.name, payload.requestId]
        .filter((value) => typeof value === "string").join(" · ") + (typeof payload.exitCode === "number" ? ` · exit ${payload.exitCode}` : "");
      if (!summary) continue;
      if (Buffer.byteLength(summary, "utf8") > 8 * 1024) { summary = summary.slice(-8 * 1024); truncated = true; }
      candidates.push({ ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}), type: event.type, summary });
    }
    const events: typeof candidates = [];
    let used = 0;
    for (const eventValue of candidates.reverse()) {
      const size = Buffer.byteLength(JSON.stringify(eventValue), "utf8");
      if (used + size > maxBytes) { truncated = true; continue; }
      events.unshift(eventValue); used += size;
      if (events.length >= 80) { truncated = true; break; }
    }
    return { events, truncated, bytesRead: tailBytes };
  } finally { await file.close(); }
}

/** Byte cursors are tied to file identity and complete UTF-8 JSONL lines, not daemon's rolling tail. */
export async function readAttemptEvents(workspace: string, attemptId: string, offset = 0, expectedFile?: string) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("attempt_cursor_invalid");
  const path = join(await attemptDirectory(workspace, attemptId), "events.jsonl");
  const link = await lstat(path);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("attempt_path_invalid");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    const fileId = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const reset = !!expectedFile && (expectedFile !== fileId || offset > info.size);
    if (reset) offset = 0;
    if (offset > info.size) throw new Error("attempt_cursor_invalid：记录已变化，请重新读取");
    if (offset) {
      const previous = Buffer.alloc(1); await file.read(previous, 0, 1, offset - 1);
      if (previous[0] !== 10) throw new Error("attempt_cursor_invalid：游标不在事件边界");
    }
    let size = Math.min(256 * 1024, info.size - offset);
    let bytes = Buffer.alloc(size); await file.read(bytes, 0, size, offset);
    let end = bytes.lastIndexOf(10);
    if (end === -1 && size < info.size - offset) {
      size = Math.min(8 * 1024 * 1024, info.size - offset);
      bytes = Buffer.alloc(size); await file.read(bytes, 0, size, offset); end = bytes.indexOf(10);
      if (end === -1 && size < info.size - offset) throw new Error("attempt_event_too_large：单条事件超过 8 MiB，请在本机检查原始文件");
    }
    const events: unknown[] = []; let malformed = 0;
    if (end >= 0) for (const line of bytes.subarray(0, end + 1).toString("utf8").split("\n").filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (!event || !Number.isSafeInteger(event.sequence) || typeof event.type !== "string" || event.attemptId !== attemptId) malformed++;
        else events.push(event);
      } catch { malformed++; }
    }
    const cursor = end < 0 ? offset : offset + end + 1;
    return { fileId, reset, events, cursor, hasMore: cursor < info.size && end >= 0, pendingPartial: cursor < info.size && end < 0, malformed };
  } finally { await file.close(); }
}
