// Only the daemon/CLI runtime dependency closure is shipped. The web UI is already bundled.
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const externalAgentPackage = name => name === "@openai/codex" || name.startsWith("@openai/codex-") || name === "@anthropic-ai/claude-code" || name.startsWith("@anthropic-ai/claude-agent-sdk-");
const workspaceNames = new Set(["@token-coupon/client", "@token-coupon/core", "@token-coupon/daemon", "@token-coupon/cli"]);
export async function runtimeDependencies(source) {
  const selected = new Map(), omittedAgentPackages = new Set(), skippedOptional = new Set();
  const inside = path => { const part = relative(source, path); return path === source || !!part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
  const queue = [...workspaceNames].map(name => ({ path: join(source, "packages", name.split("/")[1]), workspace: true }));
  async function dependency(name, from, optional) {
    if (externalAgentPackage(name)) { omittedAgentPackages.add(name); return; }
    if (workspaceNames.has(name)) return;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") throw new Error("runtime_dependency_name_invalid");
    let cursor = from;
    while (inside(cursor)) {
      const candidate = join(cursor, "node_modules", name);
      try {
        await access(join(candidate, "package.json"));
        const actual = await realpath(candidate), within = relative(source, actual);
        if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("runtime_resource_outside_source");
        const destination = relative(source, candidate).split(sep).join("/");
        if (!selected.has(destination)) { selected.set(destination, { path: actual, destination, name }); queue.push({ path: actual }); }
        return;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (cursor === source) break;
      cursor = dirname(cursor);
    }
    if (optional) skippedOptional.add(name);
    else throw new Error(`runtime_dependency_missing：缺少 ${name}`);
  }
  while (queue.length) {
    const entry = queue.shift(), manifest = JSON.parse(await readFile(join(entry.path, "package.json"), "utf8"));
    const optional = manifest.optionalDependencies ?? {};
    const dependencies = { ...manifest.dependencies, ...optional };
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[name]?.optional && !name.startsWith("@types/")) dependencies[name] ??= manifest.peerDependencies[name];
    }
    for (const name of Object.keys(dependencies)) await dependency(name, entry.path, Object.hasOwn(optional, name));
  }
  return { dependencies: [...selected.values()], omittedAgentPackages: [...omittedAgentPackages].sort(), skippedOptional: [...skippedOptional].sort() };
}

export function runtimeFileAllowed(path) {
  const segments = path.split(/[\\/]/), name = segments.at(-1);
  if (segments.some(part => ["node_modules", ".git", ".github", "test", "tests", "__tests__", "coverage", "docs", "examples", "benchmarks"].includes(part))) return false;
  // README may be the license itself (e.g. SDK "SEE LICENSE IN README.md").
  if (/^(?:\.env(?:\.|$)|changelog(?:\.|$)|tsconfig(?:\.|$))/i.test(name)) return false;
  return !/\.d\.[cm]ts$|\.(?:map|ts|tsx|tsbuildinfo)$|\.(?:test|spec)\.[cm]?js$/i.test(name);
}
