import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  approvePlannerDraft, canonicalHash, checkPlan, createPlanner, diffPlans, formatPlanner, formatSession,
  cleanupSessionWorktrees, continueSessionLanding, createSessionDelivery, formatSessionDelivery, loadCurrentPlanReview, loadPlannerConversation, MockPlanReviewer, MockPlanner, parseWorktreeSetupProfile, PlannerStore, replacePlannerDraft,
  replyToPlanner, retryPlannerTurn, reviewPlannerDraft, runApprovedPlanner, SessionStore, ReviewStore, startPlannerConversation,
  retrySession, resumeSession,
  effectiveRequirements, traceRequirement, revisePlannerDraft, refreshPlannerRequirements,
} from "@token-coupon/core";
import type { PlanChange, PlanReviewRecord, PlannerConfig, PlannerOperationResult, Runner, TaskRunnerFactory, WorktreeSetupProfile } from "@token-coupon/core";
import { ClaudeCodeRunner, MockRunner } from "@token-coupon/core";

const HELP = [
  "用法：",
  "  token-coupon planner start --planner <mock|deepseek> --runner <mock|claude-code>",
  "      --request <需求> [--workspace <目录>] [--planner-model <modelId>]",
  "      [--task-model <modelId>] [--mock-clarify]",
  "  token-coupon planner reply --id <planningId> --message <补充要求> [--workspace <目录>]",
  "  token-coupon planner retry --id <planningId> [--workspace <目录>]",
  "  token-coupon planner show --id <planningId> [--workspace <目录>]",
  "  token-coupon planner list [--workspace <目录>]",
  "  token-coupon planner check (--id <planningId>|--file <plan.json>) [--workspace <目录>]",
  "  token-coupon planner diff --id <planningId> [--from <版本>] [--to <版本>] [--full] [--workspace <目录>]",
  "  token-coupon planner review --id <planningId> [--review-id <reviewId>] [--workspace <目录>]",
  "  token-coupon planner revise --id <planningId> [--message <处理说明>] [--review-id <reviewId>] [--workspace <目录>]",
  "  token-coupon planner requirements --id <planningId> [--refresh] [--workspace <目录>]",
  "  token-coupon planner trace --id <planningId> --requirement <requirementId> [--revision <版本>] [--workspace <目录>]",
  "  token-coupon planner chat [--id <planningId>] [--planner <mock|deepseek> --runner <mock|claude-code>] [--workspace <目录>]",
  "  token-coupon planner export --id <planningId> --file <计划.json> [--workspace <目录>]",
  "  token-coupon planner replace --id <planningId> --file <计划.json> [--workspace <目录>]",
  "  token-coupon planner approve --id <planningId> --revision <版本> [--waive-findings <F1,F2> --waiver-reason <原因>] [--workspace <目录>]",
  "  token-coupon planner run --id <planningId> [--workspace <目录>] [--accept-edits]",
  "      [--isolation git-worktree --verification-task <taskId>] [--max-parallel <1-8>] [--setup-file <setup.json>]",
  "",
  "DeepSeek Planner 配置：TOKEN_COUPON_PLANNER_API_KEY、TOKEN_COUPON_PLANNER_MODEL、",
  "TOKEN_COUPON_PLANNER_BASE_URL（默认 https://api.deepseek.com）。",
  "Planner 模型与任务 Runner 的 --task-model 分开配置。",
].join("\n");

type Action = "start" | "reply" | "retry" | "show" | "list" | "check" | "diff" | "review" | "revise" | "requirements" | "trace" | "chat" | "export" | "replace" | "approve" | "run" | "help";
interface Command { action: Action; values: Map<string, string>; acceptEdits: boolean; mockClarify: boolean; full: boolean; json: boolean; }
export interface PlannerChatIO { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean; }

export async function runPlannerCli(args: string[], chatIO: PlannerChatIO = { input: stdin, output: stdout, isTTY: Boolean(stdin.isTTY && stdout.isTTY) }): Promise<number> {
  let command: Command;
  try { command = parse(args); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  if (command.action === "help") { console.log(HELP); return 0; }
  const get = (key: string) => command.values.get(key);
  const workspace = resolve(get("--workspace") ?? process.cwd());
  try {
    await validateWorkspace(workspace);
    if (command.action === "check" && get("--id") && get("--file")) throw new Error("planner check 的 --id 和 --file 不能同时指定");
    if (command.action === "list") {
      const records = await new PlannerStore(workspace).list();
      if (!records.length) { console.log("当前工作目录没有规划记录。"); return 0; }
      for (const snapshot of records) {
        const draft = snapshot.draftRevision === null ? undefined : await new PlannerStore(workspace).loadDraft(snapshot.planningId, snapshot.draftRevision).catch(() => undefined);
        console.log(`${snapshot.planningId.slice(0, 8)}  ${draft?.plan.title ?? "等待草案"}  ${snapshot.status}  draft-${snapshot.draftRevision ?? "—"}  ${snapshot.updatedAt}`);
      }
      return 0;
    }
    if (command.action === "chat") return await runPlannerChat(command, workspace, chatIO);
    if (command.action === "start") {
      const provider = get("--planner")!;
      const runnerId = get("--runner")!;
      const config: PlannerConfig = provider === "mock"
        ? { provider: "mock", model: "mock", baseUrl: "mock://local" }
        : {
          provider: "deepseek",
          model: get("--planner-model") ?? process.env.TOKEN_COUPON_PLANNER_MODEL ?? "",
          baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com",
        };
      const modelId = get("--task-model");
      const result = await cancellable((signal) => startPlannerConversation({
          workspace, request: get("--request")!, config,
          executionDefaults: { runnerId, mode: "non_interactive", ...(modelId ? { modelId } : {}) },
          ...(provider === "mock" ? {
            planner: new MockPlanner(command.mockClarify
              ? [{ kind: "clarification", message: "在生成计划前，我需要确认实现范围。", questions: ["是否需要同时补充自动化测试？"] }]
              : []),
          } : {}), signal,
        }));
      console.log(formatPlanner(result));
      await printDraftUpdate(result, workspace);
      return result.error ? turnExitCode(result.snapshot.turns.at(-1)?.status) : 0;
    }
    const planningId = get("--id")!;
    if (command.action === "check") {
      const defaults = planningId ? (await new PlannerStore(workspace).load(planningId)).executionDefaults : undefined;
      let value: unknown;
      if (get("--file")) {
        const file = resolve(get("--file")!);
        const info = await stat(file);
        if (info.size > 4 * 1024 * 1024) throw new Error("导入计划不能超过 4 MiB");
        value = JSON.parse(await readFile(file, "utf8")) as unknown;
      } else {
        const snapshot = await new PlannerStore(workspace).load(planningId);
        if (snapshot.draftRevision === null) throw new Error("规划记录中没有可检查的草案");
        value = (await new PlannerStore(workspace).loadDraft(planningId, snapshot.draftRevision)).plan;
      }
      const checked = checkPlan(value, defaults);
      if (!checked.valid) {
        for (const diagnostic of checked.diagnostics) console.error(`${diagnostic.severity} ${diagnostic.path}: ${diagnostic.message}`);
        return 2;
      }
      console.log(`计划结构有效；SHA-256：${checked.planHash}`);
      console.log(checked.executionPolicyChecked ? "执行配置：已与规划记录核对。" : "执行配置：未绑定规划记录，未核对。");
      return 0;
    }
    if (command.action === "diff") {
      const store = new PlannerStore(workspace);
      const snapshot = await store.load(planningId);
      if (snapshot.draftRevision === null) throw new Error("规划记录中没有可比较的草案");
      const to = Number(get("--to") ?? snapshot.draftRevision);
      const fromArg = get("--from");
      if (to !== snapshot.draftRevision && !get("--to")) throw new Error("目标版本必须是当前草案版本");
      if (!Number.isSafeInteger(to) || to < 1 || to > snapshot.draftRevision) throw new Error("--to 必须是有效草案版本");
      if (!fromArg && to === 1) { console.log("首次生成的计划，没有前一版本可比较。"); return 0; }
      const from = Number(fromArg ?? to - 1);
      if (!Number.isSafeInteger(from) || from < 1 || from >= to) throw new Error("--from 必须是小于目标版本的有效版本");
      const before = await store.loadDraft(planningId, from);
      const after = await store.loadDraft(planningId, to);
      const changes = diffPlans(before.plan, after.plan);
      if (command.json) console.log(JSON.stringify({ from, to, changes }, null, 2));
      else printPlanDiff(from, to, changes, command.full);
      return 0;
    }
    if (command.action === "requirements") {
      if (get("--refresh")) {
        const result = await cancellable((signal) => refreshPlannerRequirements({ planningId, workspace, signal }));
        console.log(formatPlanner(result));
        await printDraftUpdate(result, workspace);
        if (result.error) return turnExitCode(result.snapshot.turns.at(-1)?.status);
      }
      printRequirements((await new PlannerStore(workspace).load(planningId)).requirements);
      return 0;
    }
    if (command.action === "trace") {
      const revision = get("--revision");
      printRequirementTrace(traceRequirement(await new PlannerStore(workspace).load(planningId), get("--requirement")!, revision === undefined ? undefined : Number(revision)));
      return 0;
    }
    if (command.action === "revise") {
      const result = await cancellable((signal) => revisePlannerDraft({ planningId, workspace, signal, ...(get("--message") ? { message: get("--message")! } : {}), ...(get("--review-id") ? { reviewId: get("--review-id")! } : {}) }));
      console.log(formatPlanner(result));
      await printDraftUpdate(result, workspace);
      return result.error ? turnExitCode(result.snapshot.turns.at(-1)?.status) : 0;
    }
    if (command.action === "review") {
      const reviewId = get("--review-id");
      if (reviewId) {
        const record = await new ReviewStore(workspace).load(planningId, reviewId);
        const current = (await loadCurrentPlanReview(planningId, workspace))?.reviewId === reviewId;
        console.log(formatReview(record, current));
        return record.status === "succeeded" ? 0 : 1;
      }
      const result = await cancellable((signal) => reviewPlannerDraft({ planningId, workspace, signal }));
      console.log(formatReview(result.review, true));
      console.log("审查不会执行或修改计划；批准前请处理 error 问题。");
      return 0;
    }
    if (command.action === "show") {
      console.log(formatPlanner(await loadPlannerConversation(planningId, workspace)));
      return 0;
    }
    if (command.action === "reply") {
      const result = await cancellable((signal) => replyToPlanner({ planningId, workspace, message: get("--message")!, signal }));
      console.log(formatPlanner(result));
      await printDraftUpdate(result, workspace);
      return result.error ? turnExitCode(result.snapshot.turns.at(-1)?.status) : 0;
    }
    if (command.action === "retry") {
      const result = await cancellable((signal) => retryPlannerTurn({ planningId, workspace, signal }));
      console.log(formatPlanner(result));
      await printDraftUpdate(result, workspace);
      return result.error ? turnExitCode(result.snapshot.turns.at(-1)?.status) : 0;
    }
    if (command.action === "export") {
      const result = await loadPlannerConversation(planningId, workspace);
      if (!result.draft) throw new Error("规划记录中没有可导出的计划");
      const path = resolve(get("--file")!);
      await writeFile(path, JSON.stringify(result.draft.plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("已导出草案版本 draft-" + result.draft.draftRevision + "：" + path);
      return 0;
    }
    if (command.action === "replace") {
      const path = resolve(get("--file")!);
      const info = await stat(path);
      if (info.size > 4 * 1024 * 1024) throw new Error("导入计划不能超过 4 MiB");
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const result = await replacePlannerDraft({ planningId, workspace, value });
      console.log(formatPlanner(result));
      await printDraftUpdate(result, workspace);
      return 0;
    }
    if (command.action === "approve") {
      const waivedFindingIds = get("--waive-findings")?.split(",").map((id) => id.trim()).filter(Boolean);
      const reviewId = get("--review-id");
      const waiverReason = get("--waiver-reason");
      const result = await cancellable((signal) => approvePlannerDraft({ planningId, workspace, draftRevision: Number(get("--revision")),
        ...(reviewId ? { reviewId } : {}), ...(waivedFindingIds ? { waivedFindingIds } : {}),
        ...(waiverReason ? { waiverReason } : {}), signal }));
      console.log(formatPlanner(result));
      return 0;
    }
    if (command.action === "run") {
      const setupProfile = get("--setup-file") ? await readSetupFile(get("--setup-file")!) : undefined;
      const result = await cancellable((signal) => runApprovedPlanner({
          planningId, workspace, createRunner: createTaskRunner, acceptEdits: command.acceptEdits,
          ...(get("--isolation") === "git-worktree" ? { isolation: "git-worktree" as const } : {}),
          ...(get("--verification-task") ? { verificationTaskId: get("--verification-task")! } : {}),
          ...(get("--max-parallel") ? { maxParallel: Number(get("--max-parallel")) } : {}), signal,
          ...(setupProfile ? { setupProfile } : {}),
          onOutput: (taskId, output, attemptId) => {
            const visible = output.displayText ?? output.agentText;
            if (visible) process.stdout.write((Number(get("--max-parallel") ?? "1") > 1 ? `\n[${taskId}${attemptId ? `#${attemptId.slice(0, 8)}` : ""}] ` : "") + visible);
            else if (output.stream === "stderr" && output.text) process.stderr.write(output.text);
          },
          onIdleState: (taskId, state) => console.error(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。` : `\n[${taskId}] 输出已恢复。`),
        }));
      console.log(formatPlanner(result));
      if (result.snapshot.execution) {
        const record = await new SessionStore(workspace).load(result.snapshot.execution.sessionId);
        console.log(formatSession(record.snapshot, record.plan));
        return sessionExitCode(record.snapshot);
      }
      return 1;
    }
    console.error(HELP);
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parse(args: string[]): Command {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { action: "help", values: new Map(), acceptEdits: false, mockClarify: false, full: false, json: false };
  const [actionValue, ...options] = args;
  const actions: Action[] = ["start", "reply", "retry", "show", "list", "check", "diff", "review", "revise", "requirements", "trace", "chat", "export", "replace", "approve", "run"];
  if (!actions.includes(actionValue as Action)) throw new Error("planner 子命令无效。请运行 token-coupon planner --help 查看用法。");
  const action = actionValue as Action;
  const allowedByAction: Record<Action, string[]> = {
    start: ["--planner", "--runner", "--request", "--workspace", "--planner-model", "--task-model"],
    reply: ["--id", "--message", "--workspace"],
    retry: ["--id", "--workspace"], show: ["--id", "--workspace"],
    list: ["--workspace"], check: ["--id", "--file", "--workspace"], diff: ["--id", "--from", "--to", "--workspace"],
    review: ["--id", "--review-id", "--workspace"],
    revise: ["--id", "--message", "--review-id", "--workspace"], requirements: ["--id", "--workspace"], trace: ["--id", "--requirement", "--revision", "--workspace"],
    chat: ["--id", "--planner", "--runner", "--workspace", "--planner-model", "--task-model"],
    export: ["--id", "--file", "--workspace"], replace: ["--id", "--file", "--workspace"],
    approve: ["--id", "--revision", "--review-id", "--waive-findings", "--waiver-reason", "--workspace"], run: ["--id", "--workspace", "--isolation", "--verification-task", "--setup-file", "--max-parallel"],
    help: [],
  };
  const allowed = allowedByAction[action];
  const values = new Map<string, string>();
  let acceptEdits = false;
  let mockClarify = false;
  let full = false;
  let json = false;
  for (let index = 0; index < options.length; index += 1) {
    const key = options[index]!;
    if (key === "--refresh") {
      if (action !== "requirements" || values.has(key)) throw new Error("--refresh 只适用于 planner requirements，且只能指定一次");
      values.set(key, "true");
      continue;
    }
    if (key === "--mock-clarify") {
      if (action !== "start" || mockClarify) throw new Error("--mock-clarify 只适用于 planner start，且只能指定一次");
      mockClarify = true;
      continue;
    }
    if (key === "--accept-edits") {
      if (!["run", "chat"].includes(action) || acceptEdits) throw new Error("--accept-edits 只适用于 planner run/chat，且只能指定一次");
      acceptEdits = true;
      continue;
    }
    if (key === "--full" || key === "--json") {
      if (action !== "diff") throw new Error(key + " 只适用于 planner diff");
      if (key === "--full") full = true; else json = true;
      continue;
    }
    if (key === "--timeout-ms") throw new Error("--timeout-ms 已废弃：任务没有执行总时限，连续 60 秒无输出会提示；按 Ctrl+C 可取消");
    if (!allowed.includes(key)) throw new Error("不支持的参数：" + key);
    const value = options[index + 1];
    if (!value || value.startsWith("--")) throw new Error(key + " 后需要提供值");
    if (values.has(key)) throw new Error(key + " 只能指定一次");
    values.set(key, value);
    index += 1;
  }
  const required: Record<Action, string[]> = {
    start: ["--planner", "--runner", "--request"], reply: ["--id", "--message"], retry: ["--id"], show: ["--id"],
    list: [], check: [], diff: ["--id"], review: ["--id"], revise: ["--id"], requirements: ["--id"], trace: ["--id", "--requirement"], chat: [],
    export: ["--id", "--file"], replace: ["--id", "--file"], approve: ["--id", "--revision"], run: ["--id"], help: [],
  };
  for (const key of required[action]) if (!values.has(key)) throw new Error("缺少 " + key + " 参数");
  if (action === "check" && !values.has("--id") && !values.has("--file")) throw new Error("planner check 需要 --id 或 --file");
  if (action === "chat" && !values.has("--id") && (!values.has("--planner") || !values.has("--runner"))) throw new Error("新建 chat 需要 --planner 和 --runner");
  if (action === "chat" && values.has("--id") && (values.has("--planner") || values.has("--runner"))) throw new Error("重开 chat 使用记录中保存的配置，不接受覆盖参数");
  if (values.has("--isolation") && values.get("--isolation") !== "git-worktree") throw new Error("--isolation 当前只支持 git-worktree");
  if (values.has("--isolation") !== values.has("--verification-task")) throw new Error("--isolation git-worktree 与 --verification-task 必须同时提供");
  if (values.has("--max-parallel")) {
    const maxParallel = Number(values.get("--max-parallel"));
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error("--max-parallel 必须是 1 到 8 之间的整数");
    values.set("--max-parallel", String(maxParallel));
    if (maxParallel > 1 && values.get("--isolation") !== "git-worktree") throw new Error("--max-parallel 大于 1 时需要 --isolation git-worktree");
  }
  values.set("--workspace", resolve(values.get("--workspace") ?? process.cwd()));
  if (action === "start") {
    if (!["mock", "deepseek"].includes(values.get("--planner")!)) throw new Error("--planner 只能是 mock 或 deepseek");
    if (!["mock", "claude-code"].includes(values.get("--runner")!)) throw new Error("--runner 只能是 mock 或 claude-code");
    if (values.has("--task-model") && values.get("--runner") !== "claude-code") throw new Error("--task-model 只适用于 claude-code Runner");
    if (mockClarify && values.get("--planner") !== "mock") throw new Error("--mock-clarify 只适用于 mock Planner");
  }
  if (action === "chat" && !values.has("--id")) {
    if (!["mock", "deepseek"].includes(values.get("--planner")!)) throw new Error("--planner 只能是 mock 或 deepseek");
    if (!["mock", "claude-code"].includes(values.get("--runner")!)) throw new Error("--runner 只能是 mock 或 claude-code");
    if (values.has("--task-model") && values.get("--runner") !== "claude-code") throw new Error("--task-model 只适用于 claude-code Runner");
  }
  if (action === "approve" && Boolean(values.get("--waive-findings")) !== Boolean(values.get("--waiver-reason"))) throw new Error("--waive-findings 和 --waiver-reason 必须同时提供");
  if (action === "approve") {
    const revision = Number(values.get("--revision"));
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("--revision 必须是正整数");
    values.set("--revision", String(revision));
  }
  if (action === "diff") {
    for (const flag of ["--from", "--to"]) if (values.has(flag) && (!Number.isSafeInteger(Number(values.get(flag))) || Number(values.get(flag)) < 1)) throw new Error(flag + " 必须是正整数");
  }
  if (action === "trace" && values.has("--revision") && (!Number.isSafeInteger(Number(values.get("--revision"))) || Number(values.get("--revision")) < 1)) throw new Error("--revision 必须是正整数");
  return { action, values, acceptEdits, mockClarify, full, json };
}

function createTaskRunner(task: Parameters<TaskRunnerFactory>[0], options: Parameters<TaskRunnerFactory>[1]): Runner {
  if (task.execution.runnerId === "mock") return new MockRunner(options.mockScenario);
  if (task.execution.runnerId === "claude-code") return new ClaudeCodeRunner(options.acceptEdits ? "acceptEdits" : undefined);
  throw new Error("不支持的 Runner：" + task.execution.runnerId);
}

async function validateWorkspace(workspace: string): Promise<void> {
  const info = await stat(workspace);
  if (!info.isDirectory()) throw new Error("workspace 必须是已存在的目录");
}

async function readSetupFile(path: string): Promise<WorktreeSetupProfile> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("--setup-file 必须是 1 MiB 以内的 JSON 文件");
  return parseWorktreeSetupProfile(JSON.parse(await readFile(absolute, "utf8")) as unknown);
}

function turnExitCode(status: string | undefined): number { return status === "timed_out" ? 124 : status === "cancelled" ? 130 : 1; }
async function cancellable<T>(operation: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parentSignal?.reason ?? new Error("操作已取消"));
  if (parentSignal?.aborted) cancel();
  else parentSignal?.addEventListener("abort", cancel, { once: true });
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try { return await operation(controller.signal); }
  finally {
    parentSignal?.removeEventListener("abort", cancel);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
function sessionExitCode(snapshot: import("@token-coupon/core").SessionSnapshot): number {
  if (snapshot.status === "succeeded" || snapshot.status === "ready") return 0;
  if (snapshot.tasks.some((task) => task.status === "timed_out")) return 124;
  return snapshot.status === "cancelled" ? 130 : 1;
}

function printPlanDiff(from: number, to: number, changes: PlanChange[], full: boolean): void {
  console.log(`计划差异：draft-${from} → draft-${to}`);
  if (!changes.length) { console.log("无变化。"); return; }
  for (const change of changes) {
    console.log(`\n${change.kind}${change.taskId ? ` ${change.taskId}` : ""} · ${change.field}`);
    if (change.field === "prompt" && typeof change.before === "string" && typeof change.after === "string") {
      printPromptDiff(change.before, change.after, full);
    } else {
      if (change.before !== undefined) console.log("  - " + renderDiffValue(change.before, full));
      if (change.after !== undefined) console.log("  + " + renderDiffValue(change.after, full));
    }
  }
}

function printPromptDiff(before: string, after: string, full: boolean): void {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const changedOld = oldLines.slice(prefix, oldLines.length - suffix);
  const changedNew = newLines.slice(prefix, newLines.length - suffix);
  const limit = full ? Number.MAX_SAFE_INTEGER : 100;
  for (const line of oldLines.slice(Math.max(0, prefix - 1), prefix).slice(-1)) console.log(`    ${line}`);
  for (const line of changedOld.slice(0, limit)) console.log(`  - ${renderDiffValue(line, full)}`);
  for (const line of changedNew.slice(0, limit)) console.log(`  + ${renderDiffValue(line, full)}`);
  if (!full && (changedOld.length > limit || changedNew.length > limit)) console.log("  …（差异行过多；使用 --full 查看）");
  const suffixStart = oldLines.length - suffix;
  if (suffix) console.log(`    ${oldLines[suffixStart]}`);
}

function renderDiffValue(value: unknown, full: boolean): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!full && text.length > 1200) return text.slice(0, 1200) + `…（截断，完整 ${text.length} 字符）`;
  return text;
}

function formatReview(record: PlanReviewRecord, current: boolean): string {
  const lines = [
    `审查：${record.reviewId}`,
    `状态：${record.status}${record.status === "succeeded" ? current ? "（适用于当前草案）" : "（已过期）" : ""}`,
    `草案：draft-${record.draftRevision} · ${record.planHash}`,
    `摘要：${record.summary}`,
  ];
  for (const finding of record.findings) {
    lines.push(`\n${finding.findingId} [${finding.severity}/${finding.category}] ${finding.taskIds.join(", ") || "需求范围"}${finding.issueId ? " · " + finding.issueId : ""}`);
    lines.push(`  问题：${finding.description}`, `  依据：${finding.basis}`, `  建议：${finding.suggestion}`);
  }
  for (const item of record.resolutions ?? []) lines.push(`\n上轮 ${item.findingId}：${item.status === "resolved" ? "已解决" : "未解决"} · ${item.issueId ?? ""}\n  依据：${item.basis}`);
  if (record.reasonCode) lines.push(`原因：${record.reasonCode}`);
  return lines.join("\n");
}

function printRequirements(state: import("@token-coupon/core").RequirementsState | undefined): void {
  if (!state) { console.log("有效需求尚未整理，请运行 /requirements refresh。"); return; }
  console.log(`有效需求 · revision-${state.revision}`);
  for (const item of effectiveRequirements(state)) console.log(`${item.requirementId}@${item.revision} [${item.status}] ${item.text}`);
  if (!effectiveRequirements(state).length) console.log("当前没有有效需求。");
}

function printRequirementTrace(trace: ReturnType<typeof traceRequirement>): void {
  const { requirement } = trace;
  console.log(`${requirement.requirementId}@${requirement.revision} [${requirement.status}] ${requirement.text}`);
  console.log("版本链：" + trace.versions.map((item) => `${item.revision}(${item.status})`).join(" → "));
  for (const source of trace.sources) {
    console.log(`来源 ${source.message.messageId}：${source.message.content}`);
    for (const turn of source.turns) console.log(`  Turn ${turn.turnId} [${turn.status}]\n  日志目录：${turn.artifactDir}`);
  }
}

async function printDraftUpdate(result: PlannerOperationResult, workspace: string): Promise<void> {
  const { draft } = result;
  if (!draft) return;
  const checked = checkPlan(draft.plan, result.snapshot.executionDefaults);
  if (!checked.valid) {
    console.error("保存后本地校验失败：");
    for (const diagnostic of checked.diagnostics) console.error(`${diagnostic.severity} ${diagnostic.path}: ${diagnostic.message}`);
    return;
  }
  console.log(`保存后本地校验通过：draft-${draft.draftRevision} · SHA-256 ${checked.planHash}`);
  if (result.draftChanged === false) {
    console.log("计划内容未变化，继续使用现有草案版本；未创建重复版本。");
    return;
  }
  if (draft.draftRevision === 1) {
    console.log("首次生成，无前一草案可比较。");
    return;
  }
  const previous = await new PlannerStore(workspace).loadDraft(draft.planningId, draft.draftRevision - 1);
  printPlanDiff(previous.draftRevision, draft.draftRevision, diffPlans(previous.plan, draft.plan), false);
}

async function runPlannerChat(command: Command, workspace: string, chatIO: PlannerChatIO): Promise<number> {
  if (!chatIO.isTTY) throw new Error("planner chat 需要交互式终端；非交互环境请使用 planner start/reply/review/approve/run");
  const values = command.values;
  const get = (key: string) => values.get(key);
  const rl = createInterface({ input: chatIO.input, output: chatIO.output, terminal: true });
  const chatAbort = new AbortController();
  let inputClosed = false;
  rl.once("close", () => {
    inputClosed = true;
    chatAbort.abort(new Error("终端输入结束；当前操作已取消"));
  });
  let planningId = get("--id");
  let exitCode = 0;
  const ask = async (prompt: string): Promise<string | null> => {
    if (inputClosed) return null;
    return await new Promise((resolveAnswer) => {
      const onClose = () => {
        rl.removeListener("close", onClose);
        resolveAnswer(null);
      };
      rl.once("close", onClose);
      try {
        void rl.question(prompt).then((answer) => {
          rl.removeListener("close", onClose);
          resolveAnswer(answer);
        }).catch(() => {
          rl.removeListener("close", onClose);
          resolveAnswer(null);
        });
      } catch {
        rl.removeListener("close", onClose);
        resolveAnswer(null);
      }
    });
  };
  const show = async () => {
    if (!planningId) return;
    console.log(formatPlanner(await loadPlannerConversation(planningId, workspace)));
  };
  const run = async (runArgs: string[] = []) => {
    if (!planningId) throw new Error("请先输入需求生成计划");
    let isolation: "git-worktree" | undefined;
    let verificationTaskId: string | undefined;
    let setupFile: string | undefined;
    let maxParallel: number | undefined;
    for (let index = 0; index < runArgs.length; index += 1) {
      const flag = runArgs[index];
      const value = runArgs[index + 1];
      if (flag === "--isolation" && isolation === undefined && value === "git-worktree") { isolation = "git-worktree"; index += 1; }
      else if (flag === "--verification-task" && verificationTaskId === undefined && value && !value.startsWith("--")) { verificationTaskId = value; index += 1; }
      else if (flag === "--setup-file" && setupFile === undefined && value && !value.startsWith("--")) { setupFile = value; index += 1; }
      else if (flag === "--max-parallel" && maxParallel === undefined && value && !value.startsWith("--")) {
        maxParallel = Number(value);
        if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error("--max-parallel 必须是 1 到 8 之间的整数");
        index += 1;
      } else throw new Error("用法：/run [--isolation git-worktree --verification-task <taskId>] [--max-parallel <1-8>]");
    }
    if (isolation && !verificationTaskId) throw new Error("git-worktree 运行需要 --verification-task <taskId>");
    if (!isolation && verificationTaskId) throw new Error("--verification-task 需要 --isolation git-worktree");
    if ((maxParallel ?? 1) > 1 && isolation !== "git-worktree") throw new Error("--max-parallel 大于 1 时需要 --isolation git-worktree");
    const setupProfile = setupFile ? await readSetupFile(setupFile) : undefined;
    const result = await cancellable((signal) => runApprovedPlanner({
      planningId: planningId!, workspace, createRunner: createTaskRunner, acceptEdits: command.acceptEdits,
      ...(isolation ? { isolation } : {}), ...(verificationTaskId ? { verificationTaskId } : {}), ...(setupProfile ? { setupProfile } : {}), ...(maxParallel === undefined ? {} : { maxParallel }), signal,
      onOutput: (taskId, output, attemptId) => {
        const visible = output.displayText ?? output.agentText;
        if (visible) chatIO.output.write((maxParallel && maxParallel > 1 ? `\n[${taskId}${attemptId ? `#${attemptId.slice(0, 8)}` : ""}] ` : "") + visible);
        else if (output.stream === "stderr" && output.text) console.error(output.text);
      },
      onIdleState: (taskId, state) => chatIO.output.write(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。\n` : `\n[${taskId}] 输出已恢复。\n`),
    }), chatAbort.signal);
    console.log(formatPlanner(result));
    if (result.snapshot.execution) {
      const record = await new SessionStore(workspace).load(result.snapshot.execution.sessionId);
      console.log(formatSession(record.snapshot, record.plan));
      exitCode = sessionExitCode(record.snapshot);
    }
  };
  const approve = async () => {
    if (!planningId) throw new Error("请先生成计划");
    const loaded = await loadPlannerConversation(planningId, workspace);
    if (!loaded.draft) throw new Error("当前没有可批准的计划");
    if (!loaded.review || loaded.review.status !== "succeeded" || !loaded.reviewIsCurrent) throw new Error("批准前必须运行 /review；当前草案没有有效审查");
    console.log(formatReview(loaded.review, true));
    const errorFindings = loaded.review.findings.filter((finding) => finding.severity === "error");
    let waivedFindingIds: string[] = [];
    let waiverReason: string | undefined;
    if (errorFindings.length) {
      const answerValue = await ask("修订问题，或输入要豁免的 error ID（逗号分隔；回车取消）：");
      if (answerValue === null) return;
      const answer = answerValue.trim();
      if (!answer) return;
      waivedFindingIds = answer.split(",").map((id) => id.trim()).filter(Boolean);
      const reasonValue = await ask("记录豁免原因：");
      if (reasonValue === null) return;
      waiverReason = reasonValue.trim();
      if (!waiverReason) return;
    }
    const confirmation = await ask(`批准 draft-${loaded.draft.draftRevision} 和审查 ${loaded.review.reviewId}？[y/N] `);
    if (confirmation === null) return;
    const confirm = confirmation.trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") return;
    const result = await cancellable((signal) => approvePlannerDraft({ planningId: planningId!, workspace, draftRevision: loaded.draft!.draftRevision, reviewId: loaded.review!.reviewId,
      ...(waivedFindingIds.length && waiverReason ? { waivedFindingIds, waiverReason: waiverReason! } : {}), signal }), chatAbort.signal);
    console.log(formatPlanner(result));
  };
  const edit = async () => {
    if (!planningId) throw new Error("请先生成计划");
    const loaded = await loadPlannerConversation(planningId, workspace);
    if (!loaded.draft) throw new Error("当前没有可编辑的草案");
    const editor = parseEditor(process.env.VISUAL ?? process.env.EDITOR ?? "");
    const editId = randomUUID();
    const directory = join(workspace, ".token-coupon", "planners", planningId, "edits", editId);
    await mkdir(directory, { recursive: true });
    const file = join(directory, "plan.json");
    await writeFile(file, JSON.stringify(loaded.draft.plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`正在编辑 draft-${loaded.draft.draftRevision}：${file}`);
    const terminalInput = chatIO.input as NodeJS.ReadableStream & {
      isRaw?: boolean;
      setRawMode?: (mode: boolean) => unknown;
    };
    const wasRaw = Boolean(terminalInput.isRaw);
    let editCode: number;
    // The editor inherits stdin: readline must stop consuming its keys/mouse events.
    rl.pause();
    try {
      terminalInput.setRawMode?.(false);
      editCode = await runEditor(editor[0]!, [...editor.slice(1), file]);
    } finally {
      terminalInput.setRawMode?.(wasRaw);
      if (!inputClosed) rl.resume();
    }
    if (editCode !== 0) throw new Error(`编辑器退出码 ${editCode}；文件保留：${file}`);
    const info = await stat(file);
    if (info.size > 4 * 1024 * 1024) throw new Error(`编辑结果超过 4 MiB；文件保留：${file}`);
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    const result = await replacePlannerDraft({ planningId, workspace, value, expectedDraftRevision: loaded.draft.draftRevision, expectedPlanHash: loaded.draft.planHash });
    console.log(formatPlanner(result));
    await printDraftUpdate(result, workspace);
  };

  try {
    if (!planningId) {
      const records = await new PlannerStore(workspace).list();
      if (records.length) {
        console.log("已有规划：");
        for (const [index, snapshot] of records.entries()) {
          const draft = snapshot.draftRevision === null ? undefined : await new PlannerStore(workspace).loadDraft(snapshot.planningId, snapshot.draftRevision).catch(() => undefined);
          console.log(`  ${index + 1}) ${snapshot.planningId.slice(0, 8)}  ${draft?.plan.title ?? "等待草案"}  ${snapshot.status}  draft-${snapshot.draftRevision ?? "—"}`);
        }
        const selectedValue = await ask("输入序号打开规划，回车新建：");
        if (selectedValue === null) return 0;
        const selected = selectedValue.trim();
        if (selected) {
          const index = Number(selected) - 1;
          const chosen = Number.isInteger(index) && index >= 0 ? records[index] : records.find((record) => record.planningId === selected);
          if (!chosen) throw new Error("规划选择无效");
          planningId = chosen.planningId;
        }
      }
    }
    if (planningId) {
      const snapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
      if (snapshot.execution) console.log(`已关联执行 Session ${snapshot.execution.sessionId}；规划只读，请使用 /status、/resume 或 /retry。`);
      else console.log(`已打开规划 ${planningId}。输入 /help 查看命令。`);
      await show();
    } else {
      console.log("输入需求开始规划，或用 /request-file <路径> 读取多行需求；输入 /exit 退出。");
    }
    while (true) {
      const inputLine = await ask(planningId ? "planner> " : "request> ");
      if (inputLine === null) break;
      let line = inputLine.trim();
      if (!line) continue;
      if (!planningId && line.startsWith("/request-file")) {
        const file = line.slice("/request-file".length).trim();
        if (!file) { console.log("用法：/request-file <需求文本文件>"); continue; }
        const path = resolve(file);
        const info = await stat(path);
        if (info.size > 8 * 1024) { console.log("需求文件超过 8 KiB"); continue; }
        line = await readFile(path, "utf8");
      }
      if (!planningId && line.startsWith("/")) {
        if (line === "/exit") break;
        console.log("新规划尚未开始，请先输入需求。");
        continue;
      }
      if (!planningId) {
        const provider = get("--planner")!;
        const runnerId = get("--runner")!;
        const config: PlannerConfig = provider === "mock"
          ? { provider: "mock", model: "mock", baseUrl: "mock://local" }
          : { provider: "deepseek", model: get("--planner-model") ?? process.env.TOKEN_COUPON_PLANNER_MODEL ?? "", baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com" };
        const taskModel = get("--task-model");
        const result = await cancellable((signal) => startPlannerConversation({
          workspace, request: line, config,
          executionDefaults: { runnerId, mode: "non_interactive", ...(taskModel ? { modelId: taskModel } : {}) },
          ...(provider === "mock" ? { planner: new MockPlanner() } : {}), signal,
        }), chatAbort.signal);
        planningId = result.snapshot.planningId;
        console.log(formatPlanner(result));
        await printDraftUpdate(result, workspace);
        if (result.error) {
          const status = result.snapshot.turns.at(-1)?.status;
          if (status === "cancelled" || status === "timed_out") exitCode = turnExitCode(status);
        }
        continue;
      }
      if (!line.startsWith("/")) {
        const result = await cancellable((signal) => replyToPlanner({ planningId: planningId!, workspace, message: line, signal }), chatAbort.signal);
        console.log(formatPlanner(result));
        await printDraftUpdate(result, workspace);
        if (result.error) {
          const status = result.snapshot.turns.at(-1)?.status;
          if (status === "cancelled" || status === "timed_out") exitCode = turnExitCode(status);
        }
        continue;
      }
      const [name, ...args] = line.slice(1).split(/\s+/);
      try {
        if (name === "exit" || name === "quit") break;
        if (name === "help") console.log("输入自然语言继续规划；/confirm all|编号 /delegate 编号 /reject 编号 /revoke all|decisionId[,decisionId]；/plan /history /requirements [refresh] /trace <requirementId> [revision] /edit /check /diff /review /revise [说明] /approve /run [--isolation git-worktree --verification-task <taskId>] [--max-parallel <1-8>] [--setup-file <setup.json>] /delivery /status /resume /retry <taskId> [--setup-file <setup.json>] /land <taskId> /cleanup /exit");
        else if (name === "confirm" || name === "delegate" || name === "reject" || name === "revoke") {
          if (!args.length) throw new Error(`用法：/${name} ${name === "confirm" ? "all|编号[,编号]" : name === "revoke" ? "all|decisionId[,decisionId]" : "编号[,编号]"}`);
          const result = await cancellable((signal) => replyToPlanner({ planningId: planningId!, workspace, message: `/${name} ${args.join(" ")}`, signal }), chatAbort.signal);
          console.log(formatPlanner(result));
          await printDraftUpdate(result, workspace);
          if (result.error) console.error(result.error);
        }
        else if (name === "status") {
          const loaded = await loadPlannerConversation(planningId, workspace);
          console.log(formatPlanner(loaded));
          if (loaded.snapshot.execution) {
            const session = await new SessionStore(workspace).load(loaded.snapshot.execution.sessionId);
            console.log(formatSession(session.snapshot, session.plan));
          }
        } else if (name === "plan") {
          if (!args[0]) await show();
          else {
            const loaded = await loadPlannerConversation(planningId, workspace);
            const entry = loaded.draft?.plan.tasks.find(({ task }) => task.id === args[0]);
            if (!entry) throw new Error(`当前草案中没有任务 ${args[0]}`);
            console.log(`draft-${loaded.draft!.draftRevision} · ${entry.task.id} — ${entry.task.title}`);
            console.log(`依赖：${entry.dependsOn.join(", ") || "无"}\n${entry.task.prompt}`);
          }
        }
        else if (name === "history") {
          const snapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
          for (const message of snapshot.messages) console.log(`${message.role === "user" ? "用户" : "Planner"} [${message.messageId}]：${message.content}`);
        } else if (name === "requirements") {
          if (args[0] === "refresh") {
            const result = await cancellable((signal) => refreshPlannerRequirements({ planningId: planningId!, workspace, signal }), chatAbort.signal);
            console.log(formatPlanner(result));
            await printDraftUpdate(result, workspace);
          } else if (args.length) throw new Error("用法：/requirements [refresh]");
          const requirementsSnapshot = await new PlannerStore(workspace).load(planningId);
          printRequirements(requirementsSnapshot.requirements);
          if (requirementsSnapshot.planningAssessment) {
            console.log("规划决策：");
            for (const decision of requirementsSnapshot.planningAssessment.decisions) console.log(`  ${decision.decisionId} [${decision.status}]：${decision.value}`);
          }
        } else if (name === "trace") {
          if (!args[0] || args.length > 2 || (args[1] !== undefined && (!Number.isSafeInteger(Number(args[1])) || Number(args[1]) < 1))) throw new Error("用法：/trace <requirementId> [revision]");
          printRequirementTrace(traceRequirement(await new PlannerStore(workspace).load(planningId), args[0], args[1] === undefined ? undefined : Number(args[1])));
        } else if (name === "revise") {
          const result = await cancellable((signal) => revisePlannerDraft({ planningId: planningId!, workspace, message: args.join(" "), signal }), chatAbort.signal);
          console.log(formatPlanner(result));
          await printDraftUpdate(result, workspace);
        } else if (name === "edit") await edit();
        else if (name === "check") {
          const loaded = await loadPlannerConversation(planningId, workspace);
          if (!loaded.draft) throw new Error("当前没有可检查的草案");
          const checked = checkPlan(loaded.draft.plan, loaded.snapshot.executionDefaults);
          console.log(checked.valid ? `计划有效：${checked.planHash}` : checked.diagnostics.map((item) => `${item.path}：${item.message}`).join("\n"));
        } else if (name === "diff") {
          const loaded = await loadPlannerConversation(planningId, workspace);
          if (!loaded.draft) throw new Error("当前没有可比较的草案");
          const to = Number(args[1] ?? loaded.draft.draftRevision);
          const from = Number(args[0] ?? to - 1);
          if (to <= 1 && !args.length) console.log("首次生成的计划，没有前一版本可比较。");
          else printPlanDiff(from, to, diffPlans((await new PlannerStore(workspace).loadDraft(planningId!, from)).plan, (await new PlannerStore(workspace).loadDraft(planningId!, to)).plan), false);
        } else if (name === "review") {
          if (args[0] === "show") {
            const snapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
            const id = args[1] ?? snapshot.latestReviewId;
            if (!id) throw new Error("当前没有审查记录");
            const record = await new ReviewStore(workspace).load(planningId, id);
            console.log(formatReview(record, (await loadCurrentPlanReview(planningId, workspace))?.reviewId === id));
          } else {
            const result = await cancellable((signal) => reviewPlannerDraft({ planningId: planningId!, workspace, signal }), chatAbort.signal);
            console.log(formatReview(result.review, true));
          }
        } else if (name === "approve") await approve();
        else if (name === "run") await run(args);
        else if (name === "delivery") {
          const plannerSnapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
          if (!plannerSnapshot.execution) throw new Error("规划还没有执行 Session");
          const sessionStore = new SessionStore(workspace);
          const record = await sessionStore.load(plannerSnapshot.execution.sessionId);
          const report = await createSessionDelivery(record, sessionStore);
          console.log(formatSessionDelivery(report, workspace));
          console.log(`Delivery 记录：${sessionStore.sessionDirectory(record.snapshot.sessionId)}/delivery.json`);
        }
        else if (name === "cleanup") {
          const plannerSnapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
          if (!plannerSnapshot.execution) throw new Error("规划还没有执行 Session");
          const report = await cleanupSessionWorktrees({ sessionId: plannerSnapshot.execution.sessionId, workspace });
          for (const path of report.removedWorktrees) console.log(`已移除：${path}`);
          for (const item of report.retainedWorktrees) console.log(`保留：${item.path}（${item.reason}）`);
        }
        else if (name === "land") {
          if (args.length !== 1) throw new Error("用法：/land <taskId>（先在整合 worktree 手工提交并合并 Attempt 分支）");
          const plannerSnapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
          if (!plannerSnapshot.execution) throw new Error("规划还没有执行 Session");
          const result = await cancellable((signal) => continueSessionLanding({
            sessionId: plannerSnapshot.execution!.sessionId, workspace, createRunner: createTaskRunner,
            taskId: args[0]!, signal,
          }), chatAbort.signal);
          const record = await new SessionStore(workspace).load(result.snapshot.sessionId);
          console.log(formatSession(result.snapshot, record.plan));
        } else if (name === "retry" || name === "resume") {
          let setupFile: string | undefined;
          const commandArgs: string[] = [];
          for (let index = 0; index < args.length; index += 1) {
            if (args[index] === "--setup-file" && setupFile === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) {
              setupFile = args[index + 1]!;
              index += 1;
            } else commandArgs.push(args[index]!);
          }
          if (name === "retry" ? commandArgs.length !== 1 : commandArgs.length !== 0) {
            throw new Error(name === "retry" ? "用法：/retry <taskId> [--setup-file <setup.json>]" : "用法：/resume [--setup-file <setup.json>]");
          }
          const setupProfile = setupFile ? await readSetupFile(setupFile) : undefined;
          const snapshot = (await loadPlannerConversation(planningId, workspace)).snapshot;
          if (!snapshot.execution) throw new Error("规划还没有执行 Session");
          const sessionId = snapshot.execution.sessionId;
          const parallelExecution = ((await new SessionStore(workspace).load(sessionId)).snapshot.maxParallel ?? 1) > 1;
          const operation = { sessionId, workspace, createRunner: createTaskRunner, acceptEdits: command.acceptEdits,
            ...(setupProfile ? { setupProfile } : {}),
            onOutput: (taskId: string, output: import("@token-coupon/core").RunnerOutput, attemptId?: string) => { const visible = output.displayText ?? output.agentText; if (visible) chatIO.output.write((parallelExecution ? `\n[${taskId}${attemptId ? `#${attemptId.slice(0, 8)}` : ""}] ` : "") + visible); },
            onIdleState: (taskId: string, state: { idle: boolean }) => chatIO.output.write(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。\n` : `\n[${taskId}] 输出已恢复。\n`) };
          const result = await cancellable((signal) => name === "retry"
            ? retrySession({ ...operation, taskId: commandArgs[0]!, signal })
            : resumeSession({ ...operation, signal }), chatAbort.signal);
          const record = await new SessionStore(workspace).load(sessionId);
          console.log(formatSession(result.snapshot, record.plan));
        } else if (name === "request-file") {
          const file = args.join(" ");
          if (!file) throw new Error("用法：/request-file <需求文本文件>");
          const info = await stat(resolve(file));
          if (info.size > 8 * 1024) throw new Error("需求文件超过 8 KiB");
          const content = await readFile(resolve(file), "utf8");
          const result = await cancellable((signal) => replyToPlanner({ planningId: planningId!, workspace, message: content, signal }), chatAbort.signal);
          console.log(formatPlanner(result));
          await printDraftUpdate(result, workspace);
          if (result.error) {
            const status = result.snapshot.turns.at(-1)?.status;
            if (status === "cancelled" || status === "timed_out") exitCode = turnExitCode(status);
          }
        } else console.log("未知命令。输入 /help 查看可用操作。");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    rl.close();
  }
  return exitCode;
}

function parseEditor(value: string): string[] {
  if (!value.trim()) throw new Error("请在 VISUAL 或 EDITOR 中配置编辑器，例如 EDITOR=vim");
  if (/[\n\r;$|&><`$()]/.test(value)) throw new Error("EDITOR/VISUAL 仅支持可执行文件和参数，不支持 shell 表达式");
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of value) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { parts.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped || quote) throw new Error("EDITOR/VISUAL 的引号或转义不完整");
  if (current) parts.push(current);
  if (!parts.length) throw new Error("EDITOR/VISUAL 未指定可执行文件");
  return parts;
}

function runEditor(executable: string, args: string[]): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolveCode(code ?? 1));
  });
}
