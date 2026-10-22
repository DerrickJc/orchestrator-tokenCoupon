import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { ApplicationService, type JobRecord } from "../src/application-service.js";
import { acquireDaemonOwner } from "../src/daemon-owner.js";
import { createLocalServer } from "../src/http-server.js";
import { runDaemonCli } from "../../cli/src/daemon-cli.js";
import { connectOwnedDaemon } from "@token-coupon/client/node";

async function finish(service: ApplicationService, job: JobRecord) {
  await expect.poll(async () => (await service.getJob(job.jobId)).status).not.toBe("running");
  const value = await service.getJob(job.jobId); expect(value.status, value.error).toBe("succeeded"); return value;
}
async function fixture() {
  const root = await mkdtemp(join(process.platform === "win32" ? homedir() : tmpdir(), ".tc-daemon-cli-"));
  if (process.platform === "win32") await promisify(execFile)("icacls.exe", [root, "/inheritance:r", "/grant:r", `${userInfo().username}:(OI)(CI)F`], { windowsHide: true });
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const dataDirectory = join(root, "profile"), release = await acquireDaemonOwner(dataDirectory, port);
  const service = new ApplicationService({ dataDirectory }); await service.initialize();
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory, ownerToken: release.token });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  return { root, service, dataDirectory, cleanup: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await service.shutdown(); await release(); await rm(root, { recursive: true, force: true }); } };
}

it("shares verified daemon state and receipts across CLI review, approval and execution", async () => {
  const h = await fixture(), stdout: string[] = [], stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(value => { stdout.push(String(value)); });
  const error = vi.spyOn(console, "error").mockImplementation(value => { stderr.push(String(value)); });
  try {
    await mkdir(join(h.root, "中文 项目")); const ws = await h.service.addWorkspace(join(h.root, "中文 项目"), "Shared CLI");
    const started = await finish(h.service, await h.service.startPlanning(ws.workspaceId, randomUUID(), { provider: "mock", request: "增加问候函数和测试", executionDefaults: { runnerId: "mock", mode: "managed" } }));
    const planningId = (started.result as { planningId: string }).planningId;
    const shared = ["--data-dir", h.dataDirectory], plan = ["--workspace-id", ws.workspaceId, "--planning-id", planningId, ...shared];
    const executable = await promisify(execFile)(process.execPath, [join(process.cwd(), "packages/cli/dist/main.js"), "daemon", "status", ...shared], { timeout: 10_000, windowsHide: true });
    expect(JSON.parse(executable.stdout).epoch).toBe(h.service.epoch);
    async function invoke(args: string[]) { stdout.length = 0; expect(await runDaemonCli(args), stderr.join("\n")).toBe(0); return JSON.parse(stdout.find(line => line.startsWith("{"))!); }
    const status = await invoke(["status", ...shared]); expect(status.epoch).toBe(h.service.epoch);
    expect(JSON.stringify(status)).not.toMatch(/token|Cookie|browser-session/);
    await invoke(["planning", "show", ...plan]);
    const reviewed = await invoke(["planning", "review", ...plan]); await finish(h.service, reviewed);
    const current = await h.service.planningView(ws, planningId);
    const approved = await invoke(["planning", "approve", ...plan, "--draft-revision", String(current.draft!.draftRevision)]); await finish(h.service, approved);
    const key = randomUUID();
    const run = await invoke(["planning", "run", ...plan, "--isolation", "shared", "--request-key", key]); await finish(h.service, run);
    const repeated = await invoke(["planning", "run", ...plan, "--isolation", "shared", "--request-key", key]); expect(repeated.jobId).toBe(run.jobId);
    const persisted = await h.service.planningView(ws, planningId); expect(persisted.session?.status).toBe("succeeded");
    const job = await invoke(["job", "show", "--id", run.jobId, ...shared]); expect(job.status).toBe("succeeded");
    const queue = await invoke(["pending", ...shared]); expect(queue.total).toBe(0);
    // The owner remains the same process and credential; CLI did not acquire a second owner.
    expect((JSON.parse(await readFile(join(h.dataDirectory, "daemon-owner.json"), "utf8"))).pid).toBe(process.pid);
  } finally { log.mockRestore(); error.mockRestore(); await h.cleanup(); }
}, 20_000);

it("rejects identity changes before writes, and never retries a request whose response was lost", async () => {
  const h = await fixture();
  try {
    const changed = (async (url: string | URL | Request, options?: RequestInit) => {
      const response = await fetch(url, options);
      if (String(url).endsWith("/api/v1/health")) { const value = await response.json(); return Response.json({ ...value, epoch: randomUUID() }); }
      return response;
    }) as typeof fetch;
    await expect(connectOwnedDaemon(h.dataDirectory, { fetch: changed })).rejects.toThrow("daemon_epoch_changed");
    let writes = 0;
    const lost = (async (url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === "POST") {
        writes++; const accepted = await fetch(url, options); expect(accepted.status).toBe(201); await accepted.body?.cancel();
        throw new Error("lost-response");
      }
      return fetch(url, options);
    }) as typeof fetch;
    const { client } = await connectOwnedDaemon(h.dataDirectory, { fetch: lost });
    await mkdir(join(h.root, "accepted"));
    await expect(client.commands.addWorkspace({ path: join(h.root, "accepted"), label: "Accepted once" })).rejects.toThrow("lost-response");
    expect(writes).toBe(1); expect(h.service.listWorkspaces()).toHaveLength(1);
  } finally { await h.cleanup(); }
}, 15_000);

it("fails closed when no owner exists and leaves the requested profile untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-cli-offline-")); const missing = join(root, "absent");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runDaemonCli(["status", "--data-dir", missing])).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("不会退回直接执行模式");
    await expect(readFile(join(missing, "daemon-owner.json"))).rejects.toThrow();
  } finally { error.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
