import { spawn } from "node:child_process";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface GitRepositoryContext {
  workspace: string;
  repositoryRoot: string;
  gitCommonDir: string;
  baseCommit: string;
  sourceBranch: string | null;
  objectFormat: "sha1" | "sha256";
}

export interface GitCommandResult { stdout: string; stderr: string; stdoutBuffer: Buffer; }

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly gitArgs: string[];
  constructor(args: string[], exitCode: number | null, stderr: string) {
    super(`git ${args[0] ?? ""} 失败${exitCode === null ? "" : `（退出码 ${exitCode}）`}${stderr.trim() ? `：${stderr.trim()}` : ""}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.gitArgs = args;
  }
}

const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

/** Run Git with argv, never through a shell. Binary-safe callers should use the NUL output helpers. */
export function runGit(cwd: string, args: string[], input?: Buffer): Promise<GitCommandResult> {
  return new Promise((resolveResult, reject) => {
    const env = { ...process.env };
    // Do not let a caller's inherited Git routing variables redirect commands away from cwd.
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) delete env[key];
    const child = spawn("git", args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let tooLarge = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT) { tooLarge = true; child.kill("SIGKILL"); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_OUTPUT) { tooLarge = true; child.kill("SIGKILL"); }
      else stderr.push(chunk);
    });
    child.once("error", (error) => reject(new Error(`无法启动 Git：${error.message}`)));
    child.once("close", (code) => {
      if (tooLarge) { reject(new Error("Git 输出超过 32 MiB 上限")); return; }
      const outBuffer = Buffer.concat(stdout);
      const out = outBuffer.toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) { reject(new GitCommandError(args, code, err)); return; }
      resolveResult({ stdout: out, stderr: err, stdoutBuffer: outBuffer });
    });
    if (input && input.length) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function inspectGitRepository(workspaceValue: string): Promise<GitRepositoryContext> {
  const workspace = resolve(workspaceValue);
  const actualWorkspace = await realpath(workspace).catch(() => { throw new Error("git-worktree 要求 workspace 是已存在的 Git 仓库根目录"); });
  if (actualWorkspace !== workspace) throw new Error("git-worktree 不接受通过符号链接指定 workspace；请传入仓库真实路径");
  const rootOutput = (await runGit(workspace, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repositoryRoot = await realpath(rootOutput);
  if (repositoryRoot !== workspace) throw new Error("git-worktree 要求 workspace 本身是仓库根目录，不能使用仓库子目录");
  const bare = (await runGit(workspace, ["rev-parse", "--is-bare-repository"])).stdout.trim();
  if (bare !== "false") throw new Error("git-worktree 不支持 bare 仓库");
  const commonOutput = (await runGit(workspace, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const gitCommonDir = await realpath(isAbsolute(commonOutput) ? commonOutput : resolve(workspace, commonOutput));
  const baseCommit = (await runGit(workspace, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit)) throw new Error("Git HEAD 不是受支持的完整提交 OID");
  const objectFormat = (await runGit(workspace, ["rev-parse", "--show-object-format"])).stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error(`不支持的 Git 对象格式：${objectFormat}`);
  const branchResult = await runGit(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.exitCode === 1) return { stdout: "", stderr: "", stdoutBuffer: Buffer.alloc(0) };
    throw error;
  });
  const sourceBranch = branchResult.stdout.trim() || null;
  const sparse = (await runGit(workspace, ["config", "--bool", "--get", "core.sparseCheckout"]).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.exitCode === 1) return { stdout: "false", stderr: "", stdoutBuffer: Buffer.alloc(0) };
    throw error;
  })).stdout.trim();
  if (sparse === "true") throw new Error("git-worktree 首版不支持 sparse checkout");
  const index = (await runGit(workspace, ["ls-files", "--stage", "-z"])).stdout;
  if (index.split("\0").some((line) => line.startsWith("160000 "))) throw new Error("git-worktree 首版不支持包含 submodule 的仓库");
  const metadataPath = join(workspace, ".token-coupon");
  try {
    const info = await lstat(metadataPath);
    if (info.isSymbolicLink()) throw new Error("workspace/.token-coupon 不能是符号链接");
    if (!info.isDirectory()) throw new Error("workspace/.token-coupon 必须是目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const child of ["sessions", "runs", "worktrees"]) {
    try {
      const info = await lstat(join(metadataPath, child));
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`workspace/.token-coupon/${child} 必须是普通目录`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const trackedMetadata = (await runGit(workspace, ["ls-files", "-z", "--", ".token-coupon"])).stdout;
  if (trackedMetadata.length > 0) throw new Error("workspace/.token-coupon 含有 Git 跟踪文件，不能作为隔离工作目录");
  const status = (await runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  if (status.length > 0) throw new Error("git-worktree 要求 workspace 工作区干净；请先处理 tracked、staged 或未忽略的 untracked 改动。未执行 stash 或删除操作");
  await runGit(workspace, ["var", "GIT_AUTHOR_IDENT"]);
  await runGit(workspace, ["var", "GIT_COMMITTER_IDENT"]);
  return { workspace, repositoryRoot, gitCommonDir, baseCommit, sourceBranch, objectFormat };
}

/** One lock per Git common directory prevents overlapping Token Coupon worktree/ref mutations. */
export async function acquireGitRepositoryLock(gitCommonDir: string, sessionId?: string): Promise<() => Promise<void>> {
  const lockPath = join(gitCommonDir, "token-coupon-worktree.lock");
  const owner = { pid: process.pid, sessionId: sessionId ?? null, token: `${Date.now()}-${Math.random().toString(16).slice(2)}`, acquiredAt: new Date().toISOString() };
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let detail = "另一个 Token Coupon Git Session 正在操作此仓库";
      try {
        const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; sessionId?: string | null };
        detail += `（PID ${existing.pid ?? "未知"}${existing.sessionId ? `，Session ${existing.sessionId}` : ""}）`;
      } catch { detail += "（锁记录不可读；不会自动删除）"; }
      throw new Error(`${detail}。如果已确认无进程持有，可手动检查并移除 ${lockPath}`);
    }
    throw error;
  }
  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
      if (current.token === owner.token) await unlink(lockPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}

export function parseNulPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export function assertSafeGitPath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Git 返回了不安全的仓库相对路径：${JSON.stringify(path)}`);
  }
}

export function shortOid(oid: string): string { return oid.slice(0, 12); }
