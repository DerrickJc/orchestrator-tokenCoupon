#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ClaudeCodeRunner, executeTask, formatSession, InputValidationError, MockRunner, parsePlan, parseTask,
  cleanupSessionWorktrees, continueSessionLanding, createSessionDelivery, formatSessionDelivery, parseWorktreeSetupProfile, resumeSession, retrySession, runPlan, SessionLockError, SessionStore,
} from "@token-coupon/core";
import type { PlanDefinition, Runner, RunnerOutput, TaskDefinition, TaskRunnerFactoryOptions, WorktreeSetupProfile } from "@token-coupon/core";
import { runPlannerCli } from "./planner-cli.js";

const usage = `用法：
  token-coupon plan show --file <计划.json>
  token-coupon plan run --file <计划.json> [--workspace <目录>] [--accept-edits]
      [--isolation git-worktree --verification-task <taskId>] [--setup-file <setup.json>]
      [--mock-task-scenario <taskId>=<场景> ...]
  token-coupon task show --file <任务.json>
  token-coupon task run --file <任务.json> [--workspace <目录>] [--mock-scenario <场景>] [--accept-edits]
  token-coupon session show --id <sessionId> [--workspace <目录>]
  token-coupon session delivery --id <sessionId> [--workspace <目录>]
  token-coupon session cleanup --id <sessionId> [--workspace <目录>]
  token-coupon session land --id <sessionId> --task <taskId> --continue [--workspace <目录>]
  token-coupon session resume --id <sessionId> [--workspace <目录>] [--accept-edits]
      [--mock-task-scenario <taskId>=<场景> ...] [--setup-file <setup.json>]
  token-coupon session retry --id <sessionId> --task <taskId> [--workspace <目录>]
      [--accept-edits] [--mock-task-scenario <taskId>=<场景> ...] [--setup-file <setup.json>]
  token-coupon planner <start|reply|retry|show|export|replace|approve|run> [选项]
  token-coupon --help

工作目录默认为启动 CLI 时的当前目录。Session 和 Attempt 记录保存在该目录的 .token-coupon/ 下。`;

interface ParsedCommand {
  kind: "plan" | "task" | "session";
  action: "show" | "run" | "resume" | "retry" | "delivery" | "land" | "cleanup";
  file?: string;
  sessionId?: string;
  taskId?: string;
  workspace?: string;
  mockScenario?: string;
  mockTaskScenarios: Map<string, string>;
  acceptEdits: boolean;
  isolation?: "git-worktree";
  verificationTaskId?: string;
  continueLanding: boolean;
  setupFile?: string;
}

function parseArguments(args: string[]): ParsedCommand | "help" {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return "help";
  const [kind, action, ...options] = args;
  if (!(["plan", "task", "session"] as const).includes(kind as "plan" | "task" | "session") ||
      !(["show", "run", "resume", "retry", "delivery", "land", "cleanup"] as const).includes(action as "show" | "run" | "resume" | "retry" | "delivery" | "land" | "cleanup") ||
      (kind === "task" && action !== "show" && action !== "run") ||
      (kind === "plan" && action !== "show" && action !== "run") ||
      (kind === "session" && action !== "show" && action !== "resume" && action !== "retry" && action !== "delivery" && action !== "land" && action !== "cleanup")) {
    throw new Error("命令无效。请运行 token-coupon --help 查看用法。");
  }

  let file: string | undefined;
  let sessionId: string | undefined;
  let taskId: string | undefined;
  let workspace: string | undefined;
  let mockScenario: string | undefined;
  const mockTaskScenarios = new Map<string, string>();
  let acceptEdits = false;
  let continueLanding = false;
  let isolation: "git-worktree" | undefined;
  let verificationTaskId: string | undefined;
  let setupFile: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--accept-edits") {
      if (acceptEdits) throw new Error("--accept-edits 只能指定一次");
      acceptEdits = true;
      continue;
    }
    if (option === "--continue") {
      if (kind !== "session" || action !== "land" || continueLanding) throw new Error("--continue 只适用于 session land，且只能指定一次");
      continueLanding = true;
      continue;
    }
    if (!["--file", "--id", "--task", "--workspace", "--mock-scenario", "--mock-task-scenario", "--isolation", "--verification-task", "--setup-file"].includes(option ?? "")) {
      throw new Error(`不支持的参数：${option}`);
    }
    const value = options[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 后需要提供值`);
    if (option === "--file") {
      if (file !== undefined) throw new Error("--file 只能指定一次");
      file = value;
    } else if (option === "--id") {
      if (sessionId !== undefined) throw new Error("--id 只能指定一次");
      sessionId = value;
    } else if (option === "--task") {
      if (taskId !== undefined) throw new Error("--task 只能指定一次");
      taskId = value;
    } else if (option === "--workspace") {
      if (workspace !== undefined) throw new Error("--workspace 只能指定一次");
      workspace = value;
    } else if (option === "--mock-scenario") {
      if (mockScenario !== undefined) throw new Error("--mock-scenario 只能指定一次");
      mockScenario = value;
    } else if (option === "--isolation") {
      if (isolation !== undefined) throw new Error("--isolation 只能指定一次");
      if (value !== "git-worktree") throw new Error("--isolation 当前只支持 git-worktree");
      isolation = value;
    } else if (option === "--verification-task") {
      if (verificationTaskId !== undefined) throw new Error("--verification-task 只能指定一次");
      verificationTaskId = value;
    } else if (option === "--setup-file") {
      if (setupFile !== undefined) throw new Error("--setup-file 只能指定一次");
      setupFile = value;
    } else {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) throw new Error("--mock-task-scenario 格式为 <taskId>=<场景>");
      const mappedTask = value.slice(0, separator);
      const scenario = value.slice(separator + 1);
      if (mockTaskScenarios.has(mappedTask)) throw new Error(`任务 ${mappedTask} 的 Mock 场景只能指定一次`);
      mockTaskScenarios.set(mappedTask, scenario);
    }
    index += 1;
  }

  if ((kind === "plan" || kind === "task") && !file) throw new Error("缺少 --file 参数");
  if (kind === "session" && !sessionId) throw new Error("Session 命令缺少 --id 参数");
  if (kind === "session" && (action === "retry" || action === "land") && !taskId) throw new Error(`session ${action} 缺少 --task 参数`);
  if (kind === "session" && action !== "retry" && action !== "land" && taskId) throw new Error("--task 只适用于 session retry/land");
  if (kind === "session" && action === "land" && !continueLanding) throw new Error("session land 需要 --continue");
  if (kind === "session" && action !== "land" && continueLanding) throw new Error("--continue 只适用于 session land");
  if (kind === "session" && action === "land" && acceptEdits) throw new Error("session land 不启动 Runner，不接受 --accept-edits");
  if (kind === "session" && file) throw new Error("--file 不适用于 Session 命令");
  if (kind === "plan" && action === "show" && (mockTaskScenarios.size || acceptEdits)) throw new Error("Mock 场景和 --accept-edits 只适用于 plan run");
  if ((kind !== "plan" || action !== "run") && (isolation || verificationTaskId)) throw new Error("--isolation 和 --verification-task 只适用于 plan run");
  if (setupFile && !((kind === "plan" && action === "run") || (kind === "session" && (action === "resume" || action === "retry")))) throw new Error("--setup-file 只适用于 plan run、session resume 或 session retry");
  if (isolation === "git-worktree" && !verificationTaskId) throw new Error("--isolation git-worktree 需要 --verification-task <taskId>");
  if (!isolation && verificationTaskId) throw new Error("--verification-task 需要 --isolation git-worktree");
  if (kind === "task" && mockTaskScenarios.size) throw new Error("--mock-task-scenario 只适用于 plan/session 命令");
  if (kind === "task" && action === "show" && (workspace || mockScenario || acceptEdits)) throw new Error("执行参数只适用于 task run");
  if (kind === "task" && action === "run" && mockScenario && acceptEdits) throw new Error("--mock-scenario 与 --accept-edits 不能同时使用");
  if (kind === "session" && action !== undefined && ["show", "delivery", "cleanup"].includes(action) && (acceptEdits || mockScenario || mockTaskScenarios.size || setupFile)) throw new Error(`session ${action} 不接受执行参数`);
  if (mockScenario && (kind !== "task" || action !== "run")) throw new Error("--mock-scenario 只适用于 task run");

  if ((kind === "task" && action === "run") || (kind === "plan" && action === "run") || kind === "session") {
    workspace ??= process.cwd();
  }
  return {
    kind: kind as ParsedCommand["kind"], action: action as ParsedCommand["action"],
    ...(file ? { file } : {}), ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}),
    ...(workspace ? { workspace } : {}), ...(mockScenario ? { mockScenario } : {}),
    mockTaskScenarios, acceptEdits, continueLanding, ...(isolation ? { isolation } : {}), ...(verificationTaskId ? { verificationTaskId } : {}), ...(setupFile ? { setupFile } : {}),
  };
}

async function readJsonFile(file: string): Promise<unknown> {
  let contents: string;
  try { contents = await readFile(file, "utf8"); }
  catch (error) { throw new Error(`无法读取文件 ${file}：${error instanceof Error ? error.message : String(error)}`); }
  try { return JSON.parse(contents) as unknown; }
  catch (error) { throw new Error(`${file}: JSON 格式无效：${error instanceof Error ? error.message : String(error)}`); }
}

function formatTask(task: TaskDefinition, status?: string, dependsOn?: string[]): string[] {
  return [
    `任务：${task.id} — ${task.title}`,
    `  描述：${task.prompt}`,
    `  依赖：${dependsOn === undefined || dependsOn.length === 0 ? "无" : dependsOn.join(", ")}`,
    `  Runner：${task.execution.runnerId}`,
    `  模型：${task.execution.modelId ?? "未指定"}`,
    `  模式：${task.execution.mode}`,
    ...(status === undefined ? [] : [`  状态：${status}`]),
    task.execution.timeoutMs === undefined ? "  执行时限：无；60 秒无输出时提示" : `  执行时限：历史 timeoutMs ${task.execution.timeoutMs}（不生效）；60 秒无输出时提示`,
  ];
}

function formatPlan(plan: PlanDefinition): string {
  const lines = [`计划：${plan.id} — ${plan.title}`, `任务数：${plan.tasks.length}`];
  for (const [index, plannedTask] of plan.tasks.entries()) {
    if (index > 0) lines.push("");
    lines.push(...formatTask(plannedTask.task, plannedTask.status, plannedTask.dependsOn));
  }
  return lines.join("\n");
}

function createRunner(task: TaskDefinition, options: TaskRunnerFactoryOptions): Runner {
  if (task.execution.runnerId === "mock") return new MockRunner(options.mockScenario);
  if (task.execution.runnerId === "claude-code") return new ClaudeCodeRunner(options.acceptEdits ? "acceptEdits" : undefined);
  throw new InputValidationError("task.execution.runnerId", `不支持的 Runner：${task.execution.runnerId}`);
}

function bindCancellation(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return { signal: controller.signal, dispose: () => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); } };
}

function showRunnerOutput(taskId: string, output: RunnerOutput, label = false): void {
  const displayText = output.displayText ?? output.agentText;
  if (label && (displayText || output.stream === "stderr" || (output.text && output.structuredEvent === undefined))) {
    const stream = output.stream === "stderr" ? process.stderr : process.stdout;
    stream.write(`\n[${taskId}] `);
  }
  if (displayText) process.stdout.write(displayText);
  else if (output.stream === "stderr" && output.text) process.stderr.write(output.text);
  else if (output.stream === "stdout" && output.text && output.agentText === undefined && output.structuredEvent === undefined) process.stdout.write(output.text);
}

function resultExitCode(status: string): number {
  return status === "succeeded" || status === "ready" ? 0 : status === "timed_out" ? 124 : status === "cancelled" ? 130 : 1;
}

function sessionExitCode(snapshot: import("@token-coupon/core").SessionSnapshot): number {
  if (snapshot.status === "succeeded" || snapshot.status === "ready") return 0;
  if (snapshot.tasks.some((task) => task.status === "timed_out")) return 124;
  return snapshot.status === "cancelled" ? 130 : 1;
}

export async function runCli(args: string[]): Promise<number> {
  if (args[0] === "planner") return runPlannerCli(args.slice(1));
  let command: ParsedCommand | "help";
  try { command = parseArguments(args); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  if (command === "help") { console.log(usage); return 0; }

  try {
    if (command.kind === "plan" && command.action === "show") {
      console.log(formatPlan(parsePlan(await readJsonFile(command.file!))));
      return 0;
    }
    if (command.kind === "task" && command.action === "show") {
      console.log(formatTask(parseTask(await readJsonFile(command.file!))).join("\n"));
      return 0;
    }
    if (command.kind === "task" && command.action === "run") {
      const task = parseTask(await readJsonFile(command.file!));
      const runner = createRunner(task, { ...(command.acceptEdits ? { acceptEdits: true } : {}), ...(command.mockScenario ? { mockScenario: command.mockScenario } : {}) });
      if (task.execution.modelId && !runner.supportsModel) throw new InputValidationError("task.execution.modelId", `${runner.id} 不支持 modelId`);
      if (command.acceptEdits && runner.id !== "claude-code") throw new InputValidationError("--accept-edits", "仅适用于 claude-code Runner");
      await runner.checkAvailable();
      await validateWorkspace(command.workspace!);
      const cancellation = bindCancellation();
      let result: Awaited<ReturnType<typeof executeTask>>;
      try {
        result = await executeTask({ task, cwd: command.workspace!, runner, signal: cancellation.signal, onOutput: (output) => showRunnerOutput(task.id, output),
          onIdleState: (state) => console.error(state.idle ? `\n[${task.id}] 暂无输出，任务仍在运行。` : `\n[${task.id}] 输出已恢复。`) });
      } finally { cancellation.dispose(); }
      printAttempt(result);
      return resultExitCode(result.attempt.status);
    }

    const workspace = command.workspace!;
    await validateWorkspace(workspace);
    if (command.kind === "plan" && command.action === "run") {
      const plan = parsePlan(await readJsonFile(command.file!));
      const setupProfile = command.setupFile ? await readSetupFile(command.setupFile) : undefined;
      const cancellation = bindCancellation();
      let result;
      let currentOutputTask: string | undefined;
      try {
        result = await runPlan({ plan, workspace, createRunner, signal: cancellation.signal, acceptEdits: command.acceptEdits,
          ...(command.isolation ? { isolation: command.isolation } : {}), ...(command.verificationTaskId ? { verificationTaskId: command.verificationTaskId } : {}),
          ...(setupProfile ? { setupProfile } : {}),
          mockTaskScenarios: command.mockTaskScenarios, onOutput: (taskId, output) => {
            const firstForTask = taskId !== currentOutputTask;
            currentOutputTask = taskId;
            showRunnerOutput(taskId, output, firstForTask);
          }, onIdleState: (taskId, state) => console.error(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。` : `\n[${taskId}] 输出已恢复。`) });
      } finally { cancellation.dispose(); }
      console.log(formatSession(result.snapshot, plan));
      return sessionExitCode(result.snapshot);
    }

    const sessionId = command.sessionId!;
    const sessionStore = new SessionStore(workspace);
    if (command.action === "show") {
      const record = await sessionStore.load(sessionId);
      console.log(formatSession(record.snapshot, record.plan));
      return 0;
    }
    if (command.action === "delivery") {
      const record = await sessionStore.load(sessionId);
      const report = await createSessionDelivery(record, sessionStore);
      console.log(formatSessionDelivery(report, workspace));
      console.log(`Delivery 记录：${sessionStore.sessionDirectory(sessionId)}/delivery.json`);
      return 0;
    }
    if (command.action === "cleanup") {
      const report = await cleanupSessionWorktrees({ sessionId, workspace });
      console.log(`已移除 worktree：${report.removedWorktrees.length ? report.removedWorktrees.join(", ") : "无"}`);
      for (const item of report.retainedWorktrees) console.log(`保留：${item.path}（${item.reason}）`);
      console.log(`清理记录：${sessionStore.sessionDirectory(sessionId)}/cleanup.json`);
      return report.retainedWorktrees.length ? 1 : 0;
    }
    const setupProfile = command.setupFile ? await readSetupFile(command.setupFile) : undefined;
    const cancellation = bindCancellation();
    let result;
    let currentOutputTask: string | undefined;
    try {
      const operation = { sessionId, workspace, createRunner, signal: cancellation.signal,
        acceptEdits: command.acceptEdits, mockTaskScenarios: command.mockTaskScenarios, ...(setupProfile ? { setupProfile } : {}), onOutput: (taskId: string, output: RunnerOutput) => {
          const firstForTask = taskId !== currentOutputTask;
          currentOutputTask = taskId;
          showRunnerOutput(taskId, output, firstForTask);
        }, onIdleState: (taskId: string, state: { idle: boolean }) => console.error(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。` : `\n[${taskId}] 输出已恢复。`) };
      result = command.action === "retry"
        ? await retrySession({ ...operation, taskId: command.taskId! })
        : command.action === "land"
          ? await continueSessionLanding({ ...operation, taskId: command.taskId! })
          : await resumeSession(operation);
    } finally { cancellation.dispose(); }
    const record = await sessionStore.load(sessionId);
    console.log(formatSession(result.snapshot, record.plan));
    return (command.action === "retry" || command.action === "land") && result.operationStatus
      ? resultExitCode(result.operationStatus)
      : sessionExitCode(result.snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error instanceof InputValidationError && command.file ? `${command.file}: ${message}` : message);
    return error instanceof InputValidationError ? 2 : error instanceof SessionLockError ? 1 : 1;
  }
}

async function validateWorkspace(workspace: string): Promise<void> {
  let info;
  try { info = await stat(workspace); }
  catch { throw new InputValidationError("--workspace", "必须是已存在的目录"); }
  if (!info.isDirectory()) throw new InputValidationError("--workspace", "必须是已存在的目录");
}

async function readSetupFile(path: string): Promise<WorktreeSetupProfile> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 1024 * 1024) throw new InputValidationError("--setup-file", "必须是 1 MiB 以内的 JSON 文件");
  try { return parseWorktreeSetupProfile(JSON.parse(await readFile(absolute, "utf8")) as unknown); }
  catch (error) { throw new InputValidationError("--setup-file", error instanceof Error ? error.message : String(error)); }
}

function printAttempt(result: Awaited<ReturnType<typeof executeTask>>): void {
  const elapsedMs = Date.parse(result.attempt.finishedAt ?? "") - Date.parse(result.attempt.createdAt);
  console.log(`\n任务：${result.attempt.taskId}`);
  console.log(`Attempt：${result.attempt.attemptId}`);
  console.log(`状态：${result.attempt.status}（${result.attempt.reasonCode}）`);
  console.log(`退出码：${result.attempt.exitCode ?? "无"}；耗时：${Number.isFinite(elapsedMs) ? elapsedMs : "未知"} ms`);
  console.log(`产物：${result.artifactDir}`);
  if (result.attempt.reason) console.error(result.attempt.reason);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
