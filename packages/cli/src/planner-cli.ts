import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approvePlannerDraft, formatPlanner, formatSession, loadPlannerConversation, MockPlanner,
  replacePlannerDraft, replyToPlanner, retryPlannerTurn, runApprovedPlanner, SessionStore,
  startPlannerConversation,
} from "@token-coupon/core";
import type { PlannerConfig, Runner, TaskRunnerFactory } from "@token-coupon/core";
import { ClaudeCodeRunner, MockRunner } from "@token-coupon/core";

const HELP = [
  "用法：",
  "  token-coupon planner start --planner <mock|deepseek> --runner <mock|claude-code>",
  "      --request <需求> [--workspace <目录>] [--planner-model <modelId>]",
  "      [--task-model <modelId>] [--timeout-ms <毫秒>] [--mock-clarify]",
  "  token-coupon planner reply --id <planningId> --message <补充要求> [--workspace <目录>]",
  "  token-coupon planner retry --id <planningId> [--workspace <目录>]",
  "  token-coupon planner show --id <planningId> [--workspace <目录>]",
  "  token-coupon planner export --id <planningId> --file <计划.json> [--workspace <目录>]",
  "  token-coupon planner replace --id <planningId> --file <计划.json> [--workspace <目录>]",
  "  token-coupon planner approve --id <planningId> --revision <版本> [--workspace <目录>]",
  "  token-coupon planner run --id <planningId> [--workspace <目录>] [--accept-edits]",
  "",
  "DeepSeek Planner 配置：TOKEN_COUPON_PLANNER_API_KEY、TOKEN_COUPON_PLANNER_MODEL、",
  "TOKEN_COUPON_PLANNER_BASE_URL（默认 https://api.deepseek.com）。",
  "Planner 模型与任务 Runner 的 --task-model 分开配置。",
].join("\n");

type Action = "start" | "reply" | "retry" | "show" | "export" | "replace" | "approve" | "run" | "help";
interface Command { action: Action; values: Map<string, string>; acceptEdits: boolean; mockClarify: boolean; }

export async function runPlannerCli(args: string[]): Promise<number> {
  let command: Command;
  try { command = parse(args); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  if (command.action === "help") { console.log(HELP); return 0; }
  const get = (key: string) => command.values.get(key);
  const workspace = resolve(get("--workspace") ?? process.cwd());
  try {
    await validateWorkspace(workspace);
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
          executionDefaults: { runnerId, mode: "non_interactive", timeoutMs: Number(get("--timeout-ms") ?? 180_000), ...(modelId ? { modelId } : {}) },
          ...(provider === "mock" ? {
            planner: new MockPlanner(command.mockClarify
              ? [{ kind: "clarification", message: "在生成计划前，我需要确认实现范围。", questions: ["是否需要同时补充自动化测试？"] }]
              : []),
          } : {}), signal,
        }));
      console.log(formatPlanner(result));
      return result.error ? turnExitCode(result.snapshot.turns.at(-1)?.status) : 0;
    }
    const planningId = get("--id")!;
    if (command.action === "show") {
      console.log(formatPlanner(await loadPlannerConversation(planningId, workspace)));
      return 0;
    }
    if (command.action === "reply") {
      const result = await cancellable((signal) => replyToPlanner({ planningId, workspace, message: get("--message")!, signal }));
      console.log(formatPlanner(result));
      return result.error ? turnExitCode(result.snapshot.turns.at(-1)?.status) : 0;
    }
    if (command.action === "retry") {
      const result = await cancellable((signal) => retryPlannerTurn({ planningId, workspace, signal }));
      console.log(formatPlanner(result));
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
      return 0;
    }
    if (command.action === "approve") {
      const result = await cancellable((signal) => approvePlannerDraft({ planningId, workspace, draftRevision: Number(get("--revision")), signal }));
      console.log(formatPlanner(result));
      return 0;
    }
    if (command.action === "run") {
      const result = await cancellable((signal) => runApprovedPlanner({
          planningId, workspace, createRunner: createTaskRunner, acceptEdits: command.acceptEdits, signal,
          onOutput: (_taskId, output) => {
            const visible = output.displayText ?? output.agentText;
            if (visible) process.stdout.write(visible);
            else if (output.stream === "stderr" && output.text) process.stderr.write(output.text);
          },
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
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { action: "help", values: new Map(), acceptEdits: false, mockClarify: false };
  const [actionValue, ...options] = args;
  const actions: Action[] = ["start", "reply", "retry", "show", "export", "replace", "approve", "run"];
  if (!actions.includes(actionValue as Action)) throw new Error("planner 子命令无效。请运行 token-coupon planner --help 查看用法。");
  const action = actionValue as Action;
  const allowedByAction: Record<Action, string[]> = {
    start: ["--planner", "--runner", "--request", "--workspace", "--planner-model", "--task-model", "--timeout-ms"],
    reply: ["--id", "--message", "--workspace"],
    retry: ["--id", "--workspace"], show: ["--id", "--workspace"],
    export: ["--id", "--file", "--workspace"], replace: ["--id", "--file", "--workspace"],
    approve: ["--id", "--revision", "--workspace"], run: ["--id", "--workspace"],
    help: [],
  };
  const allowed = allowedByAction[action];
  const values = new Map<string, string>();
  let acceptEdits = false;
  let mockClarify = false;
  for (let index = 0; index < options.length; index += 1) {
    const key = options[index]!;
    if (key === "--mock-clarify") {
      if (action !== "start" || mockClarify) throw new Error("--mock-clarify 只适用于 planner start，且只能指定一次");
      mockClarify = true;
      continue;
    }
    if (key === "--accept-edits") {
      if (action !== "run" || acceptEdits) throw new Error("--accept-edits 只适用于 planner run，且只能指定一次");
      acceptEdits = true;
      continue;
    }
    if (!allowed.includes(key)) throw new Error("不支持的参数：" + key);
    const value = options[index + 1];
    if (!value || value.startsWith("--")) throw new Error(key + " 后需要提供值");
    if (values.has(key)) throw new Error(key + " 只能指定一次");
    values.set(key, value);
    index += 1;
  }
  const required: Record<Action, string[]> = {
    start: ["--planner", "--runner", "--request"], reply: ["--id", "--message"], retry: ["--id"], show: ["--id"],
    export: ["--id", "--file"], replace: ["--id", "--file"], approve: ["--id", "--revision"], run: ["--id"], help: [],
  };
  for (const key of required[action]) if (!values.has(key)) throw new Error("缺少 " + key + " 参数");
  values.set("--workspace", resolve(values.get("--workspace") ?? process.cwd()));
  if (action === "start") {
    if (!["mock", "deepseek"].includes(values.get("--planner")!)) throw new Error("--planner 只能是 mock 或 deepseek");
    if (!["mock", "claude-code"].includes(values.get("--runner")!)) throw new Error("--runner 只能是 mock 或 claude-code");
    if (values.has("--task-model") && values.get("--runner") !== "claude-code") throw new Error("--task-model 只适用于 claude-code Runner");
    if (mockClarify && values.get("--planner") !== "mock") throw new Error("--mock-clarify 只适用于 mock Planner");
    const timeout = Number(values.get("--timeout-ms") ?? 180_000);
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3_600_000) throw new Error("--timeout-ms 必须在 1000 到 3600000 之间");
    values.set("--timeout-ms", String(timeout));
  }
  if (action === "approve") {
    const revision = Number(values.get("--revision"));
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("--revision 必须是正整数");
    values.set("--revision", String(revision));
  }
  return { action, values, acceptEdits, mockClarify };
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

function turnExitCode(status: string | undefined): number { return status === "timed_out" ? 124 : status === "cancelled" ? 130 : 1; }
async function cancellable<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("操作已取消"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try { return await operation(controller.signal); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
function sessionExitCode(snapshot: import("@token-coupon/core").SessionSnapshot): number {
  if (snapshot.status === "succeeded" || snapshot.status === "ready") return 0;
  if (snapshot.tasks.some((task) => task.status === "timed_out")) return 124;
  return snapshot.status === "cancelled" ? 130 : 1;
}
