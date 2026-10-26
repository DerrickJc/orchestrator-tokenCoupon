import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { networkFetch, networkErrorCode } from "./network-fetch.js";

const execute = promisify(execFile);
export const CLOUDFLARED_VERSION = "2026.10.0";
export interface ComponentAsset { name: string; sha256: string; bytes: number; archive?: boolean; }
// Pinned official GitHub release asset digests, not a runtime "latest" download.
const ASSETS: Record<string, ComponentAsset> = {
  "linux-x64": { name: "cloudflared-linux-amd64", sha256: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db", bytes: 40129756 },
  "linux-arm64": { name: "cloudflared-linux-arm64", sha256: "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08", bytes: 37687584 },
  "win32-x64": { name: "cloudflared-windows-amd64.exe", sha256: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c", bytes: 55365048 },
  "darwin-x64": { name: "cloudflared-darwin-amd64.tgz", sha256: "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f", bytes: 21741581, archive: true },
  "darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", sha256: "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70", bytes: 19809074, archive: true },
};
export interface ComponentInfo { executable: string; version: string; source: "existing" | "managed"; }
export type ComponentStage = "checking" | "downloading" | "verifying";
export interface ComponentProvider { get(signal: AbortSignal, stage: (stage: ComponentStage) => void): Promise<ComponentInfo>; }

export class CloudflaredComponent implements ComponentProvider {
  constructor(private readonly dataDirectory: string, private readonly explicitPath = process.env.TOKEN_COUPON_CLOUDFLARED_PATH) {}

  async get(signal: AbortSignal, stage: (stage: ComponentStage) => void): Promise<ComponentInfo> {
    stage("checking"); signal.throwIfAborted();
    const existing = this.explicitPath || await findExecutable();
    if (existing) {
      if (this.explicitPath && !isAbsolute(existing)) throw new Error("component_path_invalid：高级配置的 cloudflared 路径必须是绝对路径");
      return { executable: existing, version: await binaryVersion(existing, signal), source: "existing" };
    }
    const target = `${process.platform}-${process.arch}`, asset = ASSETS[target];
    if (!asset) throw new Error("component_platform_unsupported：请安装本平台官方 cloudflared，或设置 TOKEN_COUPON_CLOUDFLARED_PATH");
    const directory = join(this.dataDirectory, "components", "cloudflared", CLOUDFLARED_VERSION, target);
    const executable = join(directory, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    try {
      const manifest = JSON.parse(await readFile(join(directory, "installed.json"), "utf8")) as { archiveSha256: string; binarySha256: string };
      const file = await lstat(executable);
      if (!file.isFile() || file.isSymbolicLink() || manifest.archiveSha256 !== asset.sha256 || !/^[a-f0-9]{64}$/.test(manifest.binarySha256) || await fileDigest(executable) !== (asset.archive ? manifest.binarySha256 : asset.sha256)) throw new Error("component_integrity_failed：缓存组件校验失败，请移除应用组件缓存后重试");
      await ensureCloudflaredLicense(directory);
      return { executable, version: await binaryVersion(executable, signal), source: "managed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    stage("downloading");
    await installCloudflared(directory, asset, signal, () => stage("verifying"));
    const version = await binaryVersion(executable, signal);
    if (!version.includes(CLOUDFLARED_VERSION)) throw new Error("component_version_invalid：下载组件的版本与固定发布不一致");
    return { executable, version, source: "managed" };
  }
}

/** Downloads only a pinned release and never executes an unverified download. */
export async function installCloudflared(directory: string, asset: ComponentAsset, signal: AbortSignal, verifying: () => void, fetcher: typeof fetch = networkFetch): Promise<void> {
  const temporary = join(directory, `.install-${randomUUID()}`);
  let stage: "prepare" | "download" | "install" = "prepare";
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    await ensureCloudflaredLicense(temporary);
    const download = join(temporary, "download");
    const timeout = AbortSignal.timeout(120_000);
    stage = "download";
    const response = await fetcher(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`, { signal: AbortSignal.any([signal, timeout]) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`component_download_failed：官方下载返回 HTTP ${response.status}；请检查 GitHub 下载访问及代理认证`);
    }
    const file = await open(download, "wx", 0o600), hash = createHash("sha256"); let bytes = 0;
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > asset.bytes) throw new Error("component_download_too_large：下载大小超过固定发布");
        hash.update(chunk); await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    verifying(); signal.throwIfAborted();
    if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("component_integrity_failed：官方组件 SHA-256 或大小校验失败，未安装或执行");
    stage = "install";
    let binary = download;
    if (asset.archive) {
      // macOS has /usr/bin/tar. The archive is checksum-verified before parsing.
      const listing = await execute("/usr/bin/tar", ["-tzf", download], { signal, timeout: 10_000, maxBuffer: 8192 });
      const names = listing.stdout.trim().split("\n");
      if (names.length !== 1 || !["cloudflared", "./cloudflared"].includes(names[0]!)) throw new Error("component_archive_invalid：组件归档必须只包含 cloudflared");
      await execute("/usr/bin/tar", ["-xzf", download, "-C", temporary], { signal, timeout: 10_000, maxBuffer: 8192 });
      binary = join(temporary, "cloudflared");
    }
    const info = await lstat(binary);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("component_archive_invalid：组件不是普通文件");
    const binarySha256 = await fileDigest(binary);
    await chmod(binary, 0o700); signal.throwIfAborted();
    const executable = join(directory, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    await rename(binary, executable);
    await rename(join(temporary, "LICENSE"), join(directory, "LICENSE"));
    await writeFile(join(directory, "THIRD_PARTY_NOTICE.txt"), "cloudflared by Cloudflare, Inc. — Apache-2.0\nSource: https://github.com/cloudflare/cloudflared\nLicense: https://github.com/cloudflare/cloudflared/blob/main/LICENSE\n", { mode: 0o600 });
    // Publish the completion marker only after all required resources exist.
    await writeFile(join(directory, "installed.json"), JSON.stringify({ version: CLOUDFLARED_VERSION, archiveSha256: asset.sha256, binarySha256 }) + "\n", { mode: 0o600 });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("component_")) throw error;
    const code = networkErrorCode(error);
    if (["EACCES", "EPERM"].includes(code ?? "")) throw new Error(`component_permission_denied：组件${stage === "download" ? "下载连接或文件写入" : "缓存目录写入"}被拒绝（${code}）；请检查网络策略和缓存目录权限`);
    if (code === "ENOSPC") throw new Error("component_disk_full：组件缓存目录空间不足，请清理磁盘后重试");
    if (stage !== "download") throw new Error(`component_install_failed：组件安装失败${code ? `（${code}）` : ""}；请检查缓存目录权限和应用许可资源是否完整`);
    throw new Error(`component_download_failed：官方下载连接失败${code ? `（${code}）` : ""}；应用会读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY，请检查代理是否可达及 GitHub 下载网络`);
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
}

/** Also repairs caches written by old installers before their license copy failed. */
export async function ensureCloudflaredLicense(directory: string): Promise<void> {
  let license: Buffer;
  try { license = await readFile(new URL("../THIRD_PARTY_LICENSES/cloudflared-LICENSE", import.meta.url)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("component_license_missing：应用缺少 cloudflared 许可资源，请更新应用安装包后重试");
    throw error;
  }
  const target = join(directory, "LICENSE");
  try {
    const info = await lstat(target);
    if (info.isFile() && !info.isSymbolicLink() && (await readFile(target)).equals(license)) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(directory, `.license-${randomUUID()}`);
  try { await writeFile(temporary, license, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

async function binaryVersion(executable: string, signal: AbortSignal): Promise<string> {
  try {
    const result = await execute(executable, ["--version"], { signal, timeout: 5000, maxBuffer: 8192, windowsHide: true });
    const version = result.stdout.trim();
    if (!/^cloudflared version \d{4}\.\d+\.\d+/.test(version)) throw new Error("invalid version");
    return version.slice(0, 160);
  } catch { signal.throwIfAborted(); throw new Error("component_unavailable：检测到 cloudflared，但无法执行版本检查；请更新组件或指定官方可执行文件"); }
}
async function findExecutable(): Promise<string | undefined> {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isFile()) return candidate; } catch { /* next PATH entry */ }
  }
  return undefined;
}
async function fileDigest(path: string): Promise<string> {
  const handle = await open(path, "r"); const hash = createHash("sha256");
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest("hex");
}
