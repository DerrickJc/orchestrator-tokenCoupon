import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { agentComponentHome, resolveAgentExecutable } from "../src/agent-executable.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("prefers an explicit local executable and refuses invalid overrides instead of silently falling back", async () => {
  expect(await resolveAgentExecutable("claude-code", { TOKEN_COUPON_CLAUDE_EXECUTABLE: process.execPath })).toBe(process.execPath);
  expect(await resolveAgentExecutable("codex", { TOKEN_COUPON_CODEX_EXECUTABLE: process.execPath })).toBe(process.execPath);
  await expect(resolveAgentExecutable("codex", { TOKEN_COUPON_CODEX_EXECUTABLE: "relative" })).rejects.toThrow("agent_executable_invalid");
  expect(() => agentComponentHome({ TOKEN_COUPON_AGENT_HOME: "relative" })).toThrow("agent_home_invalid");
});
it("reuses PATH tools before privately installed components, without invoking the executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-agent-discovery-")); roots.push(root);
  const bin = join(root, "bin"), managed = join(root, "components", "codex", "current", "node_modules", ".bin");
  await mkdir(bin); await mkdir(managed, { recursive: true });
  const filename = process.platform === "win32" ? "codex.cmd" : "codex";
  for (const directory of [bin, managed]) { await writeFile(join(directory, filename), "discovery must never execute this file"); await chmod(join(directory, filename), 0o755); }
  const environment = { PATH: bin, PATHEXT: ".EXE;.CMD", TOKEN_COUPON_AGENT_HOME: join(root, "components") };
  expect(await resolveAgentExecutable("codex", environment)).toBe(join(bin, filename));
  await rm(join(bin, filename));
  expect(await resolveAgentExecutable("codex", environment)).toBe(join(managed, filename));
});
