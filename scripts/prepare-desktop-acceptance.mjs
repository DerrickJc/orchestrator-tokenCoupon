// Prepare an isolated Windows preview without inheriting a build/Temp folder's ACLs.
// Run with Windows Node; existing business profiles and credentials are never migrated.
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function prepareDesktopAcceptance(executablePath, launcherPath, options = {}) {
  if (process.platform !== "win32") throw new Error("acceptance_windows_required：请使用 Windows Node 准备 Windows 验收入口");
  if (!isAbsolute(executablePath) || !isAbsolute(launcherPath)) throw new Error("acceptance_path_invalid：应用和启动脚本必须使用绝对路径");
  const executable = await realpath(executablePath);
  if (!(await lstat(executable)).isFile() || !executable.toLowerCase().endsWith(".exe")) throw new Error("acceptance_executable_invalid：请选择解包后的桌面 EXE");
  const launcher = resolve(launcherPath);
  if (!launcher.toLowerCase().endsWith(".cmd")) throw new Error("acceptance_launcher_invalid：验收入口须为 .cmd 文件");
  const runtime = join(dirname(executable), "resources", "token-coupon-runtime", "node_modules", "@token-coupon");
  const { prepareTunnelDirectory } = await import(pathToFileURL(join(runtime, "daemon", "dist", "private-gateway.js")).href);
  const { acquireDaemonOwner } = await import(pathToFileURL(join(runtime, "daemon", "dist", "daemon-owner.js")).href);
  const { readDaemonOwnerCredential } = await import(pathToFileURL(join(runtime, "client", "dist", "node.js")).href);
  const id = createHash("sha256").update(executable.toLowerCase()).digest("hex").slice(0, 12);
  const base = join(homedir(), ".token-coupon-desktop-acceptance");
  const instanceId = options.instanceId ?? id;
  if (typeof instanceId !== "string" || !/^[a-z0-9-]{1,64}$/.test(instanceId)) throw new Error("acceptance_instance_invalid：验收实例标识无效");
  const root = join(base, instanceId), desktop = join(root, "desktop"), daemon = join(root, "daemon");
  // Only these dedicated directories are restricted. Never change Temp, a user's
  // home, arbitrary installation parents, or the established business profile.
  for (const path of [base, root, desktop, daemon]) await prepareTunnelDirectory(path);
  let release;
  try {
    // Use the same fail-closed validation as the app, including the parent chain.
    // Refuse an active profile rather than stopping it or trusting its credentials.
    release = await acquireDaemonOwner(daemon);
    const credential = await readDaemonOwnerCredential(daemon);
    if (credential.owner.pid !== process.pid) throw new Error("acceptance_owner_changed：验收 profile 的身份发生变化");
  } finally { await release?.(); }
  const batchLiteral = value => {
    if (/[\r\n\0"]/.test(value)) throw new Error("acceptance_path_invalid：路径不能包含引号或控制字符");
    return value.replaceAll("%", "%%");
  };
  const batch = ["@echo off", "setlocal DisableDelayedExpansion",
    `set "TOKEN_COUPON_DESKTOP_HOME=${batchLiteral(desktop)}"`,
    `set "TOKEN_COUPON_DAEMON_HOME=${batchLiteral(daemon)}"`,
    'set "ELECTRON_RUN_AS_NODE="', `start "" "${batchLiteral(executable)}"`, "endlocal", ""].join("\r\n");
  await mkdir(dirname(launcher), { recursive: true });
  // A BOM-free UTF-8 script with chcp works for non-ASCII install/user paths.
  await writeFile(launcher, batch.replace("@echo off\r\n", "@echo off\r\nchcp 65001 >nul\r\n"), "utf8");
  return { launcher, desktop, daemon, root, existingCredentialsMigrated: false, profilePermissions: "verified" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
  const executable = value("--executable"), output = value("--output");
  if (!executable || !output) throw new Error("usage: node scripts/prepare-desktop-acceptance.mjs --executable <absolute-exe> --output <absolute-cmd>");
  console.log(JSON.stringify(await prepareDesktopAcceptance(executable, output), null, 2));
}
