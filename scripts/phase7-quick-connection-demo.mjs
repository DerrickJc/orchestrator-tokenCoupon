import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { ApplicationService } from "../packages/daemon/dist/application-service.js";
import { RemoteMcpConnection } from "../packages/daemon/dist/oauth-gateway.js";

if (!process.argv.includes("--live")) {
  console.error("请加 --live：本演示会下载官方 cloudflared 并临时开启 Cloudflare MCP 隧道，结束后自动关闭。\n离线协议回归：npx vitest run packages/daemon/test/quick-connection.test.ts");
  process.exit(2);
}
const root = resolve("demo-workspace", `phase7-quick-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const workspacePath = join(root, "project"); await mkdir(workspacePath, { recursive: true });
const service = new ApplicationService({ dataDirectory: join(root, "state") }); await service.initialize();
const workspace = await service.addWorkspace(workspacePath, "Quick Tunnel 无源码连接演示");
const listener = createServer();
await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
const remote = new RemoteMcpConnection(service, join(root, "state"), port, { healthIntervalMs: 0 });
await remote.initialize();
let interrupted = false;
const stop = () => { interrupted = true; void remote.stop(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const report = { startedAt: new Date().toISOString(), scenario: "real Cloudflare + HTTP OAuth discovery + unauthenticated 401 + JSON MCP initialize/list/call", chatgptAccountVerified: false, workspacePath, status: "failed" };
try {
  await remote.startQuick({ consent: true, workspaceId: workspace.workspaceId, scopes: ["planning:read"] });
  const deadline = Date.now() + 240_000;
  let lastPhase;
  while (!interrupted && Date.now() < deadline) {
    const current = remote.status();
    if (current.transport !== lastPhase) { console.log(`连接：${current.transport}`); lastPhase = current.transport; }
    if (current.transport === "ready") {
      report.status = "succeeded";
      report.component = current.component;
      report.originFingerprint = createHash("sha256").update(current.publicOrigin).digest("hex");
      report.lastProbeAt = current.lastProbeAt;
      break;
    }
    if (["error", "disconnected"].includes(current.transport)) { report.error = current.lastError; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (report.status !== "succeeded" && !report.error) report.error = interrupted ? "demo_cancelled" : "demo_deadline_exceeded";
} catch (error) { report.error = remote.status().lastError ?? error.message; }
finally {
  await remote.stop(); await service.shutdown();
  report.finishedAt = new Date().toISOString(); report.gatewayStopped = remote.status().gateway === "stopped";
  await writeFile(join(root, "connection-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
console.log(`演示结果：${report.status}；产物：${join(root, "connection-report.json")}`);
if (report.error) console.error(report.error);
if (report.status !== "succeeded") process.exitCode = 1;
