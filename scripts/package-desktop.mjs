// Native-host preview packaging. Publishing and cross-platform dependency reuse are disabled.
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleDesktopRuntime, installDesktopRuntimeStage, smokeDesktopResources } from "./assemble-desktop-resources.mjs";
import { auditDesktopRuntime } from "./desktop-size-audit.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

export function validatePackageOptions({ outputDirectory, mode = "dir", platform = process.platform, arch = process.arch }) {
  if (!isAbsolute(outputDirectory ?? "")) throw new Error("desktop_package_output_invalid：输出目录必须是绝对路径");
  if (!["dir", "installer"].includes(mode)) throw new Error("desktop_package_mode_invalid：只支持 dir 或 installer");
  if (!["linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("desktop_package_target_unsupported：预览打包仅支持本机 Windows/Linux x64 或 arm64");
  if (mode === "installer" && platform !== "win32") throw new Error("desktop_installer_windows_required：Windows 安装包须在原生 Windows 上构建；本机可先使用 --mode dir");
}

async function copyBuiltFiles(source, destination) {
  await cp(source, destination, { recursive: true, dereference: false, filter: async candidate => {
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink()) throw new Error("desktop_package_symlink_rejected：桌面构建产物不能包含符号链接");
    return entry.isDirectory() || /\.(?:js|cjs|json|png|ico)$/.test(candidate);
  } });
}

/** Prepare a small application tree with physical client dependencies, never the workspace root. */
export async function prepareDesktopApp(source, destination) {
  const project = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const desktop = JSON.parse(await readFile(join(source, "packages/desktop/package.json"), "utf8"));
  const client = JSON.parse(await readFile(join(source, "packages/client/package.json"), "utf8"));
  if (desktop.version !== client.version) throw new Error("desktop_package_version_mismatch：桌面与共享客户端版本不一致");
  if (!project.license || project.license === "UNLICENSED") throw new Error("desktop_package_license_missing：请先确定项目许可证");
  await mkdir(destination);
  for (const file of ["LICENSE", "NOTICE"]) await cp(join(source, file), join(destination, file));
  await copyBuiltFiles(join(source, "packages/desktop/dist"), join(destination, "dist"));
  for (const required of ["main.js", "preload.cjs", "token-coupon.ico", "token-coupon.png"]) {
    if (!(await stat(join(destination, "dist", required))).isFile()) throw new Error(`desktop_package_file_missing：缺少 ${required}`);
  }
  const clientRoot = join(destination, "node_modules/@token-coupon/client");
  await mkdir(clientRoot, { recursive: true });
  await copyBuiltFiles(join(source, "packages/client/dist"), join(clientRoot, "dist"));
  for (const file of ["LICENSE", "NOTICE"]) await cp(join(source, file), join(clientRoot, file));
  await writeFile(join(clientRoot, "package.json"), JSON.stringify({ name: client.name, version: client.version, type: client.type, exports: client.exports, license: project.license }, null, 2));
  const manifest = { name: "token-coupon-desktop", productName: "orchestrator-tokenCoupon", version: desktop.version,
    description: "Local task planning, execution and review desktop preview", type: "module", main: "dist/main.js", private: true,
    license: project.license, dependencies: { "@token-coupon/client": client.version } };
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, electronVersion: desktop.devDependencies.electron };
}

export function desktopBuilderConfiguration({ appDirectory, outputDirectory, electronVersion, electronDist }) {
  return {
    appId: "org.token-coupon.desktop", productName: "orchestrator-tokenCoupon", electronVersion,
    directories: { app: appDirectory, output: outputDirectory },
    files: ["dist/**/*", "node_modules/@token-coupon/client/**/*", "package.json", "LICENSE", "NOTICE"],
    // No automatic updater is shipped: optimize the full NSIS payload rather than a differential block map.
    compression: "maximum",
    asar: true, npmRebuild: false, nodeGypRebuild: false, forceCodeSigning: false, publish: null,
    electronLanguages: ["en-US", "zh-CN"],
    ...(electronDist ? { electronDist } : {}),
    win: { icon: join(appDirectory, "dist/token-coupon.ico"), requestedExecutionLevel: "asInvoker", signAndEditExecutable: false },
    nsis: { license: join(appDirectory, "LICENSE"), differentialPackage: false, shortcutName: "orchestrator-tokenCoupon", uninstallDisplayName: "orchestrator-tokenCoupon", oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false, runAfterFinish: false, artifactName: "Token-Coupon-${version}-${arch}-preview-setup.${ext}" },
    linux: { executableName: "token-coupon", category: "Development", icon: join(appDirectory, "dist/token-coupon.png") },
  };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function packageDesktop({ outputDirectory, mode = "dir", bundledNode = process.env.TOKEN_COUPON_BUNDLED_NODE, electronDist }) {
  validatePackageOptions({ outputDirectory, mode });
  if (!bundledNode) throw new Error("desktop_resources_node_required：设置 TOKEN_COUPON_BUNDLED_NODE 为本机 Node 22.12.0 可执行文件");
  if (electronDist) {
    if (!isAbsolute(electronDist)) throw new Error("desktop_electron_dist_invalid：Electron 目录必须是绝对路径");
    electronDist = await realpath(electronDist);
  }
  await mkdir(dirname(outputDirectory), { recursive: true });
  try { await mkdir(outputDirectory); }
  catch (error) { if (error.code === "EEXIST") throw new Error("desktop_package_output_exists：输出目录已存在，请选择新的专用打包目录"); throw error; }
  const temporary = await mkdtemp(join(tmpdir(), "token-coupon-desktop-package-"));
  try {
    const appDirectory = join(temporary, "app"), resourcesDirectory = join(temporary, "resources");
    const shell = await prepareDesktopApp(repository, appDirectory);
    if (electronDist && (await readFile(join(electronDist, "version"), "utf8")).trim().replace(/^v/, "") !== shell.electronVersion) {
      throw new Error("desktop_electron_version_mismatch：Electron 目录与固定版本不匹配");
    }
    console.log("准备随包 Node、daemon 与生产依赖…");
    const runtime = await assembleDesktopRuntime(resourcesDirectory, bundledNode);
    const { build, Platform, Arch } = await import("electron-builder");
    const smokeResults = [];
    const configuration = desktopBuilderConfiguration({ appDirectory, outputDirectory, electronVersion: shell.electronVersion, electronDist });
    configuration.afterPack = async context => {
      const resources = join(context.appOutDir, "resources");
      if (!(await stat(join(resources, "app.asar"))).isFile()) throw new Error("desktop_package_shell_missing：Electron 包缺少 app.asar");
      // Builder's application file filters prune node_modules; preserve the entire isolated daemon tree.
      await installDesktopRuntimeStage(runtime.directory, resources);
      console.log("验证最终桌面包内的 daemon 与构建身份…");
      const size = await auditDesktopRuntime(join(resources, "token-coupon-runtime"));
      const smoke = await smokeDesktopResources(resources);
      smokeResults.push({ directory: relative(outputDirectory, context.appOutDir), result: JSON.parse(smoke.output), size });
    };
    const artifacts = await build({ projectDir: appDirectory, targets: Platform.current().createTarget(mode === "installer" ? "nsis" : "dir", Arch[process.arch]),
      config: configuration, publish: "never" });
    const report = { format: 1, applicationVersion: shell.manifest.version, buildId: runtime.manifest.buildId,
      platform: process.platform, arch: process.arch, electronVersion: shell.electronVersion, mode, installerCompression: { requested: configuration.compression, differentialPackage: configuration.nsis.differentialPackage, automaticUpdates: false }, signed: false, releaseReady: false,
      runtimeSmoke: smokeResults, artifacts: [] };
    for (const artifact of artifacts) {
      const path = relative(outputDirectory, artifact);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("desktop_package_artifact_outside_output");
      report.artifacts.push({ path, bytes: (await stat(artifact)).size, sha256: await hashFile(artifact) });
    }
    await writeFile(join(outputDirectory, "desktop-build.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ outputDirectory, ...report }));
    return report;
  } catch (error) {
    throw new Error(`desktop_package_failed：${error.message}；本次输出保留于 ${outputDirectory}`, { cause: error });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = {};
  const flags = { "--output": "outputDirectory", "--mode": "mode", "--node": "bundledNode", "--electron-dist": "electronDist" };
  for (let index = 2; index < process.argv.length; index++) {
    const key = flags[process.argv[index]], value = process.argv[++index];
    if (!key || !value || value.startsWith("--") || options[key] !== undefined) throw new Error("用法：desktop:package [--mode dir|installer] [--output <新绝对目录>] [--node <Node 22.12.0>] [--electron-dist <本机 Electron 目录>]");
    options[key] = value;
  }
  options.outputDirectory ??= resolve(repository, ".token-coupon/builds", `desktop-${process.platform}-${process.arch}-${Date.now()}`);
  await packageDesktop(options);
}
