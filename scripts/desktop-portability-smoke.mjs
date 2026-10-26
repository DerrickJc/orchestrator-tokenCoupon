import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDaemonDataDirectory } from "../packages/daemon/dist/runtime-paths.js";

const core = fileURLToPath(new URL("../packages/core/", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "token-coupon-portability-"));
try {
  const packaged = join(root, "package");
  for (const relative of ["package.json", "dist/runners/mock-runner.js", "dist/runners/child-process.js", "resources/mock-process.mjs"]) {
    await mkdir(dirname(join(packaged, relative)), { recursive: true });
    await cp(join(core, relative), join(packaged, relative));
  }
  const script = join(root, "demo.mjs");
  await writeFile(script, `import { MockRunner } from ${JSON.stringify(pathToFileURL(join(packaged, "dist/runners/mock-runner.js")).href)};
    const runner = new MockRunner(); await runner.checkAvailable();
    const result = await runner.run({ cwd: process.cwd(), prompt: 'demo', completionMarker: 'PACKAGED_DEMO_DONE' }, {
      signal: new AbortController().signal, onStarted() {}, onOutput(output) { process.stdout.write(output.text); }
    }); if (result.exitCode !== 0) process.exitCode = 1;`);
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(result.stdout.includes("PACKAGED_DEMO_DONE"), "packaged demo did not return its completion marker");
  const dataDirectory = resolveDaemonDataDirectory(undefined, {});
  assert.equal(dataDirectory, join(homedir(), ".token-coupon", "daemon"));
  assert.throws(() => resolveDaemonDataDirectory(undefined, {}, ""), /daemon_home_unavailable/);
  console.log(JSON.stringify({ platform: process.platform, node: process.version, dataDirectory, packagedDemo: "passed", sourceOrTestsRequired: false }));
} finally { await rm(root, { recursive: true, force: true }); }
