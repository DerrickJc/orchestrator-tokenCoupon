// Assemble installed production files without workspace symlinks, source or test fixtures.
// This is an unpacked development stage, not a signed installer or cross-platform dependency build.
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeDependencies, runtimeFileAllowed } from "./runtime-dependencies.mjs";

export function validateBundledNodeIdentity(identity, platform = process.platform, arch = process.arch) {
  if (!identity || identity.platform !== platform) {
    throw new Error(`runtime_node_platform_invalid：随包 Node 平台必须为 ${platform}`);
  }
  if (identity.arch !== arch) {
    throw new Error(`runtime_node_arch_invalid：随包 Node 架构必须为 ${arch}`);
  }
}

export function validateDesktopBuildIdentity(identity, applicationVersion, expectedBuildId = process.env.TOKEN_COUPON_BUILD_ID?.trim()) {
  if (!identity || identity.format !== 1 || identity.applicationVersion !== applicationVersion ||
      typeof identity.buildId !== "string" || identity.buildId.length === 0 || identity.buildId.length > 120 || !/^[a-zA-Z0-9._+-]+$/.test(identity.buildId)) {
    throw new Error("runtime_build_info_invalid：daemon 构建身份缺失或与应用版本不匹配");
  }
  if (expectedBuildId && identity.buildId !== expectedBuildId) {
    throw new Error("runtime_build_id_mismatch：daemon 构建身份与当前发布标识不一致");
  }
  return { applicationVersion: identity.applicationVersion, buildId: identity.buildId };
}

export async function stageDesktopRuntime(source = fileURLToPath(new URL("../", import.meta.url)), bundledNode = process.env.TOKEN_COUPON_BUNDLED_NODE) {
  source = await realpath(source);
  const application = JSON.parse(await readFile(join(source, "packages/client/package.json"), "utf8"));
  const buildInfo = JSON.parse(await readFile(join(source, "packages/daemon/dist/build-info.json"), "utf8"));
  const buildIdentity = validateDesktopBuildIdentity(buildInfo, application.version);
  const root = await mkdtemp(join(tmpdir(), "token-coupon-runtime-"));
  const copied = [];
  async function copy(sourcePath, destination) {
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination, { recursive: true, dereference: true, filter: async candidate => {
      const child = relative(sourcePath, candidate);
      if (child && !runtimeFileAllowed(child)) return false;
      const resolved = await realpath(candidate);
      const within = relative(source, resolved);
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("runtime_resource_outside_source");
      return true;
    } });
  }
  try {
    const closure = await runtimeDependencies(source);
    for (const dependency of closure.dependencies) {
      await copy(dependency.path, join(root, dependency.destination)); copied.push(dependency.destination);
    }
    for (const name of ["client", "core", "daemon", "web", "cli"]) {
      const from = join(source, "packages", name), destination = join(root, "node_modules", "@token-coupon", name);
      await mkdir(destination, { recursive: true });
      await copy(join(from, "package.json"), join(destination, "package.json"));
      await copy(join(from, "dist"), join(destination, "dist"));
      if (name === "core") await copy(join(from, "resources"), join(destination, "resources"));
      copied.push(`@token-coupon/${name}`);
    }
    let nodeExecutable;
    if (bundledNode !== undefined) {
      if (!bundledNode || !isAbsolute(bundledNode)) throw new Error("runtime_node_path_invalid：随包 Node.js 路径必须是绝对路径");
      const nodePath = await realpath(bundledNode);
      if (!(await lstat(nodePath)).isFile()) throw new Error("runtime_node_file_invalid：随包 Node.js 必须是普通文件");
      const version = execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
      if (version !== "v22.12.0") throw new Error(`runtime_node_version_invalid：要求 v22.12.0，实际为 ${version || "未知"}`);
      let identity;
      try {
        identity = JSON.parse(execFileSync(nodePath, ["-p", "JSON.stringify({platform:process.platform,arch:process.arch})"], { encoding: "utf8", timeout: 10_000 }).trim());
      } catch { throw new Error("runtime_node_identity_invalid：无法读取随包 Node.js 的平台与架构"); }
      validateBundledNodeIdentity(identity);
      nodeExecutable = `runtime/node${process.platform === "win32" ? ".exe" : ""}`;
      await mkdir(join(root, "runtime"), { recursive: true });
      await cp(nodePath, join(root, nodeExecutable));
    }
    const manifest = { format: 1, kind: "unpacked-development-stage", hostPlatform: process.platform, hostArch: process.arch,
      ...buildIdentity, packages: copied, skippedOptional: closure.skippedOptional,
      omittedAgentPackages: closure.omittedAgentPackages, externalAgentCommands: ["codex", "claude"],
      daemonEntry: "node_modules/@token-coupon/daemon/dist/main.js",
      ...(nodeExecutable ? { nodeExecutable } : {}),
      releaseReady: false };
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { root, ...manifest, daemonEntry: join(root, manifest.daemonEntry) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await stageDesktopRuntime()));
