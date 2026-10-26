import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { DaemonRuntime } from "./daemon-runtime.js";

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.port < 1024) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error("desktop_daemon_port_unavailable：无法分配本机后台端口");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export interface ManagedDaemonStartOptions<T> {
  runtime: DaemonRuntime;
  dataDirectory: string;
  logPath: string;
  discover(): Promise<T>;
  spawnProcess?: typeof nodeSpawn;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ManagedDaemonResult<T> {
  child: ChildProcess;
  port: number;
  attachment: T;
}

export async function startManagedDaemon<T>(options: ManagedDaemonStartOptions<T>): Promise<ManagedDaemonResult<T>> {
  const port = await reserveLoopbackPort();
  const child = (options.spawnProcess ?? nodeSpawn)(options.runtime.nodeExecutable, [
    options.runtime.daemonEntry, "--host", "127.0.0.1", "--port", String(port), "--data-dir", options.dataDirectory, "--log-file", options.logPath,
  ], {
    cwd: options.runtime.workingDirectory,
    env: { ...process.env, TOKEN_COUPON_DAEMON_HOME: options.dataDirectory },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();

  let spawnError: Error | undefined;
  let lastDiscoveryError = "尚未收到发现结果";
  child.once("error", error => { spawnError = error; });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`desktop_daemon_spawn_failed：无法启动随包后台（${spawnError.message}）`);
    if (child.exitCode !== null) {
      throw new Error(`desktop_daemon_start_failed：后台在就绪前退出（exit ${child.exitCode}），日志：${options.logPath}`);
    }
    try { return { child, port, attachment: await options.discover() }; }
    catch (error) {
      lastDiscoveryError = error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
      await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs ?? 250));
    }
  }
  child.kill();
  throw new Error(`desktop_daemon_start_timeout：后台 ${options.timeoutMs ?? 20_000} ms 内未通过身份挑战就绪；最后核验：${lastDiscoveryError}；日志：${options.logPath}`);
}
