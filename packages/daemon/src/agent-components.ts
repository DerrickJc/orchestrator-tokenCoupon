import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, delimiter, relative, isAbsolute, sep } from "node:path";
import { acquireLockCoordination, agentComponentHome, managedClaudePackage, resolveAgentExecutable, resolveNativeExecutable, spawnNative, type ExternalAgentId } from "@token-coupon/core";

export const AGENT_COMPONENTS = Object.freeze({
  codex: { label: "Codex", package: "@openai/codex", version: "0.163.0", docs: "https://developers.openai.com/codex/cli/" },
  "claude-code": { label: "Claude Code", package: managedClaudePackage(), version: "2.1.308", docs: "https://code.claude.com/docs/en/setup" },
});
export type ComponentOperation = { operationId: string; phase: "installing" | "succeeded" | "failed" | "cancelled"; message: string; startedAt: string };
export interface AgentComponentStatus {
  id: ExternalAgentId; label: string; package: string; version: string; docs: string;
  available: boolean; source?: "local" | "managed"; executable?: string;
  installDirectory: string; canInstall: boolean; reason?: string; operation?: ComponentOperation;
}
type Run = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<string>;
export function componentId(value: string): ExternalAgentId {
  if (value !== "codex" && value !== "claude-code") throw new Error("agent_component_invalid：仅支持 Codex 与 Claude Code");
  return value;
}
async function execute(command: string, args: string[], options: Parameters<Run>[2]): Promise<string> {
  const child = spawnNative(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); });
  child.stderr?.on("data", () => undefined); // npm output may contain proxy credentials; never persist or expose it.
  return new Promise((resolve, reject) => {
    let failed = false;
    child.once("error", () => { failed = true; });
    // Abort can emit error before the OS child exits. Wait for close before removing staging files.
    child.once("close", code => code === 0 && !failed ? resolve(output) : reject(new Error(`agent_install_failed：命令退出码 ${code ?? "未知"}；请检查 npm、网络/代理、磁盘空间与目录权限后重试`)));
  });
}

/** Optional user-owned tools, outside the application and workspace. No implicit installs or upgrades. */
export class AgentComponents {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly operations = new Map<ExternalAgentId, ComponentOperation>();
  private readonly workers = new Map<ExternalAgentId, { controller: AbortController; done: Promise<void> }>();
  constructor(private readonly options: { environment?: NodeJS.ProcessEnv; run?: Run } = {}) { this.environment = options.environment ?? process.env; }
  async list(): Promise<AgentComponentStatus[]> { return Promise.all((Object.keys(AGENT_COMPONENTS) as ExternalAgentId[]).map(id => this.status(id))); }
  async status(id: ExternalAgentId): Promise<AgentComponentStatus> {
    const definition = AGENT_COMPONENTS[id], installDirectory = join(agentComponentHome(this.environment), id, "current");
    let executable: string | undefined, reason: string | undefined;
    try { executable = await resolveAgentExecutable(id, this.environment); } catch (error) { reason = error instanceof Error ? error.message : "未检测到本机工具"; }
    let npm = false; try { await resolveNativeExecutable("npm", "npm", this.environment); npm = true; } catch { /* Manual native installation is also supported. */ }
    const configured = this.environment[id === "codex" ? "TOKEN_COUPON_CODEX_EXECUTABLE" : "TOKEN_COUPON_CLAUDE_EXECUTABLE"] !== undefined;
    if (!executable && !npm && !configured) reason = "未检测到 npm，无法在此自动安装。请先安装 Node.js/npm，或按官方说明安装 Agent 后点击重新检测。应用随包 Node 不包含 npm。";
    const supported = ["linux", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);
    const operation = this.operations.get(id);
    const child = executable ? relative(installDirectory, executable) : "..";
    const managed = !!child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    return { id, ...definition, available: !!executable, ...(executable ? { executable, source: managed ? "managed" : "local" } : {}),
      installDirectory, canInstall: !executable && npm && !configured && supported && operation?.phase !== "installing", ...(reason ? { reason } : {}), ...(operation ? { operation: { ...operation } } : {}) };
  }
  active() { return [...this.operations.values()].filter(value => value.phase === "installing").map(value => ({ jobId: value.operationId, kind: "agent.component.install" })); }
  async install(value: string, confirmed: boolean): Promise<AgentComponentStatus> {
    const id = componentId(value);
    if (!confirmed) throw new Error("agent_install_confirmation_required：请确认官方包名、固定版本和用户组件目录后安装");
    const status = await this.status(id);
    if (this.workers.has(id)) return this.status(id);
    if (status.available || status.operation?.phase === "installing") return status;
    if (!status.canInstall) throw new Error(`agent_install_unavailable：${status.reason ?? "请检查平台支持与自定义可执行路径配置"}`);
    const controller = new AbortController();
    const operation: ComponentOperation = { operationId: randomUUID(), phase: "installing", message: "正在准备用户级组件目录；不会修改系统全局安装。", startedAt: new Date().toISOString() };
    this.operations.set(id, operation);
    const done = Promise.resolve().then(() => this.perform(id, operation, controller.signal)).catch(error => {
      operation.phase = controller.signal.aborted ? "cancelled" : "failed";
      operation.message = controller.signal.aborted ? "安装已取消；原有工具未被替换，可重新安装。" : error instanceof Error && /^agent_|^lock_coordination_/.test(error.message) ? error.message.slice(0, 500) : "agent_install_failed：安装未完成；原有组件保留，请检查网络、npm 和目录权限后重试。";
    }).finally(() => this.workers.delete(id));
    this.workers.set(id, { controller, done });
    return this.status(id);
  }
  cancel(value: string, operationId: string): void {
    const id = componentId(value);
    if (this.operations.get(id)?.operationId !== operationId) throw new Error("agent_install_operation_changed：安装记录已变化，请刷新状态");
    this.workers.get(id)?.controller.abort();
  }
  async close(): Promise<void> { for (const worker of this.workers.values()) worker.controller.abort(); await Promise.allSettled([...this.workers.values()].map(value => value.done)); }
  private async perform(id: ExternalAgentId, operation: ComponentOperation, signal: AbortSignal): Promise<void> {
    const definition = AGENT_COMPONENTS[id], home = agentComponentHome(this.environment), directory = join(home, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [home, directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 0o022) !== 0) throw new Error("agent_component_directory_unsafe：组件目录必须是当前用户的私有普通目录");
    }
    const release = await acquireLockCoordination([join(directory, "install")]);
    let staging: string | undefined;
    const timeout = setTimeout(() => this.workers.get(id)?.controller.abort(), 10 * 60_000); timeout.unref();
    try {
      signal.throwIfAborted();
      const current = join(directory, "current");
      try { await lstat(current); throw new Error("agent_component_directory_exists：已有组件目录未被覆盖。请先核对该目录、停止相关任务并将其移走，再重试安装。"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      staging = await mkdtemp(join(directory, ".install-"));
      const npm = await resolveNativeExecutable("npm", "npm", this.environment), userConfig = join(staging, "install-user.npmrc"), globalConfig = join(staging, "install-global.npmrc");
      await writeFile(userConfig, "registry=https://registry.npmjs.org/\n@openai:registry=https://registry.npmjs.org/\n@anthropic-ai:registry=https://registry.npmjs.org/\nignore-scripts=true\n", { mode: 0o600 });
      await writeFile(globalConfig, "", { mode: 0o600 });
      const env = { ...this.environment }, pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
      env[pathKey] = dirname(process.execPath) + delimiter + (env[pathKey] ?? "");
      operation.message = `正在下载 ${definition.package}@${definition.version}；仅安装所选 Agent，不运行包安装脚本。`;
      const run = this.options.run ?? execute;
      await run(npm, ["install", "--prefix", staging, "--ignore-scripts", "--omit=dev", "--include=optional", "--no-audit", "--no-fund", "--loglevel=error", "--registry=https://registry.npmjs.org/", "--userconfig", userConfig, "--globalconfig", globalConfig, `${definition.package}@${definition.version}`], { cwd: staging, env, signal });
      signal.throwIfAborted();
      const manifest = JSON.parse(await readFile(join(staging, "node_modules", definition.package, "package.json"), "utf8"));
      if (manifest.version !== definition.version || manifest.name !== definition.package) throw new Error("agent_component_identity_invalid：安装结果与固定包名/版本不符，未启用组件");
      const executable = id === "claude-code" ? join(staging, "node_modules", definition.package, process.platform === "win32" ? "claude.exe" : "claude") : await resolveNativeExecutable(join(staging, "node_modules", ".bin", "codex"), "Codex", env);
      operation.message = "下载完成，正在校验工具版本；不会登录或调用模型。";
      const version = await run(executable, ["--version"], { cwd: staging, env, signal });
      if (!version.includes(definition.version)) throw new Error("agent_component_version_invalid：可执行程序版本核验失败，未启用组件");
      signal.throwIfAborted();
      await writeFile(join(staging, "agent-component.json"), JSON.stringify({ id, package: definition.package, version: definition.version, installedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
      await rename(staging, current); staging = undefined;
      operation.phase = "succeeded"; operation.message = "组件已安装并通过版本校验。请在终端完成该工具的登录，再开始模型任务。";
    } finally { clearTimeout(timeout); if (staging) await rm(staging, { recursive: true, force: true }); await release(); }
  }
}
