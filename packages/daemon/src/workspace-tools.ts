import { readdir, realpath, stat, lstat, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, parse } from "node:path";
import { GitCommandError, ensureRuntimeMetadataIgnored, inspectGitRepository, runGit } from "@token-coupon/core";
import { normalizeWorkspacePath, workspaceEnvironment } from "./workspace-path.js";

/** Only exposed on the authenticated local console, never on remote MCP. */
export async function browseDirectories(input?: string, offset = 0) {
  const env = workspaceEnvironment();
  const path = await realpath(await normalizeWorkspacePath(input || env.currentDirectory));
  if (!(await stat(path)).isDirectory()) throw new Error("directory_invalid：请选择一个文件夹");
  const all = (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules").sort((a, b) => a.name.localeCompare(b.name));
  const shortcuts = [{ label: "当前项目目录", path: env.currentDirectory }, { label: "主目录", path: env.home }, { label: "文件系统", path: parse(path).root }];
  if (env.isWsl) shortcuts.push({ label: "Windows 磁盘（/mnt）", path: "/mnt" });
  return { path, parent: dirname(path) === path ? null : dirname(path), shortcuts, entries: all.slice(offset, offset + 100).map(entry => ({ name: entry.name, path: join(path, entry.name) })), nextOffset: offset + 100 < all.length ? offset + 100 : null };
}

export interface WorkspaceGitStatus {
  state: "not_repository" | "wrong_root" | "no_commit" | "metadata_tracked" | "dirty" | "identity_missing" | "ready" | "unsupported";
  message: string; repositoryRoot?: string; trackedMetadataCount?: number; paths?: string[]; commands?: string[];
  branch?: string; head?: string; changes?: GitChange[];
}

export interface GitChange { path: string; code: string; staged: boolean; unstaged: boolean; runtime: boolean; }
export interface GitCommitInput { mode: "runtime" | "selected"; paths: string[]; fingerprint: string; message: string; }
const runtimePath = (path: string) => path.startsWith(".token-coupon/");

export async function gitChanges(path: string): Promise<GitChange[]> {
  const fields = (await runGit(path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0");
  const changes: GitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]; if (!field) continue;
    const code = field.slice(0, 2), name = field.slice(3);
    changes.push({ path: name, code, staged: ![" ", "?"].includes(code[0]!), unstaged: code[1] !== " ", runtime: runtimePath(name) });
    if (/[RC]/.test(code)) i++; // porcelain -z supplies the old path after a rename/copy.
  }
  return changes;
}

async function repositoryHead(path: string): Promise<string> {
  return (await runGit(path, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
}

/** Read-only preview. The token binds the selection, index, HEAD and selected worktree bytes. */
export async function previewGitCommit(path: string, mode: string, paths: string[]) {
  const root = await realpath((await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (root !== path) throw new Error("git_root_required：请使用仓库根目录");
  if (mode !== "runtime" && mode !== "selected") throw new Error("git_commit_mode_invalid");
  const changes = await gitChanges(path);
  const selected = mode === "runtime" ? changes.filter(item => item.runtime && item.code === "D ").map(item => item.path) : [...new Set(paths)].sort();
  if (!selected.length || selected.length > 1000) throw new Error("git_selection_required：请选择需要提交的文件");
  const staged = changes.filter(item => item.staged);
  if (staged.some(item => !selected.includes(item.path))) throw new Error("git_staged_other_changes：暂存区还有未选中的变更，请先检查并分开处理；系统未修改暂存区");
  const hash = createHash("sha256");
  const head = await repositoryHead(path).catch(() => "unborn");
  hash.update(JSON.stringify({ root, mode, selected, head, changes }));
  hash.update((await runGit(path, ["ls-files", "--stage", "-z"])).stdoutBuffer);
  const previews: Array<{ path: string; code: string; text: string; truncated: boolean }> = [];
  for (const name of selected) {
    const change = changes.find(item => item.path === name);
    if (!change || name.startsWith("/") || name.split("/").some(part => part === ".." || part === ".git")) throw new Error("git_selection_invalid：选择包含无效或已变化的文件");
    if (mode === "runtime" ? !change.runtime || change.code !== "D " : change.runtime) throw new Error("git_selection_invalid：运行记录修复与项目提交必须分开");
    if (/[RCU]/.test(change.code) || (change.staged && change.unstaged)) throw new Error("git_manual_index_required：重命名、冲突或部分暂存文件请先手工处理，系统不会覆盖暂存版本");
    let text = "";
    if (mode === "runtime") text = "从仓库移除运行记录，本机文件保留。";
    else {
      const full = join(path, name);
      const info = await lstat(full).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (info?.isDirectory()) throw new Error("git_selection_invalid：不支持直接提交目录或子模块");
      if (info) {
        // Refuse traversal through an ancestor symlink; symlink files are previewed as links.
        if (await realpath(dirname(full)) !== dirname(full)) throw new Error("git_selection_invalid：文件父目录不能是符号链接");
        if (info.size > 2 * 1024 * 1024) throw new Error("git_preview_too_large：超过 2 MiB 的文件请手工检查提交");
        const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full);
        hash.update(bytes); hash.update(String(info.mode));
        if (bytes.includes(0)) throw new Error("git_preview_binary：二进制文件请手工检查提交");
        if (change.code === "??") text = bytes.toString("utf8");
      }
      if (change.code !== "??") text = (await runGit(path, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--binary", ...(head === "unborn" ? ["--cached"] : ["HEAD"]), "--", name])).stdout;
      hash.update(text);
    }
    previews.push({ path: name, code: change.code, text: text.slice(0, 16000), truncated: text.length > 16000 });
  }
  return { mode, paths: selected, fingerprint: hash.digest("hex"), head, previews, suggestedMessage: mode === "runtime" ? "chore: stop tracking local runtime state" : head === "unborn" ? "chore: initialize project" : "chore: save workspace changes" };
}

export async function commitWorkspaceGit(path: string, input: GitCommitInput) {
  if (!input.message?.trim() || Buffer.byteLength(input.message) > 1024) throw new Error("git_commit_message_invalid：请填写提交说明（最多 1024 字节）");
  const preview = await previewGitCommit(path, input.mode, input.paths);
  if (preview.fingerprint !== input.fingerprint) throw new Error("git_preview_stale：仓库或文件已变化，请重新预览后确认提交");
  if (input.mode === "selected") await runGit(path, ["--literal-pathspecs", "add", "--", ...preview.paths]);
  const stagedNow = await gitChanges(path);
  const headNow = await repositoryHead(path).catch(() => "unborn");
  if (headNow !== preview.head || stagedNow.filter(item => item.staged).length !== preview.paths.length || stagedNow.some(item => item.staged && (!preview.paths.includes(item.path) || item.unstaged))) throw new Error("git_preview_stale：暂存区、HEAD 或文件在提交前发生变化，请检查后重新预览");
  // Every staged path was explicitly previewed. Preserve hooks and surface failures without reset.
  await runGit(path, ["commit", "-m", input.message]);
  return { commit: await repositoryHead(path), status: await workspaceGitStatus(path) };
}

export async function workspaceGitStatus(path: string): Promise<WorkspaceGitStatus> {
  let root: string;
  try { root = await realpath((await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim()); }
  catch (error) {
    if (error instanceof GitCommandError && /not a git repository/i.test(error.message)) return { state: "not_repository", message: "此文件夹还不是 Git 仓库。可点击初始化，或自行创建后刷新；共享工作区串行执行不要求 Git。", commands: ["git init"] };
    throw error;
  }
  if (root !== path) return { state: "wrong_root", repositoryRoot: root, message: `所选文件夹位于另一个 Git 仓库内。请打开仓库根目录：${root}` };
  try { await runGit(path, ["rev-parse", "--verify", "HEAD^{commit}"]); }
  catch (error) {
    if (error instanceof GitCommandError) return { state: "no_commit", changes: await gitChanges(path), message: "Git 已初始化，但还没有首次提交。可选择项目文件并预览首次提交，或创建空基线；空基线不会保存已有源码，仍需处理未提交文件。", commands: ["# 若尚未配置 Git 身份，先填写以下两项（只作用于此仓库）", "git config user.name \"你的姓名\"", "git config user.email \"你的邮箱\"", "git commit --allow-empty -m \"chore: initialize repository\""] };
    throw error;
  }
  const head = await repositoryHead(path);
  const branch = (await runGit(path, ["branch", "--show-current"])).stdout.trim() || "分离 HEAD";
  const changes = await gitChanges(path);
  const tracked = (await runGit(path, ["ls-files", "-z", "--", ".token-coupon"])).stdout.split("\0").filter(Boolean);
  if (tracked.length) return { state: "metadata_tracked", trackedMetadataCount: tracked.length, paths: tracked.slice(0, 10), message: `.token-coupon 中有 ${tracked.length} 个文件已被 Git 跟踪。它保存持续变化的对话和运行记录，应只保存在本机。取消跟踪会保留本机文件，之后需要提交这次索引变更。`, commands: ["git rm -r --cached -- .token-coupon", "git commit -m \"chore: stop tracking local runtime state\""] };
  if (changes.length) return { state: "dirty", head, branch, changes, message: changes.every(item => item.runtime && item.code === "D ") ? "运行记录已取消跟踪，本机文件保留；还需确认提交这次仓库变更。" : "仓库还有未提交变更。请选择文件、预览后确认提交，或手工处理后重新检查。", paths: changes.slice(0, 10).map(item => `${item.code} ${item.path}`), commands: ["git status", "git diff", "git commit"] };
  try { await runGit(path, ["var", "GIT_AUTHOR_IDENT"]); await runGit(path, ["var", "GIT_COMMITTER_IDENT"]); }
  catch { return { state: "identity_missing", message: "尚未配置 Git 提交者。请设置本仓库的 user.name 与 user.email 后刷新。", commands: ["git config user.name \"你的姓名\"", "git config user.email \"你的邮箱\""] }; }
  try { await inspectGitRepository(path); }
  catch (error) { return { state: "unsupported", message: error instanceof Error ? error.message : String(error) }; }
  return { state: "ready", head, branch, changes, message: `Git 已就绪：${branch} · ${head.slice(0, 8)}；工作区干净，运行记录未被跟踪。` };
}

export async function prepareWorkspaceGit(path: string, action: string): Promise<WorkspaceGitStatus> {
  const status = await workspaceGitStatus(path);
  if (action === "initialize") {
    if (status.state !== "not_repository") throw new Error("git_action_invalid：当前目录不需要初始化，请刷新检查");
    await runGit(path, ["init"]);
  } else if (action === "initial-commit") {
    if (status.state !== "no_commit") throw new Error("git_action_invalid：此仓库已有提交或尚未初始化");
    const staged = (await runGit(path, ["diff", "--cached", "--name-only", "-z"])).stdout;
    if (staged) throw new Error("git_index_not_empty：暂存区已有文件。请自行检查并提交，系统不会将它们纳入空的首次提交");
    try { await runGit(path, ["var", "GIT_AUTHOR_IDENT"]); await runGit(path, ["var", "GIT_COMMITTER_IDENT"]); }
    catch { throw new Error("git_identity_required：请先在此仓库配置 user.name 和 user.email，再创建首次提交"); }
    await runGit(path, ["commit", "--allow-empty", "-m", "chore: initialize repository"]);
  } else if (action === "untrack-runtime") {
    if (status.state !== "metadata_tracked") throw new Error("git_action_invalid：当前没有需要取消跟踪的运行记录");
    await ensureRuntimeMetadataIgnored(path);
    // No -f: refuse to overwrite index-only versions. Never delete local files.
    await runGit(path, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ".token-coupon"]).catch(error => {
      if (error instanceof GitCommandError) throw new Error("git_runtime_index_conflict：运行记录的暂存版本与磁盘版本不一致，Git 拒绝取消跟踪。请先检查 git diff --cached -- .token-coupon 并手工处理；系统没有强制覆盖或删除本机文件。");
      throw error;
    });
  } else if (action !== "protect-runtime") throw new Error("git_action_invalid：不支持的 Git 准备操作");
  await ensureRuntimeMetadataIgnored(path);
  return workspaceGitStatus(path);
}
