import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { directoryFootprint } from "./desktop-measurements.mjs";

/** Build-time budget: protocol adapters belong here; separately installed coding agents do not. */
export async function auditDesktopRuntime(directory, budgetBytes = 40 * 1024 * 1024) {
  const manifest = JSON.parse(await readFile(join(directory, "runtime-manifest.json"), "utf8"));
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || !manifest.nodeExecutable || !Array.isArray(manifest.packages)) throw new Error("desktop_size_manifest_invalid");
  const node = resolve(directory, manifest.nodeExecutable), child = relative(directory, node);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("desktop_size_node_path_invalid");
  const forbidden = manifest.packages.filter(name => /(?:^|\/)@anthropic-ai\/(?:claude-agent-sdk-|claude-code)|(?:^|\/)@openai\/codex/.test(name));
  if (forbidden.length) throw new Error("desktop_bundled_agent_forbidden：Agent 本体必须按需安装，不能放入桌面运行资源");
  const footprint = await directoryFootprint(directory), nodeBytes = (await stat(node)).size;
  const adapterAndApplicationBytes = footprint.logicalBytes - nodeBytes;
  if (adapterAndApplicationBytes > budgetBytes) throw new Error(`desktop_runtime_budget_exceeded：不含 Node 的后台资源 ${adapterAndApplicationBytes} 字节超过 ${budgetBytes} 字节预算，请检查新增运行依赖`);
  return { runtime: footprint, nodeBytes, adapterAndApplicationBytes, budgetBytes, bundledAgentExecutables: false, excludedAgentPackages: manifest.omittedAgentPackages ?? [] };
}
