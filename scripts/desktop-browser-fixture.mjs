// Isolated real-browser fixture. Uses only Mock; never reads an existing daemon profile.
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ApplicationService } from "../packages/daemon/dist/application-service.js";
import { createLocalServer } from "../packages/daemon/dist/http-server.js";

const root = await mkdtemp(join(tmpdir(), "token-coupon-browser-"));
const dataDirectory = join(root, "profile"), workspacePath = join(root, "中文 项目");
await mkdir(workspacePath);
const service = new ApplicationService({ dataDirectory });
let server, closing = false;
async function close() {
  if (closing) return; closing = true;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await service.shutdown(); await rm(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
try {
await service.initialize();
service.runnerOptions = async () => [{ id: "mock", label: "离线演示", available: true }];
service.planningProviderOptions = async () => [{ id: "mock", label: "离线演示", available: true }];
const workspace = await service.addWorkspace(workspacePath, "桌面浏览器回归");
async function completed(job) {
  const deadline = Date.now() + 20000;
  while (job.status === "running" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25)); job = await service.getJob(job.jobId);
  }
  if (job.status !== "succeeded") throw new Error(job.error || `fixture_job_${job.status}`);
  return job.result;
}
const planned = await completed(await service.startPlanning(workspace.workspaceId, randomUUID(), {
  request: "离线演示：实现问候函数并验证", provider: "mock", executionDefaults: { runnerId: "mock", mode: "managed" },
}));
await completed(await service.review(workspace.workspaceId, planned.planningId, randomUUID()));
const draft = await service.planningView(workspace, planned.planningId);
await completed(await service.approve(workspace.workspaceId, planned.planningId, randomUUID(), draft.draft.draftRevision));
await completed(await service.run(workspace.workspaceId, planned.planningId, randomUUID(), { isolation: "shared", maxParallel: 1 }));
const editable = await completed(await service.startPlanning(workspace.workspaceId, randomUUID(), {
  request: "离线演示：草案多行编辑与对账", provider: "mock", executionDefaults: { runnerId: "mock", mode: "managed" },
}));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory });
await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
console.log(JSON.stringify({ pid: process.pid, origin: `http://127.0.0.1:${port}`, workspaceId: workspace.workspaceId, planningId: planned.planningId, editablePlanningId: editable.planningId, root }));
} catch (error) {
  await close(); throw error;
}
