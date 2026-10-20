import { ApplicationService } from "./application-service.js";
import { createLocalServer } from "./http-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { acquireDaemonOwner } from "./daemon-owner.js";
import { RemoteMcpConnection } from "./oauth-gateway.js";
import { resolveDaemonDataDirectory } from "./runtime-paths.js";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

const port = Number(option("--port", process.env.TOKEN_COUPON_DAEMON_PORT ?? "4177"));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("--port 必须是 1024 到 65535 之间的整数");
const host = option("--host", "127.0.0.1");
const dataDirectory = resolveDaemonDataDirectory(process.argv.includes("--data-dir") ? option("--data-dir", "") : undefined);
const releaseOwner = await acquireDaemonOwner(dataDirectory);
const service = new ApplicationService({ dataDirectory });
await service.initialize();
const remoteMcp = new RemoteMcpConnection(service, dataDirectory);
await remoteMcp.initialize();
const server = await createLocalServer(service, { port, host, dataDirectory, remoteMcp });
const stdio = process.argv.includes("--mcp-stdio");
server.listen(port, host, () => (stdio ? process.stderr : process.stdout).write(`Token Coupon 本机控制台已启动：http://${host.includes(":") ? `[${host}]` : host}:${port}\nMCP HTTP 入口：/mcp（独立 Bearer 认证）。按 Ctrl+C 停止业务后端，常驻快捷隧道保留；彻底断开请先在连接中心停止连接。\n`));
if (stdio) await createMcpServer(service).connect(new StdioServerTransport());
server.on("error", (error) => {
  process.stderr.write(`daemon 启动失败：${error.message}\n`);
  // A saved Quick Tunnel may already be starting when the console port fails.
  void remoteMcp.shutdown().finally(() => service.shutdown()).finally(releaseOwner).finally(() => process.exit(1));
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeAllConnections();
  void remoteMcp.shutdown().finally(() => server.close(() => { void service.shutdown().then(releaseOwner).finally(() => process.exit(0)); }));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
