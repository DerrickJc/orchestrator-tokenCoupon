import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import type { PlanDefinition, PlannedTask } from "./plan.js";
import { PlanStore, sessionStatusFor } from "./plan-store.js";
import { executeTask } from "./execute-task.js";
import type { Runner, RunnerOutput } from "./runner.js";
import type { SessionRecord, SessionSnapshot, SessionTaskState, TaskResult } from "./session-types.js";
import { SessionLockError, SessionStore } from "./session-store.js";
import type { TaskDefinition } from "./task.js";
import { acquireGitRepositoryLock, inspectGitRepository } from "./git-repository.js";
import { WorktreeIsolation } from "./worktree-isolation.js";
import type { WorktreeCleanupResult } from "./worktree-isolation.js";
import type { GitRepositoryContext } from "./git-repository.js";
import { parseWorktreeSetupProfile, worktreeSetupHash } from "./worktree-setup.js";
import type { WorktreeSetupProfile } from "./worktree-setup.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_LIMIT = 8 * 1024;
const PROMPT_CONTEXT_LIMIT = 24 * 1024;
const COLLECT_LIMIT = 64 * 1024;
const ALLOWED_MOCK_SCENARIOS = new Set(["success", "missing-marker", "marker-nonzero", "old-marker", "stderr-marker", "quoted-marker", "large-output", "hang", "marker-then-hang", "spawn-child"]);

export interface TaskRunnerFactoryOptions {
  acceptEdits?: boolean;
  mockScenario?: string;
}

export type TaskRunnerFactory = (task: TaskDefinition, options: TaskRunnerFactoryOptions) => Runner;

export interface PlanRunOptions {
  plan: PlanDefinition;
  workspace: string;
  createRunner: TaskRunnerFactory;
  signal?: AbortSignal;
  acceptEdits?: boolean;
  mockTaskScenarios?: Map<string, string>;
  sessionId?: string;
  isolation?: "shared" | "git-worktree";
  verificationTaskId?: string;
  setupProfile?: WorktreeSetupProfile;
  beforeCreateSession?: () => Promise<void>;
  onOutput?: (taskId: string, output: RunnerOutput) => void;
  onIdleState?: (taskId: string, state: { idle: boolean; idleSince: string | null; lastActivityAt: string }) => void;
}

export interface SessionOperationOptions {
  sessionId: string;
  workspace: string;
  createRunner: TaskRunnerFactory;
  signal?: AbortSignal;
  acceptEdits?: boolean;
  mockTaskScenarios?: Map<string, string>;
  setupProfile?: WorktreeSetupProfile;
  onOutput?: (taskId: string, output: RunnerOutput) => void;
  onIdleState?: (taskId: string, state: { idle: boolean; idleSince: string | null; lastActivityAt: string }) => void;
}

type ExecutionOptions = Pick<SessionOperationOptions, "workspace" | "createRunner" | "signal" | "acceptEdits" | "mockTaskScenarios" | "setupProfile" | "onOutput" | "onIdleState">;

export interface RetryOptions extends SessionOperationOptions { taskId: string; }
export interface ContinueLandingOptions extends SessionOperationOptions { taskId: string; }
export interface SessionCleanupOptions { sessionId: string; workspace: string; }

export interface SessionOperationResult {
  snapshot: SessionSnapshot;
  operationStatus?: "succeeded" | "failed" | "cancelled" | "timed_out";
}

export function validateMockTaskScenarios(plan: PlanDefinition, scenarios: Map<string, string>): void {
  const tasks = new Map(plan.tasks.map((entry) => [entry.task.id, entry.task]));
  for (const [taskId, scenario] of scenarios) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Mock 场景映射引用了未知任务：${taskId}`);
    if (task.execution.runnerId !== "mock") throw new Error(`Mock 场景只能指定给 Mock 任务：${taskId}`);
    if (!ALLOWED_MOCK_SCENARIOS.has(scenario)) throw new Error(`未知 Mock 场景：${scenario}`);
  }
}

export function validateVerificationTask(plan: PlanDefinition, taskId: string): void {
  const entries = new Map(plan.tasks.map((entry) => [entry.task.id, entry]));
  const target = entries.get(taskId);
  if (!target) throw new Error(`最终验证任务不存在：${taskId}`);
  if (plan.tasks.some((entry) => entry.dependsOn.includes(taskId))) throw new Error(`最终验证任务 ${taskId} 不能是其他任务的前置依赖`);
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    for (const dependency of entry.dependsOn) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      visit(dependency);
    }
  };
  visit(taskId);
  const missing = plan.tasks.map(({ task }) => task.id).filter((id) => id !== taskId && !ancestors.has(id));
  if (missing.length) throw new Error(`最终验证任务 ${taskId} 必须依赖所有其他任务；缺少：${missing.join(", ")}`);
}

export async function runPlan(options: PlanRunOptions): Promise<SessionOperationResult> {
  if (options.plan.tasks.length === 0) throw new Error("空计划不能执行");
  validateMockTaskScenarios(options.plan, options.mockTaskScenarios ?? new Map());
  await checkRunners(options.plan.tasks, options);
  const store = new SessionStore(options.workspace);
  const sessionId = options.sessionId ?? randomUUID();
  const mode = options.isolation ?? "shared";
  const setupProfile = options.setupProfile ? parseWorktreeSetupProfile(options.setupProfile) : undefined;
  if (mode === "git-worktree" && !options.verificationTaskId) throw new Error("--isolation git-worktree 需要指定 --verification-task");
  if (mode === "shared" && options.verificationTaskId) throw new Error("--verification-task 只适用于 --isolation git-worktree");
  if (mode === "shared" && setupProfile) throw new Error("setupProfile 只适用于 --isolation git-worktree");
  if (mode === "git-worktree") validateVerificationTask(options.plan, options.verificationTaskId!);
  const executionOptions = setupProfile ? { ...options, setupProfile } : options;
  let releaseGit: (() => Promise<void>) | undefined;
  let releaseWorkspace: (() => Promise<void>) | undefined;
  try {
    let gitContext: GitRepositoryContext | undefined;
    if (mode === "git-worktree") {
      gitContext = await inspectGitRepository(store.workspace);
      releaseGit = await acquireGitRepositoryLock(gitContext.gitCommonDir, sessionId);
      const lockedContext = await inspectGitRepository(store.workspace);
      if (lockedContext.gitCommonDir !== gitContext.gitCommonDir) throw new Error("Git 仓库身份在加锁期间发生变化");
      gitContext = lockedContext;
    }
    releaseWorkspace = await store.acquireLock();
    await options.beforeCreateSession?.();
    const isolation = gitContext ? {
      mode: "git-worktree" as const, status: "initializing" as const,
      repositoryRoot: gitContext.repositoryRoot, gitCommonDir: gitContext.gitCommonDir,
      baseCommit: gitContext.baseCommit, sourceBranch: gitContext.sourceBranch,
      integrationBranch: `token-coupon/session/${sessionId}`,
      integrationWorktree: join(store.workspace, ".token-coupon", "worktrees", sessionId, "integration"),
      verificationTaskId: options.verificationTaskId!,
      setupHash: setupProfile ? worktreeSetupHash(setupProfile) : null,
    } : { mode: "shared" as const };
    let record = await store.create(options.plan, sessionId, isolation);
    let worktrees: WorktreeIsolation | undefined;
    if (record.snapshot.isolation?.mode === "git-worktree") {
      worktrees = new WorktreeIsolation(record, store);
      try { await worktrees.initialize(); }
      catch (error) { await worktrees.saveBlocked("integration_worktree_init_failed").catch(() => undefined); throw error; }
      record = await store.load(sessionId);
    }
    return await schedule(record, store, executionOptions, undefined, worktrees);
  } finally {
    try { await releaseWorkspace?.(); }
    finally { await releaseGit?.(); }
  }
}

export async function resumeSession(options: SessionOperationOptions): Promise<SessionOperationResult> {
  const store = new SessionStore(options.workspace);
  const opened = await acquireExistingSessionLocks(store, options.sessionId);
  let worktrees: WorktreeIsolation | undefined;
  try {
    let record = await store.load(options.sessionId);
    if (options.setupProfile && record.snapshot.isolation?.mode !== "git-worktree") throw new Error("setup-file-not-applicable：仅 Git worktree Session 支持 setup 配置");
    worktrees = await prepareWorktrees(record, store, options.setupProfile);
    if (worktrees) record = await store.load(options.sessionId);
    validateMockTaskScenarios(record.plan, options.mockTaskScenarios ?? new Map());
    const current = await reconcile(record, store, worktrees);
    const unresolved = current.snapshot.tasks.filter((state) => ["failed", "timed_out", "cancelled", "interrupted", "blocked"].includes(state.status));
    if (unresolved.length > 0) throw new Error(`Session 尚有未解决的任务，先用 session retry 指定目标：${unresolved.map((state) => `${state.taskId}(${state.status})`).join(", ")}`);
    await checkRunners(pendingTasks(current), options);
    return await schedule(current, store, options, undefined, worktrees);
  } finally {
    try { await opened.releaseWorkspace(); }
    finally { await opened.releaseGit?.(); }
  }
}

export async function retrySession(options: RetryOptions): Promise<SessionOperationResult> {
  const store = new SessionStore(options.workspace);
  const opened = await acquireExistingSessionLocks(store, options.sessionId);
  let worktrees: WorktreeIsolation | undefined;
  try {
    let record = await store.load(options.sessionId);
    if (options.setupProfile && record.snapshot.isolation?.mode !== "git-worktree") throw new Error("setup-file-not-applicable：仅 Git worktree Session 支持 setup 配置");
    worktrees = await prepareWorktrees(record, store, options.setupProfile);
    if (worktrees) record = await store.load(options.sessionId);
    validateMockTaskScenarios(record.plan, options.mockTaskScenarios ?? new Map());
    const current = await reconcile(record, store, worktrees);
    const entry = current.plan.tasks.find(({ task }) => task.id === options.taskId);
    const state = current.snapshot.tasks.find(({ taskId }) => taskId === options.taskId);
    if (!entry || !state) throw new Error(`Session 中不存在任务：${options.taskId}`);
    if (!["failed", "timed_out", "cancelled", "interrupted"].includes(state.status)) throw new Error(`任务 ${options.taskId} 当前状态 ${state.status} 不允许重试`);
    const stateById = new Map(current.snapshot.tasks.map((item) => [item.taskId, item]));
    if (!entry.dependsOn.every((id) => stateById.get(id)?.status === "succeeded")) throw new Error(`任务 ${options.taskId} 的前置依赖尚未成功`);
    await checkRunners([entry], options);
    const taskStore = new PlanStore(current.plan, current.snapshot);
    return await schedule(current, store, options, { taskId: options.taskId, allowRetry: true, taskStore }, worktrees);
  } finally {
    try { await opened.releaseWorkspace(); }
    finally { await opened.releaseGit?.(); }
  }
}

export async function continueSessionLanding(options: ContinueLandingOptions): Promise<SessionOperationResult> {
  const store = new SessionStore(options.workspace);
  const opened = await acquireExistingSessionLocks(store, options.sessionId);
  try {
    const record = await store.load(options.sessionId);
    if (record.snapshot.isolation?.mode !== "git-worktree" || !record.isolationJournal) throw new Error("session land --continue 只适用于 git-worktree Session");
    const entry = record.plan.tasks.find(({ task }) => task.id === options.taskId);
    const state = record.snapshot.tasks.find((item) => item.taskId === options.taskId);
    if (!entry || !state) throw new Error(`Session 中不存在任务：${options.taskId}`);
    if (!["failed", "interrupted"].includes(state.status)) throw new Error(`任务 ${options.taskId} 当前状态 ${state.status} 不允许人工整合续接`);
    const attemptId = state.attempts.at(-1)?.attemptId;
    if (!attemptId) throw new Error("任务没有可续接的 Attempt");
    const rawAttempt = await store.readAttempt(attemptId) as Record<string, unknown>;
    if (rawAttempt.attemptId !== attemptId || rawAttempt.taskId !== options.taskId || rawAttempt.status !== "succeeded") {
      throw new Error("Runner Attempt 本身未成功；人工整合不能把失败、取消或未完成运行标记为成功");
    }
    const stateById = new Map(record.snapshot.tasks.map((item) => [item.taskId, item]));
    if (!entry.dependsOn.every((id) => stateById.get(id)?.status === "succeeded")) throw new Error("任务前置依赖尚未成功");
    const worktrees = new WorktreeIsolation(record, store);
    await worktrees.continueManualLanding(attemptId);
    let handoff: TaskResult;
    try {
      const saved = await store.readHandoff(attemptId) as TaskResult;
      if (saved.taskId !== options.taskId || saved.attemptId !== attemptId || saved.status !== "succeeded" ||
          saved.artifactDir !== attemptDirectory(store.workspace, attemptId)) throw new Error("handoff identity mismatch");
      handoff = saved;
    } catch {
      handoff = { taskId: options.taskId, attemptId, status: "succeeded", summary: "人工完成 Git 整合续接；原 Runner 已成功。", summarySource: "none", truncated: false, artifactDir: attemptDirectory(store.workspace, attemptId) };
      await store.saveHandoff(attemptId, handoff);
    }
    const latest = await store.load(options.sessionId);
    const states = latest.snapshot.tasks.map((item) => item.taskId !== options.taskId ? item : {
      ...item, status: "succeeded" as const, activeAttemptId: null, reasonCode: null, result: handoff,
      attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "recorded" as const } : ref),
    });
    const updatedStates = new PlanStore(latest.plan, latest.snapshot).recalculateDependencies(states);
    const snapshot: SessionSnapshot = {
      ...latest.snapshot, revision: latest.snapshot.revision + 1, status: sessionStatusFor(updatedStates),
      tasks: updatedStates, updatedAt: new Date().toISOString(),
    };
    await store.save(snapshot);
    return { snapshot, operationStatus: "succeeded" };
  } finally {
    try { await opened.releaseWorkspace(); }
    finally { await opened.releaseGit?.(); }
  }
}

export async function cleanupSessionWorktrees(options: SessionCleanupOptions): Promise<WorktreeCleanupResult> {
  const store = new SessionStore(options.workspace);
  const opened = await acquireExistingSessionLocks(store, options.sessionId);
  try {
    const record = await store.load(options.sessionId);
    if (record.snapshot.isolation?.mode !== "git-worktree") throw new Error("session cleanup 只适用于 git-worktree Session");
    return await new WorktreeIsolation(record, store).cleanupSafeWorktrees();
  } finally {
    try { await opened.releaseWorkspace(); }
    finally { await opened.releaseGit?.(); }
  }
}

export function formatSession(snapshot: SessionSnapshot, plan: PlanDefinition): string {
  const lines = [
    `Session：${snapshot.sessionId}`,
    `计划：${snapshot.planId} — ${snapshot.planTitle}`,
    `状态：${snapshot.status}；revision：${snapshot.revision}`,
    `工作目录：${snapshot.workspace}`,
    ...(snapshot.isolation?.mode === "git-worktree" ? [
      `隔离：git-worktree（${snapshot.isolation.status}）`,
      `仓库基线：${snapshot.isolation.baseCommit}`,
      `Session 分支：${snapshot.isolation.integrationBranch}`,
      `整合 worktree：${snapshot.isolation.integrationWorktree}`,
      `最终验证任务：${snapshot.isolation.verificationTaskId}`,
      `Setup 配置：${snapshot.isolation.setupHash ?? "未配置"}`,
    ] : snapshot.isolation?.mode === "shared" ? ["隔离：shared"] : []),
    "任务：",
  ];
  for (const [index, entry] of plan.tasks.entries()) {
    const state = snapshot.tasks[index]!;
    lines.push(`  ${entry.task.id} — ${entry.task.title}：${state.status}`);
    lines.push(`    依赖：${entry.dependsOn.length ? entry.dependsOn.join(", ") : "无"}`);
    for (const attempt of state.attempts) {
      lines.push(`    Attempt ${attempt.attemptId}：${attempt.outcome}；${attempt.artifactDir}`);
      if (snapshot.isolation?.mode === "git-worktree") {
        lines.push(`      Git 分支：token-coupon/attempt/${attempt.attemptId}`);
        lines.push(`      Attempt worktree：${join(snapshot.workspace, ".token-coupon", "worktrees", snapshot.sessionId, "attempts", attempt.attemptId)}`);
      }
      if (attempt.idleSince) lines.push("      暂无输出，仍在运行（自 " + attempt.idleSince + "）；最近活动 " + (attempt.lastActivityAt ?? "未知"));
    }
    if (state.reasonCode) lines.push(`    原因：${state.reasonCode}`);
    if (state.result) lines.push(`    结果：${state.result.summary || "无文本摘要"}${state.result.truncated ? "（已截断）" : ""}`);
  }
  return lines.join("\n");
}

async function schedule(record: SessionRecord, store: SessionStore, options: ExecutionOptions, retry?: { taskId: string; allowRetry: true; taskStore: PlanStore }, worktrees?: WorktreeIsolation): Promise<SessionOperationResult> {
  let snapshot = record.snapshot;
  let states = snapshot.tasks;
  const planStore = retry?.taskStore ?? new PlanStore(record.plan, snapshot);
  const save = async (nextStates: SessionTaskState[], status: SessionSnapshot["status"]) => {
    const current = worktrees ? (await store.load(snapshot.sessionId)).snapshot : snapshot;
    const next: SessionSnapshot = { ...current, revision: current.revision + 1, status, tasks: nextStates, updatedAt: new Date().toISOString() };
    await store.save(next);
    snapshot = next;
    states = nextStates;
  };
  const persistActivity = async (taskId: string, attemptId: string, activity: { idle: boolean; idleSince: string | null; lastActivityAt: string }) => {
    const nextStates = states.map((state) => state.taskId !== taskId ? state : {
      ...state,
      attempts: state.attempts.map((attempt) => {
        if (attempt.attemptId !== attemptId) return attempt;
        const nextAttempt = { ...attempt, lastActivityAt: activity.lastActivityAt };
        if (activity.idle && activity.idleSince) nextAttempt.idleSince = activity.idleSince;
        else delete nextAttempt.idleSince;
        return nextAttempt;
      }),
    });
    await save(nextStates, "running");
  };

  if (retry) {
    const attemptId = randomUUID();
    const entry = record.plan.tasks.find(({ task }) => task.id === retry.taskId)!;
    const reserved = planStore.beginAttempt(retry.taskId, attemptId, attemptDirectory(store.workspace, attemptId), retry.allowRetry);
    await save(reserved, "running");
    await runOne(entry, attemptId, states, record.plan, store, options, async (status, reasonCode, result, recorded) => {
      let finished = planStore.finishAttempt(retry.taskId, attemptId, status, reasonCode, result, states);
      if (!recorded) finished = finished.map((item) => item.taskId === retry.taskId ? { ...item, attempts: item.attempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, outcome: "record_missing" as const } : attempt) } : item);
      const sessionStatus = status === "cancelled" ? "cancelled" : sessionStatusFor(finished);
      await save(finished, sessionStatus);
    }, (activity) => persistActivity(retry.taskId, attemptId, activity), worktrees);
    const retryState = states.find((item) => item.taskId === retry.taskId);
    return { snapshot, operationStatus: retryState?.status === "succeeded" ? "succeeded" : retryState?.status === "timed_out" ? "timed_out" : retryState?.status === "cancelled" ? "cancelled" : "failed" };
  }

  if (states.length > 0 && states.every((state) => state.status === "succeeded")) {
    if (snapshot.status !== "succeeded") await save(states, "succeeded");
    return { snapshot };
  }

  while (!options.signal?.aborted) {
    const freshStore = new PlanStore(record.plan, snapshot);
    const entry = freshStore.nextRunnable(states);
    if (!entry) break;
    const attemptId = randomUUID();
    const reserved = freshStore.beginAttempt(entry.task.id, attemptId, attemptDirectory(store.workspace, attemptId));
    await save(reserved, "running");
    await runOne(entry, attemptId, states, record.plan, store, options, async (status, reasonCode, result, recorded) => {
      const after = new PlanStore(record.plan, snapshot);
      let finished = after.finishAttempt(entry.task.id, attemptId, status, reasonCode, result, states);
      if (!recorded) finished = finished.map((item) => item.taskId === entry.task.id ? { ...item, attempts: item.attempts.map((attempt) => attempt.attemptId === attemptId ? { ...attempt, outcome: "record_missing" as const } : attempt) } : item);
      await save(finished, status === "cancelled" ? "cancelled" : sessionStatusFor(finished));
    }, (activity) => persistActivity(entry.task.id, attemptId, activity), worktrees);
    const state = states.find((item) => item.taskId === entry.task.id);
    if (state?.status !== "succeeded") break;
  }

  if (states.length > 0 && states.every((state) => state.status === "succeeded")) {
    await save(states, "succeeded");
  } else if (options.signal?.aborted && !states.some((state) => ["failed", "timed_out", "interrupted"].includes(state.status))) {
    await save(states, "cancelled");
  } else if (states.some((state) => ["failed", "timed_out", "blocked"].includes(state.status))) {
    if (snapshot.status !== "failed") await save(states, "failed");
  } else if (states.some((state) => state.status === "cancelled")) {
    if (snapshot.status !== "cancelled") await save(states, "cancelled");
  } else if (snapshot.status !== "ready") {
    await save(states, "ready");
  }
  return { snapshot };
}

async function runOne(entry: PlannedTask, attemptId: string, states: SessionTaskState[], plan: PlanDefinition, store: SessionStore, options: ExecutionOptions,
  finish: (status: "succeeded" | "failed" | "cancelled" | "timed_out", reasonCode: string | null, result: TaskResult | null, recorded: boolean) => Promise<void>,
  persistActivity: (state: { idle: boolean; idleSince: string | null; lastActivityAt: string }) => Promise<void>,
  worktrees?: WorktreeIsolation,
): Promise<void> {
  const isVerification = worktrees?.verificationTaskId === entry.task.id;
  let runnerCwd = store.workspace;
  if (worktrees) {
    try {
      const attempt = await worktrees.createAttempt(entry.task.id, attemptId);
      runnerCwd = attempt.worktreePath;
      await worktrees.runSetup(attemptId, options.setupProfile, options.signal);
    } catch (error) {
      const reasonCode = gitFailureCode(error, "git_worktree_create_failed");
      await worktrees.markAttempt(attemptId, "failed", { reasonCode }).catch(() => undefined);
      await finish(options.signal?.aborted ? "cancelled" : "failed", reasonCode, null, false);
      return;
    }
  }
  let effectiveTask = withDependencyContext(entry, states);
  if (worktrees) effectiveTask = withGitExecutionInstructions(effectiveTask, runnerCwd, worktrees.integrationHead, isVerification);
  const scenario = options.mockTaskScenarios?.get(entry.task.id);
  const allowEdits = options.acceptEdits && entry.task.execution.runnerId === "claude-code";
  const runner = options.createRunner(entry.task, { ...(allowEdits ? { acceptEdits: true } : {}), ...(scenario ? { mockScenario: scenario } : {}) });
  const decisionConstraints = resolveTaskDecisions(plan, entry);
  const collector = new OutputCollector();
  let result: Awaited<ReturnType<typeof executeTask>>;
  try {
    result = await executeTask({
      task: effectiveTask,
      cwd: runnerCwd,
      artifactWorkspace: store.workspace,
      runner,
      attemptId,
      ...(decisionConstraints.length ? { decisionConstraints } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onOutput: (output) => { collector.push(output); options.onOutput?.(entry.task.id, output); },
      onIdleState: (state) => {
        options.onIdleState?.(entry.task.id, state);
        return persistActivity(state);
      },
    });
  } catch (error) {
    if (worktrees) await worktrees.markAttempt(attemptId, "failed", { reasonCode: "attempt_or_handoff_record_failed" }).catch(() => undefined);
    await finish("failed", "attempt_or_handoff_record_failed", null, false);
    if (error instanceof SessionLockError) throw error;
    return;
  }
  const status = result.attempt.status;
  if (status === "succeeded") {
    if (worktrees) {
      try {
        if (isVerification) await worktrees.completeVerificationAttempt(attemptId);
        else await worktrees.landSuccessfulAttempt(attemptId, entry.task.title);
      } catch (error) {
        const reasonCode = gitFailureCode(error, "git_landing_failed");
        await worktrees.saveBlocked(reasonCode).catch(() => undefined);
        await finish("failed", reasonCode, null, true);
        return;
      }
    }
    const handoff = collector.toResult(entry.task.id, attemptId, result.artifactDir);
    try {
      await store.saveHandoff(attemptId, handoff);
    } catch {
      await finish("failed", "handoff_record_failed", null, true);
      return;
    }
    await finish("succeeded", null, handoff, true);
  } else {
    const mapped = status === "timed_out" ? "timed_out" : status === "cancelled" ? "cancelled" : "failed";
    if (worktrees) await worktrees.markAttempt(attemptId, "failed", { reasonCode: result.attempt.reasonCode ?? "runner_failed" }).catch(() => undefined);
    await finish(mapped, result.attempt.reasonCode, null, true);
  }
}

function withGitExecutionInstructions(task: TaskDefinition, cwd: string, baseCommit: string, verification: boolean): TaskDefinition {
  const role = verification
    ? "你负责最终验证当前 Session 的整合版本。只运行计划中的测试/检查，不修改、暂存、提交或切换任何源码分支；验证目录有独立 Attempt 分支。"
    : "你负责当前计划任务。只在本 Attempt worktree 中修改当前任务所需文件；不要切换分支、创建提交、合并或改写 Git 历史。编排器会在完成判定成功后筛选、提交并整合结果。";
  return { ...task, prompt: `${task.prompt}\n\nGit worktree 执行约定：\n- 当前工作目录：${cwd}\n- 本任务基线：${baseCommit}\n- ${role}\n- 不要访问或修改 workspace 主目录中的其他文件及 .token-coupon 编排记录。` };
}

function gitFailureCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.match(/^([a-z][a-z0-9_]{2,80})：/u)?.[1];
  return prefix ?? fallback;
}

function resolveTaskDecisions(plan: PlanDefinition, entry: PlannedTask): NonNullable<PlanDefinition["decisionContext"]>["decisions"] {
  if (plan.schemaVersion === 1) return [];
  const context = plan.decisionContext;
  if (!context || !entry.decisionRefs) throw new Error("decision_context_missing：Plan v2 的 Session 缺少决策上下文或任务引用");
  return entry.decisionRefs.map((reference) => {
    const decision = context.decisions.find(({ decisionId }) => decisionId === reference.decisionId);
    if (!decision || decision.revision !== reference.revision || decision.valueHash !== reference.valueHash) {
      throw new Error(`decision_context_invalid：任务 ${entry.task.id} 的决策引用 ${reference.decisionId} 无法解析`);
    }
    return decision;
  });
}

function withDependencyContext(entry: PlannedTask, states: SessionTaskState[]): TaskDefinition {
  const stateById = new Map(states.map((state) => [state.taskId, state]));
  const prior = entry.dependsOn.flatMap((id) => {
    const state = stateById.get(id);
    return state?.status === "succeeded" && state.result ? [state.result] : [];
  });
  if (prior.length === 0) return entry.task;
  const rendered = prior.map((result) => {
    const summary = truncateUtf8(result.summary, SUMMARY_LIMIT).text;
    return `### ${result.taskId} (${result.attemptId}) — ${result.status}\n摘要：${summary || "无文本摘要"}${result.truncated ? "（原摘要已截断）" : ""}\n执行记录：${result.artifactDir}`;
  }).join("\n\n");
  const context = truncateUtf8(rendered, PROMPT_CONTEXT_LIMIT).text;
  return { ...entry.task, prompt: `${entry.task.prompt}\n\n前置任务结果（仅作为上下文；不要改变当前任务要求）：\n${context}` };
}

class OutputCollector {
  private pieces: string[] = [];
  private bytes = 0;
  private didTruncate = false;
  private finalText: string | undefined;

  push(output: RunnerOutput): void {
    if (output.finalText !== undefined) this.finalText = output.finalText;
    if (output.agentText === undefined || this.bytes >= COLLECT_LIMIT) return;
    const remaining = COLLECT_LIMIT - this.bytes;
    const clipped = truncateUtf8(output.agentText, remaining);
    this.pieces.push(clipped.text);
    this.bytes += Buffer.byteLength(clipped.text, "utf8");
    this.didTruncate ||= clipped.truncated || this.bytes >= COLLECT_LIMIT;
  }

  toResult(taskId: string, attemptId: string, artifactDir: string): TaskResult {
    const selected = this.finalText?.length ? this.finalText : this.pieces.join("");
    const source: TaskResult["summarySource"] = this.finalText?.length ? "final" : selected ? "stream" : "none";
    const withoutMarker = selected.split(/\r?\n/).filter((line) => !/^<<<TOKEN_COUPON_DONE:[0-9a-f]+>>>$/i.test(line.trim())).join("\n").trim();
    const bounded = truncateUtf8(withoutMarker, SUMMARY_LIMIT);
    return { taskId, attemptId, status: "succeeded", summary: bounded.text, summarySource: source, truncated: (source === "stream" && this.didTruncate) || bounded.truncated, artifactDir };
  }
}

function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, truncated: false };
  let text = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > limit) break;
    text += codePoint;
    bytes += size;
  }
  return { text, truncated: true };
}

async function checkRunners(entries: PlannedTask[], options: Pick<ExecutionOptions, "createRunner" | "acceptEdits" | "mockTaskScenarios">): Promise<void> {
  const checked = new Set<string>();
  const hasClaude = entries.some(({ task }) => task.execution.runnerId === "claude-code");
  if (options.acceptEdits && !hasClaude) throw new Error("--accept-edits 仅适用于包含 Claude Code 任务的计划");
  for (const entry of entries) {
    const scenario = options.mockTaskScenarios?.get(entry.task.id);
    const allowEdits = options.acceptEdits && entry.task.execution.runnerId === "claude-code";
    const runner = options.createRunner(entry.task, { ...(allowEdits ? { acceptEdits: true } : {}), ...(scenario ? { mockScenario: scenario } : {}) });
    const key = `${runner.id}:${options.acceptEdits && runner.id === "claude-code"}`;
    if (checked.has(key)) continue;
    if (entry.task.execution.modelId && !runner.supportsModel) throw new Error(`${runner.id} 不支持 modelId`);
    await runner.checkAvailable();
    checked.add(key);
  }
}

async function reconcile(record: SessionRecord, store: SessionStore, worktrees?: WorktreeIsolation): Promise<SessionRecord> {
  const running = record.snapshot.tasks.filter((state) => state.status === "running");
  if (running.length === 0) return record;
  let currentRecord = record;
  let states = record.snapshot.tasks;
  for (const state of running) {
    const attemptId = state.activeAttemptId;
    if (!attemptId) continue;
    let attempt: unknown;
    try { attempt = await store.readAttempt(attemptId); } catch { attempt = undefined; }
    const raw = attempt && typeof attempt === "object" ? attempt as Record<string, unknown> : undefined;
    if (raw?.attemptId === attemptId && raw.taskId === state.taskId && ["failed", "cancelled", "timed_out"].includes(String(raw.status))) {
      const nextStatus = raw.status as "failed" | "cancelled" | "timed_out";
      states = states.map((item) => item.taskId === state.taskId ? {
        ...item, status: nextStatus, activeAttemptId: null, reasonCode: typeof raw.reasonCode === "string" ? raw.reasonCode : "recovered_attempt",
        attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "recorded" as const } : ref),
      } : item);
      continue;
    }
    if (raw?.attemptId === attemptId && raw.taskId === state.taskId && raw.status === "succeeded") {
      let gitAttempt = currentRecord.snapshot.isolation?.mode === "git-worktree"
        ? currentRecord.isolationJournal?.attempts.find((item) => item.attemptId === attemptId)
        : undefined;
      if (gitAttempt && worktrees && ["ready", "committed"].includes(gitAttempt.status)) {
        try {
          const task = currentRecord.plan.tasks.find(({ task }) => task.id === state.taskId)?.task;
          if (!task) throw new Error("恢复时找不到对应任务");
          if (state.taskId === worktrees.verificationTaskId) await worktrees.completeVerificationAttempt(attemptId);
          else await worktrees.landSuccessfulAttempt(attemptId, task.title);
          currentRecord = await store.load(currentRecord.snapshot.sessionId);
          gitAttempt = currentRecord.isolationJournal?.attempts.find((item) => item.attemptId === attemptId);
        } catch { /* Git evidence is incomplete; keep the task interrupted for explicit recovery. */ }
      }
      const gitLandingComplete = currentRecord.snapshot.isolation?.mode !== "git-worktree" || gitAttempt?.status === "landed" || gitAttempt?.status === "no_changes";
      try {
        let handoff = await store.readHandoff(attemptId) as TaskResult;
        if (handoff.taskId === state.taskId && handoff.attemptId === attemptId && handoff.status === "succeeded" &&
            typeof handoff.summary === "string" && Buffer.byteLength(handoff.summary, "utf8") <= SUMMARY_LIMIT &&
            ["final", "stream", "none"].includes(handoff.summarySource) && typeof handoff.truncated === "boolean" &&
            handoff.artifactDir === attemptDirectory(store.workspace, attemptId) && gitLandingComplete) {
          states = states.map((item) => item.taskId === state.taskId ? {
            ...item, status: "succeeded", activeAttemptId: null, reasonCode: null, result: handoff,
            attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "recorded" as const } : ref),
          } : item);
          continue;
        }
      } catch { /* incomplete success cannot unlock dependants */ }
      if (gitLandingComplete) {
        const recovered: TaskResult = { taskId: state.taskId, attemptId, status: "succeeded", summary: "", summarySource: "none", truncated: false, artifactDir: attemptDirectory(store.workspace, attemptId) };
        await store.saveHandoff(attemptId, recovered).catch(() => undefined);
        states = states.map((item) => item.taskId === state.taskId ? {
          ...item, status: "succeeded", activeAttemptId: null, reasonCode: null, result: recovered,
          attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: "recorded" as const } : ref),
        } : item);
        continue;
      }
    }
    states = states.map((item) => item.taskId === state.taskId ? {
      ...item, status: "interrupted", activeAttemptId: null, reasonCode: "recovery_required",
      attempts: item.attempts.map((ref) => ref.attemptId === attemptId ? { ...ref, outcome: raw?.attemptId === attemptId ? "recorded" as const : "record_missing" as const } : ref),
    } : item);
  }
  states = new PlanStore(currentRecord.plan, currentRecord.snapshot).recalculateDependencies(states);
  const snapshot = { ...currentRecord.snapshot, revision: currentRecord.snapshot.revision + 1, status: sessionStatusFor(states), tasks: states, updatedAt: new Date().toISOString() };
  await store.save(snapshot);
  return { ...currentRecord, snapshot };
}

function pendingTasks(record: SessionRecord): PlannedTask[] {
  const statuses = new Map(record.snapshot.tasks.map((state) => [state.taskId, state.status]));
  return record.plan.tasks.filter(({ task }) => statuses.get(task.id) === "planned");
}

function attemptDirectory(workspace: string, attemptId: string): string { return join(resolve(workspace), ".token-coupon", "runs", attemptId); }

async function acquireExistingSessionLocks(store: SessionStore, sessionId: string): Promise<{ releaseWorkspace: () => Promise<void>; releaseGit?: () => Promise<void> }> {
  const initial = await store.load(sessionId);
  let releaseGit: (() => Promise<void>) | undefined;
  if (initial.snapshot.isolation?.mode === "git-worktree") {
    releaseGit = await acquireGitRepositoryLock(initial.snapshot.isolation.gitCommonDir, sessionId);
  }
  try {
    const releaseWorkspace = await store.acquireLock(sessionId);
    return { releaseWorkspace, ...(releaseGit ? { releaseGit } : {}) };
  } catch (error) {
    await releaseGit?.();
    throw error;
  }
}

async function prepareWorktrees(record: SessionRecord, store: SessionStore, setupValue?: WorktreeSetupProfile): Promise<WorktreeIsolation | undefined> {
  if (record.snapshot.isolation?.mode !== "git-worktree") return undefined;
  const setupProfile = setupValue ? parseWorktreeSetupProfile(setupValue) : undefined;
  if (record.snapshot.isolation.setupHash === null && setupProfile) throw new Error("setup_profile_mismatch：Session 创建时没有 setup 配置");
  if (record.snapshot.isolation.setupHash !== null && !setupProfile) throw new Error("setup_file_required：此 Session 需要原 setup 配置，请在 resume/retry 时传入同一 --setup-file");
  if (setupProfile && worktreeSetupHash(setupProfile) !== record.snapshot.isolation.setupHash) throw new Error("setup_profile_mismatch：setup 配置与 Session 创建时的 SHA-256 不一致");
  const worktrees = new WorktreeIsolation(record, store);
  try { await worktrees.initialize(); }
  catch (error) { await worktrees.saveBlocked("worktree_resume_check_failed").catch(() => undefined); throw error; }
  return worktrees;
}
