import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RepositoryReader, SessionStore } from "@token-coupon/core";

/** List task-owned changes from the validated isolation journal, never a whole-workspace scan. */
export async function readTaskResults(workspace: string, sessionId: string, taskId: string, path?: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new Error("task_results_cursor_invalid");
  const record = await new SessionStore(workspace).load(sessionId);
  const task = record.snapshot.tasks.find(item => item.taskId === taskId);
  if (!task) throw new Error("task_not_found：此任务不属于当前 Session");
  if (task.status !== "succeeded") throw new Error("task_results_unavailable：仅已完成任务可以查看生成结果");
  const attemptId = task.result?.attemptId ?? task.attempts.at(-1)?.attemptId;
  const proof = record.isolationJournal?.attempts.find(item => item.taskId === taskId && item.attemptId === attemptId && ["landed", "no_changes"].includes(item.status));
  if (!proof) {
    if (path !== undefined) throw new Error("task_results_path_invalid：本次任务没有可核验的文件清单");
    return { taskId, attemptId, source: "unrecorded", files: [], total: 0, nextOffset: null, executionDirectory: workspace,
      message: "此运行未记录任务级文件清单；不能将整个工作区文件算作此任务的产物。可查看模型回复与工具活动，或在工作区浏览文件。" };
  }
  const paths = [...new Set(proof.changedFiles)].sort();
  if (path !== undefined) {
    if (!paths.includes(path)) throw new Error("task_results_path_invalid：只能预览此任务记录中的文件");
    // SessionStore validates the expected worktree path. Reject substituted parent directories too.
    let current = workspace;
    for (const part of relative(workspace, proof.worktreePath).split(sep)) {
      current = join(current, part); const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("task_results_path_invalid：执行目录不可为符号链接");
    }
    const preview = JSON.parse(await new RepositoryReader(proof.worktreePath).invoke("repo_read", { path, startLine: 1, lineCount: 200 }));
    if (preview.error) throw new Error(`task_results_preview_unavailable：${preview.message || preview.error}；文件可能已删除或不允许预览。`);
    return { taskId, attemptId, source: "git-isolation", commit: proof.taskCommit, file: { ...preview, absolutePath: join(proof.worktreePath, path) },
      message: "预览为该任务执行目录中的当前文件；文件归属以任务 Git 提交记录为依据。" };
  }
  return { taskId, attemptId, source: "git-isolation", commit: proof.taskCommit, executionDirectory: proof.worktreePath,
    files: paths.slice(offset, offset + 100).map(path => ({ path, absolutePath: join(proof.worktreePath, path) })), total: paths.length,
    nextOffset: offset + 100 < paths.length ? offset + 100 : null,
    message: paths.length ? "以下为此任务的 Git 变更文件（含新增、修改或删除），不是整个项目的文件列表。" : "此任务已完成，Git 记录中没有新增或修改的交付文件。" };
}
