// Real packaged-entry HTTP flow in an isolated profile; no paid model calls.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createClient } from "../packages/client/dist/index.js";
import { createDaemonChallengeNonce, readDaemonOwnerCredential, verifyDaemonChallenge } from "../packages/client/dist/node.js";

const root = await mkdtemp(join(tmpdir(), "token-coupon-daemon-smoke-"));
const dataDirectory = process.platform === "win32" ? join(homedir(), `.token-coupon-daemon-smoke-${randomUUID()}`) : join(root, "profile");
const workspacePath = join(root, "中文 项目");
await mkdir(workspacePath); await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const entryOption = process.argv.indexOf("--entry");
const entry = entryOption >= 0 ? process.argv[entryOption + 1] : fileURLToPath(new URL("../packages/daemon/dist/main.js", import.meta.url));
assert(entry && isAbsolute(entry), "--entry requires an absolute daemon entry");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let daemon, exited, diagnostic = "", cookie;
function start() {
  diagnostic = "";
  daemon = spawn(process.execPath, [entry, "--data-dir", dataDirectory, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  daemon.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  daemon.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  exited = new Promise(resolve => { daemon.once("error", resolve); daemon.once("close", resolve); });
}
async function ready() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon_start_failed: ${diagnostic}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      cookie = response.headers.getSetCookie()[0]?.split(";")[0]; await response.body?.cancel();
      if (response.ok && cookie) return;
    } catch { /* Startup includes owner identity/coordination. */ }
    await pause(100);
  }
  throw new Error(`daemon_start_timeout: ${diagnostic}`);
}
async function stop() {
  if (!daemon) return;
  daemon.kill("SIGTERM");
  let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { daemon.kill("SIGKILL"); resolve(); }, 5000); })]); clearTimeout(timer);
  await exited; daemon = undefined;
}
const client = createClient({ fetch: (path, options) => fetch(origin + path, { ...options, headers: { ...Object.fromEntries(new Headers(options?.headers)), Cookie: cookie, Origin: origin } }) });
async function completed(job) {
  const deadline = Date.now() + 60000;
  while (job.status === "running" && Date.now() < deadline) { await pause(50); job = await client.api(`/api/v1/jobs/${job.jobId}`); }
  assert.equal(job.status, "succeeded", job.error || JSON.stringify(job)); return job;
}
try {
  start(); await ready();
  assert.equal((await fetch(`${origin}/api/v1/health`)).status, 403);
  const first = await client.api("/api/v1/health");
  assert.equal(first.profile.platform, process.platform);
  assert.equal(first.profile.id, createHash("sha256").update(await realpath(dataDirectory)).digest("hex").slice(0, 24));
  const credential = await readDaemonOwnerCredential(dataDirectory);
  assert.equal(first.capabilities.daemonDiscovery, 1, "private daemon owner profile must permit authenticated desktop discovery");
  const nonce = createDaemonChallengeNonce();
  const challengeResponse = await fetch(`${origin}/api/v1/daemon-challenge?nonce=${nonce}`);
  assert.equal(challengeResponse.status, 200);
  await verifyDaemonChallenge(await challengeResponse.json(), credential, { nonce, origin, profileId: first.profile.id });
  const workspace = await client.api("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ path: workspacePath, label: "原生后台烟测" }) });
  const planning = await completed(await client.api(`/api/v1/workspaces/${workspace.workspaceId}/plannings`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID(), provider: "mock", request: "离线问候函数演示与验证", executionDefaults: { runnerId: "mock", mode: "managed" } }) }));
  const planPath = `/api/v1/workspaces/${workspace.workspaceId}/plannings/${planning.result.planningId}`;
  await completed(await client.api(`${planPath}/review`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID() }) }));
  const reviewed = await client.api(planPath);
  await completed(await client.api(`${planPath}/approve`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID(), draftRevision: reviewed.draft.draftRevision }) }));
  await completed(await client.api(`${planPath}/run`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID(), isolation: "shared", maxParallel: 1 }) }));
  const finished = await client.api(planPath); assert.equal(finished.session.status, "succeeded");
  assert(finished.session.tasks.every(task => task.status === "succeeded"));
  const attempt = finished.session.tasks[0].attempts[0].attemptId;
  assert((await client.api(`${planPath}/attempts/${attempt}/events`)).events.length > 0);
  await stop(); start(); await ready();
  await assert.rejects(() => client.api("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ path: workspacePath }) }), /daemon_epoch_changed/);
  const restarted = await client.api("/api/v1/health"); assert.notEqual(restarted.epoch, first.epoch);
  assert.equal(restarted.profile.id, first.profile.id);
  assert.equal((await client.api(planPath)).session.status, "succeeded");
  assert((await client.api(`${planPath}/attempts/${attempt}/events`)).events.length > 0);
  console.log(JSON.stringify({ platform: process.platform, node: process.version, daemonEntry: "passed", discoveryProof: "passed", authentication: "passed", mockPlanReviewApproveRun: "passed", restart: "passed", staleWrite: "rejected", persistedAttempt: "readable" }));
} finally {
  await stop(); await rm(root, { recursive: true, force: true });
  if (process.platform === "win32") await rm(dataDirectory, { recursive: true, force: true });
}
