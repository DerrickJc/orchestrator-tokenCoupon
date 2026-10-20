import crossSpawn from "cross-spawn";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import type { spawn } from "node:child_process";

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

/** cross-spawn escapes cmd shims without opting into an unrestricted shell. */
export const spawnNative = crossSpawn as typeof spawn;
