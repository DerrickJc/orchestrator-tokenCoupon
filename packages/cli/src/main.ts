#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeCodeRunner, executeTask, InputValidationError, MockRunner, parsePlan, parseTask } from "@token-coupon/core";
import type { PlanDefinition, TaskDefinition } from "@token-coupon/core";

const usage = `用法：
  token-coupon plan show --file <计划.json>
  token-coupon task show --file <任务.json>
  token-coupon task run --file <任务.json> [--workspace <目录>] [--mock-scenario <场景>] [--accept-edits]
  token-coupon --help

支持 Runner：mock、claude-code。工作目录默认为启动 CLI 时的当前目录，可通过 --workspace 指定。
任务生成的文件写入工作目录，执行记录写入其 .token-coupon/runs/<attemptId>/。`;

interface ParsedCommand {
  kind: "plan" | "task";
  action: "show" | "run";
  file: string;
  workspace?: string;
  mockScenario?: string;
  acceptEdits?: boolean;
}

function parseArguments(args: string[]): ParsedCommand | "help" {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return "help";
  }

  const [kind, action, ...options] = args;
  if ((kind !== "plan" && kind !== "task") || (action !== "show" && !(kind === "task" && action === "run"))) {
    throw new Error("命令无效。请运行 token-coupon --help 查看用法。");
  }

  let file: string | undefined;
  let workspace: string | undefined;
  let mockScenario: string | undefined;
  let acceptEdits = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--accept-edits") {
      if (acceptEdits) throw new Error("--accept-edits 只能指定一次");
      acceptEdits = true;
      continue;
    }
    if (!["--file", "--workspace", "--mock-scenario"].includes(option ?? "")) {
      throw new Error(`不支持的参数：${option}`);
    }
    if (option === "--file" ? file !== undefined : option === "--workspace" ? workspace !== undefined : mockScenario !== undefined) {
      throw new Error(`${option} 只能指定一次`);
    }

    const value = options[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--file 后需要提供 JSON 文件路径");
    }
    if (option === "--file") file = value;
    else if (option === "--workspace") workspace = value;
    else mockScenario = value;
    index += 1;
  }

  if (file === undefined) {
    throw new Error("缺少 --file 参数");
  }

  if (action === "show" && (workspace !== undefined || mockScenario !== undefined || acceptEdits)) throw new Error("--workspace、--mock-scenario 和 --accept-edits 只适用于 task run");
  if (action === "run" && workspace === undefined) workspace = process.cwd();
  return { kind, action, file, ...(workspace ? { workspace } : {}), ...(mockScenario ? { mockScenario } : {}), ...(acceptEdits ? { acceptEdits } : {}) };
}

async function readJsonFile(file: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取文件 ${file}：${detail}`);
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: JSON 格式无效：${detail}`);
  }
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
    `  超时：${task.execution.timeoutMs} ms`,
  ];
}

function formatPlan(plan: PlanDefinition): string {
  const lines = [`计划：${plan.id} — ${plan.title}`, `任务数：${plan.tasks.length}`];

  for (const [index, plannedTask] of plan.tasks.entries()) {
    if (index > 0) {
      lines.push("");
    }
    lines.push(
      ...formatTask(plannedTask.task, plannedTask.status, plannedTask.dependsOn),
    );
  }

  return lines.join("\n");
}

export async function runCli(args: string[]): Promise<number> {
  let command: ParsedCommand | "help";
  try {
    command = parseArguments(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (command === "help") {
    console.log(usage);
    return 0;
  }

  try {
    const rawValue = await readJsonFile(command.file);
    if (command.kind === "plan") {
      console.log(formatPlan(parsePlan(rawValue)));
    } else if (command.action === "show") {
      console.log(formatTask(parseTask(rawValue)).join("\n"));
    } else {
      const task = parseTask(rawValue);
      const runner = task.execution.runnerId === "mock"
        ? new MockRunner(command.mockScenario)
        : task.execution.runnerId === "claude-code" ? new ClaudeCodeRunner(command.acceptEdits ? "acceptEdits" : undefined) : undefined;
      if (!runner) throw new InputValidationError("task.execution.runnerId", `不支持的 Runner：${task.execution.runnerId}`);
      if (task.execution.modelId && !runner.supportsModel) throw new InputValidationError("task.execution.modelId", `${runner.id} 不支持 modelId`);
      if (command.mockScenario && runner.id !== "mock") throw new InputValidationError("--mock-scenario", "仅适用于 mock Runner");
      if (command.acceptEdits && runner.id !== "claude-code") throw new InputValidationError("--accept-edits", "仅适用于 claude-code Runner");
      await runner.checkAvailable();
      const workspaceInfo = await stat(command.workspace!);
      if (!workspaceInfo.isDirectory()) throw new InputValidationError("--workspace", "必须是已存在的目录");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      let result: Awaited<ReturnType<typeof executeTask>>;
      try {
        result = await executeTask({
          task,
          cwd: command.workspace!,
          runner,
          signal: controller.signal,
          onOutput: (output) => {
            const displayText = output.displayText ?? output.agentText;
            if (displayText) process.stdout.write(displayText);
            else if (output.stream === "stderr" && output.text) process.stderr.write(output.text);
          },
        });
      } catch (error) {
        console.error(`执行记录创建失败，Runner 未启动：${error instanceof Error ? error.message : String(error)}`);
        return 1;
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
      const elapsedMs = Date.parse(result.attempt.finishedAt ?? "") - Date.parse(result.attempt.createdAt);
      console.log(`\n任务：${result.attempt.taskId}`);
      console.log(`Attempt：${result.attempt.attemptId}`);
      console.log(`状态：${result.attempt.status}（${result.attempt.reasonCode}）`);
      console.log(`退出码：${result.attempt.exitCode ?? "无"}；耗时：${Number.isFinite(elapsedMs) ? elapsedMs : "未知"} ms`);
      console.log(`产物：${result.artifactDir}`);
      if (result.attempt.reason) console.error(result.attempt.reason);
      if (result.attempt.status === "succeeded") return 0;
      if (result.attempt.status === "timed_out") return 124;
      if (result.attempt.status === "cancelled") return 130;
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof InputValidationError) {
      console.error(`${command.file}: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return 2;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
