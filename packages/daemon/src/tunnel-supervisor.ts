import { timingSafeEqual } from "node:crypto";
import { createServer, request as forward } from "node:http";
import { lstat, readFile, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { currentOwner } from "@token-coupon/core";
import { QuickTunnelAdapter, type TunnelRuntime } from "./quick-tunnel.js";
import { readTunnelRecord, tunnelRecordPath, writeTunnelRecord, type TunnelRecord } from "./persistent-tunnel.js";

// This process owns only the tunnel, never planning, OAuth, workspace permissions or execution.
const launch = process.argv[2];
if (!launch || !isAbsolute(launch)) throw new Error("tunnel_launch_invalid");
const launchInfo = await lstat(launch);
if (!launchInfo.isFile() || launchInfo.isSymbolicLink() || launchInfo.size > 8192 || process.platform !== "win32" && (launchInfo.mode & 0o077)) throw new Error("tunnel_launch_invalid");
const input = JSON.parse(await readFile(launch, "utf8")) as { executable: string; port: number; token: string };
await unlink(launch);
if (!isAbsolute(input.executable) || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535 || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error("tunnel_launch_invalid");
const directory = dirname(launch), controller = new AbortController();
let runtime: TunnelRuntime | undefined, stopping = false;
let launching: Promise<TunnelRuntime> | undefined, stopTask: Promise<void> | undefined;
let backendSocket: string | undefined;
const publicGateway = createServer((request, response) => {
  const unavailable = () => { if (response.headersSent) { response.destroy(); return; } response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "2" }); response.end(JSON.stringify({ error: "backend_temporarily_unavailable", message: "业务服务重启中，请稍后重试原 MCP 连接。" })); };
  if (!backendSocket || stopping) { unavailable(); return; }
  const upstream = forward({ socketPath: backendSocket, path: request.url, method: request.method, headers: request.headers, agent: false }, incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    incoming.once("error", () => response.destroy());
  });
  upstream.once("error", unavailable);
  upstream.setTimeout(120_000, () => upstream.destroy());
  request.once("aborted", () => upstream.destroy()); response.once("close", () => upstream.destroy());
  request.pipe(upstream);
});
let record: TunnelRecord;
const server = createServer((request, response) => {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${input.token}`);
  if (request.method !== "POST" || request.headers.origin || request.headers["x-token-coupon-tunnel"] !== "1" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403); response.end(); return; }
  if (!["/status", "/stop", "/attach", "/detach"].includes(request.url ?? "")) { response.writeHead(404); response.end(); return; }
  if (request.url === "/attach" || request.url === "/detach") {
    void (async () => {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error("body_limit"); }
      const { socketPath } = JSON.parse(body) as { socketPath: string };
      if (typeof socketPath !== "string" || !isAbsolute(socketPath) || basename(socketPath) !== "gateway.sock" || dirname(dirname(socketPath)) !== resolve(tmpdir()) || !basename(dirname(socketPath)).startsWith("tc-gateway-")) throw new Error("socket_invalid");
      if (request.url === "/attach") {
        const parent = await lstat(dirname(socketPath)), file = await lstat(socketPath);
        if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || !file.isSocket() || file.isSymbolicLink() || process.getuid && parent.uid !== process.getuid()) throw new Error("socket_invalid");
        backendSocket = socketPath;
      } else if (backendSocket === socketPath) backendSocket = undefined;
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(record));
    })().catch(() => { response.writeHead(422); response.end(); });
    return;
  }
  if (request.url === "/stop") {
    void stop().then(() => { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(record)); setTimeout(() => process.exit(0), 20); }).catch(() => { response.writeHead(500); response.end(); });
  } else { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(record)); }
});
server.requestTimeout = 5000; server.headersTimeout = 5000;
try { await new Promise<void>((resolve, reject) => { publicGateway.once("error", reject); publicGateway.listen(input.port, "127.0.0.1", resolve); }); }
catch (error) { process.exit((error as NodeJS.ErrnoException).code === "EADDRINUSE" ? 73 : 1); }
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address(); if (!address || typeof address === "string") throw new Error("tunnel_control_port_invalid");
record = { ...await currentOwner(), version: 1, token: input.token, gatewayPort: input.port, controlPort: address.port, phase: "starting" };
await writeTunnelRecord(directory, record, true);
const adapter = new QuickTunnelAdapter(45_000, async pid => {
  const owner = await currentOwner();
  let processStart: string | undefined;
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8"); processStart = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  }
  const { processStart: _ownStart, ...identity } = owner;
  record.child = { ...identity, pid, ...(processStart ? { processStart } : {}) };
  await writeTunnelRecord(directory, record);
});
async function stop() {
  if (stopTask) return stopTask;
  stopping = true;
  stopTask = (async () => {
    controller.abort(); await launching?.catch(() => undefined); await runtime?.stop();
    backendSocket = undefined; publicGateway.closeAllConnections(); publicGateway.close();
    record.phase = "error";
    if ((await readTunnelRecord(directory))?.token === input.token) await unlink(tunnelRecordPath(directory));
  })();
  return stopTask;
}
for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, () => { void stop().finally(() => process.exit(0)); });
try {
  launching = adapter.start(input.executable, input.port, directory, controller.signal, () => { void stop().finally(() => process.exit(0)); });
  runtime = await launching;
  if (stopping) await runtime.stop();
  else { record.phase = "running"; record.origin = runtime.origin; await writeTunnelRecord(directory, record); }
} catch {
  // Keep no raw upstream output; the daemon reports a bounded startup diagnostic.
  if (!stopping) { record.phase = "error"; await writeTunnelRecord(directory, record); await stop(); server.close(); process.exit(1); }
}
