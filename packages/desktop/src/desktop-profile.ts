import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

export function resolveDaemonProfileDirectory(args: readonly string[], environment: NodeJS.ProcessEnv, home: string): string {
  const flags = args.filter(value => value === "--data-dir" || value.startsWith("--data-dir="));
  if (flags.length > 1) throw new Error("desktop_data_directory_invalid：后台数据目录不能重复指定");
  const index = args.indexOf("--data-dir");
  const argument = index >= 0 ? args[index + 1] : flags[0]?.slice("--data-dir=".length);
  if (index >= 0 && (!argument || argument.startsWith("--"))) throw new Error("desktop_data_directory_invalid：--data-dir 缺少绝对目录");
  const explicit = argument ?? environment.TOKEN_COUPON_DAEMON_HOME;
  if (explicit !== undefined) {
    if (!explicit.trim() || !isAbsolute(explicit)) throw new Error("desktop_data_directory_invalid：后台数据目录必须是非空绝对路径");
    return resolve(explicit);
  }
  if (!home || !isAbsolute(home)) throw new Error("desktop_home_unavailable：无法确定用户主目录");
  return join(home, ".token-coupon", "daemon");
}

/** Additional data preserves the second process's environment-selected directory. */
export function secondInstanceDirectory(args: readonly string[], additionalData: unknown, home: string): string {
  if (additionalData && typeof additionalData === "object" && "dataDirectory" in additionalData) {
    if (typeof additionalData.dataDirectory !== "string") throw new Error("desktop_second_profile_invalid：无法核验请求的后台目录");
    return resolveDaemonProfileDirectory(["--data-dir", additionalData.dataDirectory], {}, home);
  }
  if (args.some(value => value === "--data-dir" || value.startsWith("--data-dir="))) return resolveDaemonProfileDirectory(args, {}, home);
  throw new Error("desktop_second_profile_unknown：新实例未提供可核验的后台目录，当前连接保持不变");
}

export function sameDaemonDirectory(current: string, requested: string): boolean {
  const canonical = (value: string) => {
    let result: string;
    try { result = realpathSync(value); } catch { result = resolve(value); }
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return canonical(current) === canonical(requested);
}

/** Resolve before taking Electron's instance lock so profiles never share its Chromium lock. */
export function resolveDesktopUserData(defaultDirectory: string, packaged: boolean, environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.TOKEN_COUPON_DESKTOP_HOME;
  if (configured !== undefined) {
    if (!configured.trim() || !isAbsolute(configured)) throw new Error("desktop_user_data_invalid：TOKEN_COUPON_DESKTOP_HOME 必须是非空绝对路径");
    return resolve(configured);
  }
  if (!isAbsolute(defaultDirectory)) throw new Error("desktop_user_data_unavailable：无法确定桌面用户目录");
  return packaged ? defaultDirectory : `${defaultDirectory}-development`;
}
