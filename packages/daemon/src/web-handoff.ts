import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WebSource = "chatgpt" | "claude" | "other" | "any";
export interface WebActor { grantId: string; clientId: string; source?: Exclude<WebSource, "any">; assertActive?: () => Promise<void>; }
export interface ClaimProof { claimToken: string; generation: number; }
export interface PendingInput { messageId: string; content: string; operation: boolean; }
export interface HandoffSlot {
  schemaVersion: 1; workspaceId: string; planningId: string; role: "plan" | "review";
  operationId: string; code: string; target: WebSource; generation: number; inputRevision: number;
  pending: PendingInput[]; reason?: string; updatedAt: string;
  claimHistory?: Array<{ grantId: string; requestKey: string; generation: number }>;
  claim?: { grantId: string; clientId: string; source?: string; requestKey: string; tokenHash: string; expiresAt: number; lastActivity: number };
}

/** One durable owner per project/planning/role. Secrets never enter public views or events. */
export class WebHandoffCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private secret!: Buffer;
  readonly directory: string;
  constructor(dataDirectory: string, readonly leaseMs = Number(process.env.TOKEN_COUPON_WEB_LEASE_MS ?? 10 * 60_000)) { if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 24 * 60 * 60_000) throw new Error("handoff_lease_invalid：租约需在 1000~86400000 ms 范围内"); this.directory = join(dataDirectory, "web-handoffs"); }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const secretPath = join(this.directory, "claim-secret");
    try { this.secret = await readFile(secretPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.secret = randomBytes(32); await writeFile(secretPath, this.secret, { mode: 0o600, flag: "wx" }); }
    if (this.secret.length !== 32) throw new Error("handoff_secret_invalid：本地领取密钥格式无效");
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const slot = JSON.parse(await readFile(join(this.directory, name), "utf8")) as HandoffSlot;
      if (slot.claim) { delete slot.claim; slot.generation++; slot.reason = "daemon_restarted：请重新领取；提交中断需要对账"; await this.save(slot); }
    }
  }
  key(workspaceId: string, planningId: string, role: string): string { return createHash("sha256").update(`${workspaceId}:${planningId}:${role}`).digest("hex"); }
  async serial<T>(workspaceId: string, planningId: string, role: string, action: () => Promise<T>): Promise<T> {
    // Plan and Review share the planning lock, so input arrival fences both roles.
    const key = this.key(workspaceId, planningId, "planning");
    const before = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(key, current); await before;
    try { return await action(); } finally { release(); if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  async load(workspaceId: string, planningId: string, role: "plan" | "review"): Promise<HandoffSlot | undefined> {
    try { return JSON.parse(await readFile(join(this.directory, `${this.key(workspaceId, planningId, role)}.json`), "utf8")) as HandoffSlot; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async save(slot: HandoffSlot): Promise<void> {
    slot.updatedAt = new Date().toISOString();
    const path = join(this.directory, `${this.key(slot.workspaceId, slot.planningId, slot.role)}.json`), temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(slot, null, 2) + "\n", { mode: 0o600 }); await rename(temp, path);
  }
  async slots(workspaceId: string, planningId?: string): Promise<HandoffSlot[]> {
    const slots: HandoffSlot[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const slot = JSON.parse(await readFile(join(this.directory, file), "utf8")) as HandoffSlot;
      if (slot.workspaceId === workspaceId && (!planningId || slot.planningId === planningId)) slots.push(slot);
    }
    return slots;
  }
  public(slot: HandoffSlot): unknown {
    return { operationId: slot.operationId, planningId: slot.planningId, role: slot.role, code: slot.code, target: slot.target, generation: slot.generation,
      inputRevision: slot.inputRevision, pendingInputs: slot.pending.length, updatedAt: slot.updatedAt, reason: slot.reason,
      owner: slot.claim ? { grantId: slot.claim.grantId, clientId: slot.claim.clientId, source: slot.claim.source, expiresAt: slot.claim.expiresAt, lastActivity: slot.claim.lastActivity, expired: slot.claim.expiresAt <= Date.now() } : null,
      prompt: `通过 Token Coupon MCP 的 handoff_query 查找接手码 ${slot.code}，领取后完成 ${slot.role === "plan" ? "规划／修订" : "审查"}，提交结果；批准与执行由本地控制台处理。` };
  }
  token(slot: HandoffSlot): string { return createHmac("sha256", this.secret).update(`${slot.operationId}:${slot.generation}:${slot.claim!.grantId}:${slot.claim!.requestKey}`).digest("base64url"); }
  async claim(slot: HandoffSlot, actor: WebActor, requestKey: string): Promise<ClaimProof> {
    await actor.assertActive?.();
    if (slot.target !== "any" && actor.source !== slot.target) throw new Error("handoff_target_forbidden：此操作交给其他网页来源，请在本地授权中设置来源或交接");
    const receipt = slot.claimHistory?.find(item => item.grantId === actor.grantId && item.requestKey === requestKey);
    if (receipt && (!slot.claim || slot.claim.requestKey !== requestKey || slot.generation !== receipt.generation || slot.claim.expiresAt <= Date.now())) throw new Error("handoff_superseded：原领取已归还、交接或过期，请用新的 requestKey 领取");
    if (slot.claim && slot.claim.expiresAt > Date.now()) {
      if (slot.claim.grantId !== actor.grantId || slot.claim.requestKey !== requestKey) throw new Error("handoff_owned：操作已被领取，请归还或在本地交接");
    } else {
      slot.generation++;
      const now = Date.now();
      slot.claim = { grantId: actor.grantId, clientId: actor.clientId, ...(actor.source ? { source: actor.source } : {}), requestKey, tokenHash: "", expiresAt: now + this.leaseMs, lastActivity: now };
      slot.claimHistory = [...(slot.claimHistory ?? []), { grantId: actor.grantId, requestKey, generation: slot.generation }].slice(-64);
      slot.claim.tokenHash = createHash("sha256").update(this.token(slot)).digest("hex");
    }
    slot.claim.lastActivity = Date.now(); slot.claim.expiresAt = Date.now() + this.leaseMs;
    await this.save(slot);
    return { claimToken: this.token(slot), generation: slot.generation };
  }
  async validate(slot: HandoffSlot, operationId: string, actor?: WebActor, proof?: ClaimProof): Promise<void> {
    await actor?.assertActive?.();
    const claim = slot.claim;
    const digest = createHash("sha256").update(proof?.claimToken ?? "").digest("hex");
    if (slot.operationId !== operationId || !claim || !actor || !proof || proof.generation !== slot.generation || claim.grantId !== actor.grantId || claim.clientId !== actor.clientId || claim.source !== actor.source || !timingSafeEqual(Buffer.from(claim.tokenHash), Buffer.from(digest))) throw new Error("handoff_superseded：领取无效、已交接或缺少当前领取凭证，请重新查询并领取");
    if (claim.expiresAt <= Date.now()) throw new Error("handoff_lease_expired：领取已过期，请重新领取；网页生成不会自动停止");
    claim.lastActivity = Date.now(); claim.expiresAt = claim.lastActivity + this.leaseMs;
    await this.save(slot);
  }
}
