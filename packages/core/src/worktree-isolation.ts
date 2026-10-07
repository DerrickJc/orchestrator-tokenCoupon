import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GitIsolationAttempt, GitIsolationJournal, SessionRecord } from "./session-types.js";
import type { SessionStore as SessionStoreClass } from "./session-store.js";
import { assertSafeGitPath, parseNulPaths, runGit } from "./git-repository.js";
import { runWorktreeSetup, worktreeSetupHash } from "./worktree-setup.js";
import type { WorktreeSetupProfile } from "./worktree-setup.js";

type GitIsolation = Extract<NonNullable<SessionRecord["snapshot"]["isolation"]>, { mode: "git-worktree" }>;

export interface LandedTaskChange {
  taskCommit: string | null;
  integrationHead: string;
  changedFiles: string[];
  ignoredFiles: string[];
  noChanges: boolean;
}

export interface WorktreeCleanupResult {
  schemaVersion: 1;
  sessionId: string;
  removedWorktrees: string[];
  retainedWorktrees: Array<{ path: string; reason: string }>;
  generatedAt: string;
}

/** Owns branch/worktree identity. It never removes user-visible worktrees automatically. */
export class WorktreeIsolation {
  private readonly isolation: GitIsolation;
  private journal: GitIsolationJournal;

  constructor(private readonly record: SessionRecord, private readonly store: SessionStoreClass) {
    if (record.snapshot.isolation?.mode !== "git-worktree" || !record.isolationJournal) throw new Error("Session 没有完整 Git worktree 隔离记录");
    this.isolation = record.snapshot.isolation;
    this.journal = record.isolationJournal;
  }

  get integrationHead(): string { return this.journal.integrationHead; }
  get verificationTaskId(): string { return this.isolation.verificationTaskId; }

  async initialize(): Promise<void> {
    const worktreePath = this.isolation.integrationWorktree;
    const existing = await findWorktree(this.isolation.repositoryRoot, worktreePath);
    const completed = this.record.snapshot.status === "succeeded" && this.record.snapshot.tasks.every((task) => task.status === "succeeded");
    if (existing) {
      const actualHead = await this.assertWorktree(existing.path, this.isolation.integrationBranch);
      if (actualHead !== this.journal.integrationHead) {
        const landed = this.journal.attempts.find((attempt) => attempt.status === "committed" && attempt.taskCommit === actualHead && attempt.baseCommit === this.journal.integrationHead);
        if (!landed) throw new Error("integration_head_changed：整合 worktree 的提交不符合 journal 中任何待恢复操作");
        this.journal = {
          ...this.journal, integrationHead: actualHead, updatedAt: new Date().toISOString(),
          attempts: this.journal.attempts.map((attempt) => attempt.attemptId === landed.attemptId ? { ...attempt, status: "landed" } : attempt),
        };
        await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
      }
    } else if (completed) {
      const branchHead = (await runGit(this.isolation.repositoryRoot, ["rev-parse", "--verify", `refs/heads/${this.isolation.integrationBranch}^{commit}`])).stdout.trim();
      if (branchHead !== this.journal.integrationHead) throw new Error("integration_head_changed：已完成 Session 的分支 head 与记录不一致");
      try {
        await lstat(worktreePath);
        throw new Error("integration_worktree_unregistered：已完成 Session 的整合路径存在但未登记");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      await ensureSafeDirectoryPath(this.store.workspace, dirname(worktreePath));
      const branchExists = await runGit(this.isolation.repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${this.isolation.integrationBranch}`]).then(() => true).catch((error: unknown) => {
        if (isGitExit(error, 1)) return false;
        throw error;
      });
      await assertEmptyOrMissingDirectory(worktreePath, "worktree_path_occupied");
      if (branchExists) {
        const branchHead = (await runGit(this.isolation.repositoryRoot, ["rev-parse", `refs/heads/${this.isolation.integrationBranch}^{commit}`])).stdout.trim();
        if (branchHead !== this.isolation.baseCommit && branchHead !== this.journal.integrationHead) throw new Error("integration_branch_changed：Session 整合分支已指向未知提交");
        await runGit(this.isolation.repositoryRoot, ["worktree", "add", worktreePath, this.isolation.integrationBranch]);
      } else {
        await runGit(this.isolation.repositoryRoot, ["worktree", "add", "-b", this.isolation.integrationBranch, worktreePath, this.isolation.baseCommit]);
      }
      await this.assertWorktree(worktreePath, this.isolation.integrationBranch, this.journal.integrationHead);
    }
    await this.recoverInterruptedCommits();
    const actualHead = await this.readHead(this.isolation.integrationWorktree, this.isolation.integrationBranch);
    if (actualHead !== this.journal.integrationHead) {
      const landed = this.journal.attempts.find((attempt) => attempt.status === "committed" && attempt.taskCommit === actualHead && attempt.baseCommit === this.journal.integrationHead);
      if (!landed) throw new Error("integration_head_changed：恢复提交后整合 worktree 的 HEAD 仍不符合 journal");
      this.journal = {
        ...this.journal, integrationHead: actualHead, updatedAt: new Date().toISOString(),
        attempts: this.journal.attempts.map((attempt) => attempt.attemptId === landed.attemptId ? { ...attempt, status: "landed" } : attempt),
      };
      await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    }
    this.journal = { ...this.journal, status: "ready", updatedAt: new Date().toISOString() };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    await this.saveIsolationStatus("ready");
  }

  async createAttempt(taskId: string, attemptId: string): Promise<GitIsolationAttempt> {
    if (this.journal.status !== "ready") throw new Error("git_isolation_not_ready：Session 整合 worktree 尚未就绪");
    const existing = this.journal.attempts.find((item) => item.attemptId === attemptId);
    if (existing) {
      if (existing.taskId !== taskId) throw new Error("Attempt ID 已关联到其他任务");
      if (existing.status === "ready") {
        await this.assertWorktree(existing.worktreePath, existing.branch, existing.baseCommit);
        return existing;
      }
      throw new Error(`attempt_worktree_exists：Attempt ${attemptId} 已处于 ${existing.status}，需人工检查现场`);
    }
    const attempt: GitIsolationAttempt = {
      attemptId, taskId, baseCommit: this.journal.integrationHead,
      branch: `token-coupon/attempt/${attemptId}`,
      worktreePath: join(this.store.workspace, ".token-coupon", "worktrees", this.record.snapshot.sessionId, "attempts", attemptId),
      status: "creating", taskCommit: null, changedFiles: [], reasonCode: null,
    };
    this.journal = { ...this.journal, attempts: [...this.journal.attempts, attempt], updatedAt: new Date().toISOString() };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    const occupied = await findWorktree(this.isolation.repositoryRoot, attempt.worktreePath);
    if (occupied) throw new Error(`attempt_worktree_exists：新的 Attempt 路径已由 Git 注册：${attempt.worktreePath}`);
    await ensureSafeDirectoryPath(this.store.workspace, dirname(attempt.worktreePath));
    await assertEmptyOrMissingDirectory(attempt.worktreePath, "attempt_worktree_path_occupied");
    await runGit(this.isolation.repositoryRoot, ["worktree", "add", "-b", attempt.branch, attempt.worktreePath, attempt.baseCommit]);
    await this.assertWorktree(attempt.worktreePath, attempt.branch, attempt.baseCommit);
    const ready = { ...attempt, status: "ready" as const };
    this.journal = { ...this.journal, attempts: this.journal.attempts.map((item) => item.attemptId === attemptId ? ready : item), updatedAt: new Date().toISOString() };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    return ready;
  }

  async markAttempt(attemptId: string, status: GitIsolationAttempt["status"], values: Partial<Pick<GitIsolationAttempt, "taskCommit" | "changedFiles" | "reasonCode">> = {}): Promise<void> {
    const current = this.journal.attempts.find((item) => item.attemptId === attemptId);
    if (!current) throw new Error(`Git Session journal 中没有 Attempt：${attemptId}`);
    const next = { ...current, ...values, status };
    this.journal = { ...this.journal, attempts: this.journal.attempts.map((item) => item.attemptId === attemptId ? next : item), updatedAt: new Date().toISOString() };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
  }

  async runSetup(attemptId: string, profile: WorktreeSetupProfile | undefined, signal?: AbortSignal): Promise<void> {
    if (this.isolation.setupHash === null && !profile) return;
    if (this.isolation.setupHash === null && profile) throw new Error("setup_profile_mismatch：Session 创建时没有 setup 配置");
    if (this.isolation.setupHash !== null && !profile) throw new Error("setup_file_required：此 Session 需要原 setup 配置，请在 resume/retry 时传入同一 --setup-file");
    if (!profile || worktreeSetupHash(profile) !== this.isolation.setupHash) throw new Error("setup_profile_mismatch：setup 配置与 Session 创建时的 SHA-256 不一致");
    const attempt = this.journal.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Git Session journal 中没有 Attempt：${attemptId}`);
    const startedAt = new Date().toISOString();
    let results: Awaited<ReturnType<typeof runWorktreeSetup>> = [];
    let failure: unknown;
    try {
      results = await runWorktreeSetup(profile, attempt.worktreePath, signal);
      const changed = new Set([
        ...parseNulPaths((await runGit(attempt.worktreePath, ["diff", "--name-only", "-z", "--no-renames", "HEAD"])).stdout),
        ...parseNulPaths((await runGit(attempt.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout),
      ]);
      if (changed.size) throw new Error("workspace_setup_changed_source：环境准备修改了 tracked 源码或产生非忽略文件：" + [...changed].join(", "));
    } catch (error) {
      failure = error;
      if (error && typeof error === "object" && "setupResults" in error && Array.isArray((error as { setupResults: unknown }).setupResults)) {
        results = (error as { setupResults: typeof results }).setupResults;
      }
    }
    await this.store.saveSetupRecord(this.record.snapshot.sessionId, attemptId, {
      schemaVersion: 1, attemptId, profileHash: this.isolation.setupHash, startedAt, finishedAt: new Date().toISOString(),
      status: failure ? "failed" : "succeeded", commands: results,
      ...(failure ? { reason: failure instanceof Error ? failure.message : String(failure) } : {}),
    });
    if (failure) throw failure;
  }

  async landSuccessfulAttempt(attemptId: string, taskTitle: string): Promise<LandedTaskChange> {
    const attempt = this.journal.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Git Session journal 中没有 Attempt：${attemptId}`);
    if (attempt.status === "landed" || attempt.status === "no_changes") {
      return { taskCommit: attempt.taskCommit, integrationHead: this.journal.integrationHead, changedFiles: attempt.changedFiles, ignoredFiles: [], noChanges: attempt.status === "no_changes" };
    }
    if (attempt.status === "committed") return this.landCommittedAttempt(attempt);
    await this.assertWorktree(attempt.worktreePath, attempt.branch, attempt.baseCommit);
    const integrationHead = await this.readHead(this.isolation.integrationWorktree, this.isolation.integrationBranch);
    if (integrationHead !== attempt.baseCommit || this.journal.integrationHead !== attempt.baseCommit) throw new Error("landing_base_changed：整合分支已在任务执行期间变化，保留现场并停止调度");
    const integrationStatus = (await runGit(this.isolation.integrationWorktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (integrationStatus.length) throw new Error("integration_worktree_dirty：整合 worktree 有未提交修改，拒绝自动整合");

    const changed = new Set([
      ...parseNulPaths((await runGit(attempt.worktreePath, ["diff", "--name-only", "-z", "--no-renames", "HEAD"])).stdout),
      ...parseNulPaths((await runGit(attempt.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout),
    ]);
    for (const path of changed) assertSafeGitPath(path);
    const paths = [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    let ignoredPaths: string[] = [];
    if (paths.length) {
      const ignoredOutput = await runGit(attempt.worktreePath, ["check-ignore", "--no-index", "-z", "--stdin"], Buffer.from(paths.join("\0") + "\0")).catch((error: unknown) => {
        if (isGitExit(error, 1)) return { stdout: "", stderr: "", stdoutBuffer: Buffer.alloc(0) };
        throw error;
      });
      ignoredPaths = parseNulPaths(ignoredOutput.stdout);
    }
    const ignored = new Set(ignoredPaths);
    // The Runner controls its index, so ls-files would classify its force-staged ignored files as tracked.
    // Compare against the immutable Attempt base tree to distinguish those from baseline tracked files.
    const tracked = new Set(parseNulPaths((await runGit(attempt.worktreePath, ["ls-tree", "-r", "--name-only", "-z", attempt.baseCommit])).stdout));
    const ignoredFiles = paths.filter((path) => ignored.has(path));
    const ignoredTracked = ignoredFiles.filter((path) => tracked.has(path));
    if (ignoredTracked.length) {
      await this.markAttempt(attemptId, "blocked", { changedFiles: paths, reasonCode: "tracked_ignored_changes" });
      throw new Error("tracked_ignored_changes：Runner 修改了当前被忽略规则排除的已跟踪文件，需在 Attempt worktree 中人工处理：" + ignoredTracked.join(", "));
    }
    const deliverable = paths.filter((path) => !ignored.has(path) && path !== ".token-coupon" && !path.startsWith(".token-coupon/"));
    if (deliverable.length === 0) {
      await this.markAttempt(attemptId, "no_changes", { changedFiles: [], reasonCode: null });
      return { taskCommit: null, integrationHead: this.journal.integrationHead, changedFiles: [], ignoredFiles, noChanges: true };
    }

    await this.markAttempt(attemptId, "committing", { changedFiles: deliverable });
    // Runner-created index state is not trusted. Reset only the isolated index, then stage the reviewed path list.
    await runGit(attempt.worktreePath, ["reset", "--mixed", attempt.baseCommit]);
    const pathspecs = Buffer.from(deliverable.map((path) => `:(literal)${path}\0`).join(""));
    await runGit(attempt.worktreePath, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], pathspecs);
    const staged = parseNulPaths((await runGit(attempt.worktreePath, ["diff", "--cached", "--name-only", "-z", "--no-renames"])).stdout);
    if (staged.length === 0 || !samePathSet(staged, deliverable)) throw new Error("staging_boundary_violation：暂存文件与筛选清单不一致");
    const safeTitle = taskTitle.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100);
    await runGit(attempt.worktreePath, ["commit", "-m", `token-coupon: ${attempt.taskId} ${safeTitle}`]);
    const taskCommit = (await runGit(attempt.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const commitParents = (await runGit(attempt.worktreePath, ["rev-list", "--parents", "-n", "1", taskCommit])).stdout.trim().split(/\s+/).slice(1);
    if (commitParents.length !== 1 || commitParents[0] !== attempt.baseCommit) {
      await this.markAttempt(attemptId, "blocked", { taskCommit, reasonCode: "task_git_history_changed" });
      throw new Error("task_git_history_changed：Runner 或 commit hook 改写了 Attempt 提交历史，未整合");
    }
    const committedPaths = parseNulPaths((await runGit(attempt.worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", taskCommit])).stdout);
    if (!samePathSet(committedPaths, deliverable) || committedPaths.some((path) => ignored.has(path) || path === ".token-coupon" || path.startsWith(".token-coupon/"))) {
      await this.markAttempt(attemptId, "blocked", { taskCommit, reasonCode: "commit_boundary_violation", changedFiles: committedPaths });
      throw new Error("commit_boundary_violation：commit hook 或 Runner 使任务提交越过可交付文件清单，未整合");
    }
    const postCommitStatus = (await runGit(attempt.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (postCommitStatus.length) {
      await this.markAttempt(attemptId, "blocked", { taskCommit, reasonCode: "commit_hook_left_worktree_dirty", changedFiles: committedPaths });
      throw new Error("commit_hook_left_worktree_dirty：提交 hook 留下未提交修改，未整合任务提交");
    }
    await this.markAttempt(attemptId, "committed", { taskCommit, changedFiles: committedPaths });
    return this.landCommittedAttempt({ ...attempt, status: "committed", taskCommit, changedFiles: committedPaths }, ignoredFiles);
  }

  async completeVerificationAttempt(attemptId: string): Promise<LandedTaskChange> {
    const attempt = this.journal.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Git Session journal 中没有 Attempt：${attemptId}`);
    await this.assertWorktree(attempt.worktreePath, attempt.branch, attempt.baseCommit);
    if (attempt.baseCommit !== this.journal.integrationHead) throw new Error("verification_base_changed：最终验证所基于的整合版本已变化");
    const changed = new Set([
      ...parseNulPaths((await runGit(attempt.worktreePath, ["diff", "--name-only", "-z", "--no-renames", "HEAD"])).stdout),
      ...parseNulPaths((await runGit(attempt.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout),
    ]);
    for (const path of changed) assertSafeGitPath(path);
    const paths = [...changed].sort();
    if (paths.length) {
      await this.markAttempt(attemptId, "blocked", { changedFiles: paths, reasonCode: "verification_modified_source" });
      throw new Error("verification_modified_source：最终验证任务修改了源码或新增了非忽略文件，验证结果不能绑定到整合版本：" + paths.join(", "));
    }
    await this.markAttempt(attemptId, "no_changes", { changedFiles: [], reasonCode: null });
    return { taskCommit: null, integrationHead: this.journal.integrationHead, changedFiles: [], ignoredFiles: [], noChanges: true };
  }

  async continueManualLanding(attemptId: string): Promise<LandedTaskChange> {
    const attempt = this.journal.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) throw new Error(`Git Session journal 中没有 Attempt：${attemptId}`);
    if (attempt.taskId === this.isolation.verificationTaskId) throw new Error("final_verification_cannot_land：最终验证任务的源码修改不能人工整合");
    const attemptHead = await this.assertWorktree(attempt.worktreePath, attempt.branch);
    const attemptStatus = (await runGit(attempt.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (attemptStatus.length) throw new Error("attempt_worktree_dirty：先在 Attempt worktree 中提交手工处理的任务改动");
    const noTaskCommit = attemptHead === attempt.baseCommit;
    if (!noTaskCommit) {
      const parents = (await runGit(attempt.worktreePath, ["rev-list", "--parents", "-n", "1", attemptHead])).stdout.trim().split(/\s+/).slice(1);
      if (parents.length !== 1 || parents[0] !== attempt.baseCommit) throw new Error("manual_task_commit_invalid：任务分支必须是基于记录基线的单个普通提交");
    }
    const paths = noTaskCommit ? [] : parseNulPaths((await runGit(attempt.worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", attemptHead])).stdout);
    for (const path of paths) assertSafeGitPath(path);
    const ignoredOutput = await runGit(attempt.worktreePath, ["check-ignore", "--no-index", "-z", "--stdin"], Buffer.from(paths.join("\0") + "\0")).catch((error: unknown) => {
      if (isGitExit(error, 1)) return { stdout: "", stderr: "", stdoutBuffer: Buffer.alloc(0) };
      throw error;
    });
    const ignored = new Set(parseNulPaths(ignoredOutput.stdout));
    if (paths.some((path) => ignored.has(path) || path === ".token-coupon" || path.startsWith(".token-coupon/"))) {
      throw new Error("manual_commit_boundary_violation：任务提交包含被忽略或编排元数据文件");
    }
    const integrationHead = await this.readHead(this.isolation.integrationWorktree, this.isolation.integrationBranch);
    const integrationStatus = (await runGit(this.isolation.integrationWorktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (integrationStatus.length) throw new Error("integration_worktree_dirty：人工整合 worktree 仍有未提交改动或冲突");
    await runGit(this.isolation.integrationWorktree, ["merge-base", "--is-ancestor", attempt.baseCommit, integrationHead]);
    if (!noTaskCommit) await runGit(this.isolation.integrationWorktree, ["merge-base", "--is-ancestor", attemptHead, integrationHead]);
    this.journal = {
      ...this.journal, status: "ready", integrationHead, updatedAt: new Date().toISOString(),
      attempts: this.journal.attempts.map((item) => item.attemptId === attemptId
        ? { ...item, status: noTaskCommit ? "no_changes" : "landed", taskCommit: noTaskCommit ? null : attemptHead, changedFiles: paths, reasonCode: null }
        : item),
    };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    await this.saveIsolationStatus("ready");
    return { taskCommit: noTaskCommit ? null : attemptHead, integrationHead, changedFiles: paths, ignoredFiles: [], noChanges: noTaskCommit };
  }

  async assertIntegrationClean(): Promise<void> {
    const head = await this.readHead(this.isolation.integrationWorktree, this.isolation.integrationBranch);
    if (head !== this.journal.integrationHead) throw new Error("integration_head_changed：整合分支 HEAD 与 Session 快照不一致");
    const status = (await runGit(this.isolation.integrationWorktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (status.length) throw new Error("integration_worktree_dirty：最终验证前整合 worktree 必须干净");
  }

  async assertIntegrationReadyForDelivery(): Promise<void> {
    const branchHead = (await runGit(this.isolation.repositoryRoot, ["rev-parse", "--verify", `refs/heads/${this.isolation.integrationBranch}^{commit}`])).stdout.trim();
    if (branchHead !== this.journal.integrationHead) throw new Error("integration_head_changed：Session 分支当前版本与最终验证版本不一致");
    const registered = await findWorktree(this.isolation.repositoryRoot, this.isolation.integrationWorktree);
    if (registered) {
      await this.assertIntegrationClean();
      return;
    }
    try {
      await lstat(this.isolation.integrationWorktree);
      throw new Error("integration_worktree_unregistered：整合路径存在但 Git 未登记，不生成 delivery");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async verificationWorktree(): Promise<string> {
    await this.assertIntegrationClean();
    return this.isolation.integrationWorktree;
  }

  async cleanupSafeWorktrees(): Promise<WorktreeCleanupResult> {
    if (this.record.snapshot.status !== "succeeded" || this.record.snapshot.tasks.some((task) => task.status !== "succeeded")) {
      throw new Error("cleanup_requires_success：只清理已全部成功的 Session");
    }
    const removedWorktrees: string[] = [];
    const retainedWorktrees: WorktreeCleanupResult["retainedWorktrees"] = [];
    for (const attempt of this.journal.attempts) {
      const task = this.record.snapshot.tasks.find((item) => item.taskId === attempt.taskId);
      if (!task || task.status !== "succeeded" || !["landed", "no_changes"].includes(attempt.status)) {
        retainedWorktrees.push({ path: attempt.worktreePath, reason: "失败、未整合或缺少成功 Session 关联" });
        continue;
      }
      const registered = await findWorktree(this.isolation.repositoryRoot, attempt.worktreePath);
      if (!registered) {
        let exists = false;
        try { await lstat(attempt.worktreePath); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (exists) retainedWorktrees.push({ path: attempt.worktreePath, reason: "目录存在但未登记为本 Session worktree" });
        continue;
      }
      try {
        await this.assertWorktree(attempt.worktreePath, attempt.branch, attempt.taskCommit ?? attempt.baseCommit);
        const status = (await runGit(attempt.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
        if (status.length) throw new Error("worktree 有未提交修改");
        await runGit(this.isolation.repositoryRoot, ["worktree", "remove", attempt.worktreePath]);
        removedWorktrees.push(attempt.worktreePath);
      } catch (error) {
        retainedWorktrees.push({ path: attempt.worktreePath, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const integrationRegistered = await findWorktree(this.isolation.repositoryRoot, this.isolation.integrationWorktree);
    if (!integrationRegistered) {
      let exists = false;
      try { await lstat(this.isolation.integrationWorktree); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (exists) retainedWorktrees.push({ path: this.isolation.integrationWorktree, reason: "整合路径存在但未登记为本 Session worktree" });
    } else {
      try { await this.assertIntegrationClean(); }
      catch (error) { retainedWorktrees.push({ path: this.isolation.integrationWorktree, reason: error instanceof Error ? error.message : String(error) }); }
    }
    const report: WorktreeCleanupResult = { schemaVersion: 1, sessionId: this.record.snapshot.sessionId, removedWorktrees, retainedWorktrees, generatedAt: new Date().toISOString() };
    await this.store.saveCleanupRecord(this.record.snapshot.sessionId, report);
    return report;
  }

  async saveBlocked(reasonCode: string): Promise<void> {
    this.journal = { ...this.journal, status: "blocked", updatedAt: new Date().toISOString() };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    await this.saveIsolationStatus("blocked");
    const unresolved = this.journal.attempts.find((attempt) => attempt.status === "committing" || attempt.status === "creating");
    if (unresolved) await this.markAttempt(unresolved.attemptId, "blocked", { reasonCode });
  }

  private async recoverInterruptedCommits(): Promise<void> {
    for (const attempt of this.journal.attempts.filter((item) => item.status === "committing")) {
      if (!await findWorktree(this.isolation.repositoryRoot, attempt.worktreePath)) {
        await this.markAttempt(attempt.attemptId, "blocked", { reasonCode: "attempt_worktree_missing_during_commit" });
        throw new Error(`attempt_worktree_missing_during_commit：提交恢复需要的 worktree 不存在：${attempt.worktreePath}`);
      }
      const head = await this.assertWorktree(attempt.worktreePath, attempt.branch);
      if (head === attempt.baseCommit) {
        // The process stopped before commit. Keep the Runner's files and allow normal landing recovery.
        await this.markAttempt(attempt.attemptId, "ready", { taskCommit: null });
        continue;
      }
      const parents = (await runGit(attempt.worktreePath, ["rev-list", "--parents", "-n", "1", head])).stdout.trim().split(/\s+/).slice(1);
      const status = (await runGit(attempt.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
      const committedPaths = parseNulPaths((await runGit(attempt.worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", head])).stdout);
      for (const path of committedPaths) assertSafeGitPath(path);
      if (parents.length !== 1 || parents[0] !== attempt.baseCommit || status.length || !samePathSet(committedPaths, attempt.changedFiles)) {
        await this.markAttempt(attempt.attemptId, "blocked", { taskCommit: head, changedFiles: committedPaths, reasonCode: "commit_recovery_unverifiable" });
        throw new Error("commit_recovery_unverifiable：中断前的任务提交无法与记录的基线、文件清单和干净 worktree 对应");
      }
      const ignored = await this.ignoredPaths(attempt.worktreePath, committedPaths);
      if (committedPaths.some((path) => ignored.has(path) || path === ".token-coupon" || path.startsWith(".token-coupon/"))) {
        await this.markAttempt(attempt.attemptId, "blocked", { taskCommit: head, changedFiles: committedPaths, reasonCode: "commit_recovery_boundary_violation" });
        throw new Error("commit_recovery_boundary_violation：中断前的提交包含被忽略或编排元数据文件");
      }
      await this.markAttempt(attempt.attemptId, "committed", { taskCommit: head, changedFiles: committedPaths });
    }
  }

  private async landCommittedAttempt(attempt: GitIsolationAttempt, ignoredFiles: string[] = []): Promise<LandedTaskChange> {
    const taskCommit = attempt.taskCommit;
    if (!taskCommit) throw new Error("committed_attempt_missing_oid：已提交 Attempt 缺少 commit OID");
    await this.assertWorktree(attempt.worktreePath, attempt.branch, taskCommit);
    const attemptStatus = (await runGit(attempt.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (attemptStatus.length) throw new Error("committed_attempt_dirty：已提交 Attempt worktree 有未提交修改");
    const committedPaths = parseNulPaths((await runGit(attempt.worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", taskCommit])).stdout);
    if (!samePathSet(committedPaths, attempt.changedFiles)) throw new Error("committed_attempt_paths_changed：提交文件清单与 journal 不匹配");
    const ignored = await this.ignoredPaths(attempt.worktreePath, committedPaths);
    if (committedPaths.some((path) => ignored.has(path) || path === ".token-coupon" || path.startsWith(".token-coupon/"))) {
      throw new Error("commit_boundary_violation：任务提交包含被忽略或编排元数据文件，未整合");
    }
    const integrationHead = await this.readHead(this.isolation.integrationWorktree, this.isolation.integrationBranch);
    const integrationStatus = (await runGit(this.isolation.integrationWorktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    if (integrationStatus.length) throw new Error("integration_worktree_dirty：整合 worktree 有未提交修改，拒绝整合");
    if (integrationHead === attempt.baseCommit && this.journal.integrationHead === attempt.baseCommit) {
      await runGit(this.isolation.integrationWorktree, ["merge", "--ff-only", taskCommit]);
    } else if (!(integrationHead === taskCommit && this.journal.integrationHead === attempt.baseCommit)) {
      throw new Error("landing_base_changed：整合分支已变化；任务提交保留在 Attempt 分支，需人工检查");
    }
    const landedHead = await this.readHead(this.isolation.integrationWorktree, this.isolation.integrationBranch);
    if (landedHead !== taskCommit) throw new Error("landing_head_mismatch：整合结果与任务提交不一致，需人工检查");
    this.journal = {
      ...this.journal, integrationHead: landedHead, updatedAt: new Date().toISOString(),
      attempts: this.journal.attempts.map((item) => item.attemptId === attempt.attemptId
        ? { ...item, status: "landed", taskCommit, changedFiles: committedPaths }
        : item),
    };
    await this.store.saveIsolationJournal(this.record.snapshot.sessionId, this.journal);
    return { taskCommit, integrationHead: landedHead, changedFiles: committedPaths, ignoredFiles, noChanges: false };
  }

  private async ignoredPaths(worktreePath: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const result = await runGit(worktreePath, ["check-ignore", "--no-index", "-z", "--stdin"], Buffer.from(paths.join("\0") + "\0")).catch((error: unknown) => {
      if (isGitExit(error, 1)) return { stdout: "", stderr: "", stdoutBuffer: Buffer.alloc(0) };
      throw error;
    });
    return new Set(parseNulPaths(result.stdout));
  }

  private async saveIsolationStatus(status: GitIsolation["status"]): Promise<void> {
    const latest = await this.store.load(this.record.snapshot.sessionId);
    if (latest.snapshot.isolation?.mode !== "git-worktree") throw new Error("Session 隔离配置读取失败");
    await this.store.save({ ...latest.snapshot, revision: latest.snapshot.revision + 1, isolation: { ...latest.snapshot.isolation, status }, updatedAt: new Date().toISOString() });
  }

  private async readHead(path: string, expectedBranch: string): Promise<string> {
    return this.assertWorktree(path, expectedBranch);
  }

  private async assertWorktree(pathValue: string, branch: string, expectedHead?: string): Promise<string> {
    const path = await realpath(pathValue);
    const top = await realpath((await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim());
    if (top !== path) throw new Error(`worktree_identity_mismatch：${pathValue} 实际根目录为 ${top}`);
    const common = (await runGit(path, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const commonPath = await realpath(resolve(path, common));
    if (commonPath !== this.isolation.gitCommonDir) throw new Error("worktree_git_common_dir_mismatch：worktree 不属于记录的仓库");
    const actualBranch = (await runGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (actualBranch !== branch) throw new Error(`worktree_branch_mismatch：期望 ${branch}，实际 ${actualBranch || "detached HEAD"}`);
    const head = (await runGit(path, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (expectedHead && head !== expectedHead) throw new Error(`worktree_head_mismatch：期望 ${expectedHead}，实际 ${head}`);
    return head;
  }
}

async function ensureSafeDirectoryPath(workspace: string, target: string): Promise<void> {
  const root = resolve(workspace);
  const absolute = resolve(target);
  const relative = absolute.slice(root.length + 1);
  if (!absolute.startsWith(root + "/") || relative.split("/").some((part) => part === ".." || part === "")) throw new Error("worktree_path_outside_workspace：隔离路径越出 workspace");
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`worktree_path_symlink：隔离路径包含符号链接：${cursor}`);
      if (!info.isDirectory()) throw new Error(`worktree_path_not_directory：隔离路径组件不是目录：${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor);
    }
  }
}

async function assertEmptyOrMissingDirectory(path: string, reason: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (await readdir(path)).length > 0) throw new Error(`${reason}：${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function findWorktree(repositoryRoot: string, pathValue: string): Promise<{ path: string } | undefined> {
  const listing = (await runGit(repositoryRoot, ["worktree", "list", "--porcelain", "-z"])).stdout;
  const expected = resolve(pathValue);
  for (const field of listing.split("\0")) {
    if (field.startsWith("worktree ") && resolve(field.slice("worktree ".length)) === expected) return { path: expected };
  }
  return undefined;
}

function isGitExit(error: unknown, code: number): boolean {
  return Boolean(error && typeof error === "object" && "exitCode" in error && (error as { exitCode: unknown }).exitCode === code);
}

function samePathSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return expectedSet.size === expected.length && actual.every((path) => expectedSet.has(path));
}
