import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { expect, it } from "vitest";
import { runChildProcess } from "../../core/src/runners/child-process.js";
import { spawnNative } from "@token-coupon/core";

it("assembles production resources without the application's source, test directories or workspace symlinks", async () => {
  // @ts-expect-error A maintainer ESM build script; runtime test verifies its emitted package layout.
  const { stageDesktopRuntime } = await import("../../../scripts/stage-desktop-runtime.mjs");
  const stage = await stageDesktopRuntime();
  try {
    const manifest = JSON.parse(await readFile(join(stage.root, "runtime-manifest.json"), "utf8"));
    expect(isAbsolute(manifest.daemonEntry)).toBe(false);
    expect(manifest.releaseReady).toBe(false);
    for (const name of ["core", "client", "daemon", "web", "cli"]) {
      const path = join(stage.root, "node_modules", "@token-coupon", name);
      expect((await lstat(path)).isSymbolicLink()).toBe(false);
      expect((await readdir(path)).sort()).toEqual((name === "core" ? ["dist", "package.json", "resources"] : ["dist", "package.json"]).sort());
    }
    expect(await readFile(join(stage.root, "node_modules/@token-coupon/core/resources/windows-job.ps1"), "utf8")).toContain("AssignProcessToJobObject");
    expect(JSON.parse(await readFile(join(stage.root, "node_modules/@token-coupon/daemon/package.json"), "utf8")).dependencies).toHaveProperty("@token-coupon/client");
    let output = "", diagnostic = "";
    const result = await runChildProcess({
      executable: process.execPath, args: [join(process.cwd(), "scripts/desktop-daemon-smoke.mjs"), "--entry", stage.daemonEntry],
      cwd: stage.root, input: "", spawn: spawnNative,
      context: { signal: AbortSignal.timeout(90000), onStarted() {}, onOutput() {} },
      onOutput: chunk => { if (chunk.stream === "stdout") output += chunk.text; else diagnostic += chunk.text; },
    });
    expect(result.exitCode, diagnostic).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ daemonEntry: "passed", authentication: "passed", mockPlanReviewApproveRun: "passed", restart: "passed", staleWrite: "rejected", persistedAttempt: "readable" });
  } finally { await rm(stage.root, { recursive: true, force: true }); }
}, 120000);
