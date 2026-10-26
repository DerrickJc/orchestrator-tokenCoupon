import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const MAX_PROCESS_LOG_BYTES = 5 * 1024 * 1024;
type ProcessOutput = NodeJS.WriteStream;
type WriteChunk = string | Uint8Array;

export function createBoundedChunkWriter(descriptor: number, maxBytes: number, initialSize = 0): (chunk: WriteChunk, encoding?: BufferEncoding) => number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(initialSize) || initialSize < 0) throw new Error("daemon_log_limit_invalid");
  let written = Math.min(initialSize, maxBytes);
  return (chunk, encoding = "utf8") => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    const remaining = maxBytes - written;
    const count = Math.min(buffer.length, remaining);
    let offset = 0;
    while (offset < count) offset += writeSync(descriptor, buffer, offset, count - offset);
    written += count;
    return count;
  };
}

function redirectOutput(stream: ProcessOutput, writeChunk: (chunk: WriteChunk, encoding?: BufferEncoding) => number): void {
  stream.write = ((chunk: WriteChunk, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    try {
      writeChunk(chunk, encoding);
      if (done) queueMicrotask(() => done());
      return true;
    } catch (error) {
      if (done) queueMicrotask(() => done(error instanceof Error ? error : new Error(String(error))));
      return false;
    }
  }) as typeof stream.write;
}

export function installBoundedProcessLogging(path: string, maxBytes = MAX_PROCESS_LOG_BYTES): void {
  if (!isAbsolute(path)) throw new Error("daemon_log_path_invalid：日志路径必须是绝对路径");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("daemon_log_limit_invalid");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("daemon_log_file_invalid：日志必须是普通文件");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | noFollow, 0o600);
  try {
    const initialSize = fstatSync(descriptor).size;
    if (initialSize >= maxBytes) ftruncateSync(descriptor, 0);
    const writeChunk = createBoundedChunkWriter(descriptor, maxBytes, initialSize >= maxBytes ? 0 : initialSize);
    redirectOutput(process.stdout, writeChunk);
    redirectOutput(process.stderr, writeChunk);
    process.once("exit", () => { try { closeSync(descriptor); } catch { /* already closed */ } });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
