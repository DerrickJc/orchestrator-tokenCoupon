import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("requires an authenticated, current-epoch confirmation and refuses to stop while jobs are running", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-daemon-stop-")); roots.push(root);
  const service = new ApplicationService({ dataDirectory: join(root, "data") }); await service.initialize();
  let shutdownRequests = 0;
  let announcePickerStarted!: () => void, releasePicker!: () => void;
  const pickerStarted = new Promise<void>(resolve => { announcePickerStarted = resolve; });
  const pickerGate = new Promise<void>(resolve => { releasePicker = resolve; });
  const port = await freePort();
  const server = await createLocalServer(service, {
    port, host: "127.0.0.1", dataDirectory: join(root, "data"),
    nativePicker: async () => { announcePickerStarted(); await pickerGate; return { cancelled: true, paths: [] }; },
    requestShutdown: () => { shutdownRequests += 1; },
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_missing");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const landing = await fetch(origin);
    const cookie = landing.headers.getSetCookie()[0]?.split(";", 1)[0];
    expect(cookie).toContain("tc_local=");
    const stopPath = `${origin}/api/v1/daemon/stop`;
    expect((await fetch(stopPath, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" })).status).toBe(403);
    const headers = { "Content-Type": "application/json", Origin: origin, Cookie: cookie! };
    const wrongEpoch = await fetch(stopPath, { method: "POST", headers, body: JSON.stringify({ confirmed: true, expectedEpoch: randomUUID() }) });
    expect(wrongEpoch.status).toBe(409); expect(shutdownRequests).toBe(0);

    const jobId = randomUUID();
    (service as any).jobs.set(jobId, { jobId, workspaceId: "workspace", kind: "planning.run", requestKey: randomUUID(), requestHash: "a".repeat(64), status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), planningId: randomUUID() });
    const busy = await fetch(stopPath, { method: "POST", headers, body: JSON.stringify({ confirmed: true, expectedEpoch: service.epoch }) });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: expect.stringContaining("daemon_busy"), canStop: false, activeJobs: [{ jobId, kind: "planning.run" }] });
    expect(shutdownRequests).toBe(0);
    (service as any).jobs.delete(jobId);

    const pickerRequest = fetch(`${origin}/api/v1/native-picker`, { method: "POST", headers, body: JSON.stringify({ kind: "directory" }) });
    await pickerStarted;
    const inFlight = await fetch(stopPath, { method: "POST", headers, body: JSON.stringify({ confirmed: true, expectedEpoch: service.epoch }) });
    expect(inFlight.status).toBe(409); expect(await inFlight.json()).toMatchObject({ activeMutations: 1 });
    releasePicker(); expect((await pickerRequest).status).toBe(200);

    const stopped = await fetch(stopPath, { method: "POST", headers, body: JSON.stringify({ confirmed: true, expectedEpoch: service.epoch }) });
    expect(stopped.status).toBe(202); expect(await stopped.json()).toMatchObject({ accepted: true, status: "stopping", epoch: service.epoch });
    const rejectedWrite = await fetch(`${origin}/api/v1/settings`, { method: "POST", headers, body: "{}" });
    expect(rejectedWrite.status).toBe(503);
    await expect.poll(() => shutdownRequests).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10_000);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_missing");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
