import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";
import { createClient, daemonChallengePayload, type DaemonChallenge } from "./index.js";

const execFile = promisify(execFileCallback);
export type DaemonOwnerCredential = {
  token: string;
  owner: { pid: number; hostname: string; platform: string; processStart: string; port?: number };
};
export interface DaemonAttachment {
  origin: string; port: number; epoch: string; profileId: string;
  protocol: { major: number; minor: number }; applicationVersion: string; buildId: string;
}
function powershellPath(): string {
  return join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function encodedPowerShell(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

async function assertPrivateWindowsPath(filePath: string, directory: string): Promise<void> {
  const encodedFile = Buffer.from(filePath, "utf8").toString("base64");
  const encodedDirectory = Buffer.from(directory, "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'
$file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFile}'))
$dir=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}'))
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed=@($current,'S-1-5-18','S-1-5-32-544')
$directoryDanger=0xD0040
function sidOf($identity) { try { if ($identity -is [Security.Principal.IdentityReference]) { return $identity.Translate([Security.Principal.SecurityIdentifier]).Value }; return ([Security.Principal.NTAccount]::new([string]$identity)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return '' } }
function safeFile($path) {
  $item=Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $acl=Get-Acl -LiteralPath $path
  if ((sidOf $acl.Owner) -notin $allowed) { return $false }
  foreach($rule in $acl.Access) { $sid=sidOf $rule.IdentityReference; if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowed) { return $false } }
  return $true
}
function safeDirectory($path) {
  $item=Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $acl=Get-Acl -LiteralPath $path
  foreach($rule in $acl.Access) { $sid=sidOf $rule.IdentityReference; if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowed -and (([int]$rule.FileSystemRights -band $directoryDanger) -ne 0)) { return $false } }
  return $true
}
try {
  $stage='owner-file'
  if (-not (safeFile $file)) { exit 4 }
  $cursor=Get-Item -LiteralPath $dir -Force
  $depth=0
  while ($null -ne $cursor -and $null -ne $cursor.Parent) {
    $stage='directory-depth='+$depth
    if (-not (safeDirectory $cursor.FullName)) { [Console]::Out.Write($stage); exit 5 }
    $cursor=$cursor.Parent; $depth++
  }
  [Console]::Out.Write('private')
} catch { [Console]::Out.Write('acl-probe-error='+$stage+';'+$_.Exception.GetType().Name); exit 6 }`;
  try {
    const result = await execFile(powershellPath(), encodedPowerShell(script), { windowsHide: true, timeout: 8000, maxBuffer: 4096 });
    if (result.stdout.trim() !== "private") throw new Error("daemon_discovery_profile_unprotected：Windows owner 文件 ACL 校验未返回可信结果");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("daemon_discovery_")) throw error;
    const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unknown";
    const output = error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    const depth = output.match(/directory-depth=(\d+)/)?.[1];
    const probeError = output.match(/acl-probe-error=([a-z-]+);([A-Za-z]+)/);
    const reason = code === "4" ? "owner 文件 ACL 对其他用户开放" : code === "5" ? `profile 目录链允许其他用户替换${depth ? `（父目录层级 ${depth}）` : ""}`
      : code === "6" && probeError ? `Windows ACL 检查失败（${probeError[1]}，${probeError[2]}）` : "Windows ACL 查询失败";
    throw new Error(`daemon_discovery_profile_unprotected：${reason}，拒绝信任本机后台`);
  }
}

async function assertPrivatePosixDirectory(directory: string): Promise<void> {
  if (process.platform !== "linux") throw new Error("daemon_discovery_platform_unsupported：当前仅支持核验 Linux 本机 owner 文件权限");
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (userId === undefined) throw new Error("daemon_discovery_user_unknown：无法核验 owner 文件所有者");
  let cursor = directory;
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("daemon_discovery_profile_unprotected：owner 文件目录不能是链接");
    const sticky = (info.mode & 0o1000) !== 0;
    const writableByOthers = (info.mode & 0o022) !== 0;
    if (writableByOthers && !sticky) throw new Error("daemon_discovery_profile_unprotected：owner 文件父目录允许其他用户写入");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function parseCredential(raw: string): DaemonOwnerCredential {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("daemon_discovery_owner_invalid：后台 owner 文件无效"); }
  if (!value || typeof value !== "object") throw new Error("daemon_discovery_owner_invalid：后台 owner 文件无效");
  const record = value as Record<string, unknown>;
  const owner = record;
  if (typeof record.token !== "string" || !/^[0-9a-f-]{36}$/i.test(record.token) || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 ||
      typeof owner.hostname !== "string" || !owner.hostname || owner.platform !== process.platform || typeof owner.processStart !== "string" || !/^\d+$/.test(owner.processStart)) {
    throw new Error("daemon_discovery_owner_invalid：后台 owner 身份缺少有效 token、平台或进程启动标识");
  }
  if (owner.port !== undefined && (!Number.isSafeInteger(owner.port) || (owner.port as number) < 1024 || (owner.port as number) > 65535)) throw new Error("daemon_discovery_owner_invalid：后台 owner 记录中的端口无效");
  return { token: record.token as string, owner: { pid: record.pid as number, hostname: owner.hostname as string, platform: owner.platform as string, processStart: owner.processStart as string, ...(owner.port === undefined ? {} : { port: owner.port as number }) } };
}

/** Reads the daemon's HMAC key only after checking the owner file and profile permissions. */
export async function readDaemonOwnerCredential(dataDirectory = join(homedir(), ".token-coupon", "daemon")): Promise<DaemonOwnerCredential> {
  const directory = await realpath(dataDirectory);
  const filePath = join(directory, "daemon-owner.json");
  if (process.platform === "win32") await assertPrivateWindowsPath(filePath, directory);
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0)));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384) throw new Error("daemon_discovery_owner_invalid：后台 owner 文件类型或大小无效");
    if (process.platform !== "win32") {
      const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (userId === undefined || info.uid !== userId || (info.mode & 0o077) !== 0) throw new Error("daemon_discovery_profile_unprotected：owner 文件必须由当前用户独占");
      await assertPrivatePosixDirectory(directory);
    }
    return parseCredential(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function assertOwnerIsRunning(owner: DaemonOwnerCredential["owner"]): Promise<void> {
  try { process.kill(owner.pid, 0); }
  catch { throw new Error("daemon_discovery_owner_inactive：后台 owner 进程不存在或不可核验"); }
  let start: string | undefined;
  if (process.platform === "linux") {
    try { const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8"); start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]; } catch { /* Fail closed below. */ }
  } else if (process.platform === "win32") {
    const script = `[Console]::Out.Write([Diagnostics.Process]::GetProcessById(${owner.pid}).StartTime.ToUniversalTime().Ticks.ToString())`;
    try { start = (await execFile(powershellPath(), encodedPowerShell(script), { windowsHide: true, timeout: 5000, maxBuffer: 4096 })).stdout.trim(); } catch { /* Fail closed below. */ }
  }
  if (!start || start !== owner.processStart || owner.hostname !== hostname()) throw new Error("daemon_discovery_owner_changed：后台 PID、主机或启动身份与 owner 记录不一致");
}

/** Verifies a nonce-bound daemon proof and confirms its PID has not exited or been reused. */
export async function verifyDaemonChallenge(challenge: DaemonChallenge, credential: DaemonOwnerCredential, expected: { nonce: string; origin: string; profileId?: string; nowMs?: number }): Promise<void> {
  let origin: URL;
  try { origin = new URL(expected.origin); } catch { throw new Error("daemon_discovery_origin_invalid"); }
  if (!challenge || typeof challenge !== "object" || !challenge.owner || typeof challenge.owner !== "object" || !challenge.protocol || typeof challenge.protocol !== "object" ||
      typeof challenge.nonce !== "string" || typeof challenge.origin !== "string" || typeof challenge.host !== "string" || !Number.isSafeInteger(challenge.port) ||
      typeof challenge.issuedAt !== "string" || typeof challenge.epoch !== "string" || typeof challenge.profileId !== "string" ||
      typeof challenge.applicationVersion !== "string" || typeof challenge.buildId !== "string" || typeof challenge.proof !== "string" ||
      !Number.isSafeInteger(challenge.owner.pid) || typeof challenge.owner.hostname !== "string" || typeof challenge.owner.platform !== "string" || typeof challenge.owner.processStart !== "string" ||
      !Number.isSafeInteger(challenge.protocol.major) || !Number.isSafeInteger(challenge.protocol.minor)) {
    throw new Error("daemon_discovery_proof_invalid：后台挑战字段无效");
  }
  const now = expected.nowMs ?? Date.now(), issuedAt = Date.parse(challenge.issuedAt);
  if (challenge.format !== 1 || challenge.nonce !== expected.nonce || !/^[0-9a-f]{64}$/i.test(expected.nonce) || origin.protocol !== "http:" ||
      challenge.origin !== origin.origin || challenge.host.toLowerCase() !== origin.host.toLowerCase() || challenge.port !== Number(origin.port) ||
      (credential.owner.port !== undefined && challenge.port !== credential.owner.port) ||
      (expected.profileId !== undefined && challenge.profileId !== expected.profileId) || !Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > 30_000 ||
      challenge.epoch.length < 16 || !/^[0-9a-f]{24}$/i.test(challenge.profileId) || !/^[0-9a-f]{64}$/i.test(challenge.proof)) {
    throw new Error("daemon_discovery_proof_invalid：后台挑战与当前地址、nonce、profile 或有效期不匹配");
  }
  const owner = credential.owner;
  if (challenge.owner.pid !== owner.pid || challenge.owner.hostname !== owner.hostname || challenge.owner.platform !== owner.platform || challenge.owner.processStart !== owner.processStart) {
    throw new Error("daemon_discovery_owner_mismatch：后台挑战与受保护 owner 记录不一致");
  }
  const unsigned = { format: challenge.format, nonce: challenge.nonce, origin: challenge.origin, host: challenge.host, port: challenge.port,
    issuedAt: challenge.issuedAt, owner: challenge.owner, epoch: challenge.epoch, profileId: challenge.profileId,
    protocol: challenge.protocol, applicationVersion: challenge.applicationVersion, buildId: challenge.buildId };
  const expectedProof = createHmac("sha256", credential.token).update(daemonChallengePayload(unsigned)).digest();
  const actualProof = Buffer.from(challenge.proof, "hex");
  if (actualProof.length !== expectedProof.length || !timingSafeEqual(actualProof, expectedProof)) throw new Error("daemon_discovery_signature_invalid：本机后台身份签名不匹配");
  await assertOwnerIsRunning(owner);
}

export function createDaemonChallengeNonce(): string { return randomBytes(32).toString("hex"); }

/** Finds only the daemon named by the protected owner record; it never scans ports or starts/stops processes. */
export async function discoverOwnedDaemon(dataDirectory = join(homedir(), ".token-coupon", "daemon"), options: { fetch?: typeof fetch; timeoutMs?: number; legacyPort?: number } = {}): Promise<DaemonAttachment> {
  const credential = await readDaemonOwnerCredential(dataDirectory);
  const port = credential.owner.port ?? options.legacyPort ?? 4177;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("daemon_discovery_port_invalid：后台端口无效");
  const origin = `http://127.0.0.1:${port}`;
  const nonce = createDaemonChallengeNonce();
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/v1/daemon-challenge?nonce=${nonce}`, {
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 2500),
    });
  } catch {
    throw new Error(`daemon_discovery_unreachable：受保护 owner 指向的本机后台端口 ${port} 无响应；不会扫描其他端口或接管进程`);
  }
  if (response.status !== 200 || response.redirected || response.url && new URL(response.url).origin !== origin) {
    throw new Error(`daemon_discovery_challenge_unavailable：本机端口 ${port} 未返回有效的后台身份挑战（HTTP ${response.status}）`);
  }
  let challenge: DaemonChallenge;
  try { challenge = await response.json() as DaemonChallenge; }
  catch { throw new Error("daemon_discovery_challenge_invalid：本机后台身份挑战不是有效 JSON"); }
  await verifyDaemonChallenge(challenge, credential, { nonce, origin });
  return { origin, port, epoch: challenge.epoch, profileId: challenge.profileId, protocol: challenge.protocol,
    applicationVersion: challenge.applicationVersion, buildId: challenge.buildId };
}

/** Attach only to the verified local owner; never start a replacement or retry a write. */
export async function connectOwnedDaemon(dataDirectory?: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const attachment = await discoverOwnedDaemon(dataDirectory, options);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const landing = await fetcher(attachment.origin, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  const cookie = landing.headers.getSetCookie().map(value => value.split(";", 1)[0]).find(value => value?.startsWith("tc_local="));
  await landing.body?.cancel();
  if (landing.status !== 200 || landing.redirected || !cookie) throw new Error("daemon_client_authorization_failed：本机后台未建立有效会话");
  const client = createClient({ fetch: (async (path, request) => {
    if (typeof path !== "string" || !path.startsWith("/api/v1/") || path.startsWith("//")) throw new Error("daemon_client_path_invalid：只允许本机 API 路径");
    const headers = new Headers(request?.headers); headers.set("Cookie", cookie); headers.set("Origin", attachment.origin);
    return fetcher(attachment.origin + path, { ...request, headers, redirect: "manual", cache: "no-store", signal: request?.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  }) as typeof fetch });
  const health = await client.domain.health();
  if (health.epoch !== attachment.epoch || health.profile.id !== attachment.profileId || health.buildId !== attachment.buildId) {
    throw new Error("daemon_epoch_changed：附着期间后台身份已变化，请重新执行命令核对；未重放任何写操作");
  }
  if (client.connection().compatibility !== "compatible") throw new Error("daemon_client_incompatible：客户端与后台协议不兼容，请更新后重试");
  return { attachment, client };
}
