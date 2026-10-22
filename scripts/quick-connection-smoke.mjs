import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationService } from "../packages/daemon/dist/application-service.js";
import { CloudflaredComponent } from "../packages/daemon/dist/cloudflared-component.js";
import { RemoteMcpConnection } from "../packages/daemon/dist/oauth-gateway.js";
import { PersistentQuickTunnelAdapter, readTunnelRecord } from "../packages/daemon/dist/persistent-tunnel.js";

const args = process.argv.slice(2), live = args.includes("--public"), componentOnly = args.includes("--component-only");
const outputIndex = args.indexOf("--output"), output = outputIndex < 0 ? undefined : resolve(args[outputIndex + 1] ?? "");
if (live === componentOnly || args.some((arg, index) => !["--public", "--component-only", "--output"].includes(arg) && !(outputIndex >= 0 && index === outputIndex + 1)) || outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith("--"))) throw new Error("Usage: quick-connection-smoke.mjs --public|--component-only [--output report.json]");
const root = await mkdtemp(join(tmpdir(), "tc-live-快捷连接 "));
const data = join(root, "profile"), directory = join(data, "components", "tunnel-runtime");
const report = { platform: process.platform, mode: live ? "public" : "component-only", realWebClientAuthorization: "pending", status: "running" };
let remote, service, failed;
const controller = new AbortController(), budget = setTimeout(() => controller.abort(), 240000);
const code = error => String(error?.message ?? error).match(/^[a-z][a-z0-9_]+(?=：|:|$)/)?.[0] ?? "public_connection_unverified";
async function ready() {
  const deadline = Date.now() + 90000; let previous;
  while (Date.now() < deadline && !controller.signal.aborted) {
    const status = remote.status();
    if (status.transport !== previous) { previous = status.transport; console.log(JSON.stringify({ phase: previous })); }
    if (status.transport === "ready") return status;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(remote.status().lastError ?? "public_connection_timeout");
}
try {
  await mkdir(data, { recursive: true });
  const component = new CloudflaredComponent(data);
  const info = await component.get(controller.signal, phase => console.log(JSON.stringify({ component: phase })));
  report.component = { version: info.version, source: info.source };
  if (live) {
    const listener = createServer(); await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    service = new ApplicationService({ dataDirectory: data }); await service.initialize();
    remote = new RemoteMcpConnection(service, data, port, { component, healthIntervalMs: 0 }); await remote.initialize();
    await remote.startQuick({ consent: true, connectionOnly: true, scopes: ["planning:read"] });
    const before = await ready(), record = await readTunnelRecord(directory);
    assert.equal(before.quickTunnel.available, true); assert.equal(before.validGrants, 0);
    assert(record?.child?.processStart); assert.equal(record.child.platform, process.platform);
    report.publicMetadataAndMcpProbe = "passed";
    await remote.shutdown();
    remote = new RemoteMcpConnection(service, data, port, { component, healthIntervalMs: 0 }); await remote.initialize();
    const after = await ready(), restored = await readTunnelRecord(directory);
    assert.equal(restored?.pid, record.pid); assert.equal(restored?.origin, record.origin);
    assert.equal(after.validGrants, 0);
    report.daemonRestartSameTunnel = "passed";
    await remote.stop(); assert.equal(await readTunnelRecord(directory), undefined);
    report.explicitStop = "passed";
  }
  report.status = "passed";
} catch (error) { report.status = "unverified"; report.errorCode = code(error); failed = true; }
finally {
  clearTimeout(budget); controller.abort();
  try {
    await remote?.stop(); await remote?.shutdown();
    await new PersistentQuickTunnelAdapter().stopSaved(directory);
    assert.equal(await readTunnelRecord(directory), undefined);
    report.cleanup = "passed"; await rm(root, { recursive: true, force: true });
  } catch { report.cleanup = "manual_check_required"; report.retainedProfile = root; failed = true; }
  await service?.shutdown();
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
  console.log(JSON.stringify(report));
  if (failed) process.exitCode = 1;
}
