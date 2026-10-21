import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { connectOwnedDaemon } from "@token-coupon/client/node";
import type { InteractionReplyDto, JobDto } from "@token-coupon/client";

const usage = `显式后台客户端（只连接已运行的同一后台，不启动第二个调度器）：
  token-coupon daemon status | workspaces | pending [--offset <分页位置>] [--data-dir <后台数据目录>]
  token-coupon daemon planning list --workspace-id <ID>
  token-coupon daemon planning show|review|approve|run|pause|cancel|resume|retry|delivery --workspace-id <ID> --planning-id <ID>
      approve: --draft-revision <当前草案版本>
      run: --isolation shared|git-worktree [--max-parallel <1-8>] [--verification-task <taskId>]
      retry: --task <taskId>
  token-coupon daemon job show --id <jobId>
  token-coupon daemon interaction list --workspace-id <ID> --planning-id <ID>
  token-coupon daemon interaction respond --workspace-id <ID> --request <requestId> (--decision allow-once|deny | --reply-file <JSON>)
所有命令可指定 --data-dir；默认 TOKEN_COUPON_DAEMON_HOME 或用户目录下 .token-coupon/daemon。
写命令可指定 --request-key <UUID> 查询/复用同一回执；不会自动重试或绕过审查/批准。
写入返回 Job 后用 daemon job show 查询最终结果；任务在后台继续运行。`;

type Command = { action: string; values: Map<string, string>; requestKey: string; mutation: boolean };
function parse(args: string[]): Command {
  const head = args[0]!, group = ["planning", "job", "interaction"].includes(head), action = group ? `${head}.${args[1]}` : head;
  const allowed: Record<string, string[]> = {
    status: [], workspaces: [], pending: ["--offset"], "planning.list": ["--workspace-id"],
    "planning.show": ["--workspace-id", "--planning-id"], "planning.review": ["--workspace-id", "--planning-id"],
    "planning.approve": ["--workspace-id", "--planning-id", "--draft-revision"],
    "planning.run": ["--workspace-id", "--planning-id", "--isolation", "--max-parallel", "--verification-task"],
    "planning.pause": ["--workspace-id", "--planning-id"], "planning.cancel": ["--workspace-id", "--planning-id"],
    "planning.resume": ["--workspace-id", "--planning-id"], "planning.retry": ["--workspace-id", "--planning-id", "--task"],
    "planning.delivery": ["--workspace-id", "--planning-id"], "job.show": ["--id"],
    "interaction.list": ["--workspace-id", "--planning-id"], "interaction.respond": ["--workspace-id", "--request", "--reply-file", "--decision"],
  };
  const flags = allowed[action]; if (!flags) throw new Error("daemon_command_invalid：请运行 token-coupon daemon --help");
  const values = new Map<string, string>();
  const mutation = ["planning.review", "planning.approve", "planning.run", "planning.pause", "planning.cancel", "planning.resume", "planning.retry", "planning.delivery"].includes(action);
  const permitted = [...flags, "--data-dir", ...(mutation ? ["--request-key"] : [])];
  for (let i = group ? 2 : 1; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if (!permitted.includes(flag) || !value?.trim() || value.startsWith("--") || values.has(flag)) throw new Error(`daemon_option_invalid：参数无效、缺值或重复：${flag}`);
    values.set(flag, value);
  }
  const required = flags.filter(flag => !["--max-parallel", "--verification-task", "--offset", "--reply-file", "--decision"].includes(flag));
  for (const flag of required) if (!values.has(flag)) throw new Error(`daemon_option_required：需要 ${flag}`);
  if (action === "interaction.respond" && (Number(values.has("--reply-file")) + Number(values.has("--decision")) !== 1 || values.has("--decision") && !["allow-once", "deny"].includes(values.get("--decision")!))) throw new Error("daemon_reply_invalid：仅选择 --decision allow-once|deny 或 --reply-file 其中一种回答方式");
  const revision = values.get("--draft-revision"); if (revision !== undefined && (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) < 1)) throw new Error("daemon_revision_invalid：草案版本必须为正整数");
  const parallel = values.get("--max-parallel"); if (parallel !== undefined && !/^[1-8]$/.test(parallel)) throw new Error("daemon_parallel_invalid：并发数量必须为 1–8");
  const isolation = values.get("--isolation"); if (isolation !== undefined && !["shared", "git-worktree"].includes(isolation)) throw new Error("daemon_isolation_invalid：隔离模式必须为 shared 或 git-worktree");
  const offset = values.get("--offset"); if (offset !== undefined && (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)))) throw new Error("pending_offset_invalid：分页位置必须为非负整数");
  const requestKey = values.get("--request-key") ?? randomUUID(); if (!/^[0-9a-f-]{36}$/i.test(requestKey)) throw new Error("idempotency_key_invalid：request-key 必须为 UUID");
  return { action, values, requestKey, mutation };
}

export async function runDaemonCli(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help")) { console.log(usage); return 0; }
  let command: Command;
  try { command = parse(args); } catch (error) { console.error((error as Error).message); return 2; }
  try {
    const { action, values, requestKey } = command;
    const selected = values.get("--data-dir") ?? process.env.TOKEN_COUPON_DAEMON_HOME;
    if (selected !== undefined && !selected.trim()) throw new Error("daemon_data_directory_invalid：后台数据目录不能为空");
    let reply: InteractionReplyDto | undefined;
    if (action === "interaction.respond" && values.has("--decision")) reply = { kind: "approval", decision: values.get("--decision") as "allow-once" | "deny" };
    else if (action === "interaction.respond") {
      const file = values.get("--reply-file")!;
      if ((await stat(file)).size > 64 * 1024) throw new Error("daemon_reply_too_large：回答文件不能超过 64 KiB");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) || !["approval", "question", "elicitation"].includes(String(value.kind))) throw new Error("daemon_reply_invalid：回答需为带 kind 的 JSON 对象；具体字段由后台再次校验");
      reply = value as InteractionReplyDto;
    }
    const { attachment, client } = await connectOwnedDaemon(selected === undefined ? join(homedir(), ".token-coupon", "daemon") : resolve(selected));
    const workspace = values.get("--workspace-id")!, planning = values.get("--planning-id")!, body = { requestKey };
    if (command.mutation) console.log(`请求标识：${requestKey}。响应中断时先核对计划状态；相同标识只能复用原始请求。`);
    let result: unknown;
    switch (action) {
      case "status": result = attachment; break;
      case "workspaces": result = await client.domain.workspaces(); break;
      case "pending": result = await client.domain.pendingQueue(Number(values.get("--offset") ?? 0)); break;
      case "planning.list": result = await client.domain.plannings(workspace); break;
      case "planning.show": result = await client.domain.planning(workspace, planning); break;
      case "interaction.list": result = await client.domain.interactions(workspace, planning); break;
      case "interaction.respond": result = await client.commands.answerInteraction(workspace, values.get("--request")!, reply!); break;
      case "job.show": result = await client.domain.job(values.get("--id")!); break;
      case "planning.review": result = await client.commands.reviewPlanning(workspace, planning, body); break;
      case "planning.approve": result = await client.commands.approvePlanning(workspace, planning, { ...body, draftRevision: Number(values.get("--draft-revision")) }); break;
      case "planning.run": {
        const view = await client.domain.planning(workspace, planning);
        if (!view.draft) throw new Error("draft_missing：当前计划没有草案");
        result = await client.commands.runPlanning(workspace, planning, { ...body, isolation: values.get("--isolation") as "shared" | "git-worktree", maxParallel: Number(values.get("--max-parallel") ?? 1),
          expectedDraftRevision: view.draft.draftRevision, expectedPlanHash: view.draft.planHash,
          ...(values.has("--verification-task") ? { verificationTaskId: values.get("--verification-task")! } : {}) }); break;
      }
      case "planning.pause": result = await client.commands.pauseSession(workspace, planning, body); break;
      case "planning.cancel": result = await client.commands.cancelSession(workspace, planning, body); break;
      case "planning.resume": result = await client.commands.resumeSession(workspace, planning, body); break;
      case "planning.retry": result = await client.commands.retryTask(workspace, planning, { ...body, taskId: values.get("--task")! }); break;
      case "planning.delivery": result = await client.commands.deliverSession(workspace, planning, body); break;
    }
    console.log(JSON.stringify(result, null, 2));
    if (result && typeof result === "object" && "jobId" in result) {
      const job = result as JobDto;
      console.log(`操作已提交：${job.jobId}（${job.status}）。使用 daemon job show --id ${job.jobId} 查询结果；任务由后台继续运行。`);
    }
    return 0;
  } catch (error) {
    console.error(`daemon_client_failed：${(error as Error).message}。不会退回直接执行模式；若写请求已发出，请先核对计划状态或操作回执，避免重复操作。`); return 1;
  }
}
