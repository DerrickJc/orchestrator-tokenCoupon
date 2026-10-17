import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";

export interface TunnelRuntime { origin: string; stop(): Promise<void>; }
export interface TunnelAdapter {
  start(executable: string, port: number, workingDirectory: string, signal: AbortSignal, exited: () => void): Promise<TunnelRuntime>;
}
export class QuickTunnelAdapter implements TunnelAdapter {
  constructor(private readonly discoveryTimeoutMs = 45_000) {}
  async start(executable: string, port: number, workingDirectory: string, signal: AbortSignal, exited: () => void): Promise<TunnelRuntime> {
    await mkdir(workingDirectory, { recursive: true, mode: 0o700 }); signal.throwIfAborted();
    // An explicit empty config prevents reading the user's named-tunnel config.
    const child = spawn(executable, ["tunnel", "--config", process.platform === "win32" ? "NUL" : "/dev/null", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`, "--protocol", "http2"], {
      cwd: workingDirectory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stopping = false, closed = false;
    const done = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
    const stop = async () => {
      if (stopping) return done;
      stopping = true; signal.removeEventListener("abort", cancel);
      await stopProcess(child, done, () => closed);
    };
    const cancel = () => { void stop(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        let found = false; const pending = { out: "", err: "" };
        const timer = setTimeout(() => reject(new Error("tunnel_url_timeout：未能取得公网地址，请检查 Cloudflare 网络连接后重试")), this.discoveryTimeoutMs);
        const failed = () => reject(new Error("tunnel_process_exited：隧道进程退出；请检查网络或组件版本"));
        const aborted = () => reject(new Error("tunnel_cancelled：连接已停止"));
        child.once("error", failed); child.once("close", failed); signal.addEventListener("abort", aborted, { once: true });
        const cleanup = () => { clearTimeout(timer); child.removeListener("error", failed); child.removeListener("close", failed); signal.removeEventListener("abort", aborted); };
        const consume = (key: "out" | "err", chunk: Buffer) => {
          pending[key] += chunk.toString("utf8");
          const lines = pending[key].split(/\r?\n/); pending[key] = lines.pop()!.slice(-8192);
          for (const line of lines) {
            const candidate = discoverQuickOrigin(line);
            if (candidate && !found) { found = true; cleanup(); resolve(candidate); }
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => consume("out", chunk));
        child.stderr?.on("data", (chunk: Buffer) => consume("err", chunk));
        if (signal.aborted) aborted();
        // Retain output draining, but never persist upstream raw logs or credentials.
        done.finally(cleanup).catch(() => undefined);
      });
      if (closed || signal.aborted) throw new Error("tunnel_process_exited：隧道在启动中停止");
      child.once("close", () => { if (!stopping) exited(); });
      return { origin, stop };
    } catch (error) { await stop(); throw error; }
  }
}

export function discoverQuickOrigin(line: string): string | undefined {
  const matches = line.matchAll(/https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?=[\s|"'<>]|$)/g);
  for (const match of matches) return `https://${match[1]}`;
  return undefined;
}
async function stopProcess(child: ChildProcess, done: Promise<void>, closed: () => boolean): Promise<void> {
  if (closed()) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (!closed()) child.kill("SIGKILL"); }, 2000);
  timer.unref();
  try { await done; } finally { clearTimeout(timer); }
}
