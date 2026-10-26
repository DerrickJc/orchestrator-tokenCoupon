import crossSpawn from "cross-spawn";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import type { spawn, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";

/** Resolve the command before using a workspace cwd; never implicitly search that cwd. */
export async function resolveNativeExecutable(name: string, label = name, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!name || name.includes("\0")) throw new Error("native_command_invalid");
  const windows = process.platform === "win32";
  const explicit = name.includes("/") || name.includes("\\");
  const value = (key: string) => environment[Object.keys(environment).find(item => windows ? item.toLowerCase() === key.toLowerCase() : item === key) || key];
  const extensions = windows && !extname(name)
    ? (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map(item => item.trim().toLowerCase()).filter(item => [".com", ".exe", ".bat", ".cmd"].includes(item))
    : [""];
  if (windows && extname(name) && ![".com", ".exe", ".bat", ".cmd"].includes(extname(name).toLowerCase())) throw new Error("native_command_extension_unsupported：请选择 Windows exe/com/cmd/bat 可执行入口");
  const directories = explicit ? [""] : (value("PATH") ?? "").split(delimiter).map(item => item.replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const directory of directories) for (const extension of extensions) {
    const candidate = resolve(explicit ? name + extension : join(directory, name + extension));
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Try the next explicit PATH entry. */ }
  }
  throw new Error(`找不到 ${label} 可执行文件，请先安装并登录对应 Runner，或配置绝对路径`);
}

/** Windows children live in a kill-on-close Job; Unix keeps its existing process-group handling. */
export const spawnNative = ((command: string, argumentsOrOptions: readonly string[] | SpawnOptions = [], suppliedOptions: SpawnOptions = {}) => {
  const args = Array.isArray(argumentsOrOptions) ? argumentsOrOptions : [];
  const options: SpawnOptions = Array.isArray(argumentsOrOptions) ? suppliedOptions : argumentsOrOptions as SpawnOptions;
  if (process.platform !== "win32") return crossSpawn(command, [...args], options);
  if (process.versions.electron) throw new Error("windows_job_runtime_unsupported：需明确配置随包 Node 运行时，不能把 Electron 当作 Node 启动");
  if (options.shell) throw new Error("windows_job_shell_forbidden：请使用可执行入口与独立参数");
  const config = Buffer.from(JSON.stringify({ command, args, parentPid: process.pid, runtime: process.execPath, proxy: fileURLToPath(new URL("../resources/windows-job-proxy.mjs", import.meta.url)) })).toString("base64");
  if (config.length > 30000) throw new Error("windows_job_arguments_too_large：Windows 启动参数过长，请改用 stdin 或任务文件");
  const script = readFileSync(new URL("../resources/windows-job.ps1", import.meta.url), "utf8");
  const powershell = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return nodeSpawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    ...options, windowsHide: true, env: { ...(options.env ?? process.env), TOKEN_COUPON_CHILD_CONFIG: config },
  });
}) as typeof spawn;
