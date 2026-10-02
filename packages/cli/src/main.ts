#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InputValidationError, parsePlan, parseTask } from "@token-coupon/core";
import type { PlanDefinition, TaskDefinition } from "@token-coupon/core";

const usage = `用法：
  token-coupon plan show --file <计划.json>
  token-coupon task show --file <任务.json>
  token-coupon --help

阶段 0 只读取和展示计划，不会启动 Runner 或修改工作目录。`;

interface ParsedCommand {
  kind: "plan" | "task";
  file: string;
}

function parseArguments(args: string[]): ParsedCommand | "help" {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return "help";
  }

  const [kind, action, ...options] = args;
  if ((kind !== "plan" && kind !== "task") || action !== "show") {
    throw new Error("命令无效。请运行 token-coupon --help 查看用法。");
  }

  let file: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option !== "--file") {
      throw new Error(`不支持的参数：${option}`);
    }
    if (file !== undefined) {
      throw new Error("--file 只能指定一次");
    }

    const value = options[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--file 后需要提供 JSON 文件路径");
    }
    file = value;
    index += 1;
  }

  if (file === undefined) {
    throw new Error("缺少 --file 参数");
  }

  return { kind, file };
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
    } else {
      console.log(formatTask(parseTask(rawValue)).join("\n"));
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
