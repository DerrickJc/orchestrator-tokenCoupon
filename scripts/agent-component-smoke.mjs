// Explicit network smoke: installs only in a disposable user profile and never calls a model.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AgentComponents } from "../packages/daemon/dist/agent-components.js";
import { resolveNativeExecutable } from "../packages/core/dist/native-command.js";

const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const selected = option("--agent");
assert(["codex", "claude-code", "both"].includes(selected), "Specify --agent codex|claude-code|both; this smoke downloads official Agent components.");
const output = resolve(option("--output") ?? ".token-coupon/reports/agent-components.json");
const npm = await resolveNativeExecutable("npm");
const npmEntry = process.platform === "win32" ? join(dirname(npm), "node_modules/npm/bin/npm-cli.js") : await realpath(npm);
await readFile(npmEntry); // Require a standard installed npm, rather than downloading another bootstrap tool.
const root = await mkdtemp(join(process.platform === "win32" ? homedir() : tmpdir(), ".token-coupon-agent-smoke-"));
const bin = join(root, "bin"); await mkdir(bin);
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
if (process.platform === "win32") {
  await copyFile(process.execPath, join(bin, "node.exe"));
  await writeFile(join(bin, "npm.cmd"), `@echo off\r\n"${process.execPath}" "${npmEntry}" %*\r\n`);
} else {
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(join(bin, "npm"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(npmEntry)} "$@"\n`, { mode: 0o755 });
}
const environment = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "AppData"), TOKEN_COUPON_AGENT_HOME: join(root, "agents") };
for (const key of Object.keys(environment)) if (key.toLowerCase() === "path" || ["TOKEN_COUPON_CODEX_EXECUTABLE", "TOKEN_COUPON_CLAUDE_EXECUTABLE"].includes(key)) delete environment[key];
environment.PATH = bin;
const manager = new AgentComponents({ environment });
const results = [];
try {
  for (const id of selected === "both" ? ["codex", "claude-code"] : [selected]) {
    const initial = await manager.status(id); assert.equal(initial.available, false, "smoke must not reuse the user's global Agent");
    assert(initial.canInstall, initial.reason);
    await manager.install(id, true);
    const deadline = Date.now() + 11 * 60_000; let status, lastMessage;
    do {
      status = await manager.status(id);
      if (status.operation?.message !== lastMessage) { lastMessage = status.operation?.message; console.log(`${id}: ${lastMessage}`); }
      if (status.operation?.phase !== "installing") break;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
    } while (Date.now() < deadline);
    assert.equal(status.operation?.phase, "succeeded", status.operation?.message);
    assert.equal(status.available, true); assert.equal(status.source, "managed");
    const receipt = JSON.parse(await readFile(join(status.installDirectory, "agent-component.json"), "utf8"));
    results.push({ id, package: receipt.package, version: receipt.version, installedAndVersionVerified: true, modelCalls: 0 });
    const reused = await manager.install(id, true); assert.equal(reused.operation.operationId, status.operation.operationId, "available components must not reinstall");
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ platform: process.platform, node: process.version, temporaryProfile: true, existingAgentsUntouched: true, results }, null, 2) + "\n");
  console.log(JSON.stringify({ output, results }));
} finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
