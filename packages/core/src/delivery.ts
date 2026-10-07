import { createHash } from "node:crypto";
import type { SessionRecord } from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import { parseNulPaths, runGit } from "./git-repository.js";
import { WorktreeIsolation } from "./worktree-isolation.js";

export interface SessionDeliveryReport {
  schemaVersion: 1;
  sessionId: string;
  status: "ready";
  baseCommit: string;
  integrationHead: string;
  sourceBranch: string | null;
  integrationBranch: string;
  integrationWorktree: string;
  verificationTaskId: string;
  verificationAttemptId: string;
  verificationCommit: string;
  diffSha256: string;
  changedFiles: string[];
  taskCommits: Array<{ taskId: string; attemptId: string; commit: string; files: string[] }>;
  generatedAt: string;
}

export async function createSessionDelivery(record: SessionRecord, store: SessionStore): Promise<SessionDeliveryReport> {
  const isolation = record.snapshot.isolation;
  const journal = record.isolationJournal;
  if (isolation?.mode !== "git-worktree" || !journal) throw new Error("该 Session 未启用 git-worktree 隔离，没有 Git delivery");
  if (record.snapshot.status !== "succeeded" || record.snapshot.tasks.some((task) => task.status !== "succeeded")) {
    throw new Error("Session 尚未全部成功，暂时不能生成 delivery");
  }
  const verificationState = record.snapshot.tasks.find((task) => task.taskId === isolation.verificationTaskId);
  const verificationAttemptId = verificationState?.attempts.at(-1)?.attemptId;
  const verificationJournal = verificationAttemptId ? journal.attempts.find((attempt) => attempt.attemptId === verificationAttemptId) : undefined;
  if (!verificationState || !verificationAttemptId || verificationJournal?.status !== "no_changes" || verificationJournal.baseCommit !== journal.integrationHead) {
    throw new Error("最终验证记录没有对应当前整合版本，delivery 已过期或不完整");
  }
  const worktrees = new WorktreeIsolation(record, store);
  await worktrees.assertIntegrationReadyForDelivery();
  const diff = await runGit(isolation.repositoryRoot, ["diff", "--binary", "--no-ext-diff", isolation.baseCommit, journal.integrationHead]);
  const changedFiles = parseNulPaths((await runGit(isolation.repositoryRoot, ["diff", "--name-only", "-z", "--no-renames", isolation.baseCommit, journal.integrationHead])).stdout);
  const taskCommits = journal.attempts.flatMap((attempt) => attempt.status === "landed" && attempt.taskCommit
    ? [{ taskId: attempt.taskId, attemptId: attempt.attemptId, commit: attempt.taskCommit, files: attempt.changedFiles }]
    : []);
  const report: SessionDeliveryReport = {
    schemaVersion: 1, sessionId: record.snapshot.sessionId, status: "ready",
    baseCommit: isolation.baseCommit, integrationHead: journal.integrationHead,
    sourceBranch: isolation.sourceBranch, integrationBranch: isolation.integrationBranch,
    integrationWorktree: isolation.integrationWorktree, verificationTaskId: isolation.verificationTaskId,
    verificationAttemptId, verificationCommit: verificationJournal.baseCommit,
    diffSha256: createHash("sha256").update(diff.stdoutBuffer).digest("hex"), changedFiles, taskCommits,
    generatedAt: new Date().toISOString(),
  };
  await store.saveDeliveryReport(record.snapshot.sessionId, report);
  return report;
}

export function formatSessionDelivery(report: SessionDeliveryReport, workspace: string): string {
  const lines = [
    `Delivery：${report.sessionId}（${report.status}）`,
    `基线：${report.baseCommit}`,
    `整合版本：${report.integrationHead}`,
    `Session 分支：${report.integrationBranch}`,
    `最终验证：${report.verificationTaskId} · Attempt ${report.verificationAttemptId} · ${report.verificationCommit}`,
    `Diff SHA-256：${report.diffSha256}`,
    `变更文件（${report.changedFiles.length}）：${report.changedFiles.length ? report.changedFiles.join(", ") : "无"}`,
    "任务提交：",
    ...(report.taskCommits.length ? report.taskCommits.map((item) => `  ${item.taskId} · ${item.attemptId} · ${item.commit} · ${item.files.length} 个文件`) : ["  无（仅验证或无代码变更）"]),
    `Diff：git -C '${shellQuotePath(workspace)}' diff --stat ${report.baseCommit} ${report.integrationHead}`,
    `完整差异：git -C '${shellQuotePath(workspace)}' diff ${report.baseCommit} ${report.integrationHead}`,
  ];
  if (report.sourceBranch) {
    lines.push("人工合并（核对 diff 后执行）：", `  git -C '${shellQuotePath(workspace)}' switch ${shellQuoteArg(report.sourceBranch)}`, `  git -C '${shellQuotePath(workspace)}' merge --no-ff -- ${shellQuoteArg(report.integrationBranch)}`);
  } else {
    lines.push("原仓库处于 detached HEAD；先人工选择目标分支，再核对并合并 Session 分支：", `  git -C '${shellQuotePath(workspace)}' merge --no-ff -- ${shellQuoteArg(report.integrationBranch)}`);
  }
  return lines.join("\n");
}

function shellQuoteArg(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function shellQuotePath(value: string): string { return value.replace(/'/g, `'\\''`); }
