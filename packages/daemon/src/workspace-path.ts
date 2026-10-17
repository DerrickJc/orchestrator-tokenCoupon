import { execFile } from "node:child_process";
import { homedir, release } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

export interface WorkspaceEnvironment {
  platform: NodeJS.Platform;
  isWsl: boolean;
  distro?: string;
  home: string;
  currentDirectory: string;
}

export function workspaceEnvironment(): WorkspaceEnvironment {
  const distro = process.env.WSL_DISTRO_NAME;
  return {
    platform: process.platform,
    isWsl: process.platform === "linux" && (Boolean(distro) || /microsoft/i.test(release())),
    ...(distro ? { distro } : {}),
    home: homedir(), currentDirectory: process.cwd(),
  };
}

const execFileAsync = promisify(execFile);
async function windowsToWsl(path: string): Promise<string> {
  try {
    // wslpath respects the actual automount configuration. The input is an argv
    // value, never shell code; spaces and Chinese names retain their meaning.
    const { stdout } = await execFileAsync("wslpath", ["-u", path], { timeout: 5000, maxBuffer: 16 * 1024 });
    return stdout.trim();
  } catch {
    throw new Error("workspace_path_invalid：无法将 Windows 路径转换为 WSL 路径，请填写该目录在 WSL 中的绝对路径（例如 /mnt/d/项目）");
  }
}

export async function normalizeWorkspacePath(
  input: string,
  environment: WorkspaceEnvironment = workspaceEnvironment(),
  translateWindows: (path: string) => Promise<string> = windowsToWsl,
): Promise<string> {
  let path = input.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path || Buffer.byteLength(path, "utf8") > 4096 || /[\0\r\n]/.test(path)) throw new Error("workspace_path_invalid：项目目录不能为空，且不能包含换行或控制字符");
  const nativePath = environment.platform === "win32" ? win32 : posix;
  if (path === "~") path = environment.home;
  else if (path.startsWith("~/") || (environment.platform === "win32" && path.startsWith("~\\"))) path = nativePath.join(environment.home, path.slice(2));

  if (environment.isWsl) {
    const unc = path.replaceAll("\\", "/").match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(?:\/(.*))?$/i);
    if (unc) {
      if (!environment.distro || unc[1]!.toLowerCase() !== environment.distro.toLowerCase()) {
        throw new Error(`workspace_path_invalid：WSL 路径属于 ${unc[1]}，当前后台是 ${environment.distro ?? "未知发行版"}；请填写当前发行版可访问的路径`);
      }
      path = `/${unc[2] ?? ""}`;
    } else if (/^[a-z]:[\\/]/i.test(path)) path = await translateWindows(path);
    else if (/^(?:\\\\|\/\/)/.test(path)) throw new Error("workspace_path_invalid：当前 WSL 后台不能直接访问此网络路径，请先挂载后填写 Linux 绝对路径");
  } else if (environment.platform !== "win32" && (/^[a-z]:/i.test(path) || path.startsWith("\\\\"))) {
    throw new Error("workspace_path_invalid：后台运行于 Linux/macOS，Windows 目录需先挂载，再填写后台可访问的绝对路径");
  }
  if (!nativePath.isAbsolute(path) || /^[a-z]:(?![\\/])/i.test(path)) {
    throw new Error("workspace_path_invalid：请输入绝对目录或 ~/目录；WSL 也支持 C:\\项目 这类 Windows 绝对路径");
  }
  return nativePath.normalize(path);
}
