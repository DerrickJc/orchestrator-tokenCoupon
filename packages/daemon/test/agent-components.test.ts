import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { AgentComponents, AGENT_COMPONENTS } from "../src/agent-components.js";
const roots: string[] = [], managers: AgentComponents[] = [];
const polling = { timeout: 15_000, interval: 100 };
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-agent-components-")); roots.push(root);
  const bin = join(root, "bin"); await mkdir(bin);
  const filename = (name: string) => name + (process.platform === "win32" ? ".cmd" : "");
  await writeFile(join(bin, filename("npm")), "discovery only"); await chmod(join(bin, filename("npm")), 0o755);
  const environment = { HOME: root, USERPROFILE: root, PATH: bin, PATHEXT: ".EXE;.CMD", TOKEN_COUPON_AGENT_HOME: join(root, "agents") };
  const calls: string[][] = [];
  const install = async (_command: string, args: string[], options: { cwd: string }) => {
    calls.push(args);
    if (args[0] === "--version") return AGENT_COMPONENTS["claude-code"].version;
    const definition = AGENT_COMPONENTS["claude-code"], dir = join(options.cwd, "node_modules", definition.package);
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "package.json"), JSON.stringify({ name: definition.package, version: definition.version }));
    const executable = join(dir, process.platform === "win32" ? "claude.exe" : "claude"); await writeFile(executable, "fixture"); await chmod(executable, 0o755); return "";
  };
  return { root, bin, filename, environment, calls, install };
}
it("does not install during discovery and requires explicit confirmation and fixed target IDs", async () => {
  const h = await fixture(), manager = new AgentComponents({ environment: h.environment, run: h.install }); managers.push(manager);
  const status = await manager.list(); expect(status.every(item => !item.available)).toBe(true); expect(h.calls).toEqual([]);
  await expect(readdir(h.environment.TOKEN_COUPON_AGENT_HOME)).rejects.toThrow();
  await expect(manager.install("claude-code", false)).rejects.toThrow("agent_install_confirmation_required");
  await expect(manager.install("../../arbitrary", true)).rejects.toThrow("agent_component_invalid");
  expect(h.calls).toEqual([]);
}, 20_000);
it("atomically installs a selected native Claude component, deduplicates requests, and never runs package scripts or a model", async () => {
  const h = await fixture(), manager = new AgentComponents({ environment: h.environment, run: h.install }); managers.push(manager);
  const [first, second] = await Promise.all([manager.install("claude-code", true), manager.install("claude-code", true)]);
  expect(first.operation?.operationId).toBe(second.operation?.operationId);
  await expect.poll(async () => (await manager.status("claude-code")).operation?.phase, polling).toBe("succeeded");
  const result = await manager.status("claude-code"); expect(result).toMatchObject({ available: true, source: "managed" });
  expect(h.calls).toHaveLength(2); expect(h.calls[0]).toContain("--ignore-scripts"); expect(h.calls[0]).not.toContain("--global");
  expect(h.calls[0]?.at(-1)).toBe(`${AGENT_COMPONENTS["claude-code"].package}@${AGENT_COMPONENTS["claude-code"].version}`);
  expect(h.calls[1]).toEqual(["--version"]);
  expect(JSON.parse(await readFile(join(result.installDirectory, "agent-component.json"), "utf8"))).toMatchObject({ id: "claude-code" });
  await manager.install("claude-code", true); expect(h.calls).toHaveLength(2);
}, 20_000);
it("keeps installed local tools untouched and does not replace an existing component directory", async () => {
  const h = await fixture(), manager = new AgentComponents({ environment: h.environment, run: h.install }); managers.push(manager);
  const executable = join(h.bin, h.filename("codex")); await writeFile(executable, "local tool"); await chmod(executable, 0o755);
  expect(await manager.install("codex", true)).toMatchObject({ available: true, source: "local" }); expect(h.calls).toEqual([]);
  const current = join(h.environment.TOKEN_COUPON_AGENT_HOME, "claude-code", "current"); await mkdir(current, { recursive: true }); await writeFile(join(current, "keep"), "previous files");
  await manager.install("claude-code", true);
  await expect.poll(async () => (await manager.status("claude-code")).operation?.phase, polling).toBe("failed");
  expect(await readFile(join(current, "keep"), "utf8")).toBe("previous files"); expect(h.calls).toEqual([]);
}, 20_000);
it("cleans failed staging directories and does not leak raw installer errors", async () => {
  const h = await fixture(), manager = new AgentComponents({ environment: h.environment, run: async () => { throw new Error("proxy-secret-do-not-expose"); } }); managers.push(manager);
  await manager.install("claude-code", true);
  await expect.poll(async () => (await manager.status("claude-code")).operation?.phase, polling).toBe("failed");
  const status = await manager.status("claude-code"); expect(status.available).toBe(false); expect(status.operation?.message).not.toContain("proxy-secret");
  await expect.poll(async () => (await readdir(join(h.environment.TOKEN_COUPON_AGENT_HOME, "claude-code"))).some(name => name.startsWith(".install-")), polling).toBe(false);
}, 20_000);
it("cancels the selected operation and leaves no active installer", async () => {
  let entered!: () => void; const running = new Promise<void>(resolve => { entered = resolve; });
  const h = await fixture(), manager = new AgentComponents({ environment: h.environment, run: async (_command, _args, options) => new Promise((_resolve, reject) => { entered(); if (options.signal.aborted) reject(new Error("cancelled")); else options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }) }); managers.push(manager);
  const status = await manager.install("claude-code", true); expect(manager.active()).toHaveLength(1);
  await running;
  expect(() => manager.cancel("claude-code", "old-operation")).toThrow("agent_install_operation_changed");
  manager.cancel("claude-code", status.operation!.operationId); await manager.close();
  expect((await manager.status("claude-code")).operation?.phase).toBe("cancelled"); expect(manager.active()).toEqual([]);
}, 20_000);
