import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 1024 * 1024;

export interface AttemptDiagnosticMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runnerId?: "codex" | "claude-code";
  modelId?: string;
}

export interface AttemptDiagnosticRecord {
  schemaVersion: 1;
  diagnosticId: string;
  planningId: string;
  attemptId: string;
  taskId: string;
  runnerId: "codex" | "claude-code";
  modelId?: string;
  evidenceHash: string;
  status: "running" | "completed" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  messages: AttemptDiagnosticMessage[];
  error?: string;
}

/** Keeps diagnosis conversations separate from immutable Attempt and planning records. */
export class AttemptDiagnosticStore {
  constructor(private readonly workspace: string, private readonly planningId: string, private readonly attemptId: string) {
    if (!UUID.test(planningId) || !UUID.test(attemptId)) throw new Error("diagnostic_identity_invalid");
  }

  private get path(): string { return join(this.workspace, ".token-coupon", "diagnostics", this.planningId, `${this.attemptId}.json`); }
  private async ensureDirectory(): Promise<void> {
    let parent = this.workspace;
    for (const segment of [".token-coupon", "diagnostics", this.planningId]) {
      parent = join(parent, segment);
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("diagnostic_path_invalid：诊断记录目录不能是符号链接或普通文件");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(parent, { mode: 0o700 });
      }
    }
  }

  async read(): Promise<AttemptDiagnosticRecord[]> {
    try {
      const path = this.path;
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("diagnostic_path_invalid：诊断记录文件不能是符号链接");
      const value = await readFile(path);
      if (value.byteLength > MAX_RECORD_BYTES) throw new Error("diagnostic_record_too_large");
      const parsed = JSON.parse(value.toString("utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("diagnostic_record_invalid");
      return parsed.filter(isDiagnosticRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async write(records: AttemptDiagnosticRecord[]): Promise<void> {
    const path = this.path;
    const data = JSON.stringify(records.slice(-20), null, 2) + "\n";
    if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) throw new Error("diagnostic_record_too_large：诊断对话已达到保存上限");
    await this.ensureDirectory();
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("diagnostic_path_invalid：诊断记录文件不能是符号链接");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }

  private async evidencePath(hash: string, create: boolean): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("diagnostic_evidence_hash_invalid");
    if (create) await this.ensureDirectory();
    let directory = this.workspace;
    for (const segment of [".token-coupon", "diagnostics", this.planningId, this.attemptId]) {
      directory = join(directory, segment);
      if (create && segment === this.attemptId) await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("diagnostic_path_invalid");
    }
    return join(directory, `evidence-${hash}.txt`);
  }

  async exportEvidence(text: string, hash: string): Promise<string> {
    if (createHash("sha256").update(text).digest("hex") !== hash || Buffer.byteLength(text) > 256 * 1024) throw new Error("diagnostic_evidence_invalid");
    const path = await this.evidencePath(hash, true);
    try { await writeFile(path, text, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await this.readEvidence(hash); }
    return path;
  }

  async readEvidence(hash: string): Promise<{ path: string; text: string }> {
    const path = await this.evidencePath(hash, false);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) throw new Error("diagnostic_path_invalid");
    const text = await readFile(path, "utf8");
    if (createHash("sha256").update(text).digest("hex") !== hash) throw new Error("diagnostic_evidence_changed：证据文件已修改，请在本机重新导出");
    return { path, text };
  }
}

function isDiagnosticRecord(value: unknown): value is AttemptDiagnosticRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && typeof item.diagnosticId === "string" && UUID.test(item.diagnosticId) &&
    typeof item.planningId === "string" && typeof item.attemptId === "string" && typeof item.taskId === "string" &&
    (item.runnerId === "codex" || item.runnerId === "claude-code") &&
    ["running", "completed", "failed", "interrupted"].includes(String(item.status)) &&
    Array.isArray(item.messages) && item.messages.every((message) => !!message && typeof message === "object" &&
      ((message as Record<string, unknown>).role === "user" || (message as Record<string, unknown>).role === "assistant") &&
      typeof (message as Record<string, unknown>).content === "string");
}
