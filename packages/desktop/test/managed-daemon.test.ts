import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverOwnedDaemon } from "@token-coupon/client/node";
import { resolveDevelopmentDaemonRuntime } from "../src/daemon-runtime.js";
import { startManagedDaemon } from "../src/managed-daemon.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-managed-daemon-"));
  roots.push(root);
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("managed desktop daemon startup", () => {
  it("starts only the configured Node runtime and waits for the ready probe", async () => {
    const root = await fixture(), dataDirectory = join(root, "daemon-data"), entry = join(root, "daemon.mjs"), logPath = join(root, "daemon.log");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(entry, [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const dir = process.argv[process.argv.indexOf("--data-dir") + 1];',
      'const log = process.argv[process.argv.indexOf("--log-file") + 1];',
      'writeFileSync(join(dir, "ready"), "yes");',
      'writeFileSync(log, "daemon-ready");',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const started = await startManagedDaemon({
      runtime: { nodeExecutable: process.execPath, daemonEntry: entry, workingDirectory: root },
      dataDirectory,
      logPath,
      timeoutMs: 5_000,
      pollIntervalMs: 20,
      discover: async () => {
        if ((await readFile(join(dataDirectory, "ready"), "utf8").catch(() => "")) !== "yes") throw new Error("not_ready");
        return { verified: true };
      },
    });
    expect(started.attachment).toEqual({ verified: true });
    expect(started.port).toBeGreaterThanOrEqual(1024);
    try { expect(await readFile(logPath, "utf8")).toContain("daemon-ready"); }
    finally {
      if (started.child.exitCode === null) {
        const exited = once(started.child, "exit");
        started.child.kill("SIGTERM");
        await exited;
      }
    }
  });

  it("reports a startup exit before the readiness deadline", async () => {
    const root = await fixture(), dataDirectory = join(root, "daemon-data"), entry = join(root, "failed.mjs"), logPath = join(root, "daemon.log");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(entry, ['process.stderr.write("startup-failed\\n");', "process.exit(7);"].join("\n"));
    await expect(startManagedDaemon({
      runtime: { nodeExecutable: process.execPath, daemonEntry: entry, workingDirectory: root },
      dataDirectory, logPath, timeoutMs: 2_000, pollIntervalMs: 20,
      discover: async () => { throw new Error("not_ready"); },
    })).rejects.toThrow("desktop_daemon_start_failed");
  });

  it("starts the real daemon and attaches only after its local identity challenge passes", async () => {
    const root = await fixture(), dataDirectory = join(root, "daemon-data");
    let started;
    let lastProbeError = "no probe result";
    try {
      started = await startManagedDaemon({
        runtime: resolveDevelopmentDaemonRuntime(resolve("packages/desktop"), {}),
        dataDirectory,
        logPath: join(root, "logs/daemon.log"),
        timeoutMs: 8_000,
        pollIntervalMs: 100,
        discover: async () => {
          try { return await discoverOwnedDaemon(dataDirectory, { timeoutMs: 1_200 }); }
          catch (error) { lastProbeError = error instanceof Error ? error.message : String(error); throw error; }
        },
      });
    } catch (error) {
      const log = await readFile(join(root, "logs/daemon.log"), "utf8").catch(() => "(no daemon log)");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast probe: ${lastProbeError}\n${log}`);
    }
    expect(started.attachment.origin).toBe(`http://127.0.0.1:${started.port}`);
    try {
      expect(started.attachment.protocol.major).toBeGreaterThan(0);
      expect(started.attachment.buildId).toBeTruthy();
    } finally {
      if (started.child.exitCode === null) {
        const exited = once(started.child, "exit");
        started.child.kill("SIGTERM");
        await exited;
      }
    }
  }, 15_000);
});
