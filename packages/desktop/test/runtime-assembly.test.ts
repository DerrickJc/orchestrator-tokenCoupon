import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The resource assembler is a maintainer ESM script.
const { assembleDesktopRuntime, installDesktopRuntimeStage } = await import("../../../scripts/assemble-desktop-resources.mjs");
// @ts-expect-error The staging helper is a maintainer ESM script.
const { validateBundledNodeIdentity, validateDesktopBuildIdentity } = await import("../../../scripts/stage-desktop-runtime.mjs");
// @ts-expect-error Maintainer ESM build-time resource budget.
const { auditDesktopRuntime } = await import("../../../scripts/desktop-size-audit.mjs");
const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "token-coupon-resource-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function runtimeStage(root: string) {
  const stage = join(root, "stage"), daemon = join(stage, "node_modules/@token-coupon/daemon/dist/main.js"), node = join(stage, "runtime/node");
  await mkdir(join(stage, "node_modules/@token-coupon/daemon/dist"), { recursive: true }); await mkdir(join(stage, "runtime"), { recursive: true });
  await writeFile(daemon, "// daemon entry\n"); await writeFile(node, "#!/bin/sh\nexit 0\n"); await chmod(node, 0o755);
  await writeFile(join(stage, "runtime-manifest.json"), JSON.stringify({ format: 1, kind: "unpacked-development-stage", packages: ["@token-coupon/daemon"], daemonEntry: "node_modules/@token-coupon/daemon/dist/main.js", nodeExecutable: "runtime/node", releaseReady: false }));
  return stage;
}

describe("Electron extraResources assembly", () => {
  it("rejects bundled Node runtimes for another platform or architecture", () => {
    expect(() => validateBundledNodeIdentity({ platform: "linux", arch: "x64" }, "win32", "x64")).toThrow("runtime_node_platform_invalid");
    expect(() => validateBundledNodeIdentity({ platform: "win32", arch: "arm64" }, "win32", "x64")).toThrow("runtime_node_arch_invalid");
    expect(() => validateBundledNodeIdentity({ platform: "win32", arch: "x64" }, "win32", "x64")).not.toThrow();
  });

  it("requires staged build metadata to match the application and pinned release ID", () => {
    const identity = { format: 1, applicationVersion: "0.1.0", buildId: "release-2026.10.20" };
    expect(validateDesktopBuildIdentity(identity, "0.1.0", "release-2026.10.20")).toEqual({ applicationVersion: "0.1.0", buildId: "release-2026.10.20" });
    expect(() => validateDesktopBuildIdentity(identity, "0.2.0", "release-2026.10.20")).toThrow("runtime_build_info_invalid");
    expect(() => validateDesktopBuildIdentity(identity, "0.1.0", "another-release")).toThrow("runtime_build_id_mismatch");
    expect(() => validateDesktopBuildIdentity({ ...identity, buildId: "../untrusted" }, "0.1.0")).toThrow("runtime_build_info_invalid");
  });

  it("installs a validated runtime stage and marks it as resources-only, not a release", async () => {
    const root = await fixture(), stage = await runtimeStage(root), resources = join(root, "electron", "resources");
    const result = await installDesktopRuntimeStage(stage, resources);
    expect(result.directory).toBe(join(resources, "token-coupon-runtime"));
    expect(result.manifest).toMatchObject({ kind: "electron-extra-resource", runtimeReady: true, releaseReady: false });
    expect(await readFile(join(result.directory, "node_modules/@token-coupon/daemon/dist/main.js"), "utf8")).toContain("daemon entry");
    expect((await readFile(join(result.directory, "runtime-manifest.json"), "utf8"))).toContain('"runtimeReady": true');
  });

  it("rejects missing Node, traversal paths, and overwriting an existing packaged runtime", async () => {
    const root = await fixture(), stage = await runtimeStage(root), resources = join(root, "electron", "resources");
    const manifestPath = join(stage, "runtime-manifest.json"), original = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...original, nodeExecutable: undefined }));
    await expect(installDesktopRuntimeStage(stage, resources)).rejects.toThrow("desktop_resources_node_required");
    await writeFile(manifestPath, JSON.stringify({ ...original, daemonEntry: "../../outside.js" }));
    await expect(installDesktopRuntimeStage(stage, resources)).rejects.toThrow("desktop_resources_manifest_invalid");
    await writeFile(manifestPath, JSON.stringify(original));
    await installDesktopRuntimeStage(stage, resources);
    await expect(installDesktopRuntimeStage(stage, resources)).rejects.toThrow("desktop_resources_target_exists");
  });

  it("requires the explicitly pinned Node runtime before assembling a package", async () => {
    await expect(assembleDesktopRuntime(join(await fixture(), "resources"), "")).rejects.toThrow("desktop_resources_node_required");
  });
  it("enforces an Agent-free runtime and a measured non-Node resource budget", async () => {
    const root = await fixture(), stage = await runtimeStage(root), path = join(stage, "runtime-manifest.json");
    expect(await auditDesktopRuntime(stage)).toMatchObject({ bundledAgentExecutables: false, budgetBytes: 40 * 1024 * 1024 });
    await expect(auditDesktopRuntime(stage, 1)).rejects.toThrow("desktop_runtime_budget_exceeded");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, packages: [...manifest.packages, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64"] }));
    await expect(auditDesktopRuntime(stage)).rejects.toThrow("desktop_bundled_agent_forbidden");
    await writeFile(path, JSON.stringify({ ...manifest, packages: [...manifest.packages, "node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64"] }));
    await expect(auditDesktopRuntime(stage)).rejects.toThrow("desktop_bundled_agent_forbidden");
  });
});
