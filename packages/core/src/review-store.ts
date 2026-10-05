import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PlanReviewFinding, PlanReviewRecord, RepositoryEvidence } from "./planner-types.js";
import { canonicalHash, atomicWrite } from "./planner-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

export class ReviewStore {
  readonly workspace: string;
  private readonly plannerRoot: string;

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
    this.plannerRoot = join(this.workspace, ".token-coupon", "planners");
  }

  reviewDirectory(planningId: string, reviewId: string): string {
    this.validateId(planningId);
    this.validateId(reviewId);
    return join(this.plannerRoot, planningId, "reviews", reviewId);
  }

  async create(record: PlanReviewRecord): Promise<void> {
    validateReviewRecord(record);
    const directory = this.reviewDirectory(record.planningId, record.reviewId);
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    await writeFile(join(directory, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
    await this.save(record);
    await this.appendEvent(record.planningId, record.reviewId, "review.created", { draftRevision: record.draftRevision, planHash: record.planHash });
  }

  async save(record: PlanReviewRecord): Promise<void> {
    validateReviewRecord(record);
    const directory = this.reviewDirectory(record.planningId, record.reviewId);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, "review.json"), JSON.stringify(record, null, 2) + "\n");
  }

  async load(planningId: string, reviewId: string): Promise<PlanReviewRecord> {
    const path = join(this.reviewDirectory(planningId, reviewId), "review.json");
    const info = await stat(path);
    if (info.size > 1024 * 1024) throw new Error("Planner 审查记录超过 1 MiB");
    const record = validateReviewRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (record.planningId !== planningId || record.reviewId !== reviewId) throw new Error("Planner 审查记录身份与路径不匹配");
    return record;
  }

  async list(planningId: string): Promise<PlanReviewRecord[]> {
    this.validateId(planningId);
    const root = join(this.plannerRoot, planningId, "reviews");
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records: PlanReviewRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try { records.push(await this.load(planningId, entry.name)); }
      catch { /* A damaged review should not hide other review history. */ }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendEvent(planningId: string, reviewId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const directory = this.reviewDirectory(planningId, reviewId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "events.jsonl");
    const line = JSON.stringify({ at: new Date().toISOString(), type, payload }) + "\n";
    const existing = await stat(path).catch(() => undefined);
    if ((existing?.size ?? 0) + Buffer.byteLength(line, "utf8") > 1024 * 1024) throw new Error("Planner 审查事件记录超过 1 MiB");
    const handle = await open(path, "a", 0o600);
    try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
  }

  async writeProviderCall(planningId: string, reviewId: string, requestId: number, kind: "request" | "response", value: unknown): Promise<void> {
    if (!Number.isSafeInteger(requestId) || requestId < 1 || requestId > 8) throw new Error("审查 API requestId 无效");
    const directory = join(this.reviewDirectory(planningId, reviewId), "calls");
    await mkdir(directory, { recursive: true });
    const contents = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(contents, "utf8") > 1024 * 1024) throw new Error("审查 API 调用记录超过 1 MiB");
    const name = String(requestId).padStart(4, "0") + "." + kind + ".json";
    await atomicWrite(join(directory, name), contents);
  }

  private validateId(value: string): void { if (!UUID.test(value)) throw new Error("planningId/reviewId 必须是 UUID"); }
}

export function validateReviewRecord(value: unknown): PlanReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Planner 审查记录必须是对象");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.planningId !== "string" || !UUID.test(raw.planningId) || typeof raw.reviewId !== "string" || !UUID.test(raw.reviewId) ||
      !["running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(raw.status)) ||
      !Number.isSafeInteger(raw.draftRevision) || (raw.draftRevision as number) < 1 || !isHash(raw.planHash) || !isHash(raw.requirementsHash) || !isHash(raw.reviewerConfigHash) ||
      !Array.isArray(raw.context) || !Array.isArray(raw.findings) || raw.findings.length > 100 || typeof raw.summary !== "string" || Buffer.byteLength(raw.summary, "utf8") > 16 * 1024 ||
      (raw.reportHash !== null && !isHash(raw.reportHash)) || (raw.reasonCode !== null && typeof raw.reasonCode !== "string") ||
      typeof raw.createdAt !== "string" || (raw.finishedAt !== null && typeof raw.finishedAt !== "string")) throw new Error("Planner 审查记录字段无效");
  const context = raw.context.map(parseEvidence);
  const findings = raw.findings.map(parseFinding);
  if (raw.status === "succeeded") {
    if (raw.finishedAt === null || !raw.reportHash || canonicalHash({ summary: raw.summary, findings }) !== raw.reportHash) throw new Error("Planner 审查报告哈希无效");
  } else if (raw.reportHash !== null) throw new Error("未成功的审查不能包含有效报告哈希");
  return {
    schemaVersion: 1, planningId: raw.planningId as string, reviewId: raw.reviewId as string, status: raw.status as PlanReviewRecord["status"],
    draftRevision: raw.draftRevision as number, planHash: raw.planHash as string, requirementsHash: raw.requirementsHash as string,
    reviewerConfigHash: raw.reviewerConfigHash as string, context, findings, summary: raw.summary,
    reportHash: raw.reportHash as string | null, reasonCode: raw.reasonCode as string | null,
    createdAt: raw.createdAt, finishedAt: raw.finishedAt as string | null,
  };
}

function parseEvidence(value: unknown): RepositoryEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("审查仓库证据无效");
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.split("/").includes("..") || !isHash(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0 || (item.sizeBytes as number) > 1024 * 1024) throw new Error("审查仓库证据无效");
  return { path: item.path, sha256: item.sha256 as string, sizeBytes: item.sizeBytes as number };
}

function parseFinding(value: unknown): PlanReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("审查问题必须是对象");
  const item = value as Record<string, unknown>;
  if (typeof item.findingId !== "string" || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(item.findingId) ||
      !["error", "warning", "info"].includes(String(item.severity)) || !["requirements", "dependency", "technology", "contract", "testing"].includes(String(item.category)) ||
      !Array.isArray(item.taskIds) || item.taskIds.length > 100 || item.taskIds.some((id) => typeof id !== "string" || id.length > 128) ||
      typeof item.description !== "string" || !item.description.trim() || Buffer.byteLength(item.description, "utf8") > 4096 ||
      typeof item.basis !== "string" || !item.basis.trim() || Buffer.byteLength(item.basis, "utf8") > 4096 ||
      typeof item.suggestion !== "string" || !item.suggestion.trim() || Buffer.byteLength(item.suggestion, "utf8") > 4096) throw new Error("审查问题字段无效");
  return { findingId: item.findingId, severity: item.severity as PlanReviewFinding["severity"], category: item.category as PlanReviewFinding["category"], taskIds: item.taskIds as string[], description: item.description, basis: item.basis, suggestion: item.suggestion };
}

function isHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
