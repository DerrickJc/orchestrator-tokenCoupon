import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveNativeExecutable, spawnNative } from "../packages/core/dist/native-command.js";

const root = await mkdtemp(join(tmpdir(), "token-coupon-command-"));
try {
  const bin = join(root, "中文 空格", "node_modules", ".bin"); await mkdir(bin, { recursive: true });
  const echo = join(root, "echo.mjs"); await writeFile(echo, "console.log(JSON.stringify(process.argv.slice(2)))");
  const windows = process.platform === "win32";
  const executable = join(bin, windows ? "fake-agent.cmd" : "fake-agent");
  await writeFile(executable, windows ? `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${echo}" "$@"\n`, { mode: 0o755 });
  const environment = { ...process.env, TOKEN_COUPON_ARG_PROBE: "must-stay-literal" };
  for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
  environment[windows ? "Path" : "PATH"] = (windows ? `"${bin}"` : bin) + delimiter + (process.env.PATH || process.env.Path || "");
  if (windows) environment.PATHEXT = ".EXE;.CMD";
  const resolved = await resolveNativeExecutable("fake-agent", "fake", environment);
  assert.equal(resolved.toLowerCase(), executable.toLowerCase());
  assert.equal((await resolveNativeExecutable(executable, "fake", environment)).toLowerCase(), executable.toLowerCase());
  await assert.rejects(() => resolveNativeExecutable("missing-token-coupon-command", "missing", environment));
  const sentinel = join(root, "injected.txt");
  const args = ["含空格 中文", 'quote"value', "(parentheses)", "literal&pipe|x", "caret^here", "%TOKEN_COUPON_ARG_PROBE%", "", `& echo injected>${sentinel}`];
  const child = spawnNative(resolved, args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), args);
  await assert.rejects(() => access(sentinel));
  console.log(JSON.stringify({ platform: process.platform, node: process.version, pathLookup: "passed", arguments: "passed", shellInjection: "blocked" }));
} finally { await rm(root, { recursive: true, force: true }); }
