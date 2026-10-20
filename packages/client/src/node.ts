import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";
import { daemonChallengePayload, type DaemonChallenge } from "./index.js";

const execFile = promisify(execFileCallback);
export type DaemonOwnerCredential = {
  token: string;
  owner: { pid: number; hostname: string; platform: string; processStart: string };
};
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
if (-not (safeFile $file)) { exit 4 }
$cursor=Get-Item -LiteralPath $dir -Force
$depth=0
while ($null -ne $cursor -and $null -ne $cursor.Parent) { if (-not (safeDirectory $cursor.FullName)) { [Console]::Out.Write('directory-depth='+$depth); exit 5 }; $cursor=$cursor.Parent; $depth++ }
[Console]::Out.Write('private')`;
  try {
    const result = await execFile(powershellPath(), encodedPowerShell(script), { windowsHide: true, timeout: 8000, maxBuffer: 4096 });
    if (result.stdout.trim() !== "private") throw new Error("daemon_discovery_profile_unprotected：Windows owner 文件 ACL 校验未返回可信结果");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("daemon_discovery_")) throw error;
    const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unknown";
    const output = error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    const depth = output.match(/directory-depth=(\d+)/)?.[1];
    const reason = code === "4" ? "owner 文件 ACL 对其他用户开放" : code === "5" ? `profile 目录链允许其他用户替换${depth ? `（父目录层级 ${depth}）` : ""}` : "Windows ACL 查询失败";
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
  return { token: record.token as string, owner: { pid: record.pid as number, hostname: owner.hostname as string, platform: owner.platform as string, processStart: owner.processStart as string } };
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
