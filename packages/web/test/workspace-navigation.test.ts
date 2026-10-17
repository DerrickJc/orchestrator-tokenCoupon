import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";

const windows: JSDOM[] = [];
afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 0)); for (const window of windows.splice(0)) window.window.close(); });
async function page(options: { hash?: string; ready?: boolean; empty?: boolean; approved?: boolean; pendingAuth?: boolean; gitState?: string; multiple?: boolean } = {}) {
  const [html, script] = await Promise.all([readFile(new URL("../public/index.html", import.meta.url), "utf8"), readFile(new URL("../public/app.js", import.meta.url), "utf8")]);
  const dom = new JSDOM(html, { url: `http://127.0.0.1:4177/${options.hash || ""}`, runScripts: "outside-only", pretendToBeVisual: true }); windows.push(dom);
  const w = dom.window, posts: Array<{ path: string; body: any }> = [], copied: string[] = [], reads: string[] = [];
  Object.assign(w, { Headers, EventSource: class { addEventListener() {} close() {} } });
  Object.defineProperty(w.crypto, "randomUUID", { value: randomUUID });
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  w.HTMLElement.prototype.scrollIntoView = () => undefined; w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const workspaces = options.empty ? [] : [{ workspaceId: "project", label: "排课后端", path: "/projects/排课后端" }];
  if (options.multiple) workspaces.push({ workspaceId: "other", label: "其他项目", path: "/projects/other" });
  const nativeCalls: any[] = [], nativeResults: any = { directory: { cancelled: false, paths: ["/projects/新项目"] }, files: { cancelled: false, paths: ["README.md"] } };
  let gitStatus: any = { state: options.gitState || "ready", message: options.gitState === "not_repository" ? "此文件夹还不是 Git 仓库" : "Git 已就绪", commands: ["git init"] };
  const tasks = [
    ["spec", "接口与数据库文档", []], ["backend", "实现后端", ["spec"]], ["frontend", "实现界面", ["backend"]],
    ["test", "集成测试", ["frontend"]], ["verify", "最终验证与交付", ["test"]],
  ].map(([id, title, dependsOn]: any) => ({ task: { schemaVersion: 1, id, title, prompt: "代码正文按需展开", execution: { runnerId: "mock", mode: "managed" } }, status: "planned", dependsOn }));
  const makePlan = (id: string) => ({ planningId: id, revision: 3, status: options.approved ? "approved" : "draft_ready", config: { provider: "web-mcp", model: "web-selected" }, messages: [{ messageId: "request", role: "user", content: `需求 ${id}` }], externalOperations: [], handoffs: [], review: { reviewId: "review-" + id, current: true, findings: [] }, ...(options.approved ? { approval: { planHash: id, draftRevision: 1, approvedAt: new Date().toISOString(), reviewId: "review-" + id } } : {}), verificationTasks: tasks.map((entry: any) => ({ taskId: entry.task.id, title: entry.task.title, valid: entry.task.id === "verify", reason: entry.task.id === "test" ? "最终验证任务 test 不能是其他任务的前置依赖" : undefined })), draft: { draftRevision: 1, planHash: id, plan: { schemaVersion: 1, id, title: `计划 ${id}`, tasks: structuredClone(tasks) } } });
  const plans = [makePlan("first"), makePlan("second")];
  let approvalRequests: any[] = options.pendingAuth ? [{ requestId: "auth-initial", clientId: "gpt-client", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", requestedScopes: ["planning:read", "planning:write"], createdAt: Date.now(), expiresAt: Date.now() + 60000 }] : [], grants: any[] = [];
  let remote: any = { enabled: !!options.ready, mode: "quick_tunnel", transport: options.ready ? "ready" : "stopped", gateway: options.ready ? "running" : "stopped", pendingApprovals: approvalRequests.length, validGrants: 0, workspaceIds: [], ...(options.pendingAuth ? { authorizationRequests: [{ requestId: "auth-initial", clientId: "gpt-client", clientName: "ChatGPT", createdAt: Date.now(), expiresAt: Date.now() + 60000, status: "pending" }] } : {}), ...(options.ready ? { publicOrigin: "https://existing.trycloudflare.com", mcpUrl: "https://existing.trycloudflare.com/mcp" } : {}) };
  w.fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw, w.location.origin), path = url.pathname;
    reads.push(path);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (path === "/api/v1/native-picker") { nativeCalls.push(body); return Response.json(nativeResults[body.kind]); }
      posts.push({ path, body });
      if (path === "/api/v1/workspaces") { const added = { workspaceId: "folder-project", path: body.path, label: body.label || "新项目" }; workspaces.push(added); return Response.json(added); }
      if (path.endsWith("/git")) { gitStatus = { state: body.action === "initialize" ? "no_commit" : "ready", message: body.action === "initialize" ? "Git 已初始化，但还没有首次提交" : "Git 已就绪", commands: [] }; return Response.json({ kind: "workspace.git.prepare", status: "succeeded", result: gitStatus }); }
      if (path.includes("/remote-connection/grants/")) { grants = grants.map(grant => grant.grantId === path.split("/").at(-1) ? { ...grant, ...body } : grant); return Response.json({ updated: true }); }
      if (path.endsWith("/remote-connection/test")) return Response.json(remote);
      if (path.endsWith("/approve")) {
        const plan = plans.find(item => path.includes(item.planningId))!;
        plan.status = "approved"; plan.approval = { planHash: plan.draft.planHash, draftRevision: 1, approvedAt: new Date().toISOString(), reviewId: plan.review.reviewId };
        return Response.json({ jobId: "approval-job", workspaceId: "project", kind: "planning.approve", status: "succeeded", result: { planningId: plan.planningId } });
      }
      if (path.endsWith("/run")) return Response.json({ jobId: "run-job", workspaceId: "project", kind: "planning.run", status: "succeeded", result: { planningId: path.split("/").at(-2) } });
      if (path.endsWith("/remote-connection/stop")) { grants = []; remote = { ...remote, enabled: false, transport: "stopped", gateway: "stopped", validGrants: 0, mcpUrl: undefined }; return Response.json(remote); }
      if (path.endsWith("/remote-connection/quick")) {
        const reuse = remote.enabled && remote.mode === "quick_tunnel" && remote.gateway === "running" && (body.port ?? 4178) === Number(new URL(remote.gatewayAddress || "http://127.0.0.1:4178").port);
        const publicOrigin = reuse ? remote.publicOrigin : "https://new.trycloudflare.com";
        remote = { ...remote, enabled: true, mode: "quick_tunnel", transport: "ready", gateway: "running", publicOrigin, mcpUrl: `${publicOrigin}/mcp`, gatewayAddress: `http://127.0.0.1:${body.port ?? 4178}` }; return Response.json(remote);
      }
      if (path.includes("/remote-connection/approvals/")) {
        const request = approvalRequests.find(item => item.requestId === path.split("/").at(-1));
        approvalRequests = approvalRequests.filter(item => item !== request); remote.pendingApprovals = approvalRequests.length;
        if (body.decision === "allow") grants.push({ grantId: randomUUID(), clientId: request.clientId, source: body.source, workspaceId: body.workspaceId, workspaceIds: [body.workspaceId], scopes: body.scopes, createdAt: Date.now(), expiresAt: Date.now() + 60000 });
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected POST ${path}`);
    }
    if (path.endsWith("/health")) return Response.json({ epoch: "test", workspaceEnvironment: { currentDirectory: "/projects" }, mcp: { localReady: true, url: "http://127.0.0.1:4177/mcp" } });
    if (path === "/api/v1/workspaces") return Response.json(workspaces);
    if (path.endsWith("/git")) return Response.json(gitStatus);
    if (path === "/api/v1/directories") { const path = url.searchParams.get("path") || "/projects"; return Response.json({ path, parent: "/", shortcuts: [{ label: "主目录", path: "/projects" }], entries: path === "/projects" ? [{ name: "新项目", path: "/projects/新项目" }] : [], nextOffset: null }); }
    if (path.endsWith("/providers")) return Response.json([{ id: "web-mcp", label: "网页 MCP", available: true }]);
    if (path.endsWith("/runners")) return Response.json([{ id: "mock", label: "Mock", available: true }]);
    if (path.endsWith("/models")) return Response.json({ models: [], customAllowed: true });
    if (path.endsWith("/remote-connection")) return Response.json(remote);
    if (path.endsWith("/grants")) return Response.json(grants);
    if (path.endsWith("/approvals")) return Response.json(approvalRequests);
    if (path.includes("/interactions/")) return Response.json([]);
    if (path.endsWith("/plannings")) return Response.json(plans);
    if (path.endsWith("/events")) return Response.json({ retainedWindow: true, events: [{ epoch: "test", sequence: 1, type: "runner.output", workspaceId: "project", planningId: "first", taskId: "implement", payload: { text: "本 Plan 已保存的输出" }, createdAt: new Date().toISOString() }] });
    if (path.includes("/plannings/")) return Response.json(plans.find(plan => plan.planningId === path.split("/").at(-1)));
    if (path.endsWith("/repository")) return url.searchParams.get("tool") === "repo_read" ? Response.json({ path: "README.md", startLine: 1, content: "1: <img src=x onerror=alert(1)>\n2: 项目说明", sha256: "a".repeat(64), truncated: false }) : Response.json({ path: ".", entries: [{ name: "README.md", type: "file" }], nextOffset: null });
    throw new Error(`unexpected GET ${path}`);
  };
  w.eval(script);
  const element = (id: string) => w.document.getElementById(id)!;
  const visible = (id: string) => { for (let node: Element | null = element(id); node; node = node.parentElement) if (node.classList.contains("hidden")) return false; return true; };
  await expect.poll(() => w.location.hash || element("toast").textContent).not.toBe("");
  await expect.poll(() => element("daemon-status").textContent).toContain("test");
  return { w, element, visible, posts, copied, plans, reads, workspaces, nativeCalls, setNativePicker: (kind: string, result: any) => { nativeResults[kind] = result; }, setGitStatus: (value: any) => { gitStatus = value; }, setGrants: (items: any[]) => { grants = items.map(item => ({ clientId: "gpt-client", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", scopes: ["planning:read"], createdAt: Date.now(), ...item })); }, setApprovals: (items: any[]) => { approvalRequests = items; remote.pendingApprovals = items.length; remote.authorizationRequests = items.map((item: any) => ({ requestId: item.requestId, clientId: item.clientId, clientName: item.clientName, createdAt: item.createdAt, expiresAt: item.expiresAt, status: "pending" })); }, setRemote: (patch: any) => { remote = { ...remote, ...patch }; } };
}

it("keeps workspace authorization visible after a grant and when transport is stopped", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  h.setGrants([{ grantId: "grant", workspaceIds: ["project"], source: "chatgpt" }]); h.element("refresh").click();
  await expect.poll(() => h.element("workspace-enable-access").textContent).toContain("已授权 1");
  expect(h.visible("workspace-enable-access")).toBe(true);
  h.setGrants([]); h.setRemote({ enabled: false, gateway: "stopped", transport: "stopped" }); h.element("refresh").click();
  await expect.poll(() => h.element("workspace-enable-access").textContent).toContain("查看／配置");
  expect(h.element("workspace-enable-access").disabled).toBe(false);
});

it("clears only connection errors during retry and recovery, preserving unrelated operation errors", async () => {
  const h = await page({ ready: true });
  await expect.poll(() => h.element("connection-reuse-status").textContent).toContain("入口可用");
  const message = "remote_probe_metadata：Cloudflare HTTP 530";
  h.setRemote({ transport: "error", lastError: message, probeCheck: { state: "failed", attempt: 1, maxAttempts: 3 } }); h.element("refresh").click();
  await expect.poll(() => h.visible("page-error")).toBe(true);
  expect(h.element("page-error").querySelector("strong")?.textContent).toBe("公网连接暂不可用");
  h.setRemote({ transport: "probing", busy: true, probeCheck: { state: "checking", attempt: 1, maxAttempts: 3 } }); h.element("refresh").click();
  await expect.poll(() => h.visible("page-error")).toBe(false);
  expect(h.visible("remote-error")).toBe(false);
  h.setRemote({ transport: "error", busy: false, probeCheck: { state: "failed", attempt: 3, maxAttempts: 3 } }); h.element("refresh").click();
  await expect.poll(() => h.visible("page-error")).toBe(true);
  h.setRemote({ transport: "ready", lastError: undefined, probeCheck: { state: "succeeded", attempt: 1, maxAttempts: 3 } }); h.element("refresh").click();
  await expect.poll(() => h.visible("page-error")).toBe(false);
  h.w.eval('showToast("独立的 Git 操作失败", true)'); h.element("refresh").click();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.visible("page-error")).toBe(true); expect(h.element("page-error-message").textContent).toBe("独立的 Git 操作失败");
});

it("explains cold-start validation and scheduled recovery without claiming readiness or hiding permanent failures", async () => {
  const h = await page({ ready: true });
  await expect.poll(() => h.element("connection-reuse-status").textContent).toContain("入口可用");
  h.setRemote({ transport: "reconnecting", busy: true, mcpUrl: undefined, startupReadiness: { startedAt: Date.now(), deadlineAt: Date.now() + 120000, round: 2 }, probeCheck: { state: "retrying", attempt: 3, maxAttempts: 3, lastError: "ECONNRESET" } }); h.element("refresh").click();
  await expect.poll(() => h.element("remote-status").textContent).toBe("新地址就绪检查中");
  expect(h.element("remote-progress").textContent).toContain("通过校验前入口不可用");
  expect(h.element("remote-progress").textContent).toContain("第 2 轮");
  expect((h.element("connection-next") as HTMLButtonElement).disabled).toBe(true);
  expect(h.visible("page-error")).toBe(false);
  h.setRemote({ transport: "error", busy: false, startupReadiness: undefined, nextProbeAt: Date.now() + 30000, lastError: "remote_probe_startup_timeout", probeCheck: { state: "failed" } }); h.element("refresh").click();
  await expect.poll(() => h.element("remote-progress").textContent).toContain("秒后自动复检");
  expect(h.visible("page-error")).toBe(true);
});

it("continues staged runtime cleanup through preview and explicit local commit without starting execution", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  h.setGitStatus({ state: "dirty", message: "运行记录已取消跟踪，待提交", changes: [{ path: ".token-coupon/conversation.json", code: "D ", runtime: true, staged: true }] });
  h.element("git-refresh").click();
  await expect.poll(() => h.element("run-configuration-error").textContent).toContain("待提交");
  const original = h.w.fetch; const writes: any[] = [];
  h.w.fetch = (async (url: string, init?: any) => {
    if (url.endsWith("/git/preview")) return Response.json({ mode: "runtime", paths: [".token-coupon/conversation.json"], fingerprint: "a".repeat(64), head: "b".repeat(40), suggestedMessage: "chore: stop tracking local runtime state", previews: [{ path: ".token-coupon/conversation.json", code: "D ", text: "本机文件保留" }] });
    if (url.endsWith("/git/commit")) { writes.push(JSON.parse(init.body)); h.setGitStatus({ state: "ready", message: "Git 已就绪" }); return Response.json({ status: "succeeded", kind: "workspace.git.commit", result: { commit: "c".repeat(40) } }); }
    return original(url, init);
  }) as any;
  h.element("git-readiness-actions").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.element("git-preview-dialog").hasAttribute("open")).toBe(true);
  expect(writes).toHaveLength(0);
  h.element("git-confirm-commit").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ confirmed: true, mode: "runtime", fingerprint: "a".repeat(64) });
  await expect.poll(() => h.element("git-commit-result").textContent).toContain("cccccccc");
  expect(h.posts.some(post => post.path.endsWith("/run"))).toBe(false);
});

it("shows per-task model facts and restores readable long replies with final-text deduplication", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const attemptId = randomUUID(), body = "中文正文\n```js\nconst x = 1;\n```\n" + "完整返回".repeat(1600);
  const events = [
    { sequence: 1, type: "message.delta", payload: { messageId: "m", root: true, text: body.slice(0, 90) } },
    { sequence: 2, type: "runner.output", payload: { text: body.slice(0, 90), displayText: body.slice(0, 90), structuredEvent: { type: "codex.message.delta" } } },
    { sequence: 3, type: "message.delta", payload: { messageId: "m", root: true, text: body.slice(90) } },
    { sequence: 4, type: "message.completed", payload: { messageId: "m", root: true, text: body } },
    { sequence: 5, type: "runner.output", payload: { text: "", displayText: "", finalText: body } },
    { sequence: 6, type: "command.completed", payload: { command: "node --test", exitCode: 0, outputSummary: "2 tests passed" } },
    { sequence: 7, type: "runner.output", payload: { stream: "stderr", text: "diagnostic only" } },
  ];
  const attempt = { attemptId, status: "succeeded", runnerId: "codex", execution: { modelId: "configured-model" }, reportedModel: "reported-model", exitCode: 0 };
  const original = h.w.fetch; let reads = 0;
  h.w.fetch = (async (raw: string, init?: any) => { if (raw.includes("/attempts/")) { reads++; return Response.json({ attempt, taskId: "spec", fileId: "file-1", cursor: 9000, hasMore: false, events }); } return original(raw, init); }) as any;
  (h.plans[0] as any).session = { status: "succeeded", maxParallel: 2, tasks: [{ taskId: "spec", title: "接口设计", status: "succeeded", attempts: [{ attemptId }], currentAttempt: attempt }] };
  h.element("refresh").click();
  await expect.poll(() => h.element("attempt-messages").textContent).toContain(body);
  expect(h.element("attempt-messages").querySelectorAll("article")).toHaveLength(1);
  expect(h.element("attempt-messages").textContent).not.toContain("diagnostic only");
  expect(h.element("attempt-tools").textContent).toContain("2 tests passed");
  expect(h.element("task-list").textContent).toContain("reported-model（Runner 已报告）");
  expect(h.element("session-progress").textContent).toContain("成功 1/1");
  expect(reads).toBe(1);
  h.element("attempt-refresh").click(); await expect.poll(() => reads).toBe(2);
  expect(h.element("attempt-messages").querySelectorAll("article")).toHaveLength(1);
  expect(h.posts.some(post => post.path.endsWith("/run"))).toBe(false);
});

it("keeps concurrent task outputs separate and preserves an in-progress answer on refresh", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const first = randomUUID(), second = randomUUID();
  (h.plans[0] as any).session = { status: "running", maxParallel: 2, tasks: [
    { taskId: "spec", title: "编写文档", status: "running", activeAttemptId: first, attempts: [{ attemptId: first }], currentAttempt: { runnerId: "codex", execution: { modelId: "configured-a" } } },
    { taskId: "backend", title: "实现后端", status: "running", activeAttemptId: second, attempts: [{ attemptId: second }], currentAttempt: { runnerId: "claude-code", execution: {} } },
  ] };
  const original = h.w.fetch;
  const interaction = [{ requestId: "ask", owner: { runnerId: "codex", taskId: "spec" }, request: { kind: "question", title: "确认范围", questions: [{ id: "q1", text: "是否继续？" }] } }];
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/attempts/")) { const isFirst = raw.includes(first); return Response.json({ attempt: { status: "running" }, taskId: isFirst ? "spec" : "backend", fileId: "log", cursor: 100, hasMore: false, events: [{ sequence: 1, type: "runner.output", payload: { stream: "stdout", finalText: isFirst ? "文档返回" : "后端返回" } }] }); }
    if (raw.includes("/interactions/")) return Response.json(interaction);
    return original(raw, init);
  }) as any;
  h.element("refresh").click();
  await expect.poll(() => h.element("attempt-messages").textContent).toContain("文档返回");
  expect(h.element("task-list").textContent).toContain("configured-a（配置模型）");
  expect(h.element("task-list").textContent).toContain("实际模型未报告");
  await expect.poll(() => h.element("interaction-list").querySelector("input")).not.toBeNull();
  const answer = h.element("interaction-list").querySelector("input")!; answer.value = "保留我的输入";
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 40));
  expect(h.element("interaction-list").querySelector("input")).toBe(answer); expect(answer.value).toBe("保留我的输入");
  (h.element("attempt-select") as HTMLSelectElement).value = second; h.element("attempt-select").dispatchEvent(new h.w.Event("change"));
  await expect.poll(() => h.element("attempt-messages").textContent).toContain("后端返回");
  expect(h.element("attempt-messages").textContent).not.toContain("文档返回");
});

it("keeps commit failures visible inside the preview dialog and preserves the chosen message", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 first");
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/git/preview")) return Response.json({ mode: "runtime", head: "a".repeat(40), paths: [".token-coupon/log.json"], fingerprint: "b".repeat(64), suggestedMessage: "keep this", previews: [] });
    if (raw.endsWith("/git/commit")) return Response.json({ status: "failed", error: "git_preview_stale：请重新预览", kind: "workspace.git.commit" });
    return original(raw, init);
  }) as any;
  h.w.eval('void previewGitFromUI("runtime")');
  await expect.poll(() => h.element("git-preview-dialog").hasAttribute("open")).toBe(true);
  h.element("git-confirm-commit").click();
  await expect.poll(() => h.element("git-preview-error").textContent).toContain("请重新预览");
  expect(h.element("git-preview-dialog").hasAttribute("open")).toBe(true);
  expect((h.element("git-commit-message") as HTMLInputElement).value).toBe("keep this");
});

it("starts at connection setup, reuses an existing tunnel, then opens a workspace and an individual plan", async () => {
  const h = await page({ ready: true });
  await expect.poll(() => h.visible("connection-reuse")).toBe(true);
  expect(h.visible("workspaces-page")).toBe(false); expect(h.visible("planning-panel")).toBe(false);
  h.element("remote-reuse").click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces");
  expect(h.posts).toHaveLength(0);
  h.element("workspace-cards").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.visible("workspace-detail")).toBe(true);
  expect(h.visible("remote-connection")).toBe(false); expect(h.visible("planning-panel")).toBe(false);
  await expect.poll(() => h.element("workspace-plan-cards").querySelectorAll("button").length).toBe(2);
  h.element("workspace-plan-cards").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first");
  expect(h.visible("overview-tab")).toBe(true); expect(h.visible("draft-tab")).toBe(false);
  expect(h.visible("workspaces-page")).toBe(false);
  expect((h.element("conversation-details") as HTMLDetailsElement).open).toBe(false);
  h.w.document.querySelector<HTMLButtonElement>('[data-plan-tab="draft"]')!.click();
  await expect.poll(() => h.visible("draft-tab")).toBe(true);
  expect(h.element("plan-view").querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
  h.element("refresh").click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/draft");
  expect(h.posts).toHaveLength(0);
});

it("can establish transport without any registered workspace and never implies project authorization", async () => {
  const h = await page({ empty: true });
  await expect.poll(() => (h.element("remote-quick") as HTMLButtonElement).disabled).toBe(false);
  (h.element("quick-consent") as HTMLInputElement).checked = true; h.element("remote-quick").click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/remote-connection/quick", body: { connectionOnly: true, consent: true } });
  expect(h.posts[0]!.body.workspaceId).toBeUndefined();
  await expect.poll(() => (h.element("connection-next") as HTMLButtonElement).disabled).toBe(false);
  h.element("connection-next").click(); await expect.poll(() => h.visible("workspaces-page")).toBe(true);
  expect(h.element("workspace-cards").textContent).toContain("添加一个项目");
});

it("restores the exact plan from a deep link and copies a continuation prompt for a new webpage conversation", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/second/review", ready: true });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 second");
  expect(h.visible("review-tab")).toBe(true); expect(h.visible("overview-tab")).toBe(false);
  h.w.document.querySelector<HTMLButtonElement>('[data-plan-tab="overview"]')!.click(); h.element("copy-plan-resume").click();
  await expect.poll(() => h.copied.length).toBe(1);
  expect(h.copied[0]).toContain("planningId：second"); expect(h.copied[0]).toContain("不新建 Planning");
  expect(h.copied[0]).toContain("planning_query"); expect(h.posts).toHaveLength(0);
  h.w.history.back(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/second/review");
  await expect.poll(() => h.visible("review-tab")).toBe(true);
});

it("selects only the graph-valid final verifier and requires an explicit run after approval", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  const options = [...h.element("run-verification").querySelectorAll("option")].map(item => (item as HTMLOptionElement).value);
  expect(options).toEqual(["verify"]);
  expect((h.element("run-verification") as HTMLSelectElement).value).toBe("verify");
  expect(h.posts.some(item => item.path.endsWith("/run"))).toBe(false);
  expect(h.element("run-configuration-summary").textContent).toContain("沿用 Runner 自身配置");
  await expect.poll(() => (h.element("run-button") as HTMLButtonElement).disabled).toBe(false);
  h.element("run-button").click();
  await expect.poll(() => h.posts.some(item => item.path.endsWith("/run"))).toBe(true);
  expect(h.posts.find(item => item.path.endsWith("/run"))!.body).toMatchObject({ isolation: "git-worktree", maxParallel: 1, verificationTaskId: "verify" });
});

it("moves to execution setup after approval and never launches until the user confirms the run", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/second/review", ready: true });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 second");
  await expect.poll(() => h.element("approve-button").disabled).toBe(false);
  h.element("approve-button").click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/second/execution");
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  expect(h.element("run-configuration-status").textContent).toContain("待配置");
  expect(h.posts.some(item => item.path.endsWith("/run"))).toBe(false);
});

it("preserves custom launch settings and protects them before opening a new OAuth request", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  const custom = h.w.document.querySelector<HTMLInputElement>('input[name="run-mode-choice"][value="custom"]')!;
  custom.checked = true; custom.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  (h.element("run-isolation") as HTMLSelectElement).value = "shared"; h.element("run-isolation").dispatchEvent(new h.w.Event("change"));
  expect((h.element("run-parallel") as HTMLSelectElement).value).toBe("1");
  h.setApprovals([{ requestId: "auth-during-edit", clientId: "gpt-client", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", requestedScopes: ["planning:read"], createdAt: Date.now(), expiresAt: Date.now() + 60000 }]);
  h.element("refresh").click(); await expect.poll(() => h.element("authorization-arrival").classList.contains("hidden")).toBe(false);
  expect(h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
  h.element("authorization-arrival-open").click();
  await expect.poll(() => h.element("unsaved-local-state-dialog").hasAttribute("open")).toBe(true);
  h.element("local-state-cancel").click(); await expect.poll(() => h.element("unsaved-local-state-dialog").hasAttribute("open")).toBe(false);
  expect(h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
  h.element("authorization-arrival-open").click();
  await expect.poll(() => h.element("unsaved-local-state-dialog").hasAttribute("open")).toBe(true);
  h.element("local-state-keep").click(); await expect.poll(() => h.w.location.hash).toBe("#/connect");
  expect(h.element("connection-return-plan").classList.contains("hidden")).toBe(false);
});

it("preserves each pending OAuth form when a second webpage connection arrives", async () => {
  const h = await page({ ready: true });
  const request = (id: string) => ({ requestId: id, clientId: "client-" + id, clientName: id, redirectHost: "https://chatgpt.com", requestedScopes: ["planning:read", "planning:write"], createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  h.setApprovals([request("first")]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelectorAll("[data-request-id]").length).toBe(1);
  const first = h.element("remote-approvals").querySelector<HTMLElement>('[data-request-id="first"]')!;
  (first.querySelector(".remote-source-select") as HTMLSelectElement).value = "claude";
  (first.querySelector('input[value="planning:write"]') as HTMLInputElement).checked = true;
  h.setApprovals([request("first"), request("second")]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelectorAll("[data-request-id]").length).toBe(2);
  const rebuilt = h.element("remote-approvals").querySelector<HTMLElement>('[data-request-id="first"]')!;
  expect((rebuilt.querySelector(".remote-source-select") as HTMLSelectElement).value).toBe("claude");
  expect((rebuilt.querySelector('input[value="planning:write"]') as HTMLInputElement).checked).toBe(true);
});

it("keeps expired OAuth requests visible as safe history and identifies them as expired", async () => {
  const h = await page({ ready: true });
  h.setRemote({ authorizationRequests: [{ requestId: "expired-request", clientId: "old-client", clientName: "ChatGPT", createdAt: Date.now() - 180000, expiresAt: Date.now() - 60000, status: "expired" }] });
  h.element("refresh").click();
  h.w.document.querySelector<HTMLButtonElement>('[data-connection-tab="authorization"]')!.click();
  (h.element("connection-records") as HTMLDetailsElement).open = true;
  await expect.poll(() => h.visible("remote-approval-history")).toBe(true);
  expect(h.element("remote-approval-history-list").textContent).toContain("已过期");
  expect(h.element("remote-approval-history-list").textContent).toContain("expired-");
});

it("browses files as text and carries only the selected relative reference into a new planning prompt", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => h.visible("workspace-detail")).toBe(true);
  h.element("workspace-open-file").click(); await expect.poll(() => h.element("file-list").querySelectorAll("button").length).toBe(1);
  h.element("file-list").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.element("file-preview").textContent).toContain("<img");
  expect(h.element("file-preview").querySelector("img")).toBeNull();
  h.element("file-use").click(); await expect.poll(() => h.visible("composer-page")).toBe(true);
  expect(h.element("reference-summary").textContent).toContain("README.md");
  h.element("copy-web-planning").click(); await expect.poll(() => h.copied.length).toBe(1);
  expect(h.copied[0]).toContain('"README.md"'); expect(h.copied[0]).not.toContain("<img");
  expect(h.copied[0]).toContain("审查一次"); expect(h.posts).toHaveLength(0);
});

it("guards browser navigation from a dirty draft and keeps the accepted plan route when changes are cancelled", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/draft", ready: true });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 first");
  h.element("toggle-plan-edit").click(); const editor = h.element("plan-editor") as HTMLTextAreaElement;
  editor.value = editor.value.replace("计划 first", "未保存"); editor.dispatchEvent(new h.w.Event("input"));
  h.w.location.hash = "/connect";
  await expect.poll(() => h.element("unsaved-plan-dialog").hasAttribute("open")).toBe(true);
  h.element("unsaved-plan-cancel").click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/draft");
  expect(h.visible("draft-tab")).toBe(true); expect(editor.value).toContain("未保存"); expect(h.posts).toHaveLength(0);
});

it("loads persisted plan events only when expanded and keeps mobile navigation separate from the plan", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true });
  await expect.poll(() => h.visible("execution-tab")).toBe(true);
  expect(h.reads.some(path => path.endsWith("/events"))).toBe(false);
  (h.element("plan-logs-details") as HTMLDetailsElement).open = true;
  await expect.poll(() => h.element("event-log").textContent).toContain("本 Plan 已保存的输出");
  h.element("mobile-navigation").click(); expect(h.w.document.body.classList.contains("navigation-open")).toBe(true);
  h.element("nav-backdrop").click(); expect(h.w.document.body.classList.contains("navigation-open")).toBe(false);
  expect(h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
});


it("auto-navigates only for this connection attempt, clears selection, and never opens a unique workspace", async () => {
  const h = await page();
  (h.element("quick-consent") as HTMLInputElement).checked = true; h.element("remote-quick").click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces");
  expect(h.visible("workspace-detail")).toBe(false); expect(h.visible("planning-panel")).toBe(false);
  expect(h.element("workspace-connection-summary").textContent).toContain("未选择工作区");
  expect(h.element("workspace-connection-summary").textContent).toContain("网页待授权");
  expect(h.reads.some(path => path.endsWith("/plannings"))).toBe(false);
  h.element("workspace-cards").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.visible("workspace-detail")).toBe(true);
  h.setRemote({ transport: "probing", busy: true }); h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  h.setRemote({ transport: "ready", busy: false }); h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.w.location.hash).toBe("#/workspaces/project");
  h.w.document.querySelector<HTMLButtonElement>('[data-route="/workspaces"]')!.click();
  await expect.poll(() => h.visible("workspace-detail")).toBe(false);
});

it("never navigates on initial readiness, background probes, failed attempts or explicit connection management", async () => {
  const h = await page({ ready: true });
  h.setRemote({ transport: "probing", busy: true }); h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  h.setRemote({ transport: "ready", busy: false }); h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.w.location.hash).toBe("#/connect");
  h.setRemote({ authorizationStates: [{ source: "chatgpt", workspaceIds: ["project"], status: "expired" }, { source: "claude", workspaceIds: ["project"], status: "revoked" }] });
  h.element("refresh").click(); await expect.poll(() => h.element("workspace-connection-summary").textContent).toContain("chatgpt 授权已过期");
  expect(h.element("workspace-connection-summary").textContent).toContain("claude 授权已撤销");
  h.element("connection-manage").click(); (h.element("quick-consent") as HTMLInputElement).checked = true; h.element("remote-quick").click();
  await expect.poll(() => h.posts.length).toBe(1); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.w.location.hash).toBe("#/connect");
  const failed = await page();
  failed.w.fetch = async () => Response.json({ error: "probe_failed" }, { status: 503 });
  (failed.element("quick-consent") as HTMLInputElement).checked = true; failed.element("remote-quick").click();
  await expect.poll(() => failed.element("remote-error").textContent).toBeTruthy();
  expect(failed.w.location.hash).toBe("#/connect"); expect(failed.element("workspace-connection-summary").textContent).toContain("暂不可用");
});


it("opens the local authorization card for a pending request and does not treat a public URL change as its status", async () => {
  const h = await page({ ready: true });
  h.setRemote({ addressChanged: true, previousMcpUrl: "https://old.trycloudflare.com/mcp" });
  h.setApprovals([{ requestId: "auth", clientId: "gpt-client", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", requestedScopes: ["planning:read", "planning:write"], createdAt: Date.now(), expiresAt: Date.now() + 60000 }]);
  h.element("refresh").click(); await expect.poll(() => h.element("remote-approvals").querySelectorAll("button").length).toBe(2);
  expect(h.w.location.hash).toBe("#/connect");
  expect(h.element("connection-action-title").textContent).toContain("已收到网页授权请求");
  expect(h.element("authorization-arrival").classList.contains("hidden")).toBe(false);
  expect(h.element("remote-approvals").querySelector("article")!.classList.contains("authorization-arrived")).toBe(true);
  const card = h.element("remote-approvals").querySelector("article")!;
  const source = card.querySelector("select")!; source.value = "chatgpt";
  const workspace = card.querySelector<HTMLSelectElement>(".remote-workspace-select")!; workspace.value = "project";
  for (const permission of card.querySelectorAll<HTMLInputElement>('input[value="planning:read"],input[value="planning:write"]')) { expect(permission.checked).toBe(false); permission.checked = true; }
  card.dispatchEvent(new h.w.Event("change", { bubbles: true })); [...card.querySelectorAll("button")].find(button => button.textContent === "授权所选权限")!.click();
  await expect.poll(() => h.element("workspace-connection-summary").textContent).toContain("chatgpt 已授权");
  expect(h.w.location.hash).toBe("#/connect");
  expect(h.visible("workspace-detail")).toBe(false);
  expect(h.element("workspace-connection-summary").textContent).toContain("chatgpt 已授权");
  expect(h.element("workspace-connection-summary").textContent).toContain("未选择工作区");
});

it("keeps stale-URL recovery visible after reuse and compares the webpage URL without probing or mutating plans", async () => {
  const h = await page({ ready: true });
  h.setRemote({ addressChanged: true, previousMcpUrl: "https://old.trycloudflare.com/mcp", lastProbeAt: Date.now(), remoteClientVerified: false, clients: [{ name: "demo5", status: "revoked", source: "chatgpt", mcpUrl: "https://old.trycloudflare.com/mcp", workspaceIds: ["project"] }] });
  h.element("refresh").click();
  await expect.poll(() => h.element("connection-action-title").textContent).toContain("地址已变化");
  expect(h.element("connection-action-description").textContent).toContain("https://old.trycloudflare.com/mcp");
  expect(h.element("connection-client-count").textContent).toBe("0 个有效 · 1 个历史");
  expect((h.element("connection-history") as HTMLDetailsElement).open).toBe(false);
  expect(h.element("connection-history-clients").textContent).toContain("demo5");
  h.element("remote-reuse").click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces");
  expect(h.visible("connection-action-needed")).toBe(true);
  expect(h.element("connection-action-description").textContent).toContain("你已复用该公网入口");
  expect(h.visible("workspace-detail")).toBe(false);
  h.element("connection-repair").click(); await expect.poll(() => h.w.location.hash).toBe("#/connect");
  const input = h.element("connection-client-url") as HTMLInputElement;
  input.value = "https://old.trycloudflare.com/mcp"; h.element("connection-compare-url").click();
  expect(h.element("connection-url-result").textContent).toContain("地址不一致");
  input.value = "https://existing.trycloudflare.com/mcp"; h.element("connection-compare-url").click();
  expect(h.element("connection-url-result").textContent).toContain("地址与当前入口一致");
  input.value = "https://user:secret@existing.trycloudflare.com/mcp"; h.element("connection-compare-url").click();
  expect(h.element("connection-url-result").textContent).toContain("不带凭据");
  h.element("connection-copy-current").click(); await expect.poll(() => h.copied.length).toBe(1);
  expect(h.copied[0]).toBe("https://existing.trycloudflare.com/mcp");
  expect(h.posts).toHaveLength(0);
});

it("distinguishes valid OAuth from actual webpage calls and retains explicit navigation back to the original plan", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/second/review" });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 second");
  const client = { name: "ChatGPT <img src=x onerror=alert(1)>", status: "active", source: "chatgpt", workspaceIds: ["project"], mcpUrl: "https://existing.trycloudflare.com/mcp" };
  h.setGrants([{ ...client, grantId: "grant", expiresAt: Date.now() + 60000 }]);
  h.setRemote({ validGrants: 1, remoteClientVerified: false, clients: [client], recentCalls: [], probeCheck: { state: "checking", attempt: 1, maxAttempts: 3, background: true, startedAt: Date.now() } });
  h.element("refresh").click();
  await expect.poll(() => h.element("connection-action-title").textContent).toContain("已授权，可以发起一次验证提示");
  expect(h.w.location.hash).toBe("#/workspaces/project/plans/second/review");
  expect(h.element("connection-current-clients").querySelector("img")).toBeNull();
  expect(h.visible("connection-repair")).toBe(false); expect(h.visible("connection-copy-current")).toBe(false);
  expect(h.visible("connection-action-description")).toBe(false);
  h.element("connection-verify-web").click(); await expect.poll(() => h.copied.length).toBe(1);
  expect(h.copied[0]).toContain("workspace_query"); expect(h.copied[0]).toContain("planningId=second");
  expect(h.copied[0]).toContain("不创建 Planning"); expect(h.copied[0]).toContain("不领取或提交审查");
  const lastCall = { traceId: "safe-trace", at: Date.now(), stage: "tool", outcome: "success", tool: "workspace_query", httpStatus: 200 };
  h.setRemote({ remoteClientVerified: true, clients: [{ ...client, lastCall }], recentCalls: [lastCall], probeCheck: { state: "succeeded", attempt: 1, maxAttempts: 3, background: true, startedAt: Date.now() } });
  h.element("refresh").click(); await expect.poll(() => h.visible("connection-action-needed")).toBe(false);
  await expect.poll(() => h.element("connection-current-clients").textContent).toContain("最近工具调用成功");
  expect(h.element("connection-recent-calls").textContent).toContain("safe-trace");
  h.element("plan-workspace-access").click(); await expect.poll(() => h.visible("connection-return-plan")).toBe(true);
  expect(h.w.location.hash).toBe("#/connect");
  h.element("connection-return-plan").click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/second/review");
  expect(h.posts).toHaveLength(0);
});

it("shows bounded retry progress while preserving a ready background connection", async () => {
  const h = await page({ ready: true });
  h.setRemote({ probeCheck: { state: "retrying", attempt: 2, maxAttempts: 3, background: true, startedAt: Date.now(), retryAt: Date.now() + 1000, lastError: "remote_probe_network：ECONNRESET" } });
  h.element("refresh").click();
  await expect.poll(() => h.element("connection-check-details").textContent).toContain("检查 2/3");
  expect((h.element("connection-next") as HTMLButtonElement).disabled).toBe(false);
  expect(h.element("workspace-connection-summary").textContent).toContain("公网入口可用");
  expect(h.w.location.hash).toBe("#/connect"); expect(h.posts).toHaveLength(0);
});

it("marks unavailable authorization data as unknown instead of inferring a successful or missing grant", async () => {
  const h = await page({ ready: true });
  const fetcher = h.w.fetch;
  h.w.fetch = (async (input: string, init?: RequestInit) => input.includes("remote-connection/grants") ? Response.json({ error: "temporary" }, { status: 503 }) : fetcher(input, init)) as typeof h.w.fetch;
  h.element("refresh").click();
  await expect.poll(() => h.element("connection-action-title").textContent).toContain("授权状态暂不可用");
  expect(h.element("connection-action-description").textContent).toContain("无需重建隧道");
  expect(h.element("connection-client-count").textContent).toContain("暂不可用");
  expect(h.w.location.hash).toBe("#/connect"); expect(h.posts).toHaveLength(0);
});

it("retests the existing quick address without recreating the connection, revoking grants or navigating", async () => {
  const h = await page({ ready: true });
  h.setGrants([{ grantId: "grant", source: "chatgpt", workspaceIds: ["project"], expiresAt: Date.now() + 60000 }]);
  h.setRemote({ validGrants: 1 }); h.element("refresh").click();
  await expect.poll(() => h.element("connection-client-count").textContent).toContain("1 个有效");
  expect(h.element("reuse-mcp-address").textContent).toBe("https://existing.trycloudflare.com/mcp");
  expect(h.element("quick-address-policy").textContent).toContain("重启应用");
  expect((h.element("remote-lifecycle") as HTMLDetailsElement).open).toBe(false);
  h.element("reuse-test").click(); await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toEqual({ path: "/api/v1/remote-connection/test", body: {} });
  await expect.poll(() => (h.element("reuse-test") as HTMLButtonElement).disabled).toBe(false);
  expect(h.element("reuse-mcp-address").textContent).toBe("https://existing.trycloudflare.com/mcp");
  expect(h.element("connection-client-count").textContent).toContain("1 个有效");
  expect(h.w.location.hash).toBe("#/connect");
});

it("requires confirmation to stop and starts a new address only on a later explicit create action", async () => {
  const h = await page({ ready: true });
  await expect.poll(() => (h.element("remote-stop") as HTMLButtonElement).disabled).toBe(false);
  h.element("connection-manage").click(); (h.element("remote-lifecycle") as HTMLDetailsElement).open = true;
  h.element("remote-stop").click(); expect(h.posts).toHaveLength(0);
  await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.element("confirm-action-description").textContent).toContain("撤销现有网页授权");
  h.element("confirm-action-no").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(false);
  expect(h.element("reuse-mcp-address").textContent).toBe("https://existing.trycloudflare.com/mcp");
  h.element("remote-stop").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => h.element("remote-quick").textContent).toBe("新建快捷连接");
  expect(h.posts.map(item => item.path)).toEqual(["/api/v1/remote-connection/stop"]);
  expect((h.element("remote-test") as HTMLButtonElement).disabled).toBe(true);
  (h.element("quick-consent") as HTMLInputElement).checked = true; h.element("remote-quick").click();
  await expect.poll(() => h.element("reuse-mcp-address").textContent).toBe("https://new.trycloudflare.com/mcp");
  expect(h.posts.map(item => item.path)).toEqual(["/api/v1/remote-connection/stop", "/api/v1/remote-connection/quick"]);
  expect(h.w.location.hash).toBe("#/connect");
});

it("confirms port changes while adding a workspace directly to the existing grant preserves the address", async () => {
  const h = await page({ ready: true });
  await expect.poll(() => (h.element("remote-quick") as HTMLButtonElement).disabled).toBe(false);
  h.element("connection-manage").click();
  (h.element("quick-consent") as HTMLInputElement).checked = true;
  (h.element("remote-port") as HTMLInputElement).value = "4188";
  h.element("remote-quick").click(); expect(h.posts).toHaveLength(0);
  await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.element("confirm-action-description").textContent).toContain("地址可能变化"); h.element("confirm-action-no").click();
  h.setGrants([{ grantId: "existing", source: "chatgpt", workspaceIds: ["other"], expiresAt: Date.now() + 60000 }]);
  h.element("remote-refresh").click(); await expect.poll(() => h.element("remote-grants").textContent).toContain("chatgpt");
  h.w.document.querySelector<HTMLButtonElement>('[data-route="/workspaces"]')!.click();
  await expect.poll(() => h.visible("workspaces-page")).toBe(true);
  h.element("workspace-cards").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.visible("workspace-detail")).toBe(true);
  h.element("workspace-enable-access").click(); await expect.poll(() => h.visible("authorization-panel")).toBe(true);
  expect(h.posts).toHaveLength(0);
  const add = [...h.element("remote-grants").querySelectorAll("button")].find(button => button.textContent?.includes("授权并打开"))!;
  add.click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click(); await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/remote-connection/grants/existing", body: { workspaceIds: ["other", "project"] } });
  await expect.poll(() => h.element("reuse-mcp-address").textContent).toBe("https://existing.trycloudflare.com/mcp");
  expect(h.posts.some(post => post.path.endsWith("/quick"))).toBe(false);
});

it("opens the Windows native picker and registers its Chinese folder after explicit submission", async () => {
  const h = await page({ ready: true });
  h.element("add-workspace-main").click();
  await expect.poll(() => (h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/新项目");
  expect(h.nativeCalls).toEqual([{ kind: "directory" }]); expect(h.posts).toHaveLength(0); expect(h.w.document.querySelector("#directory-dialog")).toBeNull();
  h.element("workspace-form").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/workspaces", body: { path: "/projects/新项目" } });
});

it("keeps connection and authorization separate and requires explicit Git preparation before running", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution", gitState: "not_repository" });
  await expect.poll(() => h.element("git-readiness-message").textContent).toContain("不是 Git");
  expect((h.element("run-button") as HTMLButtonElement).disabled).toBe(true);
  const initialize = h.element("git-readiness-actions").querySelector<HTMLButtonElement>('[data-git-action="initialize"]')!;
  h.w.confirm = () => false; initialize.click(); expect(h.posts).toHaveLength(0);
  initialize.click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => h.element("git-readiness-message").textContent).toContain("没有首次提交");
  expect(h.posts.some(post => post.path.endsWith("/run"))).toBe(false);
  h.element("git-readiness-actions").querySelector<HTMLButtonElement>('[data-git-action="initial-commit"]')!.click();
  await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => (h.element("run-button") as HTMLButtonElement).disabled).toBe(false);
  expect(h.posts.filter(post => post.path.endsWith("/git"))).toHaveLength(2);
  // Errors stay in the main page rather than depending on the transient toast.
  h.w.fetch = (async () => Response.json({ error: "网络错误：请重试" }, { status: 500 })) as typeof h.w.fetch;
  h.element("run-button").click(); await expect.poll(() => h.visible("page-error")).toBe(true);
  expect(h.element("page-error-message").textContent).toContain("网络错误");
  h.element("page-error-dismiss").click(); expect(h.visible("page-error")).toBe(false);
});

it("selects multiple existing workspaces without opening or authorizing them automatically", async () => {
  const h = await page({ hash: "#/workspaces", ready: true });
  h.workspaces.push({workspaceId:"other",label:"另一项目",path:"/projects/other"}); h.element("reconnect").click();
  await expect.poll(() => h.element("workspace-cards").querySelectorAll('input[type="checkbox"]').length).toBe(2);
  const inputs = h.element("workspace-cards").querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(inputs).toHaveLength(2);
  for (const input of inputs) { input.checked = true; input.dispatchEvent(new h.w.Event("change")); }
  expect(h.element("workspace-selection-status").textContent).toContain("2 个工作区");
  h.element("workspace-open-selected").click();
  expect(h.w.location.hash).toBe("#/workspaces"); expect(h.posts).toHaveLength(0);
  expect(h.visible("workspace-detail")).toBe(false); expect(h.element("workspace-connection-summary").textContent).toContain("公网入口可用");
  h.element("workspace-clear-selected").click(); expect(h.element("workspace-selection-status").textContent).toContain("尚未勾选");
});

it("cancels native folder selection without registration or a task failure banner", async () => {
  const h = await page({ hash: "#/workspaces", ready: true, empty: true }); h.setNativePicker("directory", { cancelled: true, paths: [] });
  h.element("workspace-browse").click();
  await expect.poll(() => h.element("action-feedback-title").textContent).toBe("已取消新建工作区");
  expect(h.posts).toHaveLength(0); expect(h.visible("page-error")).toBe(false);
  expect((h.element("workspace-path") as HTMLInputElement).value).toBe("");
});

it("selects several reference files and carries their relative paths into the MCP planning prompt", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => h.visible("workspace-detail")).toBe(true);
  const original = h.w.fetch;
  h.setNativePicker("files", { cancelled: false, paths: ["README.md", "design.md"] });
  h.w.fetch = (async (raw: string, init?: any) => raw.includes("tool=repo_list") ? Response.json({ path: ".", entries: [{ name: "README.md", type: "file" }, { name: "design.md", type: "file" }], nextOffset: null }) : original(raw, init)) as any;
  h.element("workspace-open-file").click();
  await expect.poll(() => h.element("file-list").querySelectorAll('input[type="checkbox"]').length).toBe(2);
  for (const input of h.element("file-list").querySelectorAll<HTMLInputElement>("input")) { input.checked = true; input.dispatchEvent(new h.w.Event("change")); }
  expect(h.element("file-selection-count").textContent).toContain("2 个参考文件"); h.element("file-use").click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/new");
  h.element("copy-web-planning").click(); await expect.poll(() => h.copied.length).toBeGreaterThan(0);
  expect(h.copied.at(-1)).toContain('"README.md","design.md"'); expect(h.posts).toHaveLength(0);
});

it("marks stale execution interrupted and requires confirmed repair before offering retry", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const session: any = { status: "interrupted", savedStatus: "running", health: { state: "owner_exited", checkedAt: new Date().toISOString(), recoveryRequired: true, message: "原执行 owner 已退出，保存状态已过期" }, tasks: [{ taskId: "spec", status: "succeeded", attempts: [] }, { taskId: "backend", status: "interrupted", attempts: [] }] };
  (h.plans[0] as any).session = session;
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/session/diagnosis")) return Response.json({ state: "owner_exited", savedStatus: "running" });
    if (raw.endsWith("/session/recover")) {
      h.posts.push({ path: raw, body: JSON.parse(init.body) }); session.health = { ...session.health, recoveryRequired: false, state: "idle" }; session.status = "failed"; session.tasks[1].status = "failed";
      return Response.json({ status: "succeeded", kind: "session.recover", result: { planningId: "first" } });
    }
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => h.visible("session-recover")).toBe(true);
  expect(h.element("task-list").textContent).not.toContain("重试 backend"); expect(h.element("session-progress").textContent).toContain("运行中 0");
  h.element("session-recover").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-no").click(); await new Promise(resolve => setTimeout(resolve, 20)); expect(h.posts).toHaveLength(0);
  h.element("session-recover").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => h.posts.some(post => post.path.endsWith("/session/recover"))).toBe(true);
  await expect.poll(() => h.element("task-list").textContent).toContain("重试 backend");
  expect(h.posts.at(-1)?.body.confirmedStopped).toBe(true);
});

it("numbers model replies, highlights verdicts, paginates diagnostics and preserves reading position", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const id = randomUUID(), original = h.w.fetch;
  const events = [
    { sequence: 1, type: "message.completed", payload: { messageId: "a", text: "已核对文档" } },
    { sequence: 2, type: "message.completed", payload: { messageId: "b", text: "错误：构建失败\n<img src=x onerror=alert(1)>" } },
    ...Array.from({ length: 34 }, (_, i) => ({ sequence: i + 3, type: "command.completed", payload: { command: `command-${i}`, exitCode: i === 17 ? 1 : 0 } })),
  ];
  h.w.fetch = (async (raw: string, init?: any) => raw.includes("/attempts/") ? Response.json({ attempt: { attemptId: id, status: "failed", reason: "build_failed", exitCode: 1 }, taskId: "spec", events, cursor: 500, fileId: "f", hasMore: false }) : original(raw, init)) as any;
  (h.plans[0] as any).session = { status: "failed", tasks: [{ taskId: "spec", status: "failed", attempts: [{ attemptId: id }] }] };
  h.element("refresh").click(); await expect.poll(() => h.element("attempt-messages").querySelectorAll("article").length).toBe(2);
  expect(h.element("attempt-reply-heading").textContent).toBe("模型回复"); expect(h.element("attempt-messages").textContent).not.toContain("模型回复");
  expect(h.element("attempt-messages").querySelector(".reply-error")?.textContent).toContain("构建失败"); expect(h.element("attempt-messages").querySelector("img")).toBeNull();
  expect(h.element("attempt-outcome").textContent).toContain("错误结论"); expect(h.w.document.getElementById("attempt-follow")).toBeNull();
  expect(h.element("attempt-tools").children).toHaveLength(15); h.element("attempt-tools-next").click();
  expect(h.element("attempt-tools-page").textContent).toContain("第 2 / 3 页"); expect(h.element("attempt-tools").textContent).toContain("command-15");
  expect(h.element("attempt-tools").querySelector(".activity-error")).not.toBeNull();
  h.element("attempt-messages").scrollTop = 50; h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.element("attempt-messages").scrollTop).toBe(50); expect(h.element("attempt-tools-page").textContent).toContain("第 2 / 3 页");
  h.element("attempt-raw-next").click(); expect(h.element("attempt-raw-page").textContent).toContain("第 2 / 3 页");
});

it("keeps approvals visible and only sends the explicit allow-once decision to the matching request", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/overview", ready: true, approved: true });
  const original = h.w.fetch; let requests = [{ requestId: "approval-1", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "批准构建", summary: "执行 node --test" } }];
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/interactions/")) {
      if (init?.method === "POST") { h.posts.push({ path: raw, body: JSON.parse(init.body) }); requests = []; return Response.json({ ok: true }); }
      return Response.json(requests);
    }
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => h.visible("pending-action-banner")).toBe(true);
  expect(h.posts).toHaveLength(0); h.element("pending-action-open").click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
  expect(h.element("pending-approval-count").textContent).toBe("1 项");
  h.element("interaction-list").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/workspaces/project/interactions/approval-1", body: { kind: "approval", decision: "allow-once" } });
  await expect.poll(() => h.visible("pending-action-banner")).toBe(false);
});

it("keeps incomplete authorization and workspace forms separate from an active task's status", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  (h.plans[0] as any).session = { status: "running", health: { state: "active", checkedAt: new Date().toISOString(), message: "owner 存活" }, tasks: [{ taskId: "spec", status: "running", attempts: [] }] };
  h.element("refresh").click(); await expect.poll(() => h.element("session-progress").textContent).toContain("运行中 1");
  h.w.eval('showToast("请选择项目，并至少勾选一项权限。",true)');
  expect(h.visible("page-error")).toBe(false); expect(h.element("action-feedback-title").textContent).toContain("请补全");
  expect(h.element("action-feedback-text").textContent).toContain("不影响已在执行的任务"); expect(h.element("session-progress").textContent).toContain("运行中 1");
  h.w.eval('showToast("请选择项目文件夹，或展开手动填写路径。",true)');
  expect(h.visible("page-error")).toBe(false); expect(h.element("session-progress").textContent).toContain("运行中 1");
  h.w.eval('showToast("真实 Runner 执行失败：构建异常",true,"execution")');
  expect(h.visible("page-error")).toBe(true); expect(h.element("page-error").querySelector("strong")?.textContent).toContain("任务操作未完成");
});

it("shows immediate selection feedback and highlights the active planning record", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true }); await expect.poll(() => h.element("workspace-plan-cards").querySelectorAll("button").length).toBe(2);
  h.element("workspace-plan-cards").querySelector<HTMLButtonElement>("button")!.click();
  expect(h.element("selection-feedback").textContent).toContain("正在打开");
  await expect.poll(() => h.element("selection-feedback").textContent).toContain("已打开：计划 first");
  expect(h.element("workspace-plan-cards").querySelector('button[aria-pressed="true"]')).not.toBeNull();
  expect(h.element("planning-list").querySelector('button[aria-current="page"]')).not.toBeNull();
});

it("retains prominent retry feedback and reports a failed task even when its operation completed normally", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  (h.plans[0] as any).session = { status: "failed", tasks: [{ taskId: "spec", status: "failed", dependsOn: [], attempts: [] }] };
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/session/retry")) { await new Promise(resolve => setTimeout(resolve, 30)); return Response.json({ jobId: "retry", workspaceId: "project", kind: "session.retry", status: "succeeded", result: { planningId: "first", status: "failed" } }); }
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => h.element("task-list").textContent).toContain("重试 spec");
  [...h.element("task-list").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试 spec")!.click();
  expect(h.element("job-label").textContent).toContain("重试 spec · 正在提交");
  await expect.poll(() => h.element("job-label").textContent).toContain("操作已结束，任务失败");
  expect(h.visible("job-bar")).toBe(true); expect(h.element("job-bar").dataset.state).toBe("failed");
  expect(h.visible("job-view-result")).toBe(true);
});

it("shows latest messages first, live summaries and dependencies without fabricating progress", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true }); const id = randomUUID(), original = h.w.fetch;
  (h.plans[0] as any).session = { status: "running", health: { state: "active", checkedAt: new Date().toISOString() }, tasks: [{ taskId: "spec", title: "设计", status: "succeeded", attempts: [] }, { taskId: "backend", title: "实现后端", dependsOn: ["spec"], status: "running", attempts: [{ attemptId: id }], activeAttemptId: id, currentAttempt: { attemptId: id, status: "running", runnerId: "codex", lastReply: "已核对设计，继续实现接口", lastActivityAt: new Date().toISOString(), activity: "正在运行构建" } }] };
  h.w.fetch = (async (raw: string, init?: any) => raw.includes("/attempts/") ? Response.json({ taskId: "backend", attempt: { attemptId: id, status: "running" }, fileId: "messages", cursor: 50, hasMore: false, events: [{ sequence: 1, type: "message.completed", payload: { messageId: "old", text: "第一条" } }, { sequence: 2, type: "message.completed", payload: { messageId: "new", text: "最新结论" } }] }) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => h.element("attempt-messages").firstElementChild?.textContent).toContain("最新结论");
  expect(h.element("live-task-replies").textContent).toContain("已核对设计，继续实现接口");
  expect(h.element("task-dependencies").textContent).toContain("实现后端"); expect(h.element("task-list").textContent).toContain("前置任务已全部完成：设计（已完成）");
});

it("only changes the execution model after an explicit confirmation and binds the stopped Attempt", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const plan: any = h.plans[0]; plan.draft.plan.tasks[0].task.execution = { runnerId: "codex", mode: "managed", modelId: "fast" };
  const id = randomUUID(); plan.session = { status: "running", models: { revision: 3, overrides: {} }, health: { state: "active", checkedAt: new Date().toISOString() }, tasks: [{ taskId: "spec", status: "running", execution: { runnerId: "codex" }, activeAttemptId: id, attempts: [] }] };
  const original = h.w.fetch; let calls: any[] = [];
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/session/models")) { calls.push(JSON.parse(init.body)); return Response.json({ jobId: "switch", workspaceId: "project", kind: "session.model-switch", status: "succeeded", result: { planningId: "first", status: "succeeded" } }); }
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => h.visible("open-runtime-model")).toBe(true);
  expect(h.visible("runtime-model-panel")).toBe(false); h.element("open-runtime-model").click(); await expect.poll(() => h.visible("runtime-model-panel")).toBe(true);
  await expect.poll(() => (h.element("runtime-model-choice") as HTMLSelectElement).options.length).toBe(2);
  (h.element("runtime-model-choice") as HTMLSelectElement).value = "__custom__"; h.element("runtime-model-choice").dispatchEvent(new h.w.Event("change")); (h.element("runtime-model-custom") as HTMLInputElement).value = "smart";
  h.element("runtime-model-retry").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-no").click(); expect(calls).toHaveLength(0);
  h.element("runtime-model-retry").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click(); await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ taskId: "spec", modelId: "smart", stopAndRetry: true, expectedAttemptId: id, expectedRevision: 3, confirmed: true });
  expect(plan.draft.plan.tasks[0].task.execution.modelId).toBe("fast");
});

it("requests notification permission only on user action and deduplicates pending approval alerts", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/overview", ready: true, approved: true });
  let permissions = 0, alerts = 0; const notes: any[] = []; h.w.focus = () => undefined;
  class Notice { onclick?: () => void; close() {} static permission = "default"; static async requestPermission() { permissions++; Notice.permission = "granted"; return "granted"; } constructor() { alerts++; notes.push(this); } }
  Object.assign(h.w, { Notification: Notice }); const original = h.w.fetch;
  h.element("enable-notifications").click(); await expect.poll(() => permissions).toBe(1);
  h.w.fetch = (async (raw: string, init?: any) => raw.includes("/interactions/") ? Response.json([{ requestId: "ask", owner: { taskId: "spec", runnerId: "codex" }, request: { kind: "approval", title: "批准命令", summary: "node --test" } }]) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => h.w.document.title).toContain("1 项待审批");
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 40));
  expect(permissions).toBe(1); expect(alerts).toBeLessThanOrEqual(1); expect(h.visible("pending-action-banner")).toBe(true);
  expect(alerts).toBe(1);
  h.element("planning-list").querySelectorAll<HTMLButtonElement>(":scope > button")[1]!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/second");
  notes[0].onclick(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
});

it("requires explicit workspace and source even when the OAuth request suggests a workspace, and preserves only user choices", async () => {
  const h = await page({ ready: true });
  const request = { requestId: "prefilled", clientId: "gpt-client", workspaceId: "project", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", requestedScopes: ["planning:read"], createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  h.setApprovals([request]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelector(".remote-workspace-select")).not.toBeNull();
  const card = h.element("remote-approvals").querySelector("article")!;
  const workspace = card.querySelector<HTMLSelectElement>(".remote-workspace-select")!, source = card.querySelector<HTMLSelectElement>(".remote-source-select")!;
  expect(workspace.value).toBe(""); expect(source.value).toBe(""); expect(workspace.options[0].textContent).toContain("新建工作区");
  expect(card.querySelectorAll("input:checked")).toHaveLength(0); expect([...card.querySelectorAll("button")].find(button => button.textContent === "授权所选权限")!.disabled).toBe(true);
  workspace.value = "project"; source.value = "claude";
  h.setApprovals([request, { ...request, requestId: "second" }]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelectorAll("article").length).toBe(2);
  expect(h.element("remote-approvals").querySelector<HTMLSelectElement>('.remote-approval-card[data-request-id="prefilled"] .remote-source-select')!.value).toBe("claude");
  expect(h.element("remote-approvals").querySelector<HTMLSelectElement>('.remote-approval-card[data-request-id="second"] .remote-workspace-select')!.value).toBe("");
  expect(h.posts).toHaveLength(0);
});

it("can return to existing workspaces while the native picker is pending and ignores a late folder result", async () => {
  const h = await page({ ready: true, hash: "#/workspaces" }), original = h.w.fetch;
  let finish!: (result: Response) => void;
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/native-picker") ? new Promise<Response>(resolve => { finish = resolve; }) : original(raw, init)) as any;
  h.element("add-workspace-main").click(); await expect.poll(() => h.visible("workspace-form")).toBe(true);
  expect(h.visible("workspace-cards")).toBe(false); expect((h.element("choose-workspace-directory") as HTMLButtonElement).disabled).toBe(true);
  expect(h.element("action-feedback-title").textContent).toContain("正在打开");
  h.element("workspace-form-back").click(); expect(h.visible("workspace-cards")).toBe(true); expect(h.visible("workspace-form")).toBe(false);
  finish(Response.json({ cancelled: false, paths: ["/late/result"] }));
  await expect.poll(() => (h.element("choose-workspace-directory") as HTMLButtonElement).disabled).toBe(false);
  expect(h.visible("workspace-form")).toBe(false); expect((h.element("workspace-path") as HTMLInputElement).value).toBe("");
  expect(h.element("choose-workspace-directory").textContent).toBe("选择文件夹");
  h.element("workspace-cards").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project");
  expect(h.visible("workspace-detail")).toBe(true); expect(h.visible("workspace-selection")).toBe(false); expect(h.posts).toHaveLength(0);
});

it("opens the new workspace page after registering a chosen folder and lets the user return to the workspace list", async () => {
  const h = await page({ ready: true, hash: "#/workspaces" }); h.element("workspace-browse").click();
  await expect.poll(() => (h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/新项目");
  h.element("workspace-form").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/folder-project");
  expect(h.visible("workspace-detail")).toBe(true); expect(h.visible("workspace-selection")).toBe(false);
  h.element("workspace-back").click(); await expect.poll(() => h.visible("workspace-cards")).toBe(true);
  expect(h.visible("workspace-form")).toBe(false);
});

it("shows native picker failures in the form with a usable manual fallback", async () => {
  const h = await page({ ready: true, hash: "#/workspaces" }), original = h.w.fetch;
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/native-picker") ? Promise.resolve(Response.json({ error: "native_picker_unavailable：没有 Windows 桌面" }, { status: 422 })) : original(raw, init)) as any;
  h.element("workspace-browse").click();
  await expect.poll(() => h.element("workspace-path-error").textContent).toContain("没有 Windows 桌面");
  expect((h.element("workspace-manual-path") as HTMLDetailsElement).open).toBe(true); expect(h.visible("workspace-form-back")).toBe(true);
  expect((h.element("choose-workspace-directory") as HTMLButtonElement).disabled).toBe(false); expect(h.posts).toHaveLength(0);
});

it("groups tasks by observed status and draws branches and joins without inventing completion", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  const tasks = [
    { taskId: "spec", title: "设计", status: "succeeded", dependsOn: [] },
    { taskId: "backend", title: "后端", status: "running", dependsOn: ["spec"] },
    { taskId: "frontend", title: "界面", status: "interrupted", dependsOn: ["spec"] },
    { taskId: "test", title: "测试", status: "blocked", dependsOn: ["backend", "frontend"] },
    { taskId: "verify", title: "验收", status: "unavailable", dependsOn: ["test"] },
  ];
  (h.plans[0] as any).session = { status: "running", tasks, health: { state: "active", checkedAt: new Date().toISOString() } }; h.element("refresh").click();
  await expect.poll(() => h.element("task-list").querySelectorAll(".task-row").length).toBe(5);
  const group = (name: string) => [...h.element("task-list").querySelectorAll(`[data-group="${name}"] .task-row`)].map(row => (row as HTMLElement).dataset.taskId);
  expect(group("completed")).toEqual(["spec"]); expect(group("running")).toEqual(["backend"]); expect(group("pending")).toEqual(["test"]); expect(group("errors")).toEqual(["frontend", "verify"]);
  h.element("task-dependencies").querySelector<HTMLButtonElement>("button")!.click();
  expect((h.element("dag-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.element("dag-viewport").querySelectorAll(".dag-node")).toHaveLength(5); expect(h.element("dag-viewport").querySelectorAll(".dag-edge")).toHaveLength(5);
  expect(h.element("dag-viewport").querySelectorAll('[data-to="test"]')).toHaveLength(2);
  const width = Number(h.element("dag-viewport").querySelector("svg")!.getAttribute("width")); h.element("dag-zoom-in").click();
  expect(Number(h.element("dag-viewport").querySelector("svg")!.getAttribute("width"))).toBeGreaterThan(width);
  h.element("dag-close").click(); expect((h.element("dag-dialog") as HTMLDialogElement).open).toBe(false);
  tasks[1].status = "succeeded"; h.element("refresh").click(); await expect.poll(() => group("completed")).toEqual(["spec", "backend"]);
  expect(group("running")).toEqual([]); expect(h.posts).toHaveLength(0);
});

it("preserves task details, keyboard focus and the dependency graph during unchanged background refresh", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { status: "failed", tasks: [{ taskId: "spec", status: "failed", result: { summary: "构建失败，已保留证据" } }], health: { state: "exited", checkedAt: new Date().toISOString() } };
  h.element("refresh").click(); await expect.poll(() => h.element("task-list").querySelector(".task-row details")).not.toBeNull();
  const row = h.element("task-list").querySelector(".task-row")!, details = row.querySelector("details")!, dag = h.element("task-dependencies").querySelector("svg");
  details.open = true; const button = row.querySelector("button")!; button.focus();
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 40));
  expect(h.element("task-list").querySelector(".task-row")).toBe(row); expect(details.open).toBe(true); expect(h.w.document.activeElement).toBe(button);
  expect(h.element("task-dependencies").querySelector("svg")).toBe(dag);
});

it("hides resume processing only when the same Session is observed actively running and keeps terminal errors visible", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch;
  const session: any = { sessionId: "session", status: "paused", tasks: [{ taskId: "spec", status: "planned" }], health: { state: "exited", checkedAt: new Date().toISOString() } };
  (h.plans[0] as any).session = session; let jobStatus = "running";
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/session/resume") || raw.endsWith("/jobs/resume-job") ? Promise.resolve(Response.json({ jobId: "resume-job", kind: "session.resume", workspaceId: "project", status: jobStatus, ...(jobStatus === "failed" ? { error: "Runner 意外退出" } : {}) })) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => (h.element("session-continue") as HTMLButtonElement).disabled).toBe(false);
  h.element("session-continue").click(); h.element("session-continue-confirm").click();
  await expect.poll(() => h.element("job-label").textContent).toContain("从断点继续执行 · 处理中"); expect(h.visible("job-bar")).toBe(true);
  session.status = "running"; session.tasks[0].status = "running"; session.health.state = "unknown";
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30)); expect(h.visible("job-bar")).toBe(true);
  session.health.state = "active"; session.health.checkedAt = new Date().toISOString(); h.element("refresh").click(); await expect.poll(() => h.visible("job-bar")).toBe(false);
  jobStatus = "failed"; await expect.poll(() => h.visible("job-bar"), { timeout: 3000 }).toBe(true);
  expect(h.element("job-label").textContent).toContain("Runner 意外退出"); expect(h.element("job-bar").dataset.state).toBe("failed");
});

it("keeps an answer and its caret when another approval arrives during background refresh", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch;
  const requests: any[] = [{ requestId: "question", owner: { runnerId: "codex", taskId: "spec" }, request: { kind: "question", title: "测试选项", questions: [{ id: "testing", text: "用何种测试？" }] } }];
  h.w.fetch = ((raw: string, init?: any) => raw.includes("/interactions/") ? Promise.resolve(Response.json(requests)) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => h.element("interaction-list").querySelector("input")).not.toBeNull();
  const input = h.element("interaction-list").querySelector("input")!; input.value = "真实 HTTP 回归"; input.focus(); input.setSelectionRange(3, 7);
  requests.push({ requestId: "new-approval", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "运行构建" } });
  h.element("refresh").click(); await expect.poll(() => h.element("pending-approval-count").textContent).toBe("2 项");
  const updated = h.element("interaction-list").querySelector("input")!;
  expect(updated.value).toBe("真实 HTTP 回归"); expect(h.w.document.activeElement).toBe(updated); expect(updated.selectionStart).toBe(3); expect(updated.selectionEnd).toBe(7);
  expect(h.posts).toHaveLength(0);
});

it("registers a workspace inside the pending authorization without leaving or losing its source and permission selections", async () => {
  const h = await page({ ready: true, pendingAuth: true });
  await expect.poll(() => h.visible("authorization-panel")).toBe(true);
  const card = h.element("remote-approvals").querySelector<HTMLElement>('article[data-request-id="auth-initial"]')!;
  const source = card.querySelector<HTMLSelectElement>(".remote-source-select")!; source.value = "claude";
  card.querySelector<HTMLInputElement>('input[value="planning:read"]')!.checked = true; card.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  const workspaceSelect = card.querySelector<HTMLSelectElement>(".remote-workspace-select")!; workspaceSelect.value = "__new__"; workspaceSelect.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  await expect.poll(() => (h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/新项目");
  expect(h.w.location.hash).toBe("#/connect"); expect(h.visible("workspace-form")).toBe(true); expect(card.contains(h.element("workspace-form"))).toBe(true);
  expect(h.nativeCalls).toEqual([{ kind: "directory" }]); expect(h.visible("workspace-detail")).toBe(false);
  (h.element("workspace-label") as HTMLInputElement).value = "授权内的新项目";
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 25));
  expect((h.element("workspace-label") as HTMLInputElement).value).toBe("授权内的新项目");
  h.element("workspace-form").dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
  await expect.poll(() => h.element("remote-approvals").querySelector<HTMLSelectElement>(".remote-workspace-select")?.value).toBe("folder-project");
  expect(h.w.location.hash).toBe("#/connect"); expect(h.visible("workspace-form")).toBe(false);
  const updated = h.element("remote-approvals").querySelector("article")!;
  expect(updated.querySelector<HTMLSelectElement>(".remote-source-select")!.value).toBe("claude");
  expect(updated.querySelector<HTMLInputElement>('input[value="planning:read"]')!.checked).toBe(true);
  expect([...updated.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "授权所选权限")!.disabled).toBe(false);
  expect(h.posts.map(post => post.path)).toEqual(["/api/v1/workspaces"]);
});

it("explains each missing authorization field next to the disabled allow button", async () => {
  const h = await page({ ready: true, pendingAuth: true }); await expect.poll(() => h.visible("authorization-panel")).toBe(true);
  const card = h.element("remote-approvals").querySelector("article")!, allow = [...card.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "授权所选权限")!;
  const guidance = () => card.querySelector(".field-guidance")!.textContent;
  expect(allow.disabled).toBe(true); expect(guidance()).toContain("请选择网页来源"); expect(guidance()).toContain("请选择已有工作区"); expect(guidance()).toContain("至少勾选一项权限");
  expect(allow.getAttribute("aria-describedby")).toBe(card.querySelector(".field-guidance")!.id);
  card.querySelector<HTMLSelectElement>(".remote-source-select")!.value = "chatgpt"; card.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  expect(guidance()).not.toContain("请选择网页来源"); expect(guidance()).toContain("请选择已有工作区");
  card.querySelector<HTMLSelectElement>(".remote-workspace-select")!.value = "project"; card.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  expect(guidance()).toContain("至少勾选一项权限"); expect(allow.disabled).toBe(true);
  card.querySelector<HTMLInputElement>('input[value="planning:read"]')!.checked = true; card.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  expect(guidance()).toContain("已就绪"); expect(allow.disabled).toBe(false); expect(h.posts).toHaveLength(0);
});

it("restores the existing-workspace default after cancelling new folder selection", async () => {
  const h = await page({ ready: true, hash: "#/workspaces" }); h.setNativePicker("directory", { cancelled: true, paths: [] });
  h.element("add-workspace-main").click(); await expect.poll(() => h.element("action-feedback-title").textContent).toBe("已取消新建工作区");
  expect(h.visible("workspace-existing")).toBe(true); expect(h.visible("add-workspace-main")).toBe(true);
  expect(h.element("workspace-existing").parentElement).toBe(h.element("add-workspace-main").parentElement);
  expect(h.visible("workspace-cards")).toBe(true); expect(h.visible("workspace-form")).toBe(false);
  expect(h.element("workspace-existing").getAttribute("aria-pressed")).toBe("true");
  expect((h.element("workspace-path") as HTMLInputElement).value).toBe("");
  expect(h.posts).toHaveLength(0);
});

it("opens and refreshes recovery state from its completion button even on the same execution page", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch;
  const plan: any = h.plans[0]; plan.session = { status: "interrupted", health: { state: "exited", message: "原执行进程已退出", recoveryRequired: true }, tasks: [] };
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/session/diagnosis") ? Promise.resolve(Response.json({ state: "owner_exited" })) : raw.endsWith("/session/recover") ? Promise.resolve(Response.json({ jobId: "recover", workspaceId: "project", kind: "session.recover", status: "succeeded", result: { recovered: true } })) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => h.visible("session-recover")).toBe(true);
  h.element("session-recover").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click(); await expect.poll(() => h.element("job-view-result").textContent).toBe("查看恢复状态");
  plan.session.health = { state: "exited", message: "中断记录已修复，需重试任务", recoveryRequired: false };
  h.element("job-view-result").click(); await expect.poll(() => h.element("action-feedback-title").textContent).toBe("已打开恢复状态");
  expect(h.element("session-health-message").textContent).toContain("中断记录已修复"); expect(h.w.document.activeElement).toBe(h.element("session-health"));
  expect(h.element("action-feedback-text").textContent).toContain("需要时在任务面板选择重试或继续执行");
});

it("opens task result details and separates model and Attempt tools from the task board", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch, id = randomUUID();
  (h.plans[0] as any).session = { status: "failed", tasks: [{ taskId: "spec", status: "failed", attempts: [{ attemptId: id }] }], health: { state: "exited" } };
  h.w.fetch = ((raw: string, init?: any) => raw.includes("/attempts/") ? Promise.resolve(Response.json({ taskId: "spec", attempt: { attemptId: id, status: "failed" }, events: [], hasMore: false, cursor: 0 })) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => h.element("task-list").querySelector(".task-row button")).not.toBeNull();
  expect(h.visible("attempt-reader")).toBe(false); expect(h.element("execution-tab").contains(h.element("attempt-reader"))).toBe(false);
  expect(h.element("execution-tab").contains(h.element("runtime-model-panel"))).toBe(false); expect(h.w.document.querySelector("#attempt-follow")).toBeNull();
  h.element("task-list").querySelector<HTMLButtonElement>(".task-row button")!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/attempts");
  expect(h.visible("attempt-reader")).toBe(true); expect((h.element("attempt-select") as HTMLSelectElement).value).toBe(id);
  const modelsLink = h.element("planning-list").querySelector<HTMLButtonElement>('[data-plan-tool="models"]')!;
  expect(modelsLink.closest("details")).not.toBeNull(); modelsLink.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/models");
  expect(h.visible("runtime-model-empty")).toBe(true); expect(h.visible("attempt-reader")).toBe(false);
});

it("keeps OAuth choices after cancelling creation and authorizes several selected workspaces at once", async () => {
  const h = await page({ ready: true, pendingAuth: true, multiple: true });
  await expect.poll(() => h.element("remote-approvals").querySelectorAll('.remote-projects input').length).toBe(2);
  let card = h.element("remote-approvals").querySelector<HTMLElement>("article")!;
  const select = card.querySelector<HTMLSelectElement>(".remote-workspace-select")!;
  select.value = "project"; select.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  card.querySelector<HTMLSelectElement>(".remote-source-select")!.value = "claude";
  card.querySelector<HTMLInputElement>('.permissions input[value="planning:read"]')!.checked = true;
  card.querySelector<HTMLInputElement>('.remote-projects input[value="other"]')!.checked = true;
  card.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  h.setNativePicker("directory", { cancelled: true, paths: [] }); select.value = "__new__"; select.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  await expect.poll(() => h.element("action-feedback-title").textContent).toBe("已取消新建工作区");
  expect(h.visible("workspace-form")).toBe(false); expect(h.w.location.hash).toBe("#/connect");
  card = h.element("remote-approvals").querySelector<HTMLElement>("article")!;
  expect(card.querySelector<HTMLSelectElement>(".remote-workspace-select")!.value).toBe("project");
  expect(card.querySelector<HTMLSelectElement>(".remote-source-select")!.value).toBe("claude");
  expect(card.querySelector<HTMLInputElement>('.remote-projects input[value="other"]')!.checked).toBe(true);
  [...card.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "授权所选权限")!.click();
  await expect.poll(() => h.posts.length).toBe(1); expect(h.posts[0]!.body.workspaceIds).toEqual(["project", "other"]);
});

it("keeps only three tasks in each group until expanded and preserves the foldout during refresh", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { status: "ready", sessionId: "session", health: { state: "idle" }, tasks: h.plans[0]!.draft.plan.tasks.map(entry => ({ taskId: entry.task.id, status: "planned", attempts: [] })) };
  h.element("refresh").click(); await expect.poll(() => h.element("task-list").querySelectorAll(".task-row").length).toBe(5);
  const group = h.element("task-list").querySelector<HTMLElement>('[data-group="pending"]')!, overflow = group.querySelector<HTMLDetailsElement>(".task-board-overflow")!;
  expect(group.querySelectorAll(".task-board-rows > .task-row")).toHaveLength(3);
  expect(overflow.querySelectorAll(".task-row")).toHaveLength(2); expect(overflow.open).toBe(false);
  overflow.open = true; h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(overflow.open).toBe(true); expect(group.querySelectorAll(".task-board-rows > .task-row")).toHaveLength(3);
});

it("offers an explicit session-wide continuation without rerunning completed prerequisites", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch;
  const attemptId = randomUUID(), plan: any = h.plans[0];
  plan.session = { sessionId: "session", status: "failed", health: { state: "idle", recoveryRequired: false }, tasks: [
    { taskId: "spec", status: "succeeded", attempts: [] }, { taskId: "backend", status: "failed", dependsOn: ["spec"], attempts: [{ attemptId }] }, { taskId: "frontend", status: "blocked", dependsOn: ["backend"], attempts: [] },
  ] };
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/session/retry")) { h.posts.push({ path: raw, body: JSON.parse(init.body) }); return Response.json({ jobId: "retry", kind: "session.retry", status: "succeeded", result: { planningId: "first" } }); }
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => (h.element("session-continue") as HTMLButtonElement).disabled).toBe(false);
  h.element("session-continue").click(); expect((h.element("session-continue-dialog") as HTMLDialogElement).open).toBe(true);
  expect([...(h.element("session-continue-target") as HTMLSelectElement).options].map(item => item.value)).toEqual(["backend"]);
  expect(h.element("session-continue-description").textContent).toContain("保留 1 个已完成任务"); expect(h.posts).toHaveLength(0);
  h.element("session-continue-confirm").click(); await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]!.body.taskId).toBe("backend"); expect(plan.session.tasks[0].status).toBe("succeeded");
});

it("opens task-owned file paths in a bounded results dialog and previews returned text safely", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch;
  (h.plans[0] as any).session = { status: "succeeded", health: { state: "idle" }, tasks: [{ taskId: "spec", status: "succeeded", attempts: [] }] };
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/tasks/spec/files")) {
      if (new URL(raw, h.w.location.origin).searchParams.has("path")) return Response.json({ file: { absolutePath: "/run/docs/file-0.md", content: "1: <img src=x onerror=alert(1)>" } });
      return Response.json({ message: "此任务的 Git 变更文件", source: "git-isolation", executionDirectory: "/run", commit: "c".repeat(40), total: 4, nextOffset: null, files: Array.from({ length: 4 }, (_, index) => ({ path: `docs/file-${index}.md`, absolutePath: `/run/docs/file-${index}.md` })) });
    }
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => [...h.element("task-list").querySelectorAll("button")].some(button => button.textContent === "查看任务生成结果")).toBe(true);
  [...h.element("task-list").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "查看任务生成结果")!.click();
  await expect.poll(() => h.element("task-results-summary").textContent).toContain("4/4");
  expect((h.element("task-results-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.element("task-results-files").querySelectorAll(":scope > article")).toHaveLength(3);
  expect(h.element("task-results-files").querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
  h.element("task-results-files").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.element("task-results-preview").textContent).toContain("<img"); expect(h.element("task-results-preview").querySelector("img")).toBeNull();
});

it("refreshes dependency wording when a predecessor completes without changing the waiting task", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  const predecessor = { taskId: "spec", title: "接口与数据库设计文档", status: "running", attempts: [] };
  (h.plans[0] as any).session = { status: "running", tasks: [predecessor, { taskId: "backend", title: "后端", status: "planned", dependsOn: ["spec"], attempts: [] }] };
  h.element("refresh").click(); await expect.poll(() => h.element("task-list").textContent).toContain("等待前置任务完成：接口与数据库设计文档（运行中）");
  predecessor.status = "succeeded"; h.element("refresh").click();
  await expect.poll(() => h.element("task-list").textContent).toContain("前置任务已全部完成：接口与数据库设计文档（已完成）");
  expect(h.element("task-list").textContent).not.toContain("等待前置任务完成：");
});

it("uses the completed job's original plan when opening its task results from another plan", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch, id = randomUUID();
  (h.plans[0] as any).session = { status: "failed", health: { state: "exited", recoveryRequired: false }, tasks: [{ taskId: "spec", status: "failed", attempts: [{ attemptId: id }] }] };
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/session/retry") ? Promise.resolve(Response.json({ jobId: "retry", workspaceId: "project", kind: "session.retry", status: "succeeded", result: { planningId: "first", status: "failed" } })) : raw.includes("/attempts/") ? Promise.resolve(Response.json({ taskId: "spec", attempt: { attemptId: id, status: "failed" }, events: [{ sequence: 1, type: "message.completed", payload: { messageId: "result", text: "执行记录：需要修复构建" } }], cursor: 1, hasMore: false })) : original(raw, init)) as any;
  h.element("refresh").click(); await expect.poll(() => h.element("task-list").textContent).toContain("重试 spec");
  [...h.element("task-list").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试 spec")!.click();
  await expect.poll(() => h.element("job-label").textContent).toContain("操作已结束");
  h.element("planning-list").querySelectorAll<HTMLButtonElement>(":scope > button")[1]!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/second");
  h.element("job-view-result").click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/attempts");
  expect(h.visible("attempt-reader")).toBe(true); expect(h.element("attempt-messages").textContent).toContain("需要修复构建");
});
