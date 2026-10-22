import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Maintainer ESM packaging script, covered through its physical output tree.
const { desktopBuilderConfiguration, prepareDesktopApp, validatePackageOptions } = await import("../../../scripts/package-desktop.mjs");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-shell-package-")); roots.push(root);
  for (const name of ["desktop", "client"]) {
    await mkdir(join(root, `packages/${name}/dist`), { recursive: true });
    await writeFile(join(root, `packages/${name}/package.json`), JSON.stringify({ name: `@token-coupon/${name}`, version: "0.1.0", type: "module",
      exports: { ".": "./dist/index.js" }, devDependencies: { electron: "44.9.1" }, scripts: { dangerous: "not packaged" } }));
  }
  for (const file of ["main.js", "preload.cjs", "token-coupon.ico", "token-coupon.png", "main.js.map", "main.d.ts"]) {
    await writeFile(join(root, "packages/desktop/dist", file), file);
  }
  await writeFile(join(root, "packages/client/dist/index.js"), "export const protocol = 1;");
  await writeFile(join(root, ".env"), "NOT_FOR_DISTRIBUTION=secret");
  return root;
}

describe("desktop preview packaging", () => {
  it("stages only the built shell and a physical client package", async () => {
    const root = await fixture(), app = join(root, "staged-app");
    const result = await prepareDesktopApp(root, app);
    expect((await readdir(app)).sort()).toEqual(["dist", "node_modules", "package.json"]);
    expect((await readdir(join(app, "dist"))).sort()).toEqual(["main.js", "preload.cjs", "token-coupon.ico", "token-coupon.png"]);
    expect(JSON.parse(await readFile(join(app, "package.json"), "utf8"))).toMatchObject({ type: "module", main: "dist/main.js", dependencies: { "@token-coupon/client": "0.1.0" } });
    const client = JSON.parse(await readFile(join(app, "node_modules/@token-coupon/client/package.json"), "utf8"));
    expect(client).not.toHaveProperty("scripts");
    expect(await readFile(join(app, "node_modules/@token-coupon/client/dist/index.js"), "utf8")).toContain("protocol");
    expect(result.electronVersion).toBe("44.9.1");
    await expect(prepareDesktopApp(root, app)).rejects.toThrow();
  });

  it("rejects version mismatches and cross-host installer targets", async () => {
    const root = await fixture();
    await writeFile(join(root, "packages/client/package.json"), JSON.stringify({ version: "0.2.0" }));
    await expect(prepareDesktopApp(root, join(root, "app"))).rejects.toThrow("desktop_package_version_mismatch");
    expect(() => validatePackageOptions({ outputDirectory: "relative", platform: "win32" })).toThrow("desktop_package_output_invalid");
    expect(() => validatePackageOptions({ outputDirectory: root, platform: "linux", mode: "installer" })).toThrow("desktop_installer_windows_required");
    expect(() => validatePackageOptions({ outputDirectory: root, platform: "win32", mode: "installer", arch: "x64" })).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects symlinks in shell output", async () => {
    const root = await fixture();
    await symlink(join(root, ".env"), join(root, "packages/desktop/dist/leaked.json"));
    await expect(prepareDesktopApp(root, join(root, "app"))).rejects.toThrow("desktop_package_symlink_rejected");
  });

  it("keeps runtime resources outside ASAR, disables publication and preserves user data", () => {
    const config = desktopBuilderConfiguration({ appDirectory: "/app", outputDirectory: "/out", resourcesDirectory: "/stage", electronVersion: "44.9.1" });
    expect(config.asar).toBe(true);
    expect(config.electronLanguages).toEqual(["en-US", "zh-CN"]);
    // Runtime resources are copied atomically by afterPack, outside builder's node_modules filters.
    expect(config.extraResources).toBeUndefined();
    expect(config.publish).toBeNull();
    expect(config.npmRebuild).toBe(false);
    expect(config.nsis).toMatchObject({ perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false, runAfterFinish: false });
    expect(config.win.requestedExecutionLevel).toBe("asInvoker");
  });
});
