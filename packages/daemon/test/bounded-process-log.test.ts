import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("caps daemon stdout/stderr and resets a full private log file", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-bounded-log-"));
  roots.push(root);
  const logPath = join(root, "daemon.log");
  await writeFile(logPath, "old".repeat(20));
  const moduleUrl = pathToFileURL(resolve("packages/daemon/dist/bounded-process-log.js")).href;
  const script = [
    `import { installBoundedProcessLogging } from ${JSON.stringify(moduleUrl)};`,
    `installBoundedProcessLogging(process.argv[1], 32);`,
    `process.stdout.write("a".repeat(40));`,
    `process.stderr.write("b".repeat(40));`,
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, logPath], { encoding: "utf8", stdio: "ignore", timeout: 10_000 });

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(await readFile(logPath, "utf8")).toBe("a".repeat(32));
});
