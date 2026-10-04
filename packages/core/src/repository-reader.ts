import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryEvidence } from "./planner-types.js";

const FILE_LIMIT = 1024 * 1024;
const SEARCH_FILE_LIMIT = 256 * 1024;
const SCAN_LIMIT = 256 * 1024;
const READ_OUTPUT_LIMIT = 16 * 1024;
const READ_BUDGET = 8 * 1024 * 1024;
const OUTPUT_BUDGET = 64 * 1024;
const LIST_PAGE = 200;
const SEARCH_FILES = 1000;
const MATCH_LIMIT = 100;
const FORBIDDEN_PARTS = new Set([".git", ".token-coupon", "node_modules", "dist", "coverage", "demo-workspace", ".aws", ".ssh", ".claude"]);

export class RepositoryReader {
  readonly workspace: string;
  private usedBytes = 0;
  private outputBytes = 0;
  private readonly evidence = new Map<string, RepositoryEvidence>();
  private scannedEntries = 0;
  private readonly signal: AbortSignal | undefined;

  constructor(workspace: string, signal?: AbortSignal, initialReadBytes = 0) {
    this.workspace = resolve(workspace);
    this.signal = signal;
    this.usedBytes = initialReadBytes;
  }

  getEvidence(): RepositoryEvidence[] { return [...this.evidence.values()].sort((a, b) => a.path.localeCompare(b.path)); }

  async invoke(name: string, args: unknown): Promise<string> {
    try {
      let result = name === "repo_list" ? await this.list(args)
        : name === "repo_read" ? await this.read(args)
          : name === "repo_search" ? await this.search(args)
            : { error: "unknown_tool", message: "此工具不可用" };
      const remaining = OUTPUT_BUDGET - this.outputBytes;
      let serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, "utf8") > remaining) {
        result = shrinkPage(result, remaining);
        serialized = JSON.stringify(result);
      }
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > remaining) return JSON.stringify({ error: "tool_output_budget_exceeded", message: "本轮只读工具输出已达上限" });
      this.outputBytes += bytes;
      return serialized;
    } catch (error) {
      const code = error instanceof RepositoryReadError ? error.code : "repository_read_failed";
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: code, message: message.slice(0, 512) });
    }
  }

  async verifyEvidence(expected: RepositoryEvidence[], signal?: AbortSignal): Promise<string[]> {
    let bytes = 0;
    const changed: string[] = [];
    for (const item of expected) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      try {
        const { evidence } = await this.hashFile(item.path, bytes, READ_BUDGET);
        bytes += evidence.sizeBytes;
        if (evidence.sha256 !== item.sha256 || evidence.sizeBytes !== item.sizeBytes) changed.push(item.path);
      } catch { changed.push(item.path); }
    }
    return changed;
  }

  private async list(value: unknown): Promise<unknown> {
    const args = exactArgs(value, ["path", "offset"]);
    const path = optionalPath(args.path);
    const offset = optionalInteger(args.offset, 0, 5000, "offset");
    const directory = await this.resolvePath(path, "directory");
    const entries = (await readDirectoryBounded(directory))
      .filter((entry) => !isExcluded([...pathParts(path), entry.name]) && !entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.scannedEntries += entries.length;
    if (this.scannedEntries > 5000) throw new RepositoryReadError("repository_entry_limit", "本轮目录项数量超过 5,000");
    return { path, offset, entries: entries.slice(offset, offset + LIST_PAGE), nextOffset: offset + LIST_PAGE < entries.length ? offset + LIST_PAGE : null };
  }

  private async read(value: unknown): Promise<unknown> {
    const args = exactArgs(value, ["path", "startLine", "lineCount"]);
    const path = requiredPath(args.path);
    const startLine = optionalInteger(args.startLine, 1, 1_000_000, "startLine");
    const lineCount = optionalInteger(args.lineCount, 200, 200, "lineCount", 1);
    const absolute = await this.resolvePath(path, "file");
    const metadata = await stat(absolute);
    if (metadata.size > FILE_LIMIT) throw new RepositoryReadError("file_too_large", `文件超过 ${FILE_LIMIT} 字节上限`);
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const handle = await open(absolute, "r");
    const content: string[] = [];
    let bytes = 0;
    let scanned = 0;
    let lineNumber = 1;
    let pending = "";
    let truncated = false;
    let lineTruncated = false;
    try {
      const buffer = Buffer.alloc(32 * 1024);
      while (true) {
        this.checkCancelled();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        bytes += bytesRead;
        this.consume(bytesRead);
        hash.update(chunk);
        let text: string;
        try { text = truncated ? "" : decoder.decode(chunk, { stream: true }); }
        catch { throw new RepositoryReadError("not_text_file", "文件不是有效的 UTF-8 文本"); }
        let index = 0;
        for (;;) {
          const newline = text.indexOf("\n", index);
          const piece = newline < 0 ? text.slice(index) : text.slice(index, newline);
          if (lineNumber >= startLine && lineNumber < startLine + lineCount) {
            const remaining = SCAN_LIMIT - scanned;
            if (remaining <= 0) { truncated = true; break; }
            const accepted = takeUtf8(piece, Math.min(remaining, 4096));
            pending += accepted.text;
            scanned += Buffer.byteLength(accepted.text, "utf8");
            lineTruncated ||= accepted.truncated;
            if (accepted.truncated) { truncated = true; break; }
          }
          if (newline < 0) break;
          if (lineNumber >= startLine && lineNumber < startLine + lineCount) {
            content.push(`${lineNumber}: ${pending.replace(/\r$/, "")}`);
            pending = "";
          }
          lineNumber += 1;
          index = newline + 1;
        }
      }
      if (!truncated) {
        let tail = "";
        try { tail = decoder.decode(); }
        catch { throw new RepositoryReadError("not_text_file", "文件不是有效的 UTF-8 文本"); }
        if (lineNumber >= startLine && lineNumber < startLine + lineCount) {
          const accepted = takeUtf8(pending + tail, Math.min(SCAN_LIMIT - scanned, 4096));
          pending = accepted.text;
          lineTruncated ||= accepted.truncated;
          truncated ||= accepted.truncated;
        }
      }
      if (pending && content.length < lineCount) content.push(`${lineNumber}: ${pending.replace(/\r$/, "")}`);
      if (truncated && pending) content.push("[读取范围因扫描或单行长度上限而截断]");
      const after = await handle.stat();
      if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) throw new RepositoryReadError("file_changed_during_read", "读取期间文件发生变化，请重新读取");
    } finally { await handle.close(); }
    const evidence = { path, sha256: hash.digest("hex"), sizeBytes: bytes };
    this.evidence.set(path, evidence);
    const boundedContent = takeUtf8(content.join("\n"), READ_OUTPUT_LIMIT);
    return {
      path,
      startLine,
      content: boundedContent.text,
      truncated: truncated || boundedContent.truncated,
      lineTruncated,
      sha256: evidence.sha256,
    };
  }

  private async search(value: unknown): Promise<unknown> {
    const args = exactArgs(value, ["path", "query", "offset"]);
    const rootPath = optionalPath(args.path);
    if (typeof args.query !== "string" || !args.query || Buffer.byteLength(args.query, "utf8") > 512) throw new RepositoryReadError("invalid_query", "query 必须是 1—512 字节的普通字符串");
    const offset = optionalInteger(args.offset, 0, 10000, "offset");
    const root = await this.resolvePath(rootPath, "directory");
    const queue = [rootPath];
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let filesScanned = 0;
    let skippedLargeFiles = 0;
    while (queue.length && filesScanned < SEARCH_FILES && matches.length < MATCH_LIMIT + offset) {
      const dirPath = queue.shift()!;
      const directory = dirPath ? await this.resolvePath(dirPath, "directory") : root;
      const entries = (await readDirectoryBounded(directory)).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        this.checkCancelled();
        if (entry.isSymbolicLink() || isExcluded([...pathParts(dirPath), entry.name])) continue;
        this.scannedEntries += 1;
        if (this.scannedEntries > 5000) throw new RepositoryReadError("repository_entry_limit", "本轮目录项数量超过 5,000");
        const child = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { queue.push(child); continue; }
        if (!entry.isFile()) continue;
        filesScanned += 1;
        const absolute = await this.resolvePath(child, "file");
        const metadata = await stat(absolute);
        if (metadata.size > SEARCH_FILE_LIMIT) { skippedLargeFiles += 1; continue; }
        const contents = await this.readBytes(absolute, metadata.size);
        const text = decode(contents);
        if (text === null) continue;
        this.evidence.set(child, { path: child, sha256: createHash("sha256").update(contents).digest("hex"), sizeBytes: contents.length });
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          let at = line.indexOf(args.query);
          while (at >= 0) {
            matches.push({ path: child, line: index + 1, text: takeUtf8(line, 1024).text });
            if (matches.length >= MATCH_LIMIT + offset) break;
            at = line.indexOf(args.query, at + args.query.length);
          }
          if (matches.length >= MATCH_LIMIT + offset) break;
        }
      }
    }
    const selected = matches.slice(offset, offset + MATCH_LIMIT);
    const hasMore = queue.length > 0 || filesScanned >= SEARCH_FILES || matches.length >= offset + MATCH_LIMIT;
    return { query: args.query, offset, matches: selected, nextOffset: hasMore ? offset + selected.length : null, filesScanned, skippedLargeFiles, truncated: hasMore };
  }

  private async readBytes(path: string, expectedSize: number): Promise<Buffer> {
    const handle = await open(path, "r");
    try {
      const data = Buffer.alloc(expectedSize);
      let position = 0;
      while (position < expectedSize) {
        const { bytesRead } = await handle.read(data, position, expectedSize - position, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        this.consume(bytesRead);
      }
      if (position !== expectedSize) throw new RepositoryReadError("file_changed_during_read", "文件读取期间大小发生变化");
      return data;
    } finally { await handle.close(); }
  }

  private async hashFile(path: string, alreadyUsed: number, limit: number): Promise<{ evidence: RepositoryEvidence }> {
    const absolute = await this.resolvePath(path, "file");
    const before = await stat(absolute);
    if (before.size > FILE_LIMIT || alreadyUsed + before.size > limit) throw new RepositoryReadError("evidence_budget_exceeded", "上下文校验超过读取预算");
    const handle = await open(absolute, "r");
    const hash = createHash("sha256");
    let size = 0;
    try {
      const buffer = Buffer.alloc(32 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new RepositoryReadError("file_changed_during_read", "读取期间文件发生变化");
    } finally { await handle.close(); }
    return { evidence: { path, sizeBytes: size, sha256: hash.digest("hex") } };
  }

  private consume(bytes: number): void {
    this.usedBytes += bytes;
    if (this.usedBytes > READ_BUDGET) throw new RepositoryReadError("repository_read_budget_exceeded", "本轮本地读取量超过 8 MiB");
  }

  private checkCancelled(): void {
    if (this.signal?.aborted) throw this.signal.reason ?? new RepositoryReadError("cancelled", "Planner 调研已取消");
  }

  private async resolvePath(path: string, expected: "file" | "directory"): Promise<string> {
    const root = await realpath(this.workspace);
    let current = root;
    for (const component of pathParts(path)) {
      if (isExcluded([component])) throw new RepositoryReadError("path_excluded", "该路径属于 Planner 排除范围");
      current = resolve(current, component);
      let info;
      try { info = await lstat(current); } catch { throw new RepositoryReadError("path_not_found", `路径不存在：${path || "."}`); }
      if (info.isSymbolicLink()) throw new RepositoryReadError("symlink_not_allowed", "只读调研不跟随符号链接");
    }
    const actual = await realpath(current);
    const escaped = relative(root, actual);
    if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new RepositoryReadError("path_outside_workspace", "路径超出 workspace");
    const info = await stat(actual);
    if (expected === "file" ? !info.isFile() : !info.isDirectory()) throw new RepositoryReadError("wrong_path_type", `路径不是${expected === "file" ? "普通文件" : "目录"}`);
    return actual;
  }
}

async function readDirectoryBounded(path: string): Promise<import("node:fs").Dirent[]> {
  const directory = await opendir(path);
  const entries: import("node:fs").Dirent[] = [];
  try {
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > 5000) throw new RepositoryReadError("repository_entry_limit", "单个目录超过 5,000 项");
    }
  } finally { await directory.close().catch(() => undefined); }
  return entries;
}

export async function verifyRepositoryEvidence(workspace: string, evidence: RepositoryEvidence[], signal?: AbortSignal): Promise<string[]> {
  const reader = new RepositoryReader(workspace);
  return reader.verifyEvidence(evidence, signal);
}

export function repositoryToolDefinitions() {
  return [
    { type: "function", function: { name: "repo_list", description: "列出 workspace 内的普通文件和目录。path 使用相对路径，offset 用于分页。", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["path", "offset"] } } },
    { type: "function", function: { name: "repo_read", description: "读取 workspace 内文本文件的指定行。", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 200 } }, required: ["path", "startLine", "lineCount"] } } },
    { type: "function", function: { name: "repo_search", description: "在 workspace 文本文件中按字面字符串搜索。", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, query: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["path", "query", "offset"] } } },
  ];
}

class RepositoryReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function exactArgs(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryReadError("invalid_tool_arguments", "工具参数必须是对象");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new RepositoryReadError("invalid_tool_arguments", "工具参数包含未定义字段");
  return args;
}
function requiredPath(value: unknown): string { if (typeof value !== "string") throw new RepositoryReadError("invalid_path", "path 必须是相对路径"); return validatePath(value); }
function optionalPath(value: unknown): string { if (value === undefined) return ""; return requiredPath(value); }
function validatePath(value: string): string {
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value) || value.split("/").some((part) => part === "..")) throw new RepositoryReadError("invalid_path", "path 必须是 workspace 内的相对路径");
  return value.split("/").filter((part) => part && part !== ".").join("/");
}
function pathParts(value: string): string[] { return value ? value.split("/").filter(Boolean) : []; }
function optionalInteger(value: unknown, fallback: number, max: number, field: string, minimum = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > max) throw new RepositoryReadError("invalid_tool_arguments", `${field} 超出有效范围`);
  return value as number;
}
function isExcluded(parts: string[]): boolean {
  return parts.some((part) => FORBIDDEN_PARTS.has(part) || /^\.env(?:\.|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part) || /^id_(?:rsa|ed25519)$/i.test(part));
}
function decode(contents: Buffer): string | null { try { const text = new TextDecoder("utf-8", { fatal: true }).decode(contents); return text.includes("\0") ? null : text; } catch { return null; } }
function takeUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, truncated: false };
  let text = "";
  for (const character of value) {
    if (Buffer.byteLength(text + character, "utf8") > limit) break;
    text += character;
  }
  return { text, truncated: true };
}

function shrinkPage(value: unknown, limit: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "tool_output_budget_exceeded", message: "本轮只读工具输出已达上限" };
  const raw = value as Record<string, unknown>;
  const key = Array.isArray(raw.entries) ? "entries" : Array.isArray(raw.matches) ? "matches" : undefined;
  if (!key) return { error: "tool_output_budget_exceeded", message: "本轮只读工具输出已达上限" };
  const items = [...raw[key] as unknown[]];
  const offset = typeof raw.offset === "number" ? raw.offset : 0;
  while (items.length > 0) {
    const candidate = { ...raw, [key]: items, truncated: true, nextOffset: offset + items.length };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= limit) return candidate;
    items.pop();
  }
  const candidate = { ...raw, [key]: [], truncated: true, nextOffset: null };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= limit) return candidate;
  return { error: "tool_output_budget_exceeded", message: "本轮只读工具输出已达上限" };
}
