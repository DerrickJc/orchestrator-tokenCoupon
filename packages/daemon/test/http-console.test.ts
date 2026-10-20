import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";
import { runGit, SessionStore, PlannerStore, currentOwner } from "@token-coupon/core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("local web console API", () => {
  it("keeps ChatGPT unconnected explicit and completes an offline plan-review-approve-run flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-web-")); roots.push(root);
    const workspacePath = join(root, "workspace"); await mkdir(workspacePath);
    const dataDirectory = join(root, "daemon-data");
    const service = new ApplicationService({ dataDirectory }); await service.initialize();
    const port = await findPort();
    let nativeCalls = 0, nativeResult = { cancelled: false, paths: [workspacePath] };
    const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory, nativePicker: async () => { nativeCalls++; return nativeResult; } });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${port}`;
      const landing = await fetch(origin);
      expect(landing.status).toBe(200);
      const webManifest = JSON.parse(await readFile(join(process.cwd(), "packages/web/dist/.vite/manifest.json"), "utf8")) as Record<string, { file?: string }>;
      const builtScripts = [...new Set(Object.values(webManifest).map(entry => entry.file).filter((file): file is string => typeof file === "string" && file.endsWith(".js")))];
      expect(builtScripts.length).toBeGreaterThan(1);
      for (const asset of builtScripts) {
        const response = await fetch(`${origin}/${asset}`);
        expect(response.status, `missing built web asset ${asset}`).toBe(200);
        expect(response.headers.get("content-type")).toContain("javascript");
      }
      const cookie = landing.headers.getSetCookie()[0]?.split(";", 1)[0];
      expect(cookie).toContain("tc_local=");
      expect((await fetch(`${origin}/api/v1/health`)).status).toBe(403);
      const health = await fetch(`${origin}/api/v1/health`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { workspaceEnvironment: { currentDirectory: string; platform: string } };
      expect(health.workspaceEnvironment.currentDirectory).toBe(process.cwd());
      expect(health.workspaceEnvironment.platform).toBe(process.platform);
      expect((await fetch(`${origin}/api/v1/runners/mock/models`)).status).toBe(403);
      const mockModels = await fetch(`${origin}/api/v1/runners/mock/models`, { headers: { Cookie: cookie! } }).then(response=>response.json());
      expect(mockModels).toMatchObject({ source: "mock", models: [], customAllowed: false });
      const protectedWrite = await fetch(`${origin}/api/v1/workspaces`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ path: workspacePath }) });
      expect(protectedWrite.status).toBe(403);

      const invalidPath = await post(origin, cookie!, "/api/v1/workspaces", { path: "relative/project" });
      expect(invalidPath.status).toBe(400);
      expect((await invalidPath.json() as { error: string }).error).toContain("绝对目录");
      const workspaceResponse = await post(origin, cookie!, "/api/v1/workspaces", { path: `\"${workspacePath}\"`, label: "演示项目" });
      expect(workspaceResponse.status).toBe(201);
      const workspace = await workspaceResponse.json() as { workspaceId: string };
      expect((await fetch(`${origin}/api/v1/directories`)).status).toBe(403);
      const directories = await fetch(`${origin}/api/v1/directories?path=${encodeURIComponent(root)}`, { headers: { Cookie: cookie! } }).then(response => response.json()) as { entries: Array<{ name: string; path: string }> };
      expect(directories.entries.some(entry => entry.path === workspacePath)).toBe(true);
      const gitUrl = `/api/v1/workspaces/${workspace.workspaceId}/git`;
      expect((await fetch(`${origin}${gitUrl}`)).status).toBe(403);
      const missingGit = await fetch(`${origin}${gitUrl}`, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(missingGit.state).toBe("not_repository");
      const forbiddenInit = await post(origin, cookie!, gitUrl, { requestKey: randomUUID(), action: "initialize" });
      expect(forbiddenInit.status).toBe(400);
      await writeFile(join(workspacePath, "README.md"), "# Reference\n<script>preview is text</script>\n");
      await writeFile(join(workspacePath, ".env"), "SECRET=must-not-be-previewed");
      await writeFile(join(root, "outside.txt"), "outside sentinel");
      await symlink(join(root, "outside.txt"), join(workspacePath, "linked.md"));
      const nativeUrl = "/api/v1/native-picker";
      expect((await fetch(`${origin}${nativeUrl}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "directory" }) })).status).toBe(403);
      expect(nativeCalls).toBe(0);
      expect((await fetch(`${origin}${nativeUrl}`, { method: "POST", headers: { Cookie: cookie!, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "directory" }) })).status).toBe(403);
      expect(nativeCalls).toBe(0);
      expect(await (await post(origin, cookie!, nativeUrl, { kind: "directory" })).json()).toEqual({ cancelled: false, paths: [workspacePath] });
      nativeResult = { cancelled: true, paths: [] };
      expect(await (await post(origin, cookie!, nativeUrl, { kind: "directory" })).json()).toEqual({ cancelled: true, paths: [] });
      nativeResult = { cancelled: false, paths: [join(workspacePath, "README.md")] };
      expect(await (await post(origin, cookie!, nativeUrl, { kind: "files", workspaceId: workspace.workspaceId })).json()).toEqual({ cancelled: false, paths: ["README.md"] });
      nativeResult = { cancelled: false, paths: [join(workspacePath, ".env")] };
      expect((await post(origin, cookie!, nativeUrl, { kind: "files", workspaceId: workspace.workspaceId })).status).toBe(422);
      nativeResult = { cancelled: false, paths: [join(root, "outside.txt")] };
      expect((await post(origin, cookie!, nativeUrl, { kind: "files", workspaceId: workspace.workspaceId })).status).toBe(422);
      const repositoryUrl = `${origin}/api/v1/workspaces/${workspace.workspaceId}/repository`;
      expect((await fetch(repositoryUrl)).status).toBe(403);
      const listing = await fetch(repositoryUrl, { headers: { Cookie: cookie! } }).then(response => response.json()) as { entries: Array<{ name: string }> };
      expect(listing.entries.map(item => item.name)).toContain("README.md"); expect(listing.entries.map(item => item.name)).not.toContain(".env");
      const preview = await fetch(`${repositoryUrl}?tool=repo_read&path=README.md`, { headers: { Cookie: cookie! } }).then(response => response.json()) as { content: string; sha256: string };
      expect(preview.content).toContain("<script>preview is text</script>"); expect(preview.sha256).toMatch(/^[0-9a-f]{64}$/);
      for (const path of [".env", "../outside.txt", "linked.md"]) {
        const denied = await fetch(`${repositoryUrl}?tool=repo_read&path=${encodeURIComponent(path)}`, { headers: { Cookie: cookie! } });
        expect(denied.status).toBe(400); const text = await denied.text(); expect(text).not.toContain("outside sentinel"); expect(text).not.toContain("must-not-be-previewed");
      }
      const preparedMcp = await post(origin, cookie!, `/api/v1/workspaces/${workspace.workspaceId}/plannings`, {
        requestKey: randomUUID(), provider: "chatgpt-mcp", request: "登记独立需求", executionDefaults: { runnerId: "mock", mode: "managed" },
      });
      expect(preparedMcp.status).toBe(202);
      expect((await waitForJob(origin, cookie!, (await preparedMcp.json() as { jobId: string }).jobId)).status).toBe("succeeded");
      const providers = await fetch(`${origin}/api/v1/providers`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as Array<{ id: string; available: boolean }>;
      expect(providers.find((provider) => provider.id === "chatgpt-web")?.available).toBe(false);

      const browserRequest = await post(origin, cookie!, `/api/v1/workspaces/${workspace.workspaceId}/plannings`, {
        requestKey: randomUUID(), provider: "chatgpt-web", request: "Add a greeting function and tests.", executionDefaults: { runnerId: "mock", mode: "managed" },
      });
      expect(browserRequest.status).toBe(409);
      expect((await browserRequest.json() as { error: string }).error).toContain("browser_bridge_not_connected");

      const startPayload = { requestKey: randomUUID(), provider: "mock", model: "mock", request: "Add a greeting function and tests.", executionDefaults: { runnerId: "mock", mode: "managed" } };
      const start = await post(origin, cookie!, `/api/v1/workspaces/${workspace.workspaceId}/plannings`, startPayload);
      expect(start.status).toBe(202);
      const firstJob = await waitForJob(origin, cookie!, (await start.json() as { jobId: string }).jobId);
      expect(firstJob.status).toBe("succeeded");
      const duplicate = await post(origin, cookie!, `/api/v1/workspaces/${workspace.workspaceId}/plannings`, startPayload);
      expect((await duplicate.json() as { jobId: string }).jobId).toBe(firstJob.jobId);
      const planningId = (firstJob.result as { planningId: string }).planningId;
      const planUrl = `/api/v1/workspaces/${workspace.workspaceId}/plannings/${planningId}`;
      const draft = await fetch(`${origin}${planUrl}`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { draft: { draftRevision: number }; status: string };
      expect(draft.status).toBe("draft_ready");
      expect(draft.draft.draftRevision).toBe(1);
      const beforeReview = await post(origin, cookie!, `${planUrl}/approve`, { requestKey: randomUUID(), draftRevision: draft.draft.draftRevision });
      const beforeReviewJob = await waitForTerminalJob(origin, cookie!, (await beforeReview.json() as { jobId: string }).jobId);
      expect(beforeReviewJob.status).toBe("failed"); expect(beforeReviewJob.error).toContain("完成当前草案的审查");
      await service.publish({ type: "runner.output", workspaceId: workspace.workspaceId, planningId, payload: { text: "this plan output" } });
      await service.publish({ type: "runner.output", workspaceId: workspace.workspaceId, planningId: randomUUID(), payload: { text: "other plan output" } });
      expect((await fetch(`${origin}${planUrl}/events`)).status).toBe(403);
      const recentEvents = await fetch(`${origin}${planUrl}/events`, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(JSON.stringify(recentEvents)).toContain("this plan output"); expect(JSON.stringify(recentEvents)).not.toContain("other plan output");

      const reviewStart = await post(origin, cookie!, `${planUrl}/review`, { requestKey: randomUUID() });
      const reviewJob = await waitForJob(origin, cookie!, (await reviewStart.json() as { jobId: string }).jobId);
      expect(reviewJob.status).toBe("succeeded");
      const reviewed = await fetch(`${origin}${planUrl}`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { review: { current: boolean; reviewId: string; findings: Array<{ findingId: string; severity: string }> }; draft: { draftRevision: number } };
      expect(reviewed.review.current).toBe(true);

      const approved = await post(origin, cookie!, `${planUrl}/approve`, { requestKey: randomUUID(), draftRevision: reviewed.draft.draftRevision });
      const approvalJob = await waitForJob(origin, cookie!, (await approved.json() as { jobId: string }).jobId);
      expect(approvalJob.status).toBe("succeeded");
      const run = await post(origin, cookie!, `${planUrl}/run`, { requestKey: randomUUID(), isolation: "shared", maxParallel: 1 });
      const runJob = await waitForJob(origin, cookie!, (await run.json() as { jobId: string }).jobId);
      expect(runJob.status).toBe("succeeded");
      const completed = await fetch(`${origin}${planUrl}`, { headers: { Cookie: cookie! } }).then((response) => response.json()) as { session: { status: string; tasks: Array<{ status: string; attempts: Array<{ attemptId: string }>; currentAttempt: { runnerId: string } }> } };
      expect(completed.session.status).toBe("succeeded");
      expect(completed.session.tasks.every((task) => task.status === "succeeded")).toBe(true);
      expect(completed.session.tasks[0]!.currentAttempt.runnerId).toBe("mock");
      const resultsUrl = `${origin}${planUrl}/tasks/implement-request/files`;
      expect((await fetch(resultsUrl)).status).toBe(403);
      const results = await fetch(resultsUrl, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(results.source).toBe("unrecorded"); expect(results.files).toEqual([]);
      expect((await fetch(`${origin}${planUrl}/tasks/unknown/files`, { headers: { Cookie: cookie! } })).status).toBe(422);
      const attemptId = completed.session.tasks[0]!.attempts[0]!.attemptId;
      const attemptUrl = `${planUrl}/attempts/${attemptId}/events`;
      expect((await fetch(`${origin}${attemptUrl}`)).status).toBe(403);
      const firstPage = await fetch(`${origin}${attemptUrl}`, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(firstPage.events.length).toBeGreaterThan(0);
      expect((await fetch(`${origin}${planUrl}/attempts/${randomUUID()}/events`, { headers: { Cookie: cookie! } })).status).toBe(422);
      await appendFile(join(workspacePath, ".token-coupon", "runs", attemptId, "events.jsonl"), JSON.stringify({ attemptId, sequence: 9999, type: "runner.output", payload: { finalText: "持久化最终回复".repeat(1500) } }) + "\n");
      const resumedPage = await fetch(`${origin}${attemptUrl}?offset=${firstPage.cursor}&fileId=${encodeURIComponent(firstPage.fileId)}`, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(resumedPage.events[0].payload.finalText).toHaveLength(10500);
      const restarted = new ApplicationService({ dataDirectory }); await restarted.initialize();
      const afterRestart = await restarted.attemptEvents(workspace.workspaceId, planningId, attemptId, 0);
      expect(JSON.stringify(afterRestart.events)).toContain("持久化最终回复");
      // Reproduce the demo after a host restart: persisted running is not live execution.
      const checkpoint = await new PlannerStore(workspacePath).load(planningId);
      const store = new SessionStore(workspacePath), saved = await store.load(checkpoint.execution!.sessionId);
      const last = saved.snapshot.tasks.at(-1)!, staleId = last.attempts.at(-1)!.attemptId;
      const stalePath = join(workspacePath, ".token-coupon/runs", staleId, "attempt.json");
      const staleAttempt = { ...JSON.parse(await readFile(stalePath, "utf8")), status: "running", owner: { ...await currentOwner(), bootId: "before-restart" } };
      await writeFile(stalePath, JSON.stringify(staleAttempt));
      const staleSnapshot = { ...saved.snapshot, status: "running" as const, revision: saved.snapshot.revision + 1, activeAttemptIds: [staleId], tasks: saved.snapshot.tasks.map(task => task.taskId === last.taskId ? { ...task, status: "running" as const, result: null, activeAttemptId: staleId, attempts: task.attempts.map(ref => ref.attemptId === staleId ? { ...ref, outcome: "pending" as const } : ref) } : task) };
      await store.save(staleSnapshot);
      const observed = await fetch(`${origin}${planUrl}`, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(observed.session).toMatchObject({ status: "interrupted", savedStatus: "running", health: { state: "owner_exited", recoveryRequired: true } });
      expect(observed.workflow.label).toContain("中断"); expect(observed.session.tasks[0].status).toBe("succeeded");
      expect((await store.load(saved.snapshot.sessionId)).snapshot.status).toBe("running");
      const stalePage = await fetch(`${origin}${planUrl}/attempts/${staleId}/events`, { headers: { Cookie: cookie! } }).then(response => response.json());
      expect(stalePage.attempt).toMatchObject({ status: "interrupted", savedStatus: "running" });
      const repair = await post(origin, cookie!, `${planUrl}/session/recover`, { requestKey: randomUUID(), confirmedStopped: true });
      expect((await waitForJob(origin, cookie!, (await repair.json() as { jobId: string }).jobId)).status).toBe("succeeded");
      const retry = await post(origin, cookie!, `${planUrl}/session/retry`, { requestKey: randomUUID(), taskId: last.taskId });
      expect((await waitForJob(origin, cookie!, (await retry.json() as { jobId: string }).jobId)).status).toBe("succeeded");
      const resumed = await store.load(saved.snapshot.sessionId);
      expect(resumed.snapshot.status).toBe("succeeded"); expect(resumed.snapshot.tasks[0].attempts).toEqual(saved.snapshot.tasks[0].attempts);
      expect(resumed.snapshot.tasks.at(-1)!.attempts).toHaveLength(last.attempts.length + 1);
      const initPayload = { requestKey: randomUUID(), action: "initialize", confirmed: true };
      const init = await post(origin, cookie!, gitUrl, initPayload);
      const initJob = await waitForJob(origin, cookie!, (await init.json() as { jobId: string }).jobId);
      expect(initJob.result).toMatchObject({ state: "no_commit" });
      expect((await (await post(origin, cookie!, gitUrl, initPayload)).json() as { jobId: string }).jobId).toBe(initJob.jobId);
      await runGit(workspacePath, ["config", "user.name", "HTTP test"]); await runGit(workspacePath, ["config", "user.email", "http@example.invalid"]);
      const tracked = Array.from({ length: 65 }, (_, index) => `.token-coupon/legacy-${index}.json`);
      await Promise.all(tracked.map(path => writeFile(join(workspacePath, path), "local runtime record")));
      await runGit(workspacePath, ["add", "-f", "--", ...tracked]); await runGit(workspacePath, ["commit", "-m", "legacy records"]);
      const cleanupJob = await post(origin, cookie!, gitUrl, { requestKey: randomUUID(), confirmed: true, action: "untrack-runtime" });
      await waitForJob(origin, cookie!, (await cleanupJob.json() as { jobId: string }).jobId);
      const cleanupPreview = await (await post(origin, cookie!, `${gitUrl}/preview`, { mode: "runtime", paths: [] })).json() as { fingerprint: string; paths: string[] };
      expect(cleanupPreview.paths).toHaveLength(65);
      const commitJob = await post(origin, cookie!, `${gitUrl}/commit`, { requestKey: randomUUID(), confirmed: true, mode: "runtime", paths: cleanupPreview.paths, fingerprint: cleanupPreview.fingerprint, message: "stop tracking runtime" });
      const committed = await waitForJob(origin, cookie!, (await commitJob.json() as { jobId: string }).jobId);
      // Earlier read-only repository fixtures remain untracked; cleanup must not commit them.
      expect(committed.result).toMatchObject({ status: { state: "dirty" } });
      expect((await runGit(workspacePath, ["ls-files", "--", ".token-coupon"])).stdout).toBe("");
      expect((await runGit(workspacePath, ["ls-files", "--", "README.md", ".env", "linked.md"])).stdout).toBe("");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30_000);
});

async function post(origin: string, cookie: string, path: string, value: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(value) });
}
async function waitForJob(origin: string, cookie: string, jobId: string): Promise<{ jobId: string; status: string; result?: unknown }> {
  const job = await waitForTerminalJob(origin, cookie, jobId);
  if (job.status !== "succeeded") throw new Error(`Daemon job ${job.status}: ${job.error}`);
  return job;
}
async function waitForTerminalJob(origin: string, cookie: string, jobId: string): Promise<{ jobId: string; status: string; result?: unknown; error?: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await fetch(`${origin}/api/v1/jobs/${jobId}`, { headers: { Cookie: cookie } }).then((response) => response.json()) as { jobId: string; status: string; result?: unknown; error?: string };
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Daemon job did not finish: ${jobId}`);
}
async function findPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not get local port");
  const { port } = address; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port;
}
