import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Maintainer ESM resource script.
const { stageDesktopRuntime } = await import("../../../scripts/stage-desktop-runtime.mjs");
// @ts-expect-error Maintainer ESM dependency collector.
const { runtimeDependencies } = await import("../../../scripts/runtime-dependencies.mjs");
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-runtime-closure-")); roots.push(root);
  vi.stubEnv("TOKEN_COUPON_BUILD_ID", "fixture");
  for (const name of ["client", "core", "daemon", "web", "cli"]) {
    const dir = join(root, "packages", name); await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: `@token-coupon/${name}`, version: "0.1.0", type: "module", dependencies: name === "daemon" ? { transport: "1" } : name === "web" ? { react: "1" } : {} }));
    for (const file of ["main.js", "index.js", "index.d.ts", "index.d.mts", "index.d.cts", "main.js.map"]) await writeFile(join(dir, "dist", file), "fixture");
  }
  await mkdir(join(root, "packages/core/resources")); await writeFile(join(root, "packages/core/resources/mock-process.mjs"), "fixture");
  await writeFile(join(root, "packages/daemon/dist/build-info.json"), JSON.stringify({ format: 1, applicationVersion: "0.1.0", buildId: "fixture" }));
  async function dependency(name: string, manifest = {}) {
    const dir = join(root, "node_modules", name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1", ...manifest })); await writeFile(join(dir, "index.js"), "export default true;");
    return dir;
  }
  return { root, dependency };
}
it("ships only the runtime closure, retaining nested dependencies and licenses while excluding Agent executables and web build dependencies", async () => {
  const h = await fixture();
  const transport = await h.dependency("transport", { dependencies: { leaf: "1" }, optionalDependencies: { "@anthropic-ai/claude-agent-sdk-win32-x64": "1", "optional-missing": "1" } });
  await h.dependency("react"); await h.dependency("unused-build-tool");
  await h.dependency("@anthropic-ai/claude-agent-sdk-win32-x64");
  const nested = join(transport, "node_modules", "leaf"); await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "leaf", version: "1" })); await writeFile(join(nested, "index.js"), "export const nested=true;");
  await mkdir(join(transport, "tests")); await writeFile(join(transport, "tests", "test.js"), "not runtime");
  for (const name of ["index.d.ts", "index.d.mts", "index.d.cts", "index.js.map", "README.md", "LICENSE", ".env"]) await writeFile(join(transport, name), name);
  const stage = await stageDesktopRuntime(h.root); roots.push(stage.root);
  expect(stage.packages).toContain("node_modules/transport/node_modules/leaf");
  expect(stage.packages).not.toContain("node_modules/react"); expect(stage.packages).not.toContain("node_modules/unused-build-tool");
  expect(stage.omittedAgentPackages).toContain("@anthropic-ai/claude-agent-sdk-win32-x64");
  expect(stage.skippedOptional).toContain("optional-missing");
  expect((await readdir(join(stage.root, "node_modules/transport"))).sort()).toEqual(["LICENSE", "README.md", "index.js", "node_modules", "package.json"]);
  expect(await readFile(join(stage.root, "node_modules/transport/node_modules/leaf/index.js"), "utf8")).toContain("nested");
  expect((await readdir(join(stage.root, "node_modules/@token-coupon/core/dist"))).sort()).toEqual(["index.js", "main.js"]);
});
it("rejects a missing required dependency instead of emitting a broken package", async () => {
  const h = await fixture(); await expect(runtimeDependencies(h.root)).rejects.toThrow("runtime_dependency_missing");
});
it.skipIf(process.platform === "win32")("refuses dependency links that escape the source tree", async () => {
  const h = await fixture(), outside = await fixture();
  await mkdir(join(h.root, "node_modules")); await symlink(join(outside.root, "packages/client"), join(h.root, "node_modules/transport"));
  await expect(runtimeDependencies(h.root)).rejects.toThrow("runtime_resource_outside_source");
});
