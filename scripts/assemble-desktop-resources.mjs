// Prepare the daemon runtime directory expected under Electron process.resourcesPath.
// This creates extraResources only; it does not create or sign an installer.
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageDesktopRuntime, validateDesktopBuildIdentity } from "./stage-desktop-runtime.mjs";

function inside(root, candidate) {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function checkedFile(root, value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`desktop_resources_manifest_invalid：${label} 必须是运行时目录内的相对路径`);
  }
  const candidate = resolve(root, value);
  if (!inside(root, candidate)) throw new Error(`desktop_resources_manifest_invalid：${label} 超出运行时目录`);
  let actual;
  try { actual = await realpath(candidate); } catch { throw new Error(`desktop_resources_file_missing：找不到 ${label}`); }
  if (!inside(root, actual) || !(await stat(actual)).isFile()) throw new Error(`desktop_resources_file_invalid：${label} 不是运行时目录中的普通文件`);
  return actual;
}

/** Atomically installs a previously verified runtime stage as Electron extraResources. */
export async function installDesktopRuntimeStage(stageRoot, resourcesDirectory) {
  if (!isAbsolute(resourcesDirectory)) throw new Error("desktop_resources_path_invalid：Electron resources 目录必须是绝对路径");
  const sourceRoot = await realpath(stageRoot), manifestPath = join(sourceRoot, "runtime-manifest.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { throw new Error("desktop_resources_manifest_missing：运行时暂存目录没有有效 manifest"); }
  if (!manifest || manifest.format !== 1 || !manifest.packages || !Array.isArray(manifest.packages)) {
    throw new Error("desktop_resources_manifest_invalid：运行时清单格式无效");
  }
  if (!manifest.nodeExecutable) throw new Error("desktop_resources_node_required：打包桌面运行时前必须提供受支持的标准 Node.js");
  await checkedFile(sourceRoot, manifest.daemonEntry, "daemonEntry");
  await checkedFile(sourceRoot, manifest.nodeExecutable, "nodeExecutable");

  const resourcesRoot = resolve(resourcesDirectory);
  await mkdir(resourcesRoot, { recursive: true });
  const target = join(resourcesRoot, "token-coupon-runtime");
  try { await lstat(target); throw new Error("desktop_resources_target_exists：目标运行时目录已存在；请先清理本次专用打包输出目录"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const staging = await mkdtemp(join(resourcesRoot, ".token-coupon-runtime-"));
  try {
    await cp(sourceRoot, staging, { recursive: true, dereference: true });
    const copiedManifestPath = join(staging, "runtime-manifest.json");
    const copiedManifest = JSON.parse(await readFile(copiedManifestPath, "utf8"));
    copiedManifest.kind = "electron-extra-resource";
    copiedManifest.runtimeReady = true;
    copiedManifest.releaseReady = false;
    await writeFile(copiedManifestPath, `${JSON.stringify(copiedManifest, null, 2)}\n`, { flag: "w", mode: 0o600 });
    await rename(staging, target);
    return { directory: target, manifest: copiedManifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function assembleDesktopRuntime(resourcesDirectory, bundledNode = process.env.TOKEN_COUPON_BUNDLED_NODE) {
  if (!bundledNode) throw new Error("desktop_resources_node_required：请设置 TOKEN_COUPON_BUNDLED_NODE 为目标平台的受支持 Node.js v22.12.0 可执行文件");
  const stage = await stageDesktopRuntime(fileURLToPath(new URL("../", import.meta.url)), bundledNode);
  try { return await installDesktopRuntimeStage(stage.root, resourcesDirectory); }
  finally { await rm(stage.root, { recursive: true, force: true }); }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** Validate the daemon actually copied into an Electron application's resources. */
export async function smokeDesktopResources(resourcesDirectory) {
  const directory = await realpath(join(resourcesDirectory, "token-coupon-runtime"));
  const manifest = JSON.parse(await readFile(join(directory, "runtime-manifest.json"), "utf8"));
  const identity = validateDesktopBuildIdentity(manifest, manifest.applicationVersion);
  const nodeExecutable = await checkedFile(directory, manifest.nodeExecutable, "nodeExecutable");
  const daemonEntry = await checkedFile(directory, manifest.daemonEntry, "daemonEntry");
  const smokeScript = fileURLToPath(new URL("./desktop-daemon-smoke.mjs", import.meta.url));
  let smokeOutput;
  try {
    smokeOutput = execFileSync(nodeExecutable, [smokeScript, "--entry", daemonEntry,
      "--expected-build-id", identity.buildId, "--expected-version", identity.applicationVersion], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const diagnostic = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr ?? error.message ?? error);
    throw new Error(`desktop_runtime_smoke_failed：暂存资源已保留供排查；${diagnostic.slice(-2000)}`);
  }
  return { manifest, output: smokeOutput };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resourcesDirectory = option("--resources-dir") ?? process.env.TOKEN_COUPON_ELECTRON_RESOURCES;
  if (!resourcesDirectory) throw new Error("desktop_resources_path_required：请传入 --resources-dir <Electron resources 绝对路径> 或设置 TOKEN_COUPON_ELECTRON_RESOURCES");
  const result = await assembleDesktopRuntime(resourcesDirectory, option("--node") ?? process.env.TOKEN_COUPON_BUNDLED_NODE);
  process.stdout.write((await smokeDesktopResources(resourcesDirectory)).output);
  console.log(JSON.stringify({ directory: result.directory, hostPlatform: result.manifest.hostPlatform, hostArch: result.manifest.hostArch,
    nodeExecutable: result.manifest.nodeExecutable, runtimeReady: result.manifest.runtimeReady, installerReady: false }));
}
