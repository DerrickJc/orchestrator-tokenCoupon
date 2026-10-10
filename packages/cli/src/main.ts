#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeTask, formatSession, InputValidationError, parsePlan, parseTask, parseRunnerProfile, recoverAbandonedAttempt,
  cleanupSessionWorktrees, continueSessionLanding, createSessionDelivery, formatSessionDelivery, parseWorktreeSetupProfile, resumeSession, retrySession, runPlan, SessionLockError, SessionStore,
} from "@token-coupon/core";
import type { PlanDefinition, RunnerInteractionReply, RunnerOutput, TaskDefinition, WorktreeSetupProfile } from "@token-coupon/core";
import { runPlannerCli } from "./planner-cli.js";
import { createTaskRunner, diagnoseRegisteredRunners, listRegisteredRunners, probeRegisteredRunner, validateCliRunnerProfile } from "./runner-factory.js";
import { createRunnerInteractionIO, readAttemptInteractions, submitAttemptInteractionReply } from "./interaction-cli.js";
import { showSessionLogs } from "./session-logs-cli.js";

const usage = `用法：
  token-coupon plan show --file <计划.json>
  token-coupon plan run --file <计划.json> [--workspace <目录>] [--accept-edits]
      [--isolation git-worktree --verification-task <taskId>] [--max-parallel <1-8>] [--setup-file <setup.json>]
      [--mock-task-scenario <taskId>=<场景> ...]
  token-coupon task show --file <任务.json>
  token-coupon task run --file <任务.json> [--workspace <目录>] [--mock-scenario <场景>] [--accept-edits]
      [--runner-profile <profile.json>]
  token-coupon runner list | doctor
  token-coupon session show --id <sessionId> [--workspace <目录>]
  token-coupon session delivery --id <sessionId> [--workspace <目录>]
  token-coupon session cleanup --id <sessionId> [--workspace <目录>]
  token-coupon session pause --id <sessionId> [--workspace <目录>]
  token-coupon session cancel --id <sessionId> [--workspace <目录>]
  token-coupon session pending --id <sessionId> [--workspace <目录>]
  token-coupon session respond --id <sessionId> --request <requestId> (--decision allow-once|deny | --answers-file <answers.json>) [--workspace <目录>]
  token-coupon session logs --id <sessionId> [--task <taskId>] [--attempt <attemptId>] [--follow] [--json] [--raw] [--workspace <目录>]
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
  action: "show" | "run" | "resume" | "retry" | "delivery" | "land" | "cleanup" | "pause" | "cancel" | "pending" | "respond" | "logs";
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
  maxParallel?: number;
  requestId?: string;
  decision?: "allow-once" | "deny";
  answersFile?: string;
  runnerProfileFile?: string;
  attemptId?: string;
  followLogs: boolean;
  rawLogs: boolean;
  jsonLogs: boolean;
}

function parseArguments(args: string[]): ParsedCommand | "help" {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return "help";
  const [kind, action, ...options] = args;
  if (!(["plan", "task", "session"] as const).includes(kind as "plan" | "task" | "session") ||
      !(["show", "run", "resume", "retry", "delivery", "land", "cleanup", "pause", "cancel", "pending", "respond", "logs"] as const).includes(action as ParsedCommand["action"]) ||
      (kind === "task" && action !== "show" && action !== "run") ||
      (kind === "plan" && action !== "show" && action !== "run") ||
      (kind === "session" && action !== "show" && action !== "resume" && action !== "retry" && action !== "delivery" && action !== "land" && action !== "cleanup" && action !== "pause" && action !== "cancel" && action !== "pending" && action !== "respond" && action !== "logs")) {
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
  let maxParallel: number | undefined;
  let requestId: string | undefined;
  let decision: "allow-once" | "deny" | undefined;
  let answersFile: string | undefined;
  let runnerProfileFile: string | undefined;
  let attemptId: string | undefined;
  let followLogs = false;
  let rawLogs = false;
  let jsonLogs = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--accept-edits") {
      if (acceptEdits) throw new Error("--accept-edits 只能指定一次");
      acceptEdits = true;
      continue;
    }
    if (option === "--follow" || option === "--raw" || option === "--json") {
      if (kind !== "session" || action !== "logs") throw new Error(`${option} 只适用于 session logs`);
      if (option === "--follow") {
        if (followLogs) throw new Error("--follow 只能指定一次");
        followLogs = true;
      } else if (option === "--raw") {
        if (rawLogs) throw new Error("--raw 只能指定一次");
        rawLogs = true;
      } else {
        if (jsonLogs) throw new Error("--json 只能指定一次");
        jsonLogs = true;
      }
      continue;
    }
    if (option === "--continue") {
      if (kind !== "session" || action !== "land" || continueLanding) throw new Error("--continue 只适用于 session land，且只能指定一次");
      continueLanding = true;
      continue;
    }
    if (!["--file", "--id", "--task", "--workspace", "--mock-scenario", "--mock-task-scenario", "--isolation", "--verification-task", "--setup-file", "--max-parallel", "--request", "--decision", "--answers-file", "--runner-profile", "--attempt"].includes(option ?? "")) {
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
    } else if (option === "--max-parallel") {
      if (maxParallel !== undefined) throw new Error("--max-parallel 只能指定一次");
      maxParallel = Number(value);
      if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error("--max-parallel 必须是 1 到 8 之间的整数");
    } else if (option === "--request") {
      if (requestId !== undefined) throw new Error("--request 只能指定一次");
      requestId = value;
    } else if (option === "--decision") {
      if (decision !== undefined) throw new Error("--decision 只能指定一次");
      if (value !== "allow-once" && value !== "deny") throw new Error("--decision 只能是 allow-once 或 deny");
      decision = value;
    } else if (option === "--answers-file") {
      if (answersFile !== undefined) throw new Error("--answers-file 只能指定一次");
      answersFile = value;
    } else if (option === "--runner-profile") {
      if (runnerProfileFile !== undefined) throw new Error("--runner-profile 只能指定一次");
      runnerProfileFile = value;
    } else if (option === "--attempt") {
      if (attemptId !== undefined) throw new Error("--attempt 只能指定一次");
      attemptId = value;
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
  if (kind === "session" && action === "respond" && !requestId) throw new Error("session respond 缺少 --request 参数");
  if (kind === "session" && action === "respond" && Boolean(decision) === Boolean(answersFile)) throw new Error("session respond 必须且只能指定 --decision 或 --answers-file 之一");
  if (kind === "session" && action !== "respond" && (requestId || decision || answersFile)) throw new Error("--request/--decision/--answers-file 只适用于 session respond");
  if (kind === "session" && action !== "retry" && action !== "land" && action !== "logs" && taskId) throw new Error("--task 只适用于 session retry/land/logs");
  if (kind === "session" && action !== "logs" && attemptId) throw new Error("--attempt 只适用于 session logs");
  if (kind === "session" && action !== "logs" && (followLogs || rawLogs || jsonLogs)) throw new Error("日志显示参数只适用于 session logs");
  if (kind === "session" && action === "land" && !continueLanding) throw new Error("session land 需要 --continue");
  if (kind === "session" && action !== "land" && continueLanding) throw new Error("--continue 只适用于 session land");
  if (kind === "session" && action === "land" && acceptEdits) throw new Error("session land 不启动 Runner，不接受 --accept-edits");
  if (kind === "session" && file) throw new Error("--file 不适用于 Session 命令");
  if (kind === "plan" && action === "show" && (mockTaskScenarios.size || acceptEdits)) throw new Error("Mock 场景和 --accept-edits 只适用于 plan run");
  if ((kind !== "plan" || action !== "run") && (isolation || verificationTaskId)) throw new Error("--isolation 和 --verification-task 只适用于 plan run");
  if ((kind !== "plan" || action !== "run") && maxParallel !== undefined) throw new Error("--max-parallel 只适用于 plan run");
  if (maxParallel !== undefined && maxParallel > 1 && isolation !== "git-worktree") throw new Error("--max-parallel 大于 1 时需要 --isolation git-worktree");
  if (setupFile && !((kind === "plan" && action === "run") || (kind === "session" && (action === "resume" || action === "retry")))) throw new Error("--setup-file 只适用于 plan run、session resume 或 session retry");
  if (isolation === "git-worktree" && !verificationTaskId) throw new Error("--isolation git-worktree 需要 --verification-task <taskId>");
  if (!isolation && verificationTaskId) throw new Error("--verification-task 需要 --isolation git-worktree");
  if (kind === "task" && mockTaskScenarios.size) throw new Error("--mock-task-scenario 只适用于 plan/session 命令");
  if (kind === "task" && action === "show" && (workspace || mockScenario || acceptEdits)) throw new Error("执行参数只适用于 task run");
  if (kind === "task" && action === "run" && mockScenario && acceptEdits) throw new Error("--mock-scenario 与 --accept-edits 不能同时使用");
  if (kind === "session" && ["show", "delivery", "cleanup", "pause", "cancel", "pending", "respond", "logs"].includes(action ?? "") && (acceptEdits || mockScenario || mockTaskScenarios.size || setupFile)) throw new Error(`session ${action} 不接受执行参数`);
  if (mockScenario && (kind !== "task" || action !== "run")) throw new Error("--mock-scenario 只适用于 task run");
  if (runnerProfileFile && !((kind === "task" && action === "run") || (kind === "plan" && action === "run") || (kind === "session" && (action === "resume" || action === "retry")))) throw new Error("--runner-profile 只适用于 task run、plan run、session resume/retry");

  if ((kind === "task" && action === "run") || (kind === "plan" && action === "run") || kind === "session") {
    workspace ??= process.cwd();
  }
  return {
    kind: kind as ParsedCommand["kind"], action: action as ParsedCommand["action"],
    ...(file ? { file } : {}), ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}),
    ...(workspace ? { workspace } : {}), ...(mockScenario ? { mockScenario } : {}), ...(requestId ? { requestId } : {}), ...(decision ? { decision } : {}), ...(answersFile ? { answersFile } : {}), ...(runnerProfileFile ? { runnerProfileFile } : {}), ...(attemptId ? { attemptId } : {}),
    mockTaskScenarios, acceptEdits, continueLanding, followLogs, rawLogs, jsonLogs, ...(isolation ? { isolation } : {}), ...(verificationTaskId ? { verificationTaskId } : {}), ...(setupFile ? { setupFile } : {}), ...(maxParallel === undefined ? {} : { maxParallel }),
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

function bindCancellation(): { signal: AbortSignal; cancel: () => void; dispose: () => void } {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return { signal: controller.signal, cancel, dispose: () => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); } };
}

function showRunnerOutput(taskId: string, output: RunnerOutput, label = false, attemptId?: string): void {
  const displayText = output.displayText ?? output.agentText;
  if (label && (displayText || output.stream === "stderr" || (output.text && output.structuredEvent === undefined))) {
    const stream = output.stream === "stderr" ? process.stderr : process.stdout;
    stream.write(`\n[${taskId}${attemptId ? `#${attemptId.slice(0, 8)}` : ""}] `);
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
  if (args[0] === "task" && args[1] === "recover") {
    let workspace: string | undefined;
    let attemptId: string | undefined;
    let confirmedStopped = false;
    for (let index = 2; index < args.length; index++) {
      const flag = args[index];
      const value = args[index + 1];
      if (flag === "--confirm-stopped" && !confirmedStopped) confirmedStopped = true;
      else if (flag === "--workspace" && !workspace && value && !value.startsWith("--")) { workspace = value; index++; }
      else if (flag === "--attempt" && !attemptId && value && !value.startsWith("--")) { attemptId = value; index++; }
      else { console.error(`task recover 参数无效：${flag}`); return 2; }
    }
    if (!workspace || !attemptId) { console.error("用法：token-coupon task recover --attempt <attemptId> --workspace <目录> --confirm-stopped"); return 2; }
    try {
      const attempt = await recoverAbandonedAttempt({ workspace, attemptId, confirmedStopped });
      console.log(`Attempt：${attempt.attemptId}\n状态：${attempt.status}（${attempt.reasonCode}）\n${attempt.reason}\n清理状态：${attempt.cleanupStatus}`);
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (args[0] === "runner") {
    if (!args[1] || !["list", "doctor"].includes(args[1])) { console.error("用法：token-coupon runner list | doctor [--runner <id>] [--workspace <目录>]"); return 2; }
    if (args[1] === "list") {
      if (args.length !== 2) { console.error("用法：token-coupon runner list"); return 2; }
      for (const item of listRegisteredRunners()) console.log(`${item.id} · modes=${item.supportedModes.join(",")} · capabilities=${JSON.stringify(item.capabilities)}`);
      return 0;
    }
    let runnerId: string | undefined;
    let workspace: string | undefined;
    let probe = false;
    let modelId: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      const option = args[index];
      const value = args[index + 1];
      if (option === "--probe" && !probe) { probe = true; continue; }
      if ((option !== "--runner" && option !== "--workspace" && option !== "--model") || !value || value.startsWith("--")) {
        console.error(`无效参数：${option}\n用法：token-coupon runner doctor [--runner <id>] [--workspace <目录>] [--probe --model <模型>]`);
        return 2;
      }
      if (option === "--runner") {
        if (runnerId) { console.error("--runner 只能指定一次"); return 2; }
        runnerId = value;
      } else if (option === "--workspace") {
        if (workspace) { console.error("--workspace 只能指定一次"); return 2; }
        workspace = value;
      } else {
        if (modelId) { console.error("--model 只能指定一次"); return 2; }
        modelId = value;
      }
      index += 1;
    }
    if ((probe && (!runnerId || !workspace)) || (modelId && !probe)) {
      console.error("--probe 必须显式指定 --runner 和 --workspace；--model 仅用于 --probe");
      return 2;
    }
    if (workspace) {
      try {
        const info = await stat(resolve(workspace));
        if (!info.isDirectory()) throw new Error("不是目录");
      } catch (error) {
        console.error(`--workspace 必须是已存在的目录：${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }
    try {
      const results = await diagnoseRegisteredRunners(runnerId, workspace ? resolve(workspace) : process.cwd());
      for (const item of results) {
        console.log(`${item.id}/${item.mode} · ${item.available ? "available" : `unavailable: ${item.error ?? "unknown error"}`}`);
        console.log(`  版本：${item.diagnostics?.version ?? "unknown"}；认证配置：${item.diagnostics?.authentication ?? "unknown"}；模型调用：unverified`);
        for (const source of item.diagnostics?.configurationSources ?? []) console.log(`  配置文件：${source}`);
      }
      if (probe) {
        const cancellation = bindCancellation();
        try {
          const result = await probeRegisteredRunner(runnerId!, resolve(workspace!), cancellation.signal, modelId);
          printAttempt(result);
          return resultExitCode(result.attempt.status);
        } finally { cancellation.dispose(); }
      }
      return results.every((item) => item.available) ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return error instanceof InputValidationError ? 2 : 1;
    }
  }
  if (args[0] === "planner") return runPlannerCli(args.slice(1));
  let command: ParsedCommand | "help";
  try { command = parseArguments(args); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  if (command === "help") { console.log(usage); return 0; }

  try {
    const runnerProfile = command.runnerProfileFile ? await readRunnerProfile(command.runnerProfileFile) : undefined;
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
      const runner = createTaskRunner(task, { ...(command.acceptEdits ? { acceptEdits: true } : {}), ...(command.mockScenario ? { mockScenario: command.mockScenario } : {}), ...(runnerProfile ? { runnerProfile } : {}) });
      if (task.execution.modelId && !runner.supportsModel) throw new InputValidationError("task.execution.modelId", `${runner.id} 不支持 modelId`);
      if (command.acceptEdits && runner.id !== "claude-code") throw new InputValidationError("--accept-edits", "仅适用于 claude-code Runner");
      await runner.checkAvailable();
      await validateWorkspace(command.workspace!);
      const cancellation = bindCancellation();
      const interaction = createRunnerInteractionIO({ workspace: command.workspace!, input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), onCancel: cancellation.cancel });
      let result: Awaited<ReturnType<typeof executeTask>>;
      try {
        result = await executeTask({ task, cwd: command.workspace!, runner, signal: cancellation.signal, onOutput: (output) => showRunnerOutput(task.id, output),
          onInteraction: interaction.onInteraction,
          onIdleState: (state) => console.error(state.idle ? `\n[${task.id}] 暂无输出，任务仍在运行。` : `\n[${task.id}] 输出已恢复。`) });
      } finally { cancellation.dispose(); interaction.close(); }
      printAttempt(result);
      return resultExitCode(result.attempt.status);
    }

    const workspace = command.workspace!;
    await validateWorkspace(workspace);
    if (command.kind === "plan" && command.action === "run") {
      const plan = parsePlan(await readJsonFile(command.file!));
      const setupProfile = command.setupFile ? await readSetupFile(command.setupFile) : undefined;
      const cancellation = bindCancellation();
      const interaction = createRunnerInteractionIO({ workspace, input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), onCancel: cancellation.cancel });
      let result;
      let currentOutputTask: string | undefined;
      try {
        result = await runPlan({ plan, workspace, createRunner: createTaskRunner, signal: cancellation.signal, acceptEdits: command.acceptEdits,
          ...(runnerProfile ? { runnerProfile } : {}),
          onInteraction: interaction.onInteraction,
          ...(command.maxParallel === undefined ? {} : { maxParallel: command.maxParallel }),
          ...(command.isolation ? { isolation: command.isolation } : {}), ...(command.verificationTaskId ? { verificationTaskId: command.verificationTaskId } : {}),
          ...(setupProfile ? { setupProfile } : {}),
          mockTaskScenarios: command.mockTaskScenarios, onOutput: (taskId, output, attemptId) => {
            const firstForTask = taskId !== currentOutputTask;
            currentOutputTask = taskId;
            showRunnerOutput(taskId, output, (command.maxParallel ?? 1) > 1 || firstForTask, attemptId);
          }, onIdleState: (taskId, state) => console.error(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。` : `\n[${taskId}] 输出已恢复。`) });
      } finally { cancellation.dispose(); interaction.close(); }
      console.log(formatSession(result.snapshot, plan));
      return sessionExitCode(result.snapshot);
    }

    const sessionId = command.sessionId!;
    const sessionStore = new SessionStore(workspace);
    if (command.action === "logs") {
      const cancellation = command.followLogs ? bindCancellation() : undefined;
      try {
        await showSessionLogs({
          workspace,
          sessionId,
          ...(command.taskId ? { taskId: command.taskId } : {}),
          ...(command.attemptId ? { attemptId: command.attemptId } : {}),
          ...(command.followLogs ? { follow: true } : {}),
          ...(command.rawLogs ? { raw: true } : {}),
          ...(command.jsonLogs ? { json: true } : {}),
          ...(cancellation ? { signal: cancellation.signal } : {}),
          output: (line) => console.log(line),
        });
      } finally { cancellation?.dispose(); }
      return 0;
    }
    if (command.action === "pending") {
      const record = await sessionStore.load(sessionId);
      const pending = [];
      for (const taskState of record.snapshot.tasks) {
        if (!taskState.activeAttemptId || taskState.status !== "running") continue;
        const interactions = await readAttemptInteractions(workspace, taskState.activeAttemptId);
        pending.push(...interactions.filter((item) => item.status === "pending"));
      }
      if (!pending.length) { console.log("当前 Session 没有等待中的 Runner 请求。"); return 0; }
      for (const item of pending) console.log(`${item.requestId} · ${item.kind} · ${item.runnerId}/${item.taskId} · Attempt ${item.attemptId}\n${item.title}\n${item.summary}\n`);
      return 0;
    }
    if (command.action === "respond") {
      const record = await sessionStore.load(sessionId);
      const candidates = record.snapshot.tasks.filter((taskState) => taskState.status === "running" && taskState.activeAttemptId);
      let selected: { attemptId: string; taskId: string } | undefined;
      for (const taskState of candidates) {
        const interactions = await readAttemptInteractions(workspace, taskState.activeAttemptId!);
        if (interactions.some((item) => item.requestId === command.requestId && item.status === "pending")) {
          selected = { attemptId: taskState.activeAttemptId!, taskId: taskState.taskId };
          break;
        }
      }
      if (!selected) throw new Error("该请求不属于当前活跃 Attempt，或已不再等待回复");
      let reply: RunnerInteractionReply;
      if (command.decision) reply = { kind: "approval", decision: command.decision };
      else {
        const value = await readJsonFile(command.answersFile!);
        const answers = Array.isArray(value) ? value : value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).answers : undefined;
        if (!Array.isArray(answers)) throw new Error("answers 文件必须是 [{questionId, optionIds?, text?}] 或 {answers:[...]} JSON");
        if (answers.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).questionId !== "string" ||
            ((item as Record<string, unknown>).optionIds !== undefined && (!Array.isArray((item as Record<string, unknown>).optionIds) || ((item as Record<string, unknown>).optionIds as unknown[]).some((id) => typeof id !== "string"))) ||
            ((item as Record<string, unknown>).text !== undefined && typeof (item as Record<string, unknown>).text !== "string"))) throw new Error("answers 文件中的题目答案格式无效");
        reply = { kind: "question", answers: answers as Array<{ questionId: string; optionIds?: string[]; text?: string }> };
      }
      const responseId = await submitAttemptInteractionReply({ workspace, attemptId: selected.attemptId, requestId: command.requestId!, reply });
      console.log(`已提交回复 ${responseId}；owner 将核对并转发给 Runner。`);
      return 0;
    }
    if (command.action === "pause" || command.action === "cancel") {
      await sessionStore.requestControl(sessionId, command.action);
      const record = await sessionStore.load(sessionId);
      console.log(command.action === "pause" ? "已确认暂停 Session。" : "已确认取消 Session。");
      console.log(formatSession(record.snapshot, record.plan));
      return 0;
    }
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
    const interaction = createRunnerInteractionIO({ workspace, input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), onCancel: cancellation.cancel });
    let result;
    let currentOutputTask: string | undefined;
    try {
      const sessionMaxParallel = (await sessionStore.load(sessionId)).snapshot.maxParallel ?? 1;
      const operation = { sessionId, workspace, createRunner: createTaskRunner, signal: cancellation.signal,
        ...(runnerProfile ? { runnerProfile } : {}),
        onInteraction: interaction.onInteraction,
        acceptEdits: command.acceptEdits, mockTaskScenarios: command.mockTaskScenarios, ...(setupProfile ? { setupProfile } : {}), onOutput: (taskId: string, output: RunnerOutput, attemptId?: string) => {
          const firstForTask = taskId !== currentOutputTask;
          currentOutputTask = taskId;
          showRunnerOutput(taskId, output, sessionMaxParallel > 1 || firstForTask, attemptId);
        }, onIdleState: (taskId: string, state: { idle: boolean }) => console.error(state.idle ? `\n[${taskId}] 暂无输出，任务仍在运行。` : `\n[${taskId}] 输出已恢复。`) };
      result = command.action === "retry"
        ? await retrySession({ ...operation, taskId: command.taskId! })
        : command.action === "land"
          ? await continueSessionLanding({ ...operation, taskId: command.taskId! })
          : await resumeSession(operation);
    } finally { cancellation.dispose(); interaction.close(); }
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

async function readRunnerProfile(path: string): Promise<import("@token-coupon/core").RunnerProfile> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 1024 * 1024) throw new InputValidationError("--runner-profile", "必须是 1 MiB 以内的 JSON 文件");
  try {
    const profile = parseRunnerProfile(JSON.parse(await readFile(absolute, "utf8")) as unknown);
    validateCliRunnerProfile(profile);
    return profile;
  } catch (error) {
    throw new InputValidationError("--runner-profile", error instanceof Error ? error.message : String(error));
  }
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
