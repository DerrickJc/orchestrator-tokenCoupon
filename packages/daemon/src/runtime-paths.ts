import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** The installed app must never implicitly write its state in the startup directory. */
export function resolveDaemonDataDirectory(explicit?: string, environment: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const selected = explicit ?? environment.TOKEN_COUPON_DAEMON_HOME;
  if (selected !== undefined) {
    if (!selected.trim()) throw new Error("daemon_data_directory_invalid：后台数据目录不能为空");
    return resolve(selected);
  }
  if (!userHome || !isAbsolute(userHome)) throw new Error("daemon_home_unavailable：无法确定用户主目录，请显式设置 --data-dir");
  return join(userHome, ".token-coupon", "daemon");
}
