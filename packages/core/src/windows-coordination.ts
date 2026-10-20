import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
function powershellPath(): string {
  return win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function argumentsFor(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export async function windowsProcessStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const result = await execute(powershellPath(), argumentsFor(`[Console]::Out.Write([Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString())`), { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const value = result.stdout.trim();
    return /^\d+$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

/** A kernel mutex, held by one helper thread until the parent closes stdin. */
export async function acquireWindowsCoordination(path: string, waitSeconds: number): Promise<() => Promise<void>> {
  if (process.platform !== "win32") throw new Error("windows_coordination_platform_invalid");
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) throw new Error("lock_wait_invalid");
  const canonical = join(await realpath(dirname(path)), basename(path)).toLowerCase();
  const name = "Global\\TokenCoupon-" + createHash("sha256").update(canonical).digest("hex");
  const script = `$ErrorActionPreference='Stop'; $held=$false; $mutex=[Threading.Mutex]::new($false,'${name}');
    try {
      try { $held=$mutex.WaitOne(${Math.ceil(waitSeconds * 1000)}); } catch [Threading.AbandonedMutexException] { $held=$true; }
      if (-not $held) { exit 3; }
      [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadToEnd();
    } finally { if ($held) { $mutex.ReleaseMutex(); }; $mutex.Dispose(); }`;
  const child = spawn(powershellPath(), argumentsFor(script), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "", diagnostic = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("lock_coordination_failed：Windows 协调辅助进程启动超时")); }, 15000 + waitSeconds * 1000);
      const cleanup = () => clearTimeout(timer);
      child.once("error", error => { cleanup(); reject(new Error(`lock_coordination_failed：${error.message}`)); });
      child.stderr.on("data", (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(0, 1024); });
      child.stdout.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(0, 128);
        if (output.split(/\r?\n/).includes("ready")) { cleanup(); resolve(); }
      });
      child.once("close", code => { cleanup(); reject(new Error(code === 3 ? "lock_coordination_busy：正在恢复或获取锁，请稍后重试" : `lock_coordination_failed：Windows Mutex 辅助进程退出 ${code} ${diagnostic}`)); });
    });
  } catch (error) { child.stdin.end(); child.kill(); await exited; throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const timer = setTimeout(() => child.kill(), 5000); timer.unref();
    child.stdin.end();
    await exited;
    clearTimeout(timer);
  };
}
