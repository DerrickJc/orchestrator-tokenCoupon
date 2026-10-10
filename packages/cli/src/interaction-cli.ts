import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import type { RunnerInteractionOwner, RunnerInteractionReply, RunnerInteractionRequest } from "@token-coupon/core";

export type AskRunnerInput = (prompt: string, signal?: AbortSignal) => Promise<string | null>;
export type InteractionOutput = (text: string) => void;

export function createRunnerInteractionIO(options: { workspace: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean; onCancel?: () => void }): { onInteraction: ReturnType<typeof createRunnerInteractionHandler>; close: () => void } {
  const rl = options.isTTY ? createInterface({ input: options.input, output: options.output, terminal: true }) : undefined;
  const cancel = () => options.onCancel?.();
  rl?.on("SIGINT", cancel);
  const ask: AskRunnerInput = async (prompt, signal) => {
    if (!rl) return null;
    try { return await rl.question(prompt, signal ? { signal } : {}); }
    catch { return null; }
  };
  return {
    onInteraction: createRunnerInteractionHandler({ workspace: options.workspace, isTTY: options.isTTY, ask, output: (text) => options.output.write(text) }),
    close: () => { rl?.removeListener("SIGINT", cancel); rl?.close(); },
  };
}

export function createRunnerInteractionHandler(options: {
  workspace: string;
  isTTY: boolean;
  ask: AskRunnerInput;
  output: InteractionOutput;
}): (requestId: string, request: RunnerInteractionRequest, owner: RunnerInteractionOwner, signal: AbortSignal) => Promise<RunnerInteractionReply> {
  let queue = Promise.resolve();
  return (requestId, request, owner, signal) => {
    const current = queue.then(() => handleInteraction(options, requestId, request, owner, signal));
    queue = current.then(() => undefined, () => undefined);
    return current;
  };
}

async function handleInteraction(
  options: { workspace: string; isTTY: boolean; ask: AskRunnerInput; output: InteractionOutput },
  requestId: string,
  request: RunnerInteractionRequest,
  owner: RunnerInteractionOwner,
  signal: AbortSignal,
): Promise<RunnerInteractionReply> {
  if (signal.aborted) throw new Error("Attempt 已取消");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const inbox = waitForInbox(options.workspace, owner, requestId, requestSignal);
  const foreground = options.isTTY ? promptForReply(options.ask, options.output, requestId, request, owner, controller.signal) : neverReply();
  try {
    const result = await Promise.race([foreground, inbox]);
    controller.abort(new Error("交互请求已由另一终端处理"));
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function promptForReply(ask: AskRunnerInput, output: InteractionOutput, requestId: string, request: RunnerInteractionRequest, owner: RunnerInteractionOwner, signal: AbortSignal): Promise<RunnerInteractionReply> {
  output(`\n\n需要人工处理：${request.title}\nRunner：${owner.runnerId} · Task：${owner.taskId} · Attempt：${owner.attemptId}\n请求 ID：${requestId}\n工作目录：${request.cwd ?? owner.cwd}\n${request.summary}\n`);
  if (request.kind === "approval") {
    if (request.operation?.command) output(`命令：${request.operation.command}\n`);
    if (request.operation?.paths?.length) output(`路径：${request.operation.paths.join(", ")}\n`);
    const answer = (await ask("输入 allow-once 执行本次请求，或 deny 拒绝：", signal))?.trim().toLowerCase();
    if (answer === "allow-once" || answer === "allow" || answer === "y" || answer === "yes") return { kind: "approval", decision: "allow-once" };
    if (answer === "deny" || answer === "n" || answer === "no") return { kind: "approval", decision: "deny" };
    throw new Error("审批回复无效；请明确输入 allow-once 或 deny");
  }
  const answers: Array<{ questionId: string; optionIds?: string[]; text?: string }> = [];
  for (const question of request.questions ?? []) {
    output(`\n${question.header ? `[${question.header}] ` : ""}${question.text}\n`);
    for (const [index, option] of (question.options ?? []).entries()) output(`  ${index + 1}. ${option.label}\n`);
    const prompt = question.multiple ? "输入选项编号/ID（逗号分隔）" : "输入选项编号/ID";
    const raw = (await ask(`${prompt}${question.allowFreeText ? "，或输入文字" : ""}：`, signal))?.trim();
    if (!raw) {
      if (question.required !== false) throw new Error(`问题 ${question.id} 必须回答`);
      continue;
    }
    const selected = raw.split(",").map((item) => item.trim()).filter(Boolean);
    const optionsById = new Map((question.options ?? []).flatMap((option, index) => [[option.id, option.id], [String(index + 1), option.id]]));
    const optionIds = selected.map((item) => optionsById.get(item));
    if (optionIds.length && optionIds.every((item): item is string => item !== undefined)) {
      answers.push({ questionId: question.id, optionIds });
      continue;
    }
    if (question.allowFreeText) answers.push({ questionId: question.id, text: raw });
    else throw new Error(`问题 ${question.id} 的选择无效`);
  }
  return { kind: "question", answers };
}

function neverReply(): Promise<RunnerInteractionReply> { return new Promise(() => undefined); }

async function waitForInbox(workspace: string, owner: RunnerInteractionOwner, requestId: string, signal: AbortSignal): Promise<RunnerInteractionReply> {
  const responseDir = join(resolve(workspace), ".token-coupon", "runs", owner.attemptId, "interactions", "responses");
  while (!signal.aborted) {
    const filenames = await readdir(responseDir).catch(() => []);
    const matches: Array<{ submittedAt: string; responseId: string; reply: RunnerInteractionReply }> = [];
    for (const filename of filenames.sort()) {
      if (!UUID.test(filename.replace(/\.json$/, "")) || !filename.endsWith(".json")) continue;
      const path = join(responseDir, filename);
      const fileInfo = await lstat(path).catch(() => undefined);
      if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 16 * 1024) continue;
      const record = await readFile(path, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => undefined);
      const responseId = filename.slice(0, -5);
      if (!record || record.responseId !== responseId || record.requestId !== requestId || record.attemptId !== owner.attemptId || !isIsoDate(record.submittedAt) || !isReply(record.reply)) continue;
      matches.push({ submittedAt: record.submittedAt, responseId, reply: record.reply });
    }
    matches.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt) || left.responseId.localeCompare(right.responseId));
    if (matches[0]) return matches[0].reply;
    await sleep(200, signal);
  }
  throw new Error("Attempt 已取消，等待中的交互回复已失效");
}

export async function readAttemptInteractions(workspace: string, attemptId: string): Promise<Array<{ requestId: string; attemptId: string; taskId: string; runnerId: string; status: string; kind: string; title: string; summary: string; file: string }>> {
  if (!UUID.test(attemptId)) throw new Error("attemptId 格式无效");
  const directory = join(resolve(workspace), ".token-coupon", "runs", attemptId, "interactions");
  const filenames = await readdir(directory).catch(() => []);
  const records = [];
  for (const filename of filenames.sort()) {
    if (!filename.endsWith(".json") || !UUID.test(filename.slice(0, -5))) continue;
    const file = join(directory, filename);
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) continue;
    const value = await readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => undefined);
    const request = value?.request as Record<string, unknown> | undefined;
    if (!value || value.attemptId !== attemptId || typeof value.requestId !== "string" || typeof value.taskId !== "string" || typeof value.runnerId !== "string" || typeof value.status !== "string" || !request || typeof request.kind !== "string") continue;
    records.push({ requestId: value.requestId, attemptId, taskId: value.taskId, runnerId: value.runnerId, status: value.status, kind: request.kind, title: typeof request.title === "string" ? request.title : "(无标题)", summary: typeof request.summary === "string" ? request.summary : "", file });
  }
  return records;
}

export async function submitAttemptInteractionReply(input: { workspace: string; attemptId: string; requestId: string; reply: RunnerInteractionReply }): Promise<string> {
  if (!UUID.test(input.attemptId) || !UUID.test(input.requestId)) throw new Error("Attempt/request ID 格式无效");
  const recordPath = join(resolve(input.workspace), ".token-coupon", "runs", input.attemptId, "interactions", `${input.requestId}.json`);
  const recordInfo = await lstat(recordPath);
  if (!recordInfo.isFile() || recordInfo.isSymbolicLink() || recordInfo.size > 64 * 1024) throw new Error("交互请求文件不安全或超过大小限制");
  const current = await readFile(recordPath, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>);
  if (current.status !== "pending" || current.attemptId !== input.attemptId || current.requestId !== input.requestId) throw new Error("该请求不再等待回复，或不属于此 Attempt");
  const request = current.request as RunnerInteractionRequest;
  validateCliReply(request, input.reply);
  const responseId = randomUUID();
  const directory = join(resolve(input.workspace), ".token-coupon", "runs", input.attemptId, "interactions", "responses");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${responseId}.json`);
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, responseId, requestId: input.requestId, attemptId: input.attemptId, taskId: current.taskId, reply: input.reply, submittedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return responseId;
}

function validateCliReply(request: RunnerInteractionRequest, reply: RunnerInteractionReply): void {
  if (request.kind === "approval") {
    if (reply.kind !== "approval" || !(request.decisions ?? ["allow-once", "deny"]).includes(reply.decision)) throw new Error("回复类型与该审批请求不匹配");
    return;
  }
  if (reply.kind !== "question" || !request.questions?.length) throw new Error("回复类型与该问题请求不匹配");
  const questions = new Map(request.questions.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const answer of reply.answers) {
    const question = questions.get(answer.questionId);
    if (!question || seen.has(answer.questionId)) throw new Error("回复包含未知或重复题目");
    seen.add(answer.questionId);
    if (answer.optionIds?.length && (!question.options || answer.optionIds.some((id) => !question.options!.some((item) => item.id === id)) || (!question.multiple && answer.optionIds.length !== 1))) throw new Error(`问题 ${answer.questionId} 的选项无效`);
    if (answer.text !== undefined && (!question.allowFreeText || !answer.text.trim() || Buffer.byteLength(answer.text, "utf8") > 8192)) throw new Error(`问题 ${answer.questionId} 的文字答案无效`);
    if (!answer.optionIds?.length && answer.text === undefined && question.required !== false) throw new Error(`问题 ${answer.questionId} 必须回答`);
  }
  for (const question of questions.values()) if (question.required !== false && !seen.has(question.id)) throw new Error(`缺少必填问题答案：${question.id}`);
}

function isReply(value: unknown): value is RunnerInteractionReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "approval" ? record.decision === "allow-once" || record.decision === "deny"
    : record.kind === "question" && Array.isArray(record.answers);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) { reject(new Error("cancelled")); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("cancelled")); };
    function done() { signal.removeEventListener("abort", abort); resolveSleep(); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isReplyType(kind: string): kind is "approval" | "question" { return kind === "approval" || kind === "question"; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
