import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDevelopmentDaemonRuntime, resolvePackagedDaemonRuntime } from "../src/daemon-runtime.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-desktop-runtime-"));
  roots.push(root);
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("desktop daemon runtime resolution", () => {
  it("resolves the staged daemon and standard Node runtime from a packaged manifest", async () => {
    const root = await fixture(), runtimeRoot = join(root, "resources", "token-coupon-runtime");
    await mkdir(join(runtimeRoot, "runtime"), { recursive: true });
    await mkdir(join(runtimeRoot, "node_modules/@token-coupon/daemon/dist"), { recursive: true });
    await writeFile(join(runtimeRoot, "runtime/node"), "node runtime");
    await chmod(join(runtimeRoot, "runtime/node"), 0o755);
    await writeFile(join(runtimeRoot, "node_modules/@token-coupon/daemon/dist/main.js"), "");
    await writeFile(join(runtimeRoot, "runtime-manifest.json"), JSON.stringify({
      format: 1, daemonEntry: "node_modules/@token-coupon/daemon/dist/main.js", nodeExecutable: "runtime/node",
    }));

    expect(resolvePackagedDaemonRuntime(join(root, "resources"))).toEqual({
      nodeExecutable: join(runtimeRoot, "runtime/node"),
      daemonEntry: join(runtimeRoot, "node_modules/@token-coupon/daemon/dist/main.js"),
      workingDirectory: join(runtimeRoot, "node_modules/@token-coupon/daemon/dist"),
    });
  });

  it("rejects missing runtime metadata and paths that escape the packaged resource root", async () => {
    const root = await fixture(), resources = join(root, "resources"), runtimeRoot = join(resources, "token-coupon-runtime");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "runtime-manifest.json"), JSON.stringify({
      format: 1, daemonEntry: "../outside.js", nodeExecutable: "../node",
    }));
    await expect(() => resolvePackagedDaemonRuntime(resources)).toThrow("desktop_runtime_manifest_invalid");
    await writeFile(join(runtimeRoot, "runtime-manifest.json"), JSON.stringify({ format: 1, daemonEntry: "main.js" }));
    await expect(() => resolvePackagedDaemonRuntime(resources)).toThrow("desktop_runtime_node_missing");
  });

  it("locates the workspace daemon in development and rejects a relative Node override", async () => {
    const root = await fixture(), appPath = join(root, "packages/desktop");
    await mkdir(join(root, "packages/daemon/dist"), { recursive: true });
    await writeFile(join(root, "packages/daemon/dist/main.js"), "");
    expect(resolveDevelopmentDaemonRuntime(appPath, {})).toMatchObject({
      nodeExecutable: "node", daemonEntry: resolve(root, "packages/daemon/dist/main.js"),
    });
    expect(() => resolveDevelopmentDaemonRuntime(appPath, { TOKEN_COUPON_NODE_EXECUTABLE: "node" })).toThrow("desktop_runtime_node_path_invalid");
  });
});
