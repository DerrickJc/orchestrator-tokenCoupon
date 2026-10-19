import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_REPOSITORY_OUTPUT_BUDGET, PlannerStore, RepositoryReader, createHistoryReader, externalPlannerProtocol, externalReviewProtocol,
  initializePlannerConversation, prepareExternalPlannerInput, prepareExternalReviewInput,
  reviewPlannerDraft, submitExternalPlannerReply, verifyRepositoryEvidence, canonicalHash,
} from "@token-coupon/core";
import type { ExecutionConfig, ExternalPlannerPreparation, PlanReviewInput, PlannerConfig, RepositoryEvidence, PlannerConversationSnapshot } from "@token-coupon/core";
import { WebHandoffCoordinator } from "./web-handoff.js";
import type { ClaimProof, WebActor, WebSource } from "./web-handoff.js";
import type { ApplicationService, JobRecord } from "./application-service.js";

export interface ExternalOperation {
  operationId: string; workspaceId: string; planningId: string; role: "plan" | "review";
  state: "prepared" | "submitting" | "succeeded" | "failed" | "stale" | "cancelled" | "interrupted";
  completedBy?: { grantId: string; clientId: string; source?: string; generation: number }; expectedRevision: number; coordinated?: boolean; inputRevision?: number; preparation?: ExternalPlannerPreparation; reviewInput?: PlanReviewInput; reviewerConfig?: PlannerConfig;
  evidence: RepositoryEvidence[]; reads: Array<{ name: string; args: unknown; result: string }>;
  outputBytes: number; outputBudgetBytes?: number; budgetExtensions?: Array<{ previousBytes: number; nextBytes: number; confirmedAt: string }>;
  historyCalls?: number; attempts: number; diagnostic?: string; result?: unknown; createdAt: string; updatedAt: string;
}
const LEGACY_OUTPUT_BUDGET = 64 * 1024;
const MAX_OUTPUT_BUDGET = 1024 * 1024;
const OUTPUT_BUDGET_INCREMENT = 256 * 1024;
function outputBudget(op: ExternalOperation): number { return op.outputBudgetBytes ?? LEGACY_OUTPUT_BUDGET; }
function formatBudget(value: number): string { return value >= 1024 * 1024 ? `${value / (1024 * 1024)} MiB` : `${value / 1024} KiB`; }
export interface PrepareExternalInput {
  role: "plan" | "review"; planningId?: string; message?: string; model?: string; reviewerConfig?: PlannerConfig;
  executionDefaults?: ExecutionConfig; retry?: boolean; operation?: boolean; coordinated?: boolean; target?: WebSource; reusePending?: boolean;
  sourcePlanning?: PlannerConversationSnapshot["sourcePlanning"];
  plannerConfig?: PlannerConfig;
}

/** Persisted bridge operations; no model call, browser scraping, or waiting domain lock. */
export class ExternalPlanningService {
  private readonly directory: string;
  private readonly queues = new Map<string, Promise<void>>();
  readonly handoffs: WebHandoffCoordinator;
  constructor(private readonly service: ApplicationService, dataDirectory: string) { this.directory = join(dataDirectory, "external-operations"); this.handoffs = new WebHandoffCoordinator(dataDirectory); }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.handoffs.initialize();
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const op = await this.load(name.slice(0, -5)).catch(() => undefined);
      if (op?.state === "submitting") await this.save({ ...op, state: "interrupted", diagnostic: "daemon_restarted：提交结果可能已经落库，请对账领域记录，不自动重放", updatedAt: new Date().toISOString() });
    }
  }

  async prepare(workspaceId: string, requestKey: string, input: PrepareExternalInput, actor?: WebActor): Promise<JobRecord> {
    const workspace = await this.service.getWorkspace(workspaceId);
    return this.service.submit(workspaceId, "external.prepare", requestKey, input, async () => {
      let planningId = input.planningId;
      if (!planningId) {
        if (input.role !== "plan" || !input.message || !input.executionDefaults) throw new Error("external_input_invalid：新规划需要需求和执行配置");
        planningId = (await initializePlannerConversation({ workspace: workspace.path, request: input.message,
          config: { provider: input.coordinated ? "web-mcp" : "chatgpt-mcp", model: input.model || "web-selected-unknown", baseUrl: input.coordinated ? "mcp://web" : "mcp://chatgpt" }, executionDefaults: input.executionDefaults, ...(input.sourcePlanning ? { sourcePlanning: input.sourcePlanning } : {}) })).planningId;
      }
      const id = planningId;
      return this.handoffs.serial(workspaceId, id, input.role, async () => {
      return this.prepareSlot(workspaceId, id, input, actor);
      });
    });
  }

  private async prepareSlot(workspaceId: string, id: string, input: PrepareExternalInput, actor?: WebActor): Promise<unknown> {
      const workspace = await this.service.getWorkspace(workspaceId);
      const snapshot = await new PlannerStore(workspace.path).load(id);
      const coordinated = input.coordinated || snapshot.config.provider === "web-mcp" || !!(await this.handoffs.load(workspaceId, id, "plan")) || !!(await this.handoffs.load(workspaceId, id, "review"));
      if (input.plannerConfig && actor) throw new Error("external_provider_forbidden：只有本机操作可以选择规划方式");
      if (input.role === "plan" && !input.plannerConfig && !["chatgpt-mcp", "web-mcp"].includes(snapshot.config.provider)) throw new Error("external_provider_invalid：不能把 API 规划悄悄改成网页规划");
      let preparation: ExternalPlannerPreparation | undefined;
      const previousSlot = coordinated ? await this.handoffs.load(workspaceId, id, input.role) : undefined;
      await actor?.assertActive?.();
      // Remote callers must release/submit their claim, not replace the operation.
      // Trusted local input can supersede the old plan and fence its generation.
      if (input.role === "plan" && actor && previousSlot?.claim && previousSlot.claim.expiresAt > Date.now()) throw new Error("handoff_owned：已有网页领取处理中；请先提交或归还当前操作");
      // Continuing a review must never replace its owner or discard its evidence.
      // Check under the same planning lock used by claim/submit/input changes.
      if (input.role === "review" && previousSlot) {
        const previous = await this.load(previousSlot.operationId);
        const planSlot = await this.handoffs.load(workspaceId, id, "plan");
        // An MCP actor's source identifies the caller; it is not a local request
        // to change the chosen reviewer. Reuse is safe: claim() still checks owner/target.
        const sameReviewSource = (!!actor || !input.target || previousSlot.target === input.target) && (!input.reviewerConfig || canonicalHash(previous.reviewerConfig ?? snapshot.config) === canonicalHash(input.reviewerConfig));
        const sameContext = previous.expectedRevision === snapshot.revision && previous.inputRevision === (planSlot?.inputRevision ?? 0) && !planSlot?.pending.length;
        if (["prepared", "submitting"].includes(previous.state) && sameContext && sameReviewSource) {
          return { operationId: previous.operationId, planningId: id, role: "review", reused: true, nextAction: "handoff_claim" };
        }
        if (["prepared", "submitting"].includes(previous.state) && sameContext && !sameReviewSource) throw new Error("external_review_switch_requires_cancel：当前网页审查操作仍有效；请先在交接面板取消或完成，再更换网页来源／模型");
        if (["prepared", "submitting"].includes(previous.state) && previousSlot.claim && previousSlot.claim.expiresAt > Date.now() && !input.reusePending) throw new Error("handoff_owned：已有网页审查领取处理中；请先在网页归还／结束该操作，再切换审查方式");
      }
      const planSlot = await this.handoffs.load(workspaceId, id, "plan");
      let pending = [...(planSlot?.pending ?? [])];
      if (coordinated && !planSlot) {
        for (const old of (await this.list(workspaceId, id) as Array<{ operationId: string; state: string }>).reverse()) {
          if (old.state !== "prepared") continue;
          const op = await this.load(old.operationId);
          if (op.preparation && !snapshot.requirements?.messageDecisions.some((decision) => decision.messageId === op.preparation!.messageId)) pending.push({ messageId: op.preparation.messageId, content: op.preparation.message, operation: op.preparation.operation });
        }
        pending = [...new Map(pending.map((item) => [item.messageId, item])).values()];
      }
      let review: Awaited<ReturnType<typeof prepareExternalReviewInput>> | undefined;
      if (input.role === "plan") {
        const lastTurn = snapshot.turns.at(-1);
        const prior = input.retry || input.reusePending && lastTurn?.messageId === pending.at(-1)?.messageId && lastTurn?.status !== "succeeded" ? lastTurn : undefined;
        const message = (input.reusePending ? pending.at(-1)?.content : undefined) ?? input.message ?? (prior ? snapshot.messages.find((item) => item.messageId === prior.messageId)?.content : undefined);
        if (!message) throw new Error("external_input_invalid：请提供当前用户输入");
        const messageId = prior?.messageId ?? (input.reusePending ? pending.at(-1)?.messageId : undefined) ?? randomUUID();
        const operationInput = input.reusePending && pending.length ? pending.at(-1)!.operation : input.operation ?? prior?.operation ?? false;
        if (coordinated && !pending.some((item) => item.messageId === messageId)) pending.push({ messageId, content: message, operation: operationInput });
        preparation = await prepareExternalPlannerInput({ planningId: id, workspace: workspace.path, message,
          ...(input.plannerConfig ? { plannerConfig: input.plannerConfig } : {}),
          ...(prior ? { retryMessageId: prior.messageId } : { messageId }), operation: operationInput,
          ...(coordinated ? { messages: pending } : {}) });
      } else {
        if (coordinated && pending.length) throw new Error("pending_inputs_require_plan：请先处理已登记的补充需求，再审查");
        review = await prepareExternalReviewInput(id, workspace.path);
      }
      const now = new Date().toISOString();
      const operation: ExternalOperation = { operationId: randomUUID(), workspaceId, planningId: id, role: input.role, state: "prepared",
        expectedRevision: preparation?.expectedRevision ?? review!.expectedRevision,
        ...(coordinated ? { coordinated: true, inputRevision: (planSlot?.inputRevision ?? 0) + (input.role === "plan" ? 1 : 0) } : {}),
        ...(preparation ? { preparation } : { reviewInput: review!.input, ...(input.reviewerConfig ? { reviewerConfig: input.reviewerConfig } : {}) }),
        evidence: [], reads: [], outputBytes: 0, outputBudgetBytes: DEFAULT_REPOSITORY_OUTPUT_BUDGET, attempts: 0, createdAt: now, updatedAt: now };
      await this.save(operation);
      if (coordinated) {
        await this.handoffs.save({ schemaVersion: 1, workspaceId, planningId: id, role: input.role, operationId: operation.operationId,
          code: "TC-" + randomBytes(5).toString("hex").toUpperCase(), target: input.target ?? previousSlot?.target ?? "any",
          generation: (previousSlot?.generation ?? 0) + 1, inputRevision: operation.inputRevision!, pending: input.role === "plan" ? pending : [], updatedAt: now });
      }
      await this.service.publish({ type: "external.prepared", workspaceId, planningId: id, payload: { operationId: operation.operationId, role: input.role } });
      return { operationId: operation.operationId, planningId: id, role: input.role, nextAction: coordinated ? "handoff_claim" : "external_context" };
  }

  async context(workspaceId: string, operationId: string, includeContext = true, actor?: WebActor, proof?: ClaimProof): Promise<unknown> {
    if (actor && includeContext) return this.withOperation(workspaceId, operationId, actor, proof, async () => this.context(workspaceId, operationId, true));
    const op = await this.owned(workspaceId, operationId);
    const slot = op.coordinated ? await this.handoffs.load(workspaceId, op.planningId, op.role) : undefined;
    const budget = outputBudget(op);
    return { operationId, planningId: op.planningId, role: op.role, state: op.state, attempts: op.attempts, remainingAttempts: Math.max(0, 3 - op.attempts),
      readBudget: { limitBytes: budget, usedBytes: op.outputBytes, remainingBytes: Math.max(0, budget - op.outputBytes), maximumBytes: MAX_OUTPUT_BUDGET, extensionBytes: OUTPUT_BUDGET_INCREMENT },
      ...(slot ? { handoff: this.handoffs.public(slot) } : {}), ...(op.diagnostic ? { diagnostic: op.diagnostic } : {}), ...(op.result ? { result: op.result } : {}),
      ...(includeContext ? { protocol: op.preparation ? externalPlannerProtocol(op.preparation.input) : externalReviewProtocol(op.reviewInput!),
        input: op.preparation?.input ?? op.reviewInput, evidence: op.evidence,
        sourceMessageId: op.preparation?.messageId, modelIdentity: "declared_not_observed",
        instructions: "使用 repository_query 按需调研；响应中的 result 是读取数据，readBudget 显示累计预算。默认 256 KiB；若不足，先暂停并提示用户在 4177 确认扩容后再继续。external_submit 提交 JSON。失败时根据具体诊断修正，最多三次；人工批准和工具审批请在本地控制台处理。" } : {}) };
  }

  async list(workspaceId: string, planningId?: string): Promise<unknown[]> {
    const entries = [];
    for (const name of (await readdir(this.directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).slice(-500)) {
      const op = await this.load(name.slice(0, -5)).catch(() => undefined);
      const slot = op?.coordinated ? await this.handoffs.load(workspaceId, op.planningId, op.role) : undefined;
      if (op?.workspaceId === workspaceId && (!planningId || op.planningId === planningId)) entries.push({ operationId: op.operationId, role: op.role, coordinated: !!op.coordinated, isCurrent: !op.coordinated || slot?.operationId === op.operationId, state: op.state, planningId: op.planningId, completedBy: op.completedBy, message: op.preparation?.message, sourceMessageId: op.preparation?.messageId, expectedRevision: op.expectedRevision, diagnostic: op.diagnostic, readBudget: { limitBytes: outputBudget(op), usedBytes: op.outputBytes, remainingBytes: Math.max(0, outputBudget(op) - op.outputBytes), maximumBytes: MAX_OUTPUT_BUDGET }, updatedAt: op.updatedAt });
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  }

  async read(workspaceId: string, operationId: string, name: "repo_list" | "repo_read" | "repo_search", args: unknown, actor?: WebActor, proof?: ClaimProof): Promise<unknown> {
    return this.withOperation(workspaceId, operationId, actor, proof, async () => {
      const op = await this.owned(workspaceId, operationId);
      if (op.state !== "prepared") throw new Error("external_operation_unavailable：仅待提交操作可以调研");
      if (op.reads.length + (op.historyCalls ?? 0) >= 20) throw new Error("repository_tool_limit：本轮最多 20 次只读调研");
      const workspace = await this.service.getWorkspace(workspaceId);
      const budget = outputBudget(op), remaining = Math.max(1, budget - op.outputBytes);
      const reader = new RepositoryReader(workspace.path, undefined, op.evidence.reduce((sum, item) => sum + item.sizeBytes, 0), remaining);
      const result = await reader.invoke(name, args);
      const size = Buffer.byteLength(result, "utf8");
      if (op.outputBytes + size > budget) throw new Error(`repository_output_limit：本轮只读输出已达 ${formatBudget(budget)}；可在 4177 确认扩容后继续`);
      const evidence = new Map(op.evidence.map((item) => [item.path, item]));
      for (const item of reader.getEvidence()) evidence.set(item.path, item);
      await this.save({ ...op, evidence: [...evidence.values()], reads: [...op.reads, { name, args, result }], outputBytes: op.outputBytes + size, updatedAt: new Date().toISOString() });
      return { result: JSON.parse(result) as unknown, readBudget: { limitBytes: budget, usedBytes: op.outputBytes + size, remainingBytes: Math.max(0, budget - op.outputBytes - size), maximumBytes: MAX_OUTPUT_BUDGET } };
    });
  }

  async extendReadBudget(workspaceId: string, operationId: string, confirmed: boolean): Promise<unknown> {
    if (!confirmed) throw new Error("repository_budget_confirmation_required：必须由本机页面明确确认扩容");
    return this.serial(operationId, async () => {
      const op = await this.owned(workspaceId, operationId);
      if (op.state !== "prepared") throw new Error("external_operation_unavailable：只有待处理的网页操作可以扩容");
      const previousBytes = outputBudget(op);
      if (previousBytes >= MAX_OUTPUT_BUDGET) throw new Error("repository_budget_maximum：本次操作已达到 1 MiB 上限");
      const nextBytes = Math.min(MAX_OUTPUT_BUDGET, previousBytes + OUTPUT_BUDGET_INCREMENT);
      const budgetExtensions = [...(op.budgetExtensions ?? []), { previousBytes, nextBytes, confirmedAt: new Date().toISOString() }];
      await this.save({ ...op, outputBudgetBytes: nextBytes, budgetExtensions, updatedAt: new Date().toISOString() });
      return { operationId, readBudget: { limitBytes: nextBytes, usedBytes: op.outputBytes, remainingBytes: Math.max(0, nextBytes - op.outputBytes), maximumBytes: MAX_OUTPUT_BUDGET }, budgetExtensions };
    });
  }

  async history(workspaceId: string, operationId: string, messageIds: string[], actor?: WebActor, proof?: ClaimProof): Promise<unknown> {
    return this.withOperation(workspaceId, operationId, actor, proof, async () => {
      const op = await this.owned(workspaceId, operationId);
      if (op.state !== "prepared" || op.reads.length + (op.historyCalls ?? 0) >= 20) throw new Error("history_query_limit：操作已结束或达到只读调研上限");
      const workspace = await this.service.getWorkspace(workspaceId);
      const snapshot = await new PlannerStore(workspace.path).load(op.planningId);
      if (snapshot.revision !== op.expectedRevision) throw new Error("external_context_stale：追溯上下文已变化，请重新准备");
      const slot = await this.handoffs.load(workspaceId, op.planningId, "plan");
      const preview = { ...snapshot, messages: [...snapshot.messages, ...(slot?.pending ?? []).filter((item) => !snapshot.messages.some((old) => old.messageId === item.messageId)).map((item) => ({ messageId: item.messageId, role: "user" as const, content: item.content }))] };
      const text = await createHistoryReader(preview, slot?.pending.map(item => item.messageId) ?? [])(messageIds);
      const bytes = Buffer.byteLength(text, "utf8");
      const budget = outputBudget(op);
      if (op.outputBytes + bytes > budget) throw new Error(`history_output_limit：本轮只读输出已达 ${formatBudget(budget)}；可在 4177 确认扩容后继续`);
      await this.save({ ...op, outputBytes: op.outputBytes + bytes, historyCalls: (op.historyCalls ?? 0) + 1, updatedAt: new Date().toISOString() });
      return { result: JSON.parse(text) as unknown, readBudget: { limitBytes: budget, usedBytes: op.outputBytes + bytes, remainingBytes: Math.max(0, budget - op.outputBytes - bytes), maximumBytes: MAX_OUTPUT_BUDGET } };
    });
  }

  async submit(workspaceId: string, operationId: string, requestKey: string, reply: unknown, actor?: WebActor, proof?: ClaimProof): Promise<JobRecord> {
    const workspace = await this.service.getWorkspace(workspaceId);
    // Dedupe is checked by ApplicationService before the background action.
    return this.service.submit(workspaceId, "external.submit", requestKey, { operationId, reply }, async () => this.withOperation(workspaceId, operationId, actor, proof, async () => {
      let op = await this.owned(workspaceId, operationId);
      if (op.state !== "prepared" || op.attempts >= 3) throw new Error("external_operation_unavailable：操作已结束，请查询原结果或重新准备");
      const snapshot = await new PlannerStore(workspace.path).load(op.planningId);
      if (snapshot.revision !== op.expectedRevision) { await this.save({ ...op, state: "stale", diagnostic: "草案或需求已变化，请重新准备" }); throw new Error("external_context_stale：草案或需求已变化，请重新准备"); }
      const changed = await verifyRepositoryEvidence(workspace.path, op.evidence);
      if (changed.length) { await this.save({ ...op, state: "stale", diagnostic: changed.join(", ") }); throw new Error("workspace_changed：调研依据已变化：" + changed.join(", ")); }
      op = { ...op, state: "submitting", attempts: op.attempts + 1, updatedAt: new Date().toISOString() }; await this.save(op);
      try {
        let result: unknown;
        if (op.role === "plan") {
          const committed = await submitExternalPlannerReply({ planningId: op.planningId, workspace: workspace.path, preparation: op.preparation!, reply, operationId, evidence: op.evidence, reads: op.reads, outputBudgetBytes: outputBudget(op), beforeCommit: async () => { await actor?.assertActive?.(); } });
          if (committed.error) {
            op = { ...op, preparation: await prepareExternalPlannerInput({ planningId: op.planningId, workspace: workspace.path, message: op.preparation!.message, retryMessageId: op.preparation!.messageId, operation: op.preparation!.operation, ...(op.preparation!.messages ? { messages: op.preparation!.messages } : {}) }), expectedRevision: committed.snapshot.revision };
            throw new Error(committed.error);
          }
          result = { planningId: op.planningId, status: committed.snapshot.status, draftRevision: committed.draft?.draftRevision };
        } else {
          const committed = await reviewPlannerDraft({ planningId: op.planningId, workspace: workspace.path, expectedRevision: op.expectedRevision, ...(op.reviewerConfig ? { reviewerConfig: op.reviewerConfig } : {}), repositoryOutputBudgetBytes: outputBudget(op), beforeCommit: async () => { await actor?.assertActive?.(); },
            reviewer: { review: async (_input, context) => {
              for (const read of op.reads) { context.consumeToolCall(); await context.repository.invoke(read.name, read.args); }
              const reread = new Map(context.repository.getEvidence().map((item) => [item.path, item.sha256]));
              if (op.evidence.some((item) => reread.get(item.path) !== item.sha256)) throw new Error("workspace_changed：提交期间文件证据已变化");
              await context.record({ type: "external.response", payload: { operationId } }); return reply;
            } } });
          result = { planningId: op.planningId, reviewId: committed.review.reviewId, findings: committed.review.findings.length };
        }
        if (op.coordinated) {
          const slot = (await this.handoffs.load(workspaceId, op.planningId, op.role))!;
          op = { ...op, completedBy: { grantId: slot.claim!.grantId, clientId: slot.claim!.clientId, ...(slot.claim!.source ? { source: slot.claim!.source } : {}), generation: slot.generation } };
          if (op.role === "plan") slot.pending = [];
          delete slot.claim;
          await this.handoffs.save(slot);
        }
        await this.save({ ...op, state: "succeeded", result, updatedAt: new Date().toISOString() });
        await this.service.publish({ type: "external.completed", workspaceId, planningId: op.planningId, payload: { operationId, role: op.role, completedBy: op.completedBy } });
        return result;
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        const state = /external_context_stale|workspace_changed/.test(diagnostic) ? "stale" : op.attempts < 3 ? "prepared" : "failed";
        await this.save({ ...op, state, diagnostic, updatedAt: new Date().toISOString() });
        throw new Error(`${diagnostic}；${state === "prepared" ? "请复用本 operationId 和证据修正 JSON，使用新的 requestKey 重新提交" : "请重新准备上下文"}`);
      }
    }));
  }

  async cancel(workspaceId: string, operationId: string, actor?: WebActor, proof?: ClaimProof): Promise<unknown> {
    const existing = await this.owned(workspaceId, operationId);
    if (existing.coordinated && !actor) return this.handoffs.serial(workspaceId, existing.planningId, existing.role, async () => {
      const slot = await this.handoffs.load(workspaceId, existing.planningId, existing.role);
      if (slot?.operationId === operationId) { slot.generation++; delete slot.claim; await this.handoffs.save(slot); }
      const op = await this.load(operationId);
      if (op.state === "prepared") await this.save({ ...op, state: "cancelled", updatedAt: new Date().toISOString() });
      return this.context(workspaceId, operationId, false);
    });
    return this.withOperation(workspaceId, operationId, actor, proof, async () => {
      const op = await this.owned(workspaceId, operationId);
      if (op.state === "prepared") await this.save({ ...op, state: "cancelled", updatedAt: new Date().toISOString() });
      return this.context(workspaceId, operationId, false);
    });
  }

  async queryHandoffs(workspaceId: string, planningId?: string, code?: string): Promise<unknown[]> {
    await this.service.getWorkspace(workspaceId);
    const result = [];
    for (const slot of await this.handoffs.slots(workspaceId, planningId)) {
      if (code && slot.code !== code) continue;
      const op = await this.load(slot.operationId);
      result.push({ ...(this.handoffs.public(slot) as object), state: op.state, completedBy: op.completedBy });
    }
    return result;
  }

  async claim(workspaceId: string, operationId: string, requestKey: string, actor: WebActor): Promise<unknown> {
    const op = await this.owned(workspaceId, operationId);
    return this.handoffs.serial(workspaceId, op.planningId, op.role, async () => {
      const slot = await this.handoffs.load(workspaceId, op.planningId, op.role);
      const current = await this.load(operationId);
      if (!slot || slot.operationId !== operationId) throw new Error("handoff_superseded：请查询当前操作");
      if (current.state !== "prepared") throw new Error("handoff_unavailable：操作已结束或中断，先查询结果并对账");
      const workspace = await this.service.getWorkspace(workspaceId);
      if ((await new PlannerStore(workspace.path).load(op.planningId)).revision !== op.expectedRevision) throw new Error("external_context_stale：草案或需求已变化，请重新准备交接");
      const planSlot = await this.handoffs.load(workspaceId, op.planningId, "plan");
      if (op.inputRevision !== (planSlot?.inputRevision ?? slot.inputRevision)) throw new Error("external_context_stale：补充输入已变化，请在本地重新准备交接");
      const proof = await this.handoffs.claim(slot, actor, requestKey);
      return { ...proof, context: await this.context(workspaceId, operationId), nextAction: "repository_query / external_submit；全部携带 claimToken 和 generation" };
    });
  }

  async release(workspaceId: string, operationId: string, actor: WebActor, proof: ClaimProof): Promise<unknown> {
    return this.withOperation(workspaceId, operationId, actor, proof, async () => {
      const op = await this.load(operationId), slot = (await this.handoffs.load(workspaceId, op.planningId, op.role))!;
      delete slot.claim; slot.generation++; await this.handoffs.save(slot);
      return this.handoffs.public(slot);
    }, false);
  }

  async handoff(workspaceId: string, planningId: string, requestKey: string, role: "plan" | "review", target: WebSource, reason?: string): Promise<JobRecord> {
    if (!["chatgpt", "claude", "other", "any"].includes(target)) throw new Error("handoff_target_invalid");
    return this.service.submit(workspaceId, "external.handoff", requestKey, { planningId, role, target, reason }, async () => {
      const observedSlot = await this.handoffs.load(workspaceId, planningId, role);
      const observed = observedSlot ? await this.load(observedSlot.operationId) : undefined;
      return this.handoffs.serial(workspaceId, planningId, role, async () => {
        let slot = await this.handoffs.load(workspaceId, planningId, role);
        let op = slot ? await this.load(slot.operationId) : undefined;
        if (observed && ["prepared", "submitting"].includes(observed.state) && op?.operationId === observed.operationId && op.state === "succeeded") return { operationId: op.operationId, planningId, state: op.state, result: op.result, nextAction: "planning_query：提交已经完成，无需重放" };
        if (op?.state === "interrupted") throw new Error("handoff_interrupted：提交中断，请先核对领域草案／审查和原 job；不会自动重放");
        const workspace = await this.service.getWorkspace(workspaceId), snapshot = await new PlannerStore(workspace.path).load(planningId);
        const planSlot = await this.handoffs.load(workspaceId, planningId, "plan");
        if (!op || !op.coordinated || op.state !== "prepared" || op.expectedRevision !== snapshot.revision || op.inputRevision !== (planSlot?.inputRevision ?? op.inputRevision)) {
          const last = planSlot?.pending.at(-1);
          await this.prepareSlot(workspaceId, planningId, { role, planningId, coordinated: true, target, reusePending: true,
            ...(role === "plan" ? { message: last?.content ?? "根据当前有效需求和审查继续规划，保持需求身份；无需变更时说明当前状态。", operation: !last } : {}) });
          slot = await this.handoffs.load(workspaceId, planningId, role);
        }
        const current = slot!;
        current.target = target; current.generation++; delete current.claim;
        if (reason) current.reason = reason;
        await this.handoffs.save(current);
        await this.service.publish({ type: "external.handoff", workspaceId, planningId, payload: { operationId: current.operationId, target, generation: current.generation } });
        return this.handoffs.public(current);
      });
    });
  }

  async reconcile(workspaceId: string, operationId: string): Promise<unknown> {
    const existing = await this.owned(workspaceId, operationId);
    return this.handoffs.serial(workspaceId, existing.planningId, existing.role, async () => {
      const op = await this.load(operationId);
      if (op.state !== "interrupted") return this.context(workspaceId, operationId, false);
      const workspace = await this.service.getWorkspace(workspaceId), store = new PlannerStore(workspace.path), snapshot = await store.load(op.planningId);
      let result: unknown;
      if (op.role === "plan") {
        for (const turn of snapshot.turns.filter(item => item.status === "succeeded" && item.messageId === op.preparation?.messageId)) {
          const record = JSON.parse(await readFile(join(workspace.path, ".token-coupon", "planners", op.planningId, "turns", turn.turnId, "turn.json"), "utf8")) as { events?: Array<{ type: string; payload?: { operationId?: string } }> };
          if (record.events?.some(event => event.type === "external.response" && event.payload?.operationId === operationId)) result = { planningId: op.planningId, status: snapshot.status, draftRevision: snapshot.draftRevision };
        }
      } else if (snapshot.latestReviewId) {
        const directory = join(workspace.path, ".token-coupon", "planners", op.planningId, "reviews", snapshot.latestReviewId);
        const review = JSON.parse(await readFile(join(directory, "review.json"), "utf8")) as { status: string; findings: unknown[] };
        const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; payload?: { operationId?: string } });
        if (review.status === "succeeded" && events.some(event => event.type === "external.response" && event.payload?.operationId === operationId)) result = { planningId: op.planningId, reviewId: snapshot.latestReviewId, findings: review.findings.length };
      }
      if (!result) throw new Error("reconciliation_unknown：未找到与本 operationId 对应的权威成功记录；保持中断，不自动重放。请先检查原 job 和领域日志");
      await this.save({ ...op, state: "succeeded", result, diagnostic: "已根据领域成功记录对账；未重新调用模型", updatedAt: new Date().toISOString() });
      const slot = await this.handoffs.load(workspaceId, op.planningId, op.role);
      if (slot?.operationId === operationId) { delete slot.claim; if (op.role === "plan") slot.pending = []; await this.handoffs.save(slot); }
      return this.context(workspaceId, operationId, false);
    });
  }

  private async withOperation<T>(workspaceId: string, operationId: string, actor: WebActor | undefined, proof: ClaimProof | undefined, action: () => Promise<T>, checkContext = true): Promise<T> {
    const op = await this.owned(workspaceId, operationId);
    if (!op.coordinated) { await actor?.assertActive?.(); const slot = await this.handoffs.load(workspaceId, op.planningId, op.role); if (slot) throw new Error("handoff_superseded：此旧操作已启用交接，请领取当前操作"); return this.serial(operationId, action); }
    return this.handoffs.serial(workspaceId, op.planningId, op.role, async () => {
      const slot = await this.handoffs.load(workspaceId, op.planningId, op.role);
      if (!slot) throw new Error("handoff_superseded：协调记录不存在");
      await this.handoffs.validate(slot, operationId, actor, proof);
      const planSlot = await this.handoffs.load(workspaceId, op.planningId, "plan");
      if (checkContext && op.inputRevision !== (planSlot?.inputRevision ?? slot.inputRevision)) throw new Error("external_context_stale：登记输入已变化，请重新准备");
      if (checkContext) {
        const workspace = await this.service.getWorkspace(workspaceId);
        if ((await new PlannerStore(workspace.path).load(op.planningId)).revision !== op.expectedRevision) throw new Error("external_context_stale：草案或需求已变化，请重新准备交接");
      }
      return action();
    });
  }

  private async owned(workspaceId: string, operationId: string): Promise<ExternalOperation> {
    await this.service.getWorkspace(workspaceId);
    const op = await this.load(operationId);
    if (op.workspaceId !== workspaceId) throw new Error("external_operation_not_found：操作不属于当前项目");
    return op;
  }
  private async load(operationId: string): Promise<ExternalOperation> {
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("external_operation_invalid：操作 ID 无效");
    const op = JSON.parse(await readFile(join(this.directory, `${operationId}.json`), "utf8")) as ExternalOperation;
    if (op.operationId !== operationId || !["plan", "review"].includes(op.role)) throw new Error("external_operation_invalid：操作记录无效");
    return op;
  }
  private async save(op: ExternalOperation): Promise<void> {
    const target = join(this.directory, `${op.operationId}.json`), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(op, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, target);
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(id, current); await before;
    try { return await action(); } finally { release(); if (this.queues.get(id) === current) this.queues.delete(id); }
  }
}
