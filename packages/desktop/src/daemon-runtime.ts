import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DaemonRuntime {
  nodeExecutable: string;
  daemonEntry: string;
  workingDirectory: string;
}

interface RuntimeManifest {
  format: 1;
  daemonEntry: string;
  nodeExecutable?: string;
}

function requireFile(path: string, label: string): string {
  let resolved: string;
  try { resolved = realpathSync(path); }
  catch { throw new Error(`desktop_runtime_${label}_missing：找不到 ${label === "node" ? "随包 Node.js 运行时" : "daemon 入口"}`); }
  if (!statSync(resolved).isFile()) throw new Error(`desktop_runtime_${label}_invalid：${label} 必须是普通文件`);
  return resolved;
}

function resolveInside(root: string, value: string, label: string): string {
  if (!value || isAbsolute(value) || value.includes("\\")) throw new Error(`desktop_runtime_manifest_invalid：${label} 必须是相对路径`);
  const candidate = resolve(root, value);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`desktop_runtime_manifest_invalid：${label} 超出运行时目录`);
  }
  const rootReal = realpathSync(root);
  const fileReal = requireFile(candidate, label === "nodeExecutable" ? "node" : "daemon");
  const realRelative = relative(rootReal, fileReal);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`desktop_runtime_manifest_invalid：${label} 指向运行时目录之外`);
  }
  return fileReal;
}

function readManifest(runtimeRoot: string): RuntimeManifest {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(runtimeRoot, "runtime-manifest.json"), "utf8")); }
  catch { throw new Error("desktop_runtime_manifest_missing：随包 daemon 运行清单不可读"); }
  if (!raw || typeof raw !== "object") throw new Error("desktop_runtime_manifest_invalid：运行清单格式无效");
  const manifest = raw as Partial<RuntimeManifest>;
  if (manifest.format !== 1 || typeof manifest.daemonEntry !== "string" ||
      (manifest.nodeExecutable !== undefined && typeof manifest.nodeExecutable !== "string")) {
    throw new Error("desktop_runtime_manifest_invalid：运行清单字段无效");
  }
  return manifest as RuntimeManifest;
}

export function resolvePackagedDaemonRuntime(resourcesPath: string): DaemonRuntime {
  let runtimeRoot: string;
  try { runtimeRoot = realpathSync(join(resourcesPath, "token-coupon-runtime")); }
  catch { throw new Error("desktop_runtime_directory_missing：安装包缺少 token-coupon-runtime 资源目录"); }
  const manifest = readManifest(runtimeRoot);
  if (!manifest.nodeExecutable) throw new Error("desktop_runtime_node_missing：安装包没有附带 Node.js 运行时");
  const nodeExecutable = resolveInside(runtimeRoot, manifest.nodeExecutable, "nodeExecutable");
  const daemonEntry = resolveInside(runtimeRoot, manifest.daemonEntry, "daemonEntry");
  try { accessSync(nodeExecutable, constants.X_OK); } catch { throw new Error("desktop_runtime_node_not_executable：随包 Node.js 运行时不可执行"); }
  return { nodeExecutable, daemonEntry, workingDirectory: dirname(daemonEntry) };
}

export function resolveDevelopmentDaemonRuntime(appPath: string, environment: NodeJS.ProcessEnv = process.env): DaemonRuntime {
  const daemonEntry = requireFile(environment.TOKEN_COUPON_DAEMON_ENTRY ?? resolve(appPath, "../daemon/dist/main.js"), "daemon");
  const configuredNode = environment.TOKEN_COUPON_NODE_EXECUTABLE;
  let nodeExecutable = "node";
  if (configuredNode) {
    if (!isAbsolute(configuredNode)) throw new Error("desktop_runtime_node_path_invalid：Node.js 路径必须是绝对路径");
    nodeExecutable = requireFile(configuredNode, "node");
    try { accessSync(nodeExecutable, constants.X_OK); } catch { throw new Error("desktop_runtime_node_not_executable：Node.js 运行时不可执行"); }
  }
  return { nodeExecutable, daemonEntry, workingDirectory: dirname(daemonEntry) };
}
