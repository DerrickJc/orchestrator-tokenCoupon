import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveNativeExecutable } from "./native-command.js";

export type ExternalAgentId = "codex" | "claude-code";
function userHome(environment: NodeJS.ProcessEnv): string { const value = environment.HOME ?? environment.USERPROFILE; return value && isAbsolute(value) ? value : homedir(); }
export function managedClaudePackage(platform = process.platform, arch = process.arch): string { return `@anthropic-ai/claude-code-${platform}-${arch}`; }
export function agentComponentHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.TOKEN_COUPON_AGENT_HOME;
  if (configured !== undefined && (!configured.trim() || !isAbsolute(configured))) throw new Error("agent_home_invalid：Agent 组件目录必须是绝对路径");
  return configured ?? join(userHome(environment), ".token-coupon", "agents");
}

/** Discovery never installs, updates or invokes a model. Explicit paths fail closed. */
export async function resolveAgentExecutable(id: ExternalAgentId, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const command = id === "codex" ? "codex" : "claude";
  const key = id === "codex" ? "TOKEN_COUPON_CODEX_EXECUTABLE" : "TOKEN_COUPON_CLAUDE_EXECUTABLE";
  const explicit = environment[key];
  if (explicit !== undefined) {
    if (!explicit.trim() || !isAbsolute(explicit)) throw new Error(`agent_executable_invalid：${key} 必须是绝对路径`);
    return resolveNativeExecutable(explicit, command, environment);
  }
  try { return await resolveNativeExecutable(command, command, environment); } catch { /* Try known user-owned locations; never the workspace. */ }
  const home = userHome(environment), components = agentComponentHome(environment);
  const candidates = [
    join(home, ".local", "bin", command),
    ...(process.platform === "win32" && environment.APPDATA ? [join(environment.APPDATA, "npm", command)] : []),
    ...(id === "claude-code" ? [join(components, id, "current", "node_modules", managedClaudePackage(), process.platform === "win32" ? "claude.exe" : "claude")] : []),
    join(components, id, "current", "node_modules", ".bin", command),
  ];
  for (const candidate of candidates) {
    try { return await resolveNativeExecutable(candidate, command, environment); } catch { /* Installation remains an explicit separate action. */ }
  }
  throw new Error(`runner_component_missing：未检测到 ${id === "codex" ? "Codex" : "Claude Code"}。请在系统设置的 Agent 组件中安装，或配置 ${key}；不会自动下载安装或启动其他 Runner。`);
}
