import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
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
    expect(manifest.applicationVersion).toBe("0.1.0");
    expect(manifest.buildId).toMatch(/^[a-zA-Z0-9._+-]{1,120}$/);
    for (const name of ["core", "client", "daemon", "web", "cli"]) {
      const path = join(stage.root, "node_modules", "@token-coupon", name);
      expect((await lstat(path)).isSymbolicLink()).toBe(false);
      expect((await readdir(path)).sort()).toEqual(["LICENSE", "NOTICE", ...(name === "core" ? ["dist", "package.json", "resources"] : name === "daemon" ? ["dist", "package.json", "THIRD_PARTY_LICENSES"] : ["dist", "package.json"])].sort());
      expect(await readFile(join(path, "LICENSE"), "utf8")).toBe(await readFile(join(process.cwd(), "LICENSE"), "utf8"));
      expect(await readFile(join(path, "NOTICE"), "utf8")).toBe(await readFile(join(process.cwd(), "NOTICE"), "utf8"));
    }
    expect(await readFile(join(stage.root, "node_modules/@token-coupon/core/resources/windows-job.ps1"), "utf8")).toContain("AssignProcessToJobObject");
    expect(JSON.parse(await readFile(join(stage.root, "node_modules/@token-coupon/daemon/package.json"), "utf8")).dependencies).toHaveProperty("@token-coupon/client");
    // Execute installation from the physical package, so a repository-only
    // license cannot hide a missing runtime resource. No binary is executed.
    const component = await import(pathToFileURL(join(stage.root, "node_modules/@token-coupon/daemon/dist/cloudflared-component.js")).href);
    const content = Buffer.from("package-side component fixture"), installed = join(stage.root, "component-install-smoke");
    await component.installCloudflared(installed, { name: "fixture", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }, new AbortController().signal, () => undefined, async () => new Response(content));
    expect(await readFile(join(installed, "LICENSE"), "utf8")).toContain("Apache License");
    expect(JSON.parse(await readFile(join(installed, "installed.json"), "utf8"))).toHaveProperty("binarySha256");
    let output = "", diagnostic = "";
    const result = await runChildProcess({
      executable: process.execPath, args: [join(process.cwd(), "scripts/desktop-daemon-smoke.mjs"), "--entry", stage.daemonEntry,
        "--expected-build-id", manifest.buildId, "--expected-version", manifest.applicationVersion],
      cwd: stage.root, input: "", spawn: spawnNative,
      context: { signal: AbortSignal.timeout(90000), onStarted() {}, onOutput() {} },
      onOutput: chunk => { if (chunk.stream === "stdout") output += chunk.text; else diagnostic += chunk.text; },
    });
    expect(result.exitCode, diagnostic).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ daemonEntry: "passed", discoveryProof: "passed", authentication: "passed", mockPlanReviewApproveRun: "passed", restart: "passed", staleWrite: "rejected", persistedAttempt: "readable" });
  } finally { await rm(stage.root, { recursive: true, force: true }); }
}, 120000);
