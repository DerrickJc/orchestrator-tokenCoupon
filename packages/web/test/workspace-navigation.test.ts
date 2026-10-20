import { createClient } from "@token-coupon/client";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { defaultSystemSettings } from "../../daemon/src/system-settings.js";
import { AttemptDiagnosisDialog } from "../src/attempt-diagnosis-dialog-ui.js";

const windows: JSDOM[] = [];
async function chooseNativeFolder(h: Awaited<ReturnType<typeof page>>) {
  await expect.poll(() => (h.element("directory-dialog") as HTMLDialogElement)?.open).toBe(true);
  h.element("directory-close").click(); (h.element("workspace-native-choice") as HTMLDetailsElement).open = true;
  h.element("choose-workspace-native").click();
}
async function chooseBackendFolder(h: Awaited<ReturnType<typeof page>>, path = "/projects/新项目") {
  await expect.poll(() => (h.element("directory-dialog") as HTMLDialogElement)?.open).toBe(true);
  (h.element("directory-path") as HTMLInputElement).value = path; h.element("directory-go").click();
  await expect.poll(() => h.element("directory-status").textContent).toContain(path);
  h.element("directory-use").click();
}
it("opens backend directory selection by default for remote clients and registers only the explicitly chosen server path", async () => {
  const h = await page({ hash: "#/workspaces", ready: true });
  h.element("workspace-browse").click();
  await expect.poll(() => (h.element("directory-dialog") as HTMLDialogElement)?.open).toBe(true);
  expect(h.element("directory-dialog").textContent).toContain("远程电脑也可使用");
  expect(h.nativeCalls).toHaveLength(0); expect(h.posts).toHaveLength(0);
  await chooseBackendFolder(h, "/projects/远程项目");
  expect((h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/远程项目");
  expect((h.element("workspace-native-choice") as HTMLDetailsElement).open).toBe(false);
  h.element("workspace-form").dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/workspaces", body: { path: "/projects/远程项目" } });
  expect(h.nativeCalls).toHaveLength(0);
});
it("initializes unified preferences, persists a selected Agent and keeps per-function settings editable", async () => {
  const h = await page({ empty: true, settings: defaultSystemSettings(), reactSystemPolicyRouting: true });
  await expect.poll(() => h.w.location.hash).toBe("#/settings");
  expect(h.visible("system-settings-page")).toBe(true);
  const policy = h.element("system-settings-policies").querySelector<HTMLElement>('[data-function="unified"]')!;
  const priority = policy.querySelector<HTMLSelectElement>('[data-field="priority"]')!;
  priority.value = "agent"; priority.dispatchEvent(new h.w.Event("change"));
  const runner = policy.querySelector<HTMLSelectElement>('[data-field="runner"]')!;
  runner.value = "claude-code"; runner.dispatchEvent(new h.w.Event("change"));
  await expect.poll(() => policy.querySelector<HTMLSelectElement>('[data-field="model-choice"]')!.options.length).toBeGreaterThan(1);
  const model = policy.querySelector<HTMLInputElement>('[data-field="model"]')!;
  model.value = "deepseek-flash"; model.dispatchEvent(new h.w.Event("input"));
  h.element("system-settings-form").dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => h.element("system-settings-status").textContent).toContain("设置已保存");
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/settings", body: { mode: "unified", unified: { priority: "agent", agent: { runnerId: "claude-code", modelId: "deepseek-flash" } } } });
  expect(h.visible("system-settings-continue")).toBe(true);
  const mode = h.element("system-settings-mode") as HTMLSelectElement;
  mode.value = "per-function"; mode.dispatchEvent(new h.w.Event("change"));
  expect(h.element("system-settings-policies").querySelectorAll("fieldset")).toHaveLength(4);
  expect(h.posts).toHaveLength(1);
});

it("uses per-function defaults for new planning and review while preserving an explicit review choice", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true; settings.mode = "per-function";
  settings.functions.planning = { priority: "agent", agent: { runnerId: "claude-code", modelId: "deepseek-flash" }, webSource: "chatgpt" };
  settings.functions.review = { priority: "web", agent: { runnerId: "codex" }, webSource: "claude" };
  const h = await page({ hash: "#/workspaces/project/new", settings });
  await expect.poll(() => (h.element("planner-provider") as HTMLSelectElement).value).toBe("claude-agent");
  await expect.poll(() => (h.element("planner-model") as HTMLInputElement).value).toBe("deepseek-flash");
  h.w.eval('void navigate("/workspaces/project/plans/first/review")');
  await expect.poll(() => (h.element("reviewer-mode") as HTMLSelectElement).value).toBe("web-claude");
  const select = h.element("reviewer-mode") as HTMLSelectElement;
  select.value = "codex-agent"; select.dispatchEvent(new h.w.Event("change"));
  h.w.eval('renderReviewerControls(__testState.planning)'); expect(select.value).toBe("codex-agent");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.posts).toHaveLength(0);
});

it("applies webpage priority after saving over an Agent default, including a new round on the same planning route", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true; settings.unified.priority = "agent";
  const h = await page({ hash: "#/workspaces/project/new", settings });
  await expect.poll(() => (h.element("planner-provider") as HTMLSelectElement).value).toBe("codex-agent");
  expect([...((h.element("planner-provider") as HTMLSelectElement).options)].some(option => option.value === "chatgpt-mcp")).toBe(false);
  h.w.eval('void navigate("/settings")'); await expect.poll(() => h.element("system-settings-policies").children.length).toBe(1);
  const priority = h.element("system-settings-policies").querySelector<HTMLSelectElement>('[data-field="priority"]')!;
  priority.value = "web"; priority.dispatchEvent(new h.w.Event("change"));
  h.element("system-settings-form").dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => h.element("system-settings-status").textContent).toContain("已保存");
  h.w.eval('void navigate("/workspaces/project/new")');
  await expect.poll(() => (h.element("planner-provider") as HTMLSelectElement).value).toBe("web-mcp");
  const provider = h.element("planner-provider") as HTMLSelectElement; provider.value = "claude-agent"; provider.dispatchEvent(new h.w.Event("change"));
  h.element("new-task").click(); await expect.poll(() => provider.value).toBe("web-mcp");
  expect(h.visible("start-planning")).toBe(false); expect(h.visible("copy-web-planning")).toBe(true);
  expect(h.posts.filter(post => post.path.endsWith("/plannings"))).toHaveLength(0);
});

it("uses the current Agent review default on a webpage plan and requires confirmation before cancelling its pending review", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true; settings.unified.priority = "agent"; settings.unified.agent.modelId = "test-fast-model";
  const h = await page({ hash: "#/workspaces/project/plans/first/review", settings });
  await expect.poll(() => h.w.eval('__testState.planning?.planningId')).toBe("first");
  const plan: any = h.plans[0]; plan.review.current = false; plan.workflow = { role: "review", operationId: "pending-review", stage: "review_owned", detail: "等待网页" };
  plan.externalOperations = [{ operationId: "pending-review", role: "review", state: "prepared", coordinated: true, isCurrent: true }];
  h.element("refresh").click(); await expect.poll(() => h.element("review-button").textContent).toBe("使用 Codex 审查");
  await expect.poll(() => h.w.eval('__testState.planning.workflow?.role')).toBe("review");
  expect(h.visible("web-continue")).toBe(false);
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (init?.method === "POST" && (raw.endsWith("/pending-review/cancel") || raw.endsWith("/review"))) {
      h.posts.push({ path: raw, body: JSON.parse(init.body) });
      if (raw.endsWith("/cancel")) { plan.externalOperations[0].state = "cancelled"; delete plan.workflow; return Response.json({ state: "cancelled" }); }
      plan.review.current = true; return Response.json({ jobId: "review-agent", workspaceId: "project", kind: "planning.review", status: "succeeded", result: { planningId: "first" } });
    }
    return original(raw, init);
  }) as any;
  h.element("review-button").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.posts).toHaveLength(0); h.element("confirm-action-no").click(); expect(h.posts).toHaveLength(0);
  h.element("review-button").click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => h.posts.length).toBe(2);
  expect(h.posts[0]!.path).toContain("/pending-review/cancel");
  expect(h.posts[1]).toMatchObject({ path: "/api/v1/workspaces/project/plannings/first/review", body: { reviewer: { mode: "codex-agent", model: "test-fast-model" } } });
  expect(h.copied).toHaveLength(0);
});

it("routes revision by its independent policy and exposes Agent continuation on an originally webpage plan", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true; settings.mode = "per-function";
  settings.functions.review.priority = "agent";
  settings.functions.revision = { priority: "agent", agent: { runnerId: "claude-code", modelId: "deepseek-flash" }, webSource: "chatgpt" };
  const h = await page({ hash: "#/workspaces/project/plans/first/review", settings });
  const plan: any = h.plans[0]; plan.review.findings = [{ findingId: "F1", severity: "warning", description: "测试不足", basis: "验收", suggestion: "补充空字符串测试" }];
  h.element("refresh").click(); await expect.poll(() => h.element("review-actions").querySelector("button")?.textContent).toBe("调用 Agent 修订草案");
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/revise") && init?.method === "POST") { h.posts.push({ path: raw, body: JSON.parse(init.body) }); return Response.json({ jobId: "revision-agent", workspaceId: "project", kind: "planning.draft.revise", status: "succeeded", result: { planningId: "first" } }); }
    return original(raw, init);
  }) as any;
  h.w.eval('__testState.activeJob={jobId:"finishing-review",status:"running"}; renderReview()');
  expect(h.element("review-actions").querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(h.element("review-actions").textContent).toContain("正在收尾");
  h.w.eval('__testState.activeJob=null; renderReview()');
  h.element("review-actions").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]!.body).toMatchObject({ planner: { mode: "claude-agent", model: "deepseek-flash" } });
});

it("keeps workspace settings separate, retains the selected project through system settings and reuses authorization management", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => (h.element("workspace-settings-nav") as HTMLButtonElement).disabled).toBe(false);
  expect(h.visible("workspace-rename-open")).toBe(false);
  h.element("workspace-settings-nav").click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/settings");
  expect(h.visible("workspace-rename-open")).toBe(true); expect(h.element("workspace-settings-path").textContent).toContain("/projects/排课后端");
  h.w.eval('void navigate("/settings")'); await expect.poll(() => h.w.location.hash).toBe("#/settings");
  expect(h.w.eval('__testState.workspace.workspaceId')).toBe("project");
  h.element("workspace-settings-nav").click(); await expect.poll(() => h.visible("workspace-settings-page")).toBe(true);
  h.element("workspace-manage-access").click(); await expect.poll(() => h.w.location.hash).toBe("#/connect");
  expect(h.visible("authorization-panel")).toBe(true); expect(h.posts).toHaveLength(0);
});

it("opens the configured diagnostic Agent without calling a model and lets the user switch analysis routes", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true; settings.unified.priority = "agent"; settings.unified.agent = { runnerId: "claude-code", modelId: "deepseek-flash" };
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", settings });
  await expect.poll(() => h.w.eval('__testState.planning?.planningId')).toBe("first");
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => raw.endsWith("/diagnostics") ? Response.json({ diagnostics: [{ diagnosticId: "older-diagnosis", runnerId: "codex", modelId: "old-model", status: "completed", messages: [] }] }) : original(raw, init)) as any;
  h.w.eval('__testState.attemptView = {workspaceId:"project",planningId:"first",attemptId:"diagnostic-attempt",attempt:{runnerId:"codex"}}; void openAttemptDiagnosis()');
  await expect.poll(() => h.element("attempt-diagnosis-dialog").hasAttribute("open")).toBe(true);
  await expect.poll(() => (h.element("attempt-diagnosis-runner") as HTMLSelectElement).value).toBe("claude-code");
  await expect.poll(() => (h.element("attempt-diagnosis-model") as HTMLSelectElement).value).toBe("deepseek-flash");
  expect(h.posts).toHaveLength(0);
  const switchMode = [...h.element("attempt-diagnosis-dialog").querySelectorAll("button")].find(button => button.textContent === "切换分析方式")!;
  switchMode.click(); expect(h.element("diagnosis-choice-dialog").hasAttribute("open")).toBe(true);
});

it("uses webpage diagnosis preference to export evidence without starting the previous Attempt's Agent", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true;
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", settings });
  await expect.poll(() => h.w.eval('__testState.planning?.planningId')).toBe("first");
  const original = h.w.fetch, diagnosticRequests: string[] = [];
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/diagnostics") && init?.method === "POST") { diagnosticRequests.push(raw); return Response.json({ absolutePath: "/projects/evidence.json", prompt: "通过 MCP 读取证据并分析" }); }
    return original(raw, init);
  }) as any;
  h.w.eval('__testState.attemptView = {workspaceId:"project",planningId:"first",attemptId:"diagnostic-attempt",attempt:{runnerId:"codex"}}; void openAttemptDiagnosis()');
  await expect.poll(() => h.copied).toEqual(["通过 MCP 读取证据并分析"]);
  expect(diagnosticRequests).toEqual(["/api/v1/workspaces/project/plannings/first/attempts/diagnostic-attempt/diagnostics/export"]);
  expect(h.element("attempt-diagnosis-dialog").hasAttribute("open")).toBe(false);
});

it("offers local preparation before handing an existing Agent plan to the webpage", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true;
  const h = await page({ hash: "#/workspaces/project/plans/first/overview", settings });
  const plan: any = h.plans[0]; plan.config.provider = "codex-agent"; h.element("refresh").click();
  await expect.poll(() => h.visible("prepare-web-planning")).toBe(true);
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/web-continue") && init?.method === "POST") { h.posts.push({ path: raw, body: JSON.parse(init.body) }); plan.config.provider = "web-mcp"; plan.workflow = { role: "plan", detail: "等待网页" }; return Response.json({ jobId: "web-continue", workspaceId: "project", kind: "external.prepare", status: "succeeded", result: { planningId: "first", nextAction: "handoff_claim" } }); }
    return original(raw, init);
  }) as any;
  h.element("prepare-web-planning").click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]!.path).toBe("/api/v1/workspaces/project/plannings/first/web-continue");
  await expect.poll(() => h.visible("prepare-web-planning")).toBe(false);
});

it("retains unsaved settings after a failed save and reloads saved preferences explicitly", async () => {
  const settings = defaultSystemSettings(); settings.initialized = true;
  const h = await page({ hash: "#/settings", settings });
  await expect.poll(() => h.element("system-settings-policies").children.length).toBe(1);
  const priority = h.element("system-settings-policies").querySelector<HTMLSelectElement>('[data-field="priority"]')!;
  priority.value = "agent"; priority.dispatchEvent(new h.w.Event("change"));
  const original = h.w.fetch;
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/settings") && init?.method === "POST" ? Promise.resolve(Response.json({ error: "settings_revision_conflict" }, { status: 400 })) : original(raw, init)) as any;
  h.element("system-settings-form").dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => h.element("system-settings-status").textContent).toContain("保存未完成");
  expect(priority.value).toBe("agent"); expect(h.w.eval('__testState.systemSettings.unified.priority')).toBe("web");
  h.element("system-settings-reload").click();
  await expect.poll(() => h.element("system-settings-policies").querySelector<HTMLSelectElement>('[data-field="priority"]')!.value).toBe("web");
});

it("cancels folder selection immediately and prevents a late cancelled response from unlocking a newer picker", async () => {
  const h = await page({ hash: "#/workspaces", ready: true }), original = h.w.fetch;
  const pending: Array<{ signal: AbortSignal; finish(result: Response): void }> = [];
  h.w.fetch = ((raw: string, init?: any) => raw.endsWith("/native-picker") ? new Promise<Response>(finish => pending.push({ signal: init.signal, finish })) : original(raw, init)) as any;
  h.element("add-workspace-main").click(); await chooseNativeFolder(h); await expect.poll(() => pending.length).toBe(1);
  h.element("cancel-directory-picker").click(); expect(pending[0]!.signal.aborted).toBe(true);
  expect((h.element("workspace-manual-path") as HTMLDetailsElement).open).toBe(true);
  expect((h.element("choose-workspace-native") as HTMLButtonElement).disabled).toBe(false);
  h.element("choose-workspace-native").click(); await expect.poll(() => pending.length).toBe(2);
  pending[0]!.finish(Response.json({ cancelled: false, paths: ["/stale"] })); await new Promise(resolve => setTimeout(resolve, 20));
  expect((h.element("choose-workspace-native") as HTMLButtonElement).disabled).toBe(true);
  expect((h.element("workspace-path") as HTMLInputElement).value).toBe("");
  h.element("workspace-form-back").click(); expect(pending[1]!.signal.aborted).toBe(true);
  pending[1]!.finish(Response.json({ cancelled: false, paths: ["/late"] }));
  expect(h.visible("workspace-form")).toBe(false); expect(h.posts).toHaveLength(0);
});

it("loads the full task model menu, isolates Runner choices and ignores a late catalog", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/draft", ready: true });
  await expect.poll(() => h.w.eval("__testState.planning?.planningId")).toBe("first");
  const original = h.w.fetch; let delayed: ((value: Response) => void) | undefined, delayClaude = false;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/runners/codex/models")) return Response.json({ models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }], customAllowed: true });
    if (raw.includes("/runners/claude-code/models")) {
      if (delayClaude) return new Promise<Response>(resolve => { delayed = resolve; });
      return Response.json({ models: [{ id: "opus" }, { id: "deepseek-flash" }], customAllowed: true });
    }
    return original(raw, init);
  }) as any;
  h.w.eval('__testState.runners = [{id:"codex",available:true},{id:"claude-code",available:true},{id:"mock",available:true}]; __testState.planning.draft.plan.tasks[0].task.execution = {runnerId:"codex",mode:"managed",modelId:"gpt-6.1-sol"}');
  h.element("configure-task-agents").click();
  const row = h.element("task-agent-config-list").firstElementChild!, runner = row.querySelector<HTMLSelectElement>('[data-field="runner"]')!, model = row.querySelector<HTMLInputElement>('[data-field="model"]')!, choice = row.querySelector<HTMLSelectElement>('[data-field="model-choice"]')!;
  await expect.poll(() => [...choice.options].map(option => option.value)).toContain("gpt-6-luna");
  choice.value = "__custom__"; choice.dispatchEvent(new h.w.Event("change")); model.value = "custom-codex"; model.dispatchEvent(new h.w.Event("input"));
  runner.value = "claude-code"; runner.dispatchEvent(new h.w.Event("change"));
  expect(model.value).toBe(""); await expect.poll(() => [...choice.options].map(option => option.value)).toContain("deepseek-flash");
  choice.value = "deepseek-flash"; choice.dispatchEvent(new h.w.Event("change")); expect(model.value).toBe("deepseek-flash");
  runner.value = "codex"; runner.dispatchEvent(new h.w.Event("change")); expect(model.value).toBe("custom-codex");
  delayClaude = true; runner.value = "claude-code"; runner.dispatchEvent(new h.w.Event("change")); await expect.poll(() => !!delayed).toBe(true);
  runner.value = "codex"; runner.dispatchEvent(new h.w.Event("change"));
  delayed!(Response.json({ models: [{ id: "stale-claude" }], customAllowed: true }));
  await expect.poll(() => [...choice.options].map(option => option.value)).toContain("gpt-6-luna");
  expect([...choice.options].map(option => option.value)).not.toContain("stale-claude"); expect(model.value).toBe("custom-codex");
});

it("shows a clickable execution floating bar outside its source plan without replacing the job", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true });
  await expect.poll(() => h.w.eval("__testState.planning?.planningId")).toBe("first");
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => raw.includes("/jobs/float-job") ? Response.json({ jobId: "float-job", kind: "planning.run", status: "running" }) : original(raw, init)) as any;
  h.w.eval('void startJob("运行计划", () => Promise.resolve({jobId:"float-job",kind:"planning.run",status:"running"}))');
  await expect.poll(() => h.w.eval('__testState.activeJob?.jobId')).toBe("float-job");
  h.w.eval('void navigate("/connect")'); await expect.poll(() => h.visible("execution-floating-status")).toBe(true);
  expect(h.element("execution-floating-title").textContent).toBe("计划 first"); expect(h.element("execution-floating-state").textContent).toContain("执行中");
  expect(h.element("execution-floating-status").textContent).not.toContain("打开计划");
  h.element("execution-floating-status").click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
  expect(h.visible("execution-floating-status")).toBe(false); expect(h.w.eval('__testState.activeJob.jobId')).toBe("float-job");
});

it("keeps a pause receipt visible while work drains and permits cancellation without replacing the execution job", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true });
  const session: any = { sessionId: "session", executionId: "execution", status: "running", isolation: { mode: "git-worktree" }, health: { state: "active" }, tasks: [{ taskId: "spec", title: "接口设计", status: "running", attempts: [] }] };
  (h.plans[0] as any).session = session; h.element("refresh").click();
  await expect.poll(() => h.element("session-controls").querySelector(".button-session-pause")).not.toBeNull();
  h.w.eval('__testState.activeJob={jobId:"execution-job",kind:"planning.run",status:"running"}');
  const original = h.w.fetch; let calls = 0;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/session/pause") && init?.method === "POST") {
      calls++; session.status = "pausing"; session.pendingControl = { requestId: "pause-request", kind: "pause", executionId: "execution" };
      return Response.json({ jobId: "pause-job", kind: "session.pause", status: "succeeded", result: { phase: "requested", kind: "pause", requestId: "pause-request", executionId: "execution", status: "pausing" } });
    }
    return original(raw, init);
  }) as any;
  h.element("session-controls").querySelector<HTMLButtonElement>(".button-session-pause")!.click();
  await expect.poll(() => h.element("session-control-status").textContent).toContain("暂停请求已接收");
  expect(h.element("session-control-status").textContent).toContain("接口设计");
  expect(h.element("session-controls").querySelector<HTMLButtonElement>(".button-session-pause")!.disabled).toBe(true);
  expect(h.element("session-controls").querySelector<HTMLButtonElement>(".button-session-cancel")!.disabled).toBe(false);
  expect(h.w.eval('__testState.activeJob.jobId')).toBe("execution-job"); expect(calls).toBe(1);
  session.status = "paused"; session.pendingControl = undefined; session.controlState = { requestId: "pause-request", kind: "pause", acknowledgedAt: new Date().toISOString() }; session.tasks[0].status = "succeeded";
  h.element("refresh").click(); await expect.poll(() => h.element("session-control-status").textContent).toContain("会话已暂停");
});

it("shows MCP names outside details and sorts authorization records by their creation time", async () => {
  const h = await page({ ready: true }); const now = Date.now();
  h.setGrants([{ grantId: "older", alias: "demo-old", source: "chatgpt", workspaceIds: ["project"], createdAt: now - 3000, expiresAt: now + 60000 }, { grantId: "newest", alias: "demo-new", source: "claude", workspaceIds: ["project"], createdAt: now - 1000, expiresAt: now + 60000 }, { grantId: "middle", source: "chatgpt", workspaceIds: ["project"], createdAt: now - 2000, expiresAt: now + 60000 }]);
  h.element("refresh").click(); await expect.poll(() => h.element("remote-grants").children.length).toBe(3);
  expect([...h.element("remote-grants").children].map(card => (card as HTMLElement).dataset.grantId)).toEqual(["newest", "middle", "older"]);
  expect(h.element("remote-mcp-names").textContent).toContain("demo-new"); expect(h.element("remote-grants").firstElementChild!.textContent).toContain("MCP：demo-new");
  h.setRemote({ authorizationRequests: [{ requestId: "old-request", status: "approved", createdAt: now - 2000 }, { requestId: "new-request", status: "approved", createdAt: now }] });
  h.element("refresh").click(); await expect.poll(() => h.element("remote-approval-history-list").textContent).toContain("new-requ");
  expect(h.element("remote-approval-history-list").textContent!.indexOf("new-requ")).toBeLessThan(h.element("remote-approval-history-list").textContent!.indexOf("old-requ"));
});

it("distinguishes a generic web source from its MCP name and saves a name without changing authorization", async () => {
  const h = await page({ ready: true });
  h.setGrants([{ grantId: "named", clientName: "ChatGPT", source: "chatgpt", workspaceIds: ["project"], expiresAt: Date.now() + 60000 }, { grantId: "other", alias: "demo-other", source: "claude", workspaceIds: ["project"], expiresAt: Date.now() + 60000 }]);
  h.element("refresh").click(); await expect.poll(() => h.element("remote-grants").children.length).toBe(2);
  const card = () => h.element("remote-grants").querySelector<HTMLElement>('[data-grant-id="named"]')!;
  expect(card().querySelector(".grant-mcp-title")!.textContent).toContain("MCP：待设置名称");
  card().querySelector<HTMLButtonElement>(".grant-rename")!.click();
  const input = card().querySelector<HTMLInputElement>(".grant-name-input")!; input.value = "demo1";
  card().querySelector<HTMLFormElement>(".grant-name-form")!.dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
  await expect.poll(() => card().querySelector(".grant-mcp-title")!.textContent).toContain("MCP：demo1");
  expect(h.posts.filter(item => item.path.includes("/grants/"))).toEqual([{ path: "/api/v1/remote-connection/grants/named/name", body: { alias: "demo1" } }]);
  expect(h.element("remote-mcp-names").textContent).toContain("demo1");
  h.element("refresh").click(); await expect.poll(() => card().textContent).toContain("demo1");
  expect(h.element("remote-grants").querySelector('[data-grant-id="other"]')!.textContent).toContain("demo-other");
  expect(h.w.eval('grantMcpName({clientName:"web-demo",source:"claude"})')).toBe("web-demo");
  expect(h.w.eval('grantMcpName({clientName:"web-demo",alias:"my-demo"})')).toBe("my-demo");
});

it("keeps an unsuccessful name edit and allows cancellation without changing the saved name", async () => {
  const h = await page({ ready: true });
  h.setGrants([{ grantId: "named", alias: "demo1", source: "chatgpt", workspaceIds: ["project"], expiresAt: Date.now() + 60000 }]);
  h.element("refresh").click(); await expect.poll(() => h.element("remote-grants").querySelector('[data-grant-id="named"]')).not.toBeNull();
  const card = h.element("remote-grants").querySelector('[data-grant-id="named"]')!;
  card.querySelector<HTMLButtonElement>(".grant-rename")!.click();
  const input = card.querySelector<HTMLInputElement>(".grant-name-input")!; input.value = "new-name";
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: any) => raw.endsWith("/name") ? Response.json({ error: "save unavailable" }, { status: 503 }) : original(raw, init)) as any;
  card.querySelector<HTMLFormElement>(".grant-name-form")!.dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => card.querySelector(".grant-name-feedback")!.textContent).toContain("save unavailable");
  expect(input.value).toBe("new-name"); expect(card.querySelector(".grant-mcp-title")!.textContent).toContain("demo1");
  card.querySelector<HTMLButtonElement>('.grant-name-form button[type="button"]')!.click();
  expect(card.querySelector(".grant-name-form")!.classList.contains("hidden")).toBe(true); expect(input.value).toBe("demo1");
});

it("supports optional directory path navigation and server-side name search without opening a native picker", async () => {
  const h = await page({ hash: "#/workspaces", ready: true, empty: true });
  await expect.poll(() => h.visible("workspace-selection")).toBe(true);
  const original = h.w.fetch, queries: string[] = [];
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/api/v1/directories")) {
      const url = new URL(raw, "http://127.0.0.1:4177"), path = url.searchParams.get("path") || "/projects"; queries.push(url.searchParams.get("query") || "");
      return Response.json({ path, parent: "/", entries: [{ name: "课程设计", path: path + "/课程设计" }], totalMatches: 1, nextOffset: null });
    }
    return original(raw, init);
  }) as any;
  h.element("workspace-path-browse").click(); await expect.poll(() => h.element("directory-list").children.length).toBe(1);
  const input = h.element("directory-query") as HTMLInputElement; input.value = "课程"; input.dispatchEvent(new h.w.Event("input"));
  await expect.poll(() => queries).toContain("课程");
  (h.element("directory-path") as HTMLInputElement).value = "/projects/目标"; h.element("directory-go").click();
  await expect.poll(() => h.element("directory-status").textContent).toContain("/projects/目标"); h.element("directory-use").click();
  expect((h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/目标"); expect(h.nativeCalls).toHaveLength(0); expect(h.posts).toHaveLength(0);
});
it("updates the displayed model from native events and distinguishes SDK startup declarations from replies", async () => {
  const h = await page();
  const result = h.w.eval(`(() => {
    const view = { seen: new Set(), raw: [] };
    projectAttemptEvent(view, { sequence: 1, type: "runner.model.reported", payload: { model: "startup-alias", source: "claude-sdk-init" } });
    const startup = reportedModelLabel(view.reportedModel, view.reportedModelSource);
    projectAttemptEvent(view, { sequence: 2, type: "runner.model.reported", payload: { model: "deepseek-flash", source: "claude-sdk-assistant" } });
    projectAttemptEvent(view, { sequence: 1, type: "runner.model.reported", payload: { model: "stale", source: "claude-sdk-init" } });
    return { startup, reply: reportedModelLabel(view.reportedModel, view.reportedModelSource), rawCount: view.raw.length };
  })()`);
  expect(result).toEqual({ startup: "startup-alias（SDK 启动报告）", reply: "deepseek-flash（回复模型）", rawCount: 2 });
});
afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 0)); for (const window of windows.splice(0)) window.window.close(); });
it("reconciles a restarted daemon without replaying mutations or discarding local inputs", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/draft" });
  await expect.poll(() => (h.w as any).__testState.initialized).toBe(true);
  h.element("toggle-plan-edit").click();
  const title = h.element("plan-text-editor").querySelector("input") as HTMLInputElement;
  title.value = "尚未保存的标题"; title.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  const input = h.element("reply-text") as HTMLTextAreaElement; input.value = "未提交澄清";
  const sources: any[] = [];
  h.w.EventSource = class {
    listeners = new Map<string, (event: any) => void>();
    constructor(readonly url: string) { sources.push(this); }
    addEventListener(name: string, callback: (event: any) => void) { this.listeners.set(name, callback); }
    close() {}
    emit(name: string, value: any) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
  } as any;
  const originalFetch = h.w.fetch;
  h.w.fetch = async (path: string, options?: RequestInit) => String(path).endsWith("/health")
    ? Response.json({ epoch: "restarted", protocol: { major: 1, minor: 0 }, workspaceEnvironment: { currentDirectory: "/projects" }, capabilities: { executionSelection: 1 } })
    : originalFetch(path, options);
  const before = h.posts.length;
  h.w.eval("__testState.lastEventId = 800; connectEvents();");
  expect(sources[0].url).toContain("epoch=test");
  sources[0].emit("hello", { epoch: "restarted", latestSequence: 2, resetReason: "epoch_changed" });
  await expect.poll(() => h.element("connection-label").textContent).toContain("状态已核对");
  expect((h.w as any).__testState.daemonEpoch).toBe("restarted");
  expect((h.w as any).__testState.lastEventId).toBe(2);
  expect((h.element("plan-text-editor").querySelector("input") as HTMLInputElement).value).toBe("尚未保存的标题");
  expect(input.value).toBe("未提交澄清");
  expect(h.posts).toHaveLength(before);
  h.w.eval("connectEvents();");
  expect(sources[1].url).toContain("after=2&epoch=restarted");
});
async function page(options: { hash?: string; ready?: boolean; empty?: boolean; approved?: boolean; pendingAuth?: boolean; gitState?: string; multiple?: boolean; legacyDaemon?: boolean; reactRunMode?: boolean; reactRunAdvanced?: boolean; reactRunAgentMode?: boolean; reactAgentSelection?: boolean; reactRuntimeModels?: boolean; reactSystemPolicyRouting?: boolean; settings?: ReturnType<typeof defaultSystemSettings> } = {}) {
  const [html, clientScript, script] = await Promise.all([readFile(new URL("../public/index.html", import.meta.url), "utf8"), readFile(new URL("../public/api-client.js", import.meta.url), "utf8"), readFile(new URL("../public/app.js", import.meta.url), "utf8")]);
  const dom = new JSDOM(html, { url: `http://127.0.0.1:4177/${options.hash || ""}`, runScripts: "outside-only", pretendToBeVisual: true }); windows.push(dom);
  const w = dom.window, posts: Array<{ path: string; body: any }> = [], copied: string[] = [], reads: string[] = [];
  Object.assign(w, { Headers, structuredClone, EventSource: class { addEventListener() {} close() {} } });
  Object.defineProperty(w.crypto, "randomUUID", { value: randomUUID });
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  if (options.reactRunMode) Object.assign(w, { tokenCouponRunModeSelector: { render(model: { options: Array<{ id: string; title: string; description: string }>; selectedMode: string }, onChange: (mode: "default" | "custom") => void) {
    const root = w.document.getElementById("run-mode-selector-root")!;
    root.replaceChildren(...model.options.map(option => {
      const label = w.document.createElement("label"); label.className = "run-config-choice";
      const input = w.document.createElement("input"); input.type = "radio"; input.name = "run-mode-choice"; input.value = option.id; input.checked = model.selectedMode === option.id;
      input.onchange = () => onChange(option.id as "default" | "custom");
      const copy = w.document.createElement("span"), title = w.document.createElement("strong"), description = w.document.createElement("small"); title.textContent = option.title; description.textContent = option.description; copy.append(title, description); label.append(input, copy); return label;
    }));
  } } });
  if (options.reactRunAgentMode) Object.assign(w, { tokenCouponRunAgentMode: { render(model: { options: Array<{ id: string; label: string; disabled: boolean }>; selectedMode: string }, onChange: (mode: "plan" | "unified" | "per-task") => void) {
    const root = w.document.getElementById("run-agent-mode-root")!;
    const select = w.document.createElement("select"); select.id = "run-agent-mode";
    select.replaceChildren(...model.options.map(option => { const item = new w.Option(option.label, option.id); item.disabled = option.disabled; return item; }));
    select.value = model.selectedMode; select.onchange = () => onChange(select.value as "plan" | "unified" | "per-task"); root.replaceChildren(select);
  } } });
  if (options.reactAgentSelection) Object.assign(w, { tokenCouponAgentSelectionControls: { render(mount: HTMLElement, model: { runners: Array<{ id: string; label: string; disabled: boolean }>; selectedRunnerId: string; modelChoices: Array<{ id: string; label: string }>; selectedModelChoice: string; modelId: string; showCustomModel: boolean; hint: string }, callbacks: { onRunnerChange: (id: string) => void; onModelChoice: (id: string) => void; onModelInput: (value: string) => void; onRefresh: () => void }) {
    let root = mount.querySelector<HTMLElement>(".agent-selection-controls"), runner: HTMLSelectElement, choice: HTMLSelectElement, input: HTMLInputElement, refresh: HTMLButtonElement, hint: HTMLElement;
    if (!root) {
      root = w.document.createElement("div"); root.className = "agent-selection-controls";
      const fields = w.document.createElement("div"); fields.className = "settings-grid task-agent-config-fields";
      const runnerLabel = w.document.createElement("label"); runnerLabel.append(w.document.createTextNode("Runner"));
      runner = w.document.createElement("select"); runner.dataset.field = "runner"; runner.onchange = () => callbacks.onRunnerChange(runner.value); runnerLabel.append(runner);
      const modelLabel = w.document.createElement("label"); modelLabel.append(w.document.createTextNode("模型"));
      choice = w.document.createElement("select"); choice.dataset.field = "model-choice"; choice.onchange = () => callbacks.onModelChoice(choice.value);
      input = w.document.createElement("input"); input.dataset.field = "model"; input.oninput = () => callbacks.onModelInput(input.value);
      refresh = w.document.createElement("button"); refresh.type = "button"; refresh.textContent = "刷新模型"; refresh.onclick = () => callbacks.onRefresh();
      modelLabel.append(choice, input, refresh); fields.append(runnerLabel, modelLabel); root.append(fields);
      hint = w.document.createElement("p"); hint.className = "hint"; root.append(hint); mount.append(root);
    } else {
      runner = root.querySelector('[data-field="runner"]')!; choice = root.querySelector('[data-field="model-choice"]')!; input = root.querySelector('[data-field="model"]')!; refresh = root.querySelector("button")!; hint = root.querySelector(".hint")!;
    }
    runner.replaceChildren(...model.runners.map(item => { const option = new w.Option(item.label, item.id); option.disabled = item.disabled; return option; })); runner.value = model.selectedRunnerId;
    choice.replaceChildren(...model.modelChoices.map(item => new w.Option(item.label, item.id))); choice.value = model.selectedModelChoice;
    input.value = model.modelId; input.hidden = !model.showCustomModel; hint.textContent = model.hint;
  }, unmount(mount: HTMLElement) { mount.replaceChildren(); } } });
  if (options.reactRuntimeModels) Object.assign(w, { tokenCouponRuntimeModelControls: { render(model: { tasks: Array<{ id: string; label: string }>; selectedTaskId: string; models: Array<{ id: string; label: string }>; selectedModelId: string; customModelId: string }, callbacks: { onTaskChange: (id: string) => void; onModelChange: (id: string) => void; onCustomModelChange: (value: string) => void }) {
    const root = w.document.getElementById("runtime-model-controls-root")!;
    let task = root.querySelector<HTMLSelectElement>("#runtime-model-task"), choice = root.querySelector<HTMLSelectElement>("#runtime-model-choice"), custom = root.querySelector<HTMLInputElement>("#runtime-model-custom");
    if (!task || !choice || !custom) {
      root.innerHTML = '<div class="settings-grid"><label>目标任务<select id="runtime-model-task"></select></label><label>模型<select id="runtime-model-choice"></select></label><label id="runtime-model-custom-wrap">自定义模型 ID<input id="runtime-model-custom"></label></div>';
      task = root.querySelector("#runtime-model-task")!; choice = root.querySelector("#runtime-model-choice")!; custom = root.querySelector("#runtime-model-custom")!;
    }
    task.replaceChildren(...model.tasks.map(item => new w.Option(item.label, item.id))); task.value = model.selectedTaskId; task.onchange = () => callbacks.onTaskChange(task!.value);
    choice.replaceChildren(...model.models.map(item => new w.Option(item.label, item.id))); choice.value = model.selectedModelId; choice.onchange = () => callbacks.onModelChange(choice!.value);
    custom.value = model.customModelId; custom.oninput = () => callbacks.onCustomModelChange(custom!.value);
    custom.parentElement!.classList.toggle("hidden", model.selectedModelId !== "__custom__");
  } } });
  if (options.reactSystemPolicyRouting) Object.assign(w, { tokenCouponSystemPolicyRouting: { render(mount: HTMLElement, model: { priority: "web" | "agent"; webSource: "chatgpt" | "claude" }, callbacks: { onPriorityChange: (priority: "web" | "agent") => void; onWebSourceChange: (source: "chatgpt" | "claude") => void }) {
    let priority = mount.querySelector<HTMLSelectElement>('[data-field="priority"]'), source = mount.querySelector<HTMLSelectElement>('[data-field="web-source"]');
    if (!priority || !source) {
      mount.innerHTML = '<label>默认方式<select data-field="priority"><option value="web">网页优先</option><option value="agent">指定 Agent 优先</option></select></label><label>默认网页<select data-field="web-source"><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select></label>';
      priority = mount.querySelector('[data-field="priority"]')!; source = mount.querySelector('[data-field="web-source"]')!;
    }
    priority.value = model.priority; priority.onchange = () => callbacks.onPriorityChange(priority!.value as "web" | "agent");
    source.value = model.webSource; source.onchange = () => callbacks.onWebSourceChange(source!.value as "chatgpt" | "claude");
    source.parentElement!.classList.toggle("hidden", model.priority !== "web");
  }, unmount(mount: HTMLElement) { mount.replaceChildren(); } } });
  if (options.reactRunAdvanced) Object.assign(w, { tokenCouponRunParameters: { render(model: { parallelOptions: Array<{ id: string; label: string }>; selectedParallel: string; isolationOptions: Array<{ id: string; label: string }>; selectedIsolation: string; verificationOptions: Array<{ id: string; label: string }>; selectedVerification: string; showVerification: boolean }, onChange: (field: "parallel" | "isolation" | "verification", value: string) => void) {
    const root = w.document.getElementById("run-advanced-options-root")!;
    const grid = w.document.createElement("div"); grid.className = "settings-grid advanced-grid";
    const addSelect = (id: string, labelText: string, options: Array<{ id: string; label: string }>, selected: string, field: "parallel" | "isolation" | "verification", hidden = false) => {
      const label = w.document.createElement("label"); if (id === "run-verification") { label.id = "run-verification-wrap"; if (hidden) label.className = "hidden"; }
      const select = w.document.createElement("select"); select.id = id; select.replaceChildren(...options.map(option => new w.Option(option.label, option.id))); select.value = selected; select.onchange = () => onChange(field, select.value);
      label.append(w.document.createTextNode(labelText), select); grid.append(label);
    };
    addSelect("run-parallel", "任务并发", model.parallelOptions, model.selectedParallel, "parallel");
    addSelect("run-isolation", "任务隔离", model.isolationOptions, model.selectedIsolation, "isolation");
    addSelect("run-verification", "最终验证任务", model.verificationOptions, model.selectedVerification, "verification", !model.showVerification);
    root.replaceChildren(grid);
  } } });
  w.HTMLElement.prototype.scrollIntoView = () => undefined; w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const workspaces = options.empty ? [] : [{ workspaceId: "project", label: "排课后端", path: "/projects/排课后端" }];
  if (options.multiple) workspaces.push({ workspaceId: "other", label: "其他项目", path: "/projects/other" });
  const nativeCalls: any[] = [], nativeResults: any = { directory: { cancelled: false, paths: ["/projects/新项目"] }, files: { cancelled: false, paths: ["README.md"] } };
  let settings = options.settings;
  let pendingInteractions: any[] = [];
  let gitStatus: any = { state: options.gitState || "ready", message: options.gitState === "not_repository" ? "此文件夹还不是 Git 仓库" : "Git 已就绪", commands: ["git init"] };
  const tasks = [
    ["spec", "接口与数据库文档", []], ["backend", "实现后端", ["spec"]], ["frontend", "实现界面", ["backend"]],
    ["test", "集成测试", ["frontend"]], ["verify", "最终验证与交付", ["test"]],
  ].map(([id, title, dependsOn]: any) => ({ task: { schemaVersion: 1, id, title, prompt: "代码正文按需展开", execution: { runnerId: "mock", mode: "managed" } }, status: "planned", dependsOn }));
  const makePlan = (id: string) => ({ planningId: id, createdAt: "2026-10-18T08:06:09.000Z", revision: 3, status: options.approved ? "approved" : "draft_ready", config: { provider: "web-mcp", model: "web-selected" }, messages: [{ messageId: "request", role: "user", content: `需求 ${id}` }], externalOperations: [], handoffs: [], review: { reviewId: "review-" + id, current: true, findings: [] }, ...(options.approved ? { approval: { planHash: id, draftRevision: 1, approvedAt: new Date().toISOString(), reviewId: "review-" + id } } : {}), verificationTasks: tasks.map((entry: any) => ({ taskId: entry.task.id, title: entry.task.title, valid: entry.task.id === "verify", reason: entry.task.id === "test" ? "最终验证任务 test 不能是其他任务的前置依赖" : undefined })), draft: { draftRevision: 1, planHash: id, plan: { schemaVersion: 1, id, title: `计划 ${id}`, tasks: structuredClone(tasks) } } });
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
      if (path === "/api/v1/settings") { settings = { ...body, revision: body.revision + 1, initialized: true }; return Response.json(settings); }
      if (path.includes("/interactions/")) { pendingInteractions = []; return Response.json({ ok: true }); }
      if (path === "/api/v1/workspaces") { const added = { workspaceId: "folder-project", path: body.path, label: body.label || "新项目" }; workspaces.push(added); return Response.json(added); }
      if (path.endsWith("/git")) { gitStatus = { state: body.action === "initialize" ? "no_commit" : "ready", message: body.action === "initialize" ? "Git 已初始化，但还没有首次提交" : "Git 已就绪", commands: [] }; return Response.json({ kind: "workspace.git.prepare", status: "succeeded", result: gitStatus }); }
      if (path.includes("/remote-connection/grants/")) { const grantId = path.endsWith("/name") ? path.split("/").at(-2) : path.split("/").at(-1); grants = grants.map(grant => grant.grantId === grantId ? { ...grant, ...body } : grant); return Response.json({ updated: true }); }
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
    if (path.endsWith("/health")) return Response.json({ epoch: "test", ...(options.legacyDaemon ? {} : { capabilities: { executionSelection: 1, ...(settings ? { systemSettings: 1, operationRouting: 1 } : {}) } }), workspaceEnvironment: { currentDirectory: "/projects" }, mcp: { localReady: true, url: "http://127.0.0.1:4177/mcp" } });
    if (path === "/api/v1/settings") return Response.json(settings);
    if (path === "/api/v1/workspaces") return Response.json(workspaces);
    if (path.endsWith("/git")) return Response.json(gitStatus);
    if (path === "/api/v1/directories") { const path = url.searchParams.get("path") || "/projects"; return Response.json({ path, parent: "/", shortcuts: [{ label: "主目录", path: "/projects" }], entries: path === "/projects" ? [{ name: "新项目", path: "/projects/新项目" }] : [], nextOffset: null }); }
    if (path.endsWith("/providers")) return Response.json([{ id: "web-mcp", label: "网页 MCP", available: true }, ...(settings ? ["codex-agent", "claude-agent", "chatgpt-mcp", "claude-mcp"].map(id => ({ id, label: id, available: true })) : [])]);
    if (path.endsWith("/runners")) return Response.json([{ id: "mock", label: "Mock", available: true }, ...(settings ? ["codex", "claude-code"].map(id => ({ id, label: id, available: true })) : [])]);
    if (path.endsWith("/models")) return Response.json({ models: [], customAllowed: true });
    if (path.endsWith("/remote-connection")) return Response.json(remote);
    if (path.endsWith("/grants")) return Response.json(grants);
    if (path.endsWith("/approvals")) return Response.json(approvalRequests);
    if (path.includes("/interactions/")) return Response.json(pendingInteractions);
    if (path.endsWith("/plannings")) return Response.json(plans);
    if (path.endsWith("/events")) return Response.json({ retainedWindow: true, events: [{ epoch: "test", sequence: 1, type: "runner.output", workspaceId: "project", planningId: "first", taskId: "implement", payload: { text: "本 Plan 已保存的输出" }, createdAt: new Date().toISOString() }] });
    if (path.includes("/plannings/")) return Response.json(plans.find(plan => plan.planningId === path.split("/").at(-1)));
    if (path.endsWith("/repository")) return url.searchParams.get("tool") === "repo_read" ? Response.json({ path: "README.md", startLine: 1, content: "1: <img src=x onerror=alert(1)>\n2: 项目说明", sha256: "a".repeat(64), truncated: false }) : Response.json({ path: ".", entries: [{ name: "README.md", type: "file" }], nextOffset: null });
    throw new Error(`unexpected GET ${path}`);
  };
  Object.assign(w, { createClient: () => createClient({ fetch: ((path, options) => w.fetch(String(path), options)) as typeof fetch, eventSource: (path) => new w.EventSource(path) }) });
  w.eval(clientScript.replace(/^import .*;$/m, "")); w.eval(script + "\nwindow.__testState = state;");
  const element = (id: string) => w.document.getElementById(id)!;
  const visible = (id: string) => { for (let node: Element | null = element(id); node; node = node.parentElement) if (node.classList.contains("hidden")) return false; return true; };
  await expect.poll(() => w.location.hash || element("toast").textContent).not.toBe("");
  await expect.poll(() => element("connection-label").textContent).toContain("已连接");
  await expect.poll(() => (w as any).__testState.initialized).toBe(true);
  return { w, element, visible, posts, copied, plans, reads, workspaces, nativeCalls, setInteractions: (items: any[]) => { pendingInteractions = items; }, setNativePicker: (kind: string, result: any) => { nativeResults[kind] = result; }, setGitStatus: (value: any) => { gitStatus = value; }, setGrants: (items: any[]) => { grants = items.map(item => ({ clientId: "gpt-client", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", scopes: ["planning:read"], createdAt: Date.now(), ...item })); }, setApprovals: (items: any[]) => { approvalRequests = items; remote.pendingApprovals = items.length; remote.authorizationRequests = items.map((item: any) => ({ requestId: item.requestId, clientId: item.clientId, clientName: item.clientName, createdAt: item.createdAt, expiresAt: item.expiresAt, status: "pending" })); }, setRemote: (patch: any) => { remote = { ...remote, ...patch }; } };
}

it("keeps quick navigation usable when the compiled React entry is unavailable", async () => {
  const h = await page({ ready: true });
  h.element("command-palette-open").click();
  const dialog = h.element("command-palette") as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(h.element("command-palette-results").querySelectorAll('[role="option"]').length).toBeGreaterThan(0);

  const input = h.element("command-palette-query") as HTMLInputElement;
  input.value = "连接中心";
  input.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  const options = h.element("command-palette-results").querySelectorAll<HTMLButtonElement>('[role="option"]');
  expect(options).toHaveLength(1);
  options[0]!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/connect");
  expect(dialog.open).toBe(false);
});

it("passes workspace state to the React switcher and keeps selection in the existing router", async () => {
  const h = await page({ ready: true });
  let received: any;
  (h.w as any).tokenCouponWorkspaceSwitcher = {
    render: (workspaces: any[], selectedWorkspaceId: string | undefined, onSelect: (id: string) => void) => {
      received = { workspaces, selectedWorkspaceId, onSelect };
    },
  };
  h.w.eval("renderWorkspaces()");
  expect(received.workspaces).toMatchObject([{ workspaceId: "project", label: "排课后端", path: "/projects/排课后端" }]);
  expect(received.selectedWorkspaceId).toBeUndefined();
  received.onSelect("project");
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project");
  expect(received.selectedWorkspaceId).toBe("project");
});

it("passes plan summaries to the React navigation and preserves existing plan/tool routes", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => h.w.eval("__testState?.plannings?.length")).toBe(2);
  let received: any;
  (h.w as any).tokenCouponPlanningSwitcher = {
    render: (items: any[], activeTool: string | undefined, onSelect: (id: string) => void, onOpenTool: (id: string, tab: string) => void, onToolsToggle: (id: string, expanded: boolean) => void) => {
      received = { items, activeTool, onSelect, onOpenTool, onToolsToggle };
    },
  };
  h.w.eval("renderPlanningList()");
  expect(received.items).toHaveLength(2);
  expect(received.items[0]).toMatchObject({ planningId: "first", title: "计划 first", taskCount: 5, selected: false });
  received.onSelect("first");
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first");
  await expect.poll(() => received.items.find((item: any) => item.planningId === "first")?.selected).toBe(true);
  received.onOpenTool("first", "attempts");
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/attempts");
  received.onToolsToggle("first", true);
  h.w.eval("renderPlanningList()");
  expect(received.items.find((item: any) => item.planningId === "first")?.toolsExpanded).toBe(true);
});

it("passes review findings to the React view and persists the chosen revision guidance", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/review", ready: true });
  await expect.poll(() => h.w.eval("__testState?.planning?.planningId")).toBe("first");
  h.w.eval(`__testState.planning.review.findings = [{ findingId: "F1", severity: "warning", description: "缺少错误响应测试", suggestion: "补充 400 响应测试", basis: "接口契约没有负向测试" }]; __testState.renderedReviewSignature = undefined;`);
  let received: any;
  (h.w as any).tokenCouponReviewView = {
    render: (model: any, onChoiceChange: (id: string, choice: any) => void) => { received = { model, onChoiceChange }; },
    setErrors: () => undefined,
  };
  h.w.eval("renderReview()");
  expect(received.model.findings).toMatchObject([{ findingId: "F1", severity: "warning", suggestion: "补充 400 响应测试" }]);
  expect(received.model.canChoose).toBe(true);
  received.onChoiceChange("F1", { choice: "custom", custom: "增加错误响应断言" });
  const storageKey = h.w.eval("`tc-review-${__testState.reviewChoiceContext.key}`");
  expect(JSON.parse(h.w.sessionStorage.getItem(storageKey)!)).toMatchObject({ F1: { choice: "custom", custom: "增加错误响应断言" } });
});

it("passes structured and legacy task fields to the React draft view while retaining old-plan compatibility", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/draft" });
  await expect.poll(() => h.w.eval("__testState?.planning?.planningId")).toBe("first");
  const structuredTask = {
    schemaVersion: 2, id: "spec", title: "接口与数据库设计", objective: "定义排课接口", approach: "使用 SQLite",
    steps: ["整理实体", "定义接口"], deliverables: ["接口文档"], acceptanceCriteria: ["CRUD 可验证"], constraints: ["不增加前端"],
    execution: { runnerId: "codex", mode: "managed", modelId: "fast-model" },
  };
  h.w.eval(`__testState.planning.draft.plan.tasks[0].task = ${JSON.stringify(structuredTask)}`);
  let received: any;
  (h.w as any).tokenCouponPlanDraftView = { render: (model: unknown) => { received = model; } };
  h.w.eval("renderDraft()");
  expect(received.tasks).toHaveLength(5);
  expect(received.tasks[0]).toMatchObject({
    taskId: "spec", title: "接口与数据库设计", schemaLabel: "结构化任务", runnerLabel: "Codex", modelLabel: "fast-model",
    sections: [
      { label: "需求目标", value: "定义排课接口" },
      { label: "设计与技术方案", value: "使用 SQLite" },
      { label: "实施步骤", value: ["整理实体", "定义接口"] },
      { label: "交付物", value: ["接口文档"] },
      { label: "验收标准", value: ["CRUD 可验证"] },
      { label: "约束", value: ["不增加前端"] },
    ],
  });
  expect(received.tasks[1]).toMatchObject({ schemaLabel: "旧版正文", sections: [{ label: "任务正文", value: "代码正文按需展开" }] });
});

it("passes the current plan metrics and primary action through the React overview bridge", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first" });
  await expect.poll(() => h.w.eval("__testState?.planning?.planningId")).toBe("first");
  let received: any;
  (h.w as any).tokenCouponPlanOverview = { render: (model: unknown, onPrimaryAction: () => void, onResume: () => void) => { received = { model, onPrimaryAction, onResume }; } };
  h.w.eval("renderPlanOverview()");
  expect(received.model).toMatchObject({ stage: "待核对与批准", taskCount: 5, completedTaskCount: 0, reviewStatus: "有效", primaryActionLabel: "核对并批准", resumeDisabled: false });
  received.onPrimaryAction();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/review");
});

it("uses the React plan tabs bridge for active navigation while preserving the current route actions", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/review" });
  await expect.poll(() => h.w.eval("__testState?.planning?.planningId")).toBe("first");
  let received: any;
  (h.w as any).tokenCouponPlanTabs = { render: (selectedTab: string, onSelect: (tab: string) => void) => { received = { selectedTab, onSelect }; } };
  h.w.eval("renderRoute()");
  expect(received.selectedTab).toBe("review");
  received.onSelect("execution");
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project/plans/first/execution");
  expect(received.selectedTab).toBe("execution");
});

it("passes recent conversation and pending webpage replies to the React message list", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first" });
  await expect.poll(() => h.w.eval("__testState?.planning?.planningId")).toBe("first");
  h.w.eval(`__testState.planning.messages = [
    { messageId: "user-turn", role: "user", content: "确认技术默认方案" },
    { messageId: "planner-turn", role: "assistant", content: "草案已生成" }
  ]; __testState.planning.externalOperations = [{ operationId: "op-pending", sourceMessageId: "pending-turn", role: "plan", state: "prepared", message: "补充接口异常场景" }];`);
  let received: any;
  (h.w as any).tokenCouponConversationView = { render: (model: unknown) => { received = model; } };
  h.w.eval("renderPlanning()");
  expect(received.count).toBe(3);
  expect(received.messages).toMatchObject([
    { messageId: "user-turn", roleClass: "user", label: "你", content: "确认技术默认方案" },
    { messageId: "planner-turn", roleClass: "assistant", label: "Planner", content: "草案已生成" },
    { messageId: "pending-turn", roleClass: "user", label: "你 · 已登记，等待网页", content: "补充接口异常场景" },
  ]);
});

it("keeps workspace authorization visible after a grant and when transport is stopped", async () => {
  const h = await page({ hash: "#/workspaces/project/settings", ready: true });
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

it("labels the current Attempt as waiting for an answer without relabeling another task or a new Attempt", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const first = randomUUID(), second = randomUUID();
  const plan: any = h.plans[0];
  plan.session = { status: "running", maxParallel: 2, tasks: [
    { taskId: "spec", title: "接口及存储设计", status: "running", activeAttemptId: first, attempts: [{ attemptId: first }], currentAttempt: { attemptId: first, runnerId: "codex", lastReply: "等待确认", execution: { modelId: "gpt-6-luna" } } },
    { taskId: "backend", title: "后端实现", status: "running", activeAttemptId: second, attempts: [{ attemptId: second }], currentAttempt: { attemptId: second, runnerId: "claude-code", lastReply: "正在实现" } },
  ] };
  const interaction = { requestId: "biz01-question", owner: { runnerId: "codex", taskId: "spec", attemptId: first }, request: { kind: "question", title: "补充信息", summary: "4177 批准状态", questions: [{ id: "q", text: "4177 批准状态" }] } };
  h.setInteractions([interaction]); h.element("refresh").click();
  await expect.poll(() => h.element("task-list").querySelector('[data-task-id="spec"] .badge')?.textContent).toBe("等待回答");
  expect(h.element("task-list").querySelector('[data-task-id="backend"] .badge')?.textContent).toBe("运行中");
  expect(h.element("session-progress").querySelector('[data-kind="running"]')?.textContent).toContain("运行中 1");
  expect(h.element("session-progress").querySelector('[data-kind="waiting"]')?.textContent).toContain("等待回答／审批 1");
  const reply = h.element("live-task-replies").querySelector(`[data-attempt-id="${first}"]`)!;
  expect(reply.querySelector("strong")?.textContent).toContain("接口及存储设计 · 等待回答");
  expect(reply.querySelector(".hint")?.textContent).not.toContain("长任务暂无输出");
  expect(reply.querySelector(".hint")?.textContent).toContain("审批与回答");
  h.setInteractions([{ ...interaction, owner: { ...interaction.owner, attemptId: randomUUID() } }]); h.element("refresh").click();
  await expect.poll(() => h.element("task-list").querySelector('[data-task-id="spec"] .badge')?.textContent).toBe("运行中");
  expect(h.element("session-progress").querySelector('[data-kind="waiting"]')).toBeNull();
  expect(h.element("session-progress").querySelector('[data-kind="running"]')?.textContent).toContain("运行中 2");
  expect(plan.session.tasks[0].status).toBe("running");
  h.setInteractions([]); h.element("refresh").click();
  await expect.poll(() => h.element("session-progress").querySelector('[data-kind="waiting"]')).toBeNull();
});

it("shows the BIZ-01 question's actual options and context, then submits an answer rather than a tool approval", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const attemptId = randomUUID(), background = "无法核验当前 Attempt 是否获批，等待用户说明。";
  (h.plans[0] as any).session = { status: "running", tasks: [{ taskId: "spec", title: "接口及存储设计", status: "running", activeAttemptId: attemptId, attempts: [], currentAttempt: { attemptId, lastReply: `${background}\n<<<TOKEN_COUPON_NEEDS_INPUT:abcdef>>>` } }] };
  h.setInteractions([{ requestId: "biz01-options", owner: { runnerId: "codex", taskId: "spec", attemptId }, request: { kind: "question", title: "Codex 需要补充信息", summary: "4177 批准状态", questions: [{ id: "status", text: "4177 批准状态", required: true, allowFreeText: true, options: [{ id: "confirmed", label: "已批准，恢复连接后继续" }, { id: "pending", label: "尚未批准，先完成审批" }] }] } }]);
  h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelectorAll(".runner-question-option").length).toBe(3);
  const card = h.element("interaction-list"), submit = card.querySelector<HTMLButtonElement>(".runner-question-help + button")!;
  expect(card.textContent?.match(/4177 批准状态/g)).toHaveLength(1);
  expect(card.querySelector("h4")?.textContent).toBe("Codex 提问 · 接口及存储设计");
  expect(card.querySelector(".runner-question-context")?.textContent).toContain(background);
  expect(card.textContent).not.toContain("TOKEN_COUPON_NEEDS_INPUT");
  expect(h.element("pending-approval-summary").textContent).toContain("不代表批准计划或工具操作");
  expect(submit.disabled).toBe(true);
  expect(card.querySelector("input:checked")).toBeNull();
  card.querySelector<HTMLInputElement>('[data-option-id="confirmed"]')!.click();
  expect(submit.disabled).toBe(false); submit.click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]!.body).toEqual({ kind: "question", answers: [{ questionId: "status", optionIds: ["confirmed"] }] });
  expect(h.posts[0]!.path).toBe("/api/v1/workspaces/project/interactions/biz01-options");
});

it("preserves multiple choices and a custom question answer when another request arrives", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const item = { requestId: "question-draft", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "question", summary: "选择测试范围", questions: [{ id: "scope", text: "选择测试范围", multiple: true, allowFreeText: true, options: [{ id: "normal", label: "正常请求" }, { id: "error", label: "错误请求" }] }] } };
  h.setInteractions([item]); h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelectorAll('[data-option-id]').length).toBe(2);
  for (const input of h.element("interaction-list").querySelectorAll<HTMLInputElement>('[data-option-id]')) input.click();
  h.setInteractions([item, { requestId: "another", owner: { runnerId: "claude-code", taskId: "verify" }, request: { kind: "approval", title: "测试命令", summary: "执行 node --test" } }]); h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelectorAll(".interaction-card").length).toBe(2);
  expect(h.element("interaction-list").querySelectorAll('[data-option-id]:checked')).toHaveLength(2);
  const custom = h.w.document.getElementById("interaction-custom:question-draft:scope") as HTMLInputElement; custom.click();
  const answer = h.w.document.getElementById("interaction-answer:question-draft:scope") as HTMLInputElement; answer.value = "仅使用本地固定测试，不联网"; answer.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  expect(h.element("interaction-list").querySelectorAll('[data-option-id]:checked')).toHaveLength(0);
  h.setInteractions([item]); h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelectorAll(".interaction-card").length).toBe(1);
  expect((h.w.document.getElementById(custom.id) as HTMLInputElement).checked).toBe(true);
  expect((h.w.document.getElementById(answer.id) as HTMLInputElement).value).toBe(answer.value);
  h.element("interaction-list").querySelector<HTMLButtonElement>(".runner-question-help + button")!.click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]!.body).toEqual({ kind: "question", answers: [{ questionId: "scope", text: answer.value }] });
});

it("does not show another Attempt's context and keeps answer-only questions separate from command approval", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  const attemptId = randomUUID();
  (h.plans[0] as any).session = { status: "running", tasks: [{ taskId: "spec", title: "设计", status: "running", activeAttemptId: attemptId, attempts: [], currentAttempt: { attemptId, lastReply: "不属于旧问题的新 Attempt 上下文" } }] };
  h.setInteractions([{ requestId: "old-question", owner: { runnerId: "codex", taskId: "spec", attemptId: randomUUID() }, request: { kind: "question", summary: "确认范围", questions: [{ id: "q", text: "确认范围", allowFreeText: false, options: [{ id: "a", label: "只写文档" }] }] } }]);
  h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelector(".runner-question")).not.toBeNull();
  expect(h.element("interaction-list").querySelector(".runner-question-context")).toBeNull();
  expect(h.element("interaction-list").querySelector('input[type="text"]')).toBeNull();
  expect(h.element("interaction-list").textContent).not.toContain("本次允许");
  expect(h.posts).toHaveLength(0);
});

it("renders Codex MCP elicitation as a typed form and a confirmed external URL action", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  h.setInteractions([{ requestId: "form-request", owner: { runnerId: "codex", taskId: "backend" }, request: {
    kind: "elicitation", title: "Codex MCP 表单", summary: "选择项目配置",
    elicitation: { mode: "form", serverName: "school-planner", requestedSchema: { type: "object", properties: {
      language: { type: "string", title: "语言", enum: ["java", "node"], enumNames: ["Java", "Node.js"] },
      workers: { type: "integer", title: "并发", minimum: 1, maximum: 4, default: 2 },
      enabled: { type: "boolean", title: "启用" },
      scopes: { type: "array", title: "权限", items: { enum: ["read", "write"] }, minItems: 1 },
    }, required: ["language", "workers", "enabled", "scopes"] } },
  } }]);
  h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelector(".elicitation-form")).not.toBeNull();
  const form = h.element("interaction-list").querySelector<HTMLFormElement>(".elicitation-form")!;
  const language = form.querySelector<HTMLSelectElement>('[data-elicitation-field="language"]')!; language.value = "node";
  const workers = form.querySelector<HTMLInputElement>('[data-elicitation-field="workers"]')!; workers.value = "3";
  const enabled = form.querySelector<HTMLInputElement>('[data-elicitation-field="enabled"]')!; enabled.checked = false;
  const scopes = form.querySelector<HTMLSelectElement>('[data-elicitation-field="scopes"]')!; scopes.options[0]!.selected = true;
  form.dispatchEvent(new h.w.Event("submit", { bubbles: true, cancelable: true }));
  await expect.poll(() => h.posts.some(post => post.path.endsWith("/form-request"))).toBe(true);
  expect(h.posts.at(-1)).toMatchObject({ path: "/api/v1/workspaces/project/interactions/form-request", body: {
    kind: "elicitation", action: "accept", content: { language: "node", workers: 3, enabled: false, scopes: ["read"] },
  } });

  h.setInteractions([{ requestId: "url-request", owner: { runnerId: "codex", taskId: "backend" }, request: {
    kind: "elicitation", title: "网页授权", summary: "在授权站点完成登录",
    elicitation: { mode: "url", serverName: "school-planner", elicitationId: "flow-1", url: "https://login.example.test/authorize?code=private" },
  } }]);
  h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelector('a[href^="https://login.example.test/"]')).not.toBeNull();
  const link = h.element("interaction-list").querySelector<HTMLAnchorElement>("a[href]")!;
  expect(link.target).toBe("_blank"); expect(link.rel).toContain("noopener");
  [...h.element("interaction-list").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "已完成，继续执行")!.click();
  await expect.poll(() => h.posts.some(post => post.path.endsWith("/url-request"))).toBe(true);
  expect(h.posts.at(-1)).toMatchObject({ path: "/api/v1/workspaces/project/interactions/url-request", body: { kind: "elicitation", action: "accept" } });
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

it("requires an updated backend before enabling launch model overrides", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true, legacyDaemon: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  const mode = h.element("run-agent-mode") as HTMLSelectElement;
  expect([...mode.options].filter(item => item.value !== "plan").every(item => item.disabled)).toBe(true);
  expect(h.element("run-agent-support-note").textContent).toContain("重启后台");
  // A stored preference from a newer daemon must not be silently ignored by an older one.
  h.w.eval('__testState.runConfiguration.agentMode="unified";renderRunConfiguration()');
  expect((h.element("run-button") as HTMLButtonElement).disabled).toBe(true); expect(h.element("run-configuration-error").textContent).toContain("不支持"); expect(h.posts).toHaveLength(0);
});

it("launches one unified model with a task-specific exception without modifying the approved draft", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true, reactRunAgentMode: true, reactAgentSelection: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  const original = JSON.stringify(h.plans[0]);
  h.w.eval('__testState.runners=[{id:"codex",available:true},{id:"claude-code",available:true},{id:"mock",available:true}]');
  const fetch = h.w.fetch, modelRequests: string[] = [];
  h.w.fetch = (async (raw: string, init?: any) => { if (raw.includes("/models?")) { modelRequests.push(raw); return Response.json({ models: raw.includes("/codex/") ? [{ id: "gpt-6-luna" }] : [{ id: "deepseek-flash" }], customAllowed: true }); } return fetch(raw, init); }) as any;
  const mode = h.element("run-agent-mode") as HTMLSelectElement; mode.value = "unified"; mode.dispatchEvent(new h.w.Event("change"));
  const defaults = h.element("run-agent-defaults"), runner = defaults.querySelector<HTMLSelectElement>('[data-field="runner"]')!;
  runner.value = "codex"; runner.dispatchEvent(new h.w.Event("change"));
  const model = defaults.querySelector<HTMLSelectElement>('[data-field="model-choice"]')!;
  await expect.poll(() => modelRequests).toContainEqual(expect.stringContaining("/codex/models?"));
  await expect.poll(() => [...model.options].map(item => item.value)).toContain("gpt-6-luna"); expect(modelRequests.some(raw => raw.includes("/codex/"))).toBe(true); model.value = "gpt-6-luna"; model.dispatchEvent(new h.w.Event("change"));
  const row = h.element("run-agent-task-list").querySelector<HTMLDetailsElement>('[data-task-id="verify"]')!; row.open = true; row.dispatchEvent(new h.w.Event("toggle"));
  const override = row.querySelector<HTMLInputElement>('[data-task-override]')!; override.checked = true; override.dispatchEvent(new h.w.Event("change"));
  const taskRunner = row.querySelector<HTMLSelectElement>('[data-field="runner"]')!; taskRunner.value = "claude-code"; taskRunner.dispatchEvent(new h.w.Event("change"));
  const taskModel = row.querySelector<HTMLSelectElement>('[data-field="model-choice"]')!;
  await expect.poll(() => [...taskModel.options].map(item => item.value)).toContain("deepseek-flash"); taskModel.value = "deepseek-flash"; taskModel.dispatchEvent(new h.w.Event("change"));
  h.element("refresh").click(); await expect.poll(() => h.element("run-configuration-summary").textContent).toContain("deepseek-flash");
  expect(JSON.stringify(h.plans[0])).toBe(original); expect(h.posts).toHaveLength(0);
  await expect.poll(() => (h.element("run-button") as HTMLButtonElement).disabled).toBe(false); h.element("run-button").click();
  await expect.poll(() => h.posts.some(item => item.path.endsWith("/run"))).toBe(true);
  expect(h.posts.find(item => item.path.endsWith("/run"))!.body).toMatchObject({ expectedPlanHash: "first", expectedDraftRevision: 1, executionSelection: { defaults: { runnerId: "codex", modelId: "gpt-6-luna" }, tasks: [{ taskId: "verify", runnerId: "claude-code", modelId: "deepseek-flash" }] } });
});

it("remembers per-task launch choices for their own plan and keeps other tasks on their original defaults", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  h.w.eval('__testState.runners=[{id:"codex",available:true},{id:"mock",available:true}]');
  const mode = h.element("run-agent-mode") as HTMLSelectElement; mode.value = "per-task"; mode.dispatchEvent(new h.w.Event("change"));
  const row = h.element("run-agent-task-list").querySelector<HTMLDetailsElement>('[data-task-id="spec"]')!; row.open = true; row.dispatchEvent(new h.w.Event("toggle"));
  const runner = row.querySelector<HTMLSelectElement>('[data-field="runner"]')!; runner.value = "codex"; runner.dispatchEvent(new h.w.Event("change"));
  const model = row.querySelector<HTMLInputElement>('[data-field="model"]')!; model.value = "my-fast-model"; model.dispatchEvent(new h.w.Event("input"));
  h.w.eval('void navigate("/workspaces/project/plans/second/execution")'); h.element("local-state-keep").click();
  await expect.poll(() => h.w.eval('__testState.planning?.planningId')).toBe("second"); expect((h.element("run-agent-mode") as HTMLSelectElement).value).toBe("plan");
  h.w.eval('void navigate("/workspaces/project/plans/first/execution")');
  await expect.poll(() => (h.element("run-agent-mode") as HTMLSelectElement).value).toBe("per-task");
  const selection = h.w.eval('runExecutionSelection(__testState.runConfiguration,__testState.planning.draft.plan)');
  expect(selection.tasks.find((item: any) => item.taskId === "spec")).toEqual({ taskId: "spec", runnerId: "codex", modelId: "my-fast-model" });
  expect(selection.tasks.filter((item: any) => item.taskId !== "spec").every((item: any) => item.runnerId === "mock" && !item.modelId)).toBe(true);
  expect(h.posts).toHaveLength(0);
});

it("selects only the graph-valid final verifier and requires an explicit run after approval", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true, reactRunAdvanced: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  const options = [...h.element("run-verification").querySelectorAll("option")].map(item => (item as HTMLOptionElement).value);
  expect(options).toEqual(["verify"]);
  expect((h.element("run-verification") as HTMLSelectElement).value).toBe("verify");
  expect(h.posts.some(item => item.path.endsWith("/run"))).toBe(false);
  expect(h.element("run-configuration-summary").textContent).toContain("Runner 默认模型");
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
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true, reactRunMode: true, reactRunAdvanced: true });
  await expect.poll(() => h.visible("run-configuration")).toBe(true);
  const custom = h.w.document.querySelector<HTMLInputElement>('input[name="run-mode-choice"][value="custom"]')!;
  custom.checked = true; custom.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  (h.element("run-isolation") as HTMLSelectElement).value = "shared"; h.element("run-isolation").dispatchEvent(new h.w.Event("change"));
  expect(h.w.eval('__testState.runConfiguration.mode')).toBe("custom");
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
  h.element("workspace-open-file").click(); h.element("file-browse-workspace").click(); await expect.poll(() => h.element("file-list").querySelectorAll("button").length).toBe(1);
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
  h.element("refresh").click(); await expect.poll(() => h.element("remote-approvals").querySelectorAll(".remote-approval-actions button").length).toBe(2);
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
  expect(h.element("quick-address-policy").textContent).toContain("业务后端重启");
  expect((h.element("remote-lifecycle") as HTMLDetailsElement).open).toBe(false);
  h.element("reuse-test").click(); await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toEqual({ path: "/api/v1/remote-connection/test", body: {} });
  await expect.poll(() => (h.element("reuse-test") as HTMLButtonElement).disabled).toBe(false);
  expect(h.element("reuse-mcp-address").textContent).toBe("https://existing.trycloudflare.com/mcp");
  expect(h.element("connection-client-count").textContent).toContain("1 个有效");
  expect(h.w.location.hash).toBe("#/connect");
});

it("explains a recovered persistent tunnel without implying an expired grant was restored", async () => {
  const h = await page({ ready: true });
  h.setRemote({ validGrants: 0, connectionProcess: { persistent: true, recovered: true } }); h.element("refresh").click();
  await expect.poll(() => h.element("connection-reuse-description").textContent).toContain("已恢复原常驻隧道");
  expect(h.element("connection-reuse-status").textContent).toContain("网页待授权");
  expect(h.element("connection-reuse-description").textContent).toContain("0 个有效网页授权");
  expect(h.element("quick-address-policy").textContent).toContain("业务后端重启保留地址");
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
  h.element("remote-refresh").click(); await expect.poll(() => h.element("remote-grants").textContent).toContain("ChatGPT");
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
  h.element("add-workspace-main").click(); await chooseNativeFolder(h);
  await expect.poll(() => (h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/新项目");
  expect(h.nativeCalls).toEqual([{ kind: "directory" }]); expect(h.posts).toHaveLength(0); expect((h.element("directory-dialog") as HTMLDialogElement).open).toBe(false);
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

it("opens existing workspaces directly without ineffective selection or authorization side effects", async () => {
  const h = await page({ hash: "#/workspaces", ready: true, multiple: true });
  await expect.poll(() => h.visible("workspaces-page")).toBe(true);
  await expect.poll(() => h.element("workspace-cards").querySelectorAll(".project-card").length).toBe(2);
  expect(h.element("workspace-cards").querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(h.w.document.getElementById("workspace-open-selected")).toBeNull();
  expect(h.w.document.getElementById("workspace-clear-selected")).toBeNull();
  const cards = h.element("workspace-cards").querySelectorAll<HTMLButtonElement>("button");
  expect([...cards].every(card => card.textContent?.includes("打开工作区"))).toBe(true);
  expect(h.visible("workspace-detail")).toBe(false); expect(h.posts).toHaveLength(0);
  cards[1]!.click(); await expect.poll(() => h.w.location.hash).toBe("#/workspaces/other");
  expect(h.visible("workspace-detail")).toBe(true); expect(h.element("workspace-detail-title").textContent).toContain("其他项目");
  expect(h.posts).toHaveLength(0);
});

it("cancels native folder selection without registration or a task failure banner", async () => {
  const h = await page({ hash: "#/workspaces", ready: true, empty: true }); h.setNativePicker("directory", { cancelled: true, paths: [] });
  h.element("workspace-browse").click(); await chooseNativeFolder(h);
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
  h.element("file-open-native").click();
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
  const h = await page({ hash: "#/workspaces/project/plans/first/execution", ready: true, approved: true, reactRuntimeModels: true });
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

it("infers the source while keeping workspace selection explicit and preserving manual overrides", async () => {
  const h = await page({ ready: true });
  const request = { requestId: "prefilled", clientId: "gpt-client", workspaceId: "project", clientName: "ChatGPT", redirectHost: "https://chatgpt.com", requestedScopes: ["planning:read"], createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  h.setApprovals([request]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelector(".remote-workspace-select")).not.toBeNull();
  const card = h.element("remote-approvals").querySelector("article")!;
  const workspace = card.querySelector<HTMLSelectElement>(".remote-workspace-select")!, source = card.querySelector<HTMLSelectElement>(".remote-source-select")!;
  expect(workspace.value).toBe(""); expect(source.value).toBe("chatgpt"); expect(workspace.options[0].textContent).toContain("请选择已有工作区");
  expect(card.querySelector(".authorization-new-workspace")?.textContent).toBe("新建工作区");
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
  h.element("add-workspace-main").click(); await chooseNativeFolder(h); await expect.poll(() => h.visible("workspace-form")).toBe(true);
  expect(h.visible("workspace-cards")).toBe(false); expect((h.element("choose-workspace-native") as HTMLButtonElement).disabled).toBe(true);
  expect(h.element("action-feedback-title").textContent).toContain("正在打开");
  h.element("workspace-form-back").click(); expect(h.visible("workspace-cards")).toBe(true); expect(h.visible("workspace-form")).toBe(false);
  finish(Response.json({ cancelled: false, paths: ["/late/result"] }));
  await expect.poll(() => (h.element("choose-workspace-native") as HTMLButtonElement).disabled).toBe(false);
  expect(h.visible("workspace-form")).toBe(false); expect((h.element("workspace-path") as HTMLInputElement).value).toBe("");
  expect(h.element("choose-workspace-native").textContent).toBe("在后台 Windows 打开选择窗口");
  h.element("workspace-cards").querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => h.w.location.hash).toBe("#/workspaces/project");
  expect(h.visible("workspace-detail")).toBe(true); expect(h.visible("workspace-selection")).toBe(false); expect(h.posts).toHaveLength(0);
});

it("opens the new workspace page after registering a chosen folder and lets the user return to the workspace list", async () => {
  const h = await page({ ready: true, hash: "#/workspaces" }); h.element("workspace-browse").click(); await chooseBackendFolder(h);
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
  h.element("workspace-browse").click(); await chooseNativeFolder(h);
  await expect.poll(() => h.element("workspace-path-error").textContent).toContain("没有 Windows 桌面");
  expect((h.element("workspace-manual-path") as HTMLDetailsElement).open).toBe(true); expect(h.visible("workspace-form-back")).toBe(true);
  expect((h.element("choose-workspace-native") as HTMLButtonElement).disabled).toBe(false); expect(h.posts).toHaveLength(0);
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
  const workspaceSelect = card.querySelector<HTMLSelectElement>(".remote-workspace-select")!; card.querySelector<HTMLButtonElement>(".authorization-new-workspace")!.click();
  await chooseBackendFolder(h);
  await expect.poll(() => (h.element("workspace-path") as HTMLInputElement).value).toBe("/projects/新项目");
  expect(h.w.location.hash).toBe("#/connect"); expect(h.visible("workspace-form")).toBe(true); expect(card.contains(h.element("workspace-form"))).toBe(true);
  expect(h.nativeCalls).toHaveLength(0); expect(h.visible("workspace-detail")).toBe(false);
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
  card.querySelector<HTMLSelectElement>(".remote-source-select")!.value = ""; card.dispatchEvent(new h.w.Event("change", { bubbles: true }));
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
  h.element("add-workspace-main").click(); await chooseNativeFolder(h); await expect.poll(() => h.element("action-feedback-title").textContent).toBe("已取消新建工作区");
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
  [...h.element("task-list").querySelectorAll<HTMLButtonElement>(".task-row button")].find(button => button.textContent === "查看回复与工具活动")!.click();
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
  card.querySelector<HTMLButtonElement>(".authorization-new-workspace")!.click();
  await expect.poll(() => h.visible("workspace-form")).toBe(true);
  expect(card.querySelector<HTMLButtonElement>(".remote-approval-actions .button-primary")!.disabled).toBe(true);
  expect(card.querySelector(".field-guidance")!.textContent).toContain("请先登记新工作区");
  card.querySelector<HTMLButtonElement>(".authorization-existing-workspace")!.click();
  expect(h.visible("workspace-form")).toBe(false);
  expect(card.querySelector<HTMLButtonElement>(".remote-approval-actions .button-primary")!.disabled).toBe(false);
  h.setNativePicker("directory", { cancelled: true, paths: [] }); card.querySelector<HTMLButtonElement>(".authorization-new-workspace")!.click(); await chooseNativeFolder(h);
  await expect.poll(() => h.element("action-feedback-title").textContent).toBe("已取消新建工作区");
  expect(h.visible("workspace-form")).toBe(false); expect(h.w.location.hash).toBe("#/connect");
  card = h.element("remote-approvals").querySelector<HTMLElement>("article")!;
  expect(card.querySelector<HTMLSelectElement>(".remote-workspace-select")!.value).toBe("project");
  expect(card.querySelector<HTMLSelectElement>(".remote-source-select")!.value).toBe("claude");
  expect(card.querySelector<HTMLInputElement>('.remote-projects input[value="other"]')!.checked).toBe(true);
  [...card.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "授权所选权限")!.click();
  await expect.poll(() => h.posts.length).toBe(1); expect(h.posts[0]!.body.workspaceIds).toEqual(["project", "other"]);
});

it("keeps the workspace checkbox, name and path in one clickable cell", async () => {
  const h = await page({ ready: true, pendingAuth: true, multiple: true });
  await expect.poll(() => h.element("remote-approvals").querySelectorAll(".workspace-check-cell").length).toBe(2);
  const cell = h.element("remote-approvals").querySelector<HTMLLabelElement>(".workspace-check-cell")!;
  expect(cell.querySelector("strong")!.textContent).toBe("排课后端");
  expect(cell.querySelector("small")!.textContent).toBe("/projects/排课后端");
  const checkbox = cell.querySelector<HTMLInputElement>("input")!;
  cell.querySelector<HTMLElement>("strong")!.click(); expect(checkbox.checked).toBe(true);
  expect(h.posts).toHaveLength(0);
});

it("separates status, operations, approvals, task board and returns, with optional notifications folded", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 first");
  expect(h.element("session-progress").closest("#execution-overview")).not.toBeNull();
  expect(h.element("session-continue").closest("#execution-overview")).not.toBeNull();
  expect(h.element("session-check").closest("#execution-operations")).not.toBeNull();
  expect(h.element("task-list").closest("#execution-task-panel")).not.toBeNull();
  expect(h.element("live-task-replies").closest("#execution-response-panel")).not.toBeNull();
  expect(h.element("enable-notifications").closest("details")!.open).toBe(false);
  expect(h.element("pending-approval-box").contains(h.element("enable-notifications"))).toBe(false);
});

it("opens the newest retry instead of the first completed task and labels explicitly selected history", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  const baseline = randomUUID(), failed = randomUUID(), newer = randomUUID();
  const plan: any = h.plans[0], original = h.w.fetch;
  const attempt = (id: string, at: string, status: string, lastReply: string) => ({ attemptId: id, runnerId: "codex", status, startedAt: at, lastReply, ...(status === "failed" ? { reason: "不支持的 Codex app-server 请求：mcpServer/elicitation/request", exitCode: 0 } : {}) });
  plan.session = { sessionId: "retry-session", status: "failed", health: { state: "idle", checkedAt: new Date().toISOString() }, tasks: [
    { taskId: "spec", title: "资产审查", status: "succeeded", attempts: [{ attemptId: baseline }], currentAttempt: attempt(baseline, "2026-10-17T04:54:00Z", "succeeded", "历史资产审查结论") },
    { taskId: "backend", title: "技术门禁", status: "failed", dependsOn: ["spec"], attempts: [{ attemptId: failed }], currentAttempt: attempt(failed, "2026-10-17T08:04:00Z", "failed", "缺少权威选型，需要澄清") },
  ] };
  h.w.fetch = (async (raw: string, init?: any) => raw.includes("/attempts/") ? Response.json({ attempt: { attemptId: raw.includes(baseline) ? baseline : failed, status: raw.includes(baseline) ? "succeeded" : "failed" }, fileId: raw.includes(baseline) ? "old-log" : "new-log", cursor: 1, hasMore: false, events: [{ sequence: 1, type: "runner.output", payload: { finalText: raw.includes(baseline) ? "历史资产审查结论" : "本次技术门禁返回" } }] }) : original(raw, init)) as any;
  h.element("refresh").click();
  await expect.poll(() => (h.element("attempt-select") as HTMLSelectElement).value).toBe(failed);
  await expect.poll(() => h.element("attempt-messages").textContent).toContain("本次技术门禁返回");
  expect(h.element("attempt-messages").textContent).not.toContain("历史资产审查结论");
  const primary = h.element("live-task-replies").querySelector(":scope > .live-task-reply")!;
  expect(primary.textContent).toContain("mcpServer/elicitation/request"); expect(primary.textContent).not.toContain("历史资产审查结论");
  expect(h.element("live-task-replies").querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
  const select = h.element("attempt-select") as HTMLSelectElement;
  select.value = baseline; select.dispatchEvent(new h.w.Event("change"));
  await expect.poll(() => h.element("attempt-messages").textContent).toContain("历史资产审查结论");
  expect(h.element("attempt-selection-context").textContent).toContain("不是本次重试返回");
  plan.session.tasks[1].attempts.push({ attemptId: newer });
  plan.session.tasks[1].currentAttempt = attempt(newer, "2026-10-17T09:04:00Z", "failed", "再次失败");
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(select.value).toBe(baseline);
  h.element("attempt-show-latest").click(); await expect.poll(() => select.value).toBe(newer);
  expect(h.element("attempt-selection-context").textContent).not.toContain("不是本次重试返回");
  h.element("copy-execution-clarification").click();
  expect((h.element("revision-planning-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.copied).toHaveLength(0);
  expect(h.posts).toHaveLength(0);
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

it("places decisions before tasks and execution returns after tasks, with sidebar notifications and metric cards", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { status: "running", maxParallel: 2, tasks: [{ taskId: "spec", title: "接口文档", status: "running", attempts: [] }] }; h.element("refresh").click();
  await expect.poll(() => h.element("task-list").querySelectorAll(".task-row").length).toBeGreaterThan(0);
  const precedes = (a: string, b: string) => !!(h.element(a).compareDocumentPosition(h.element(b)) & h.w.Node.DOCUMENT_POSITION_FOLLOWING);
  expect(precedes("execution-operations", "execution-task-panel")).toBe(true);
  expect(precedes("pending-approval-box", "execution-task-panel")).toBe(true);
  expect(precedes("execution-task-panel", "execution-response-panel")).toBe(true);
  expect(h.element("sidebar").contains(h.element("enable-notifications"))).toBe(true);
  expect(h.element("session-progress").querySelectorAll(".execution-metric")).toHaveLength(5);
  expect(h.element("session-progress").querySelector("progress")!.max).toBeGreaterThan(0);
});

it("sends the current DAG preview and full-view action to the React bridge", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { status: "running", tasks: [{ taskId: "spec", title: "接口设计", status: "succeeded", dependsOn: [] }, { taskId: "backend", title: "后端实现", status: "running", dependsOn: ["spec"] }] };
  let received: any;
  h.w.tokenCouponTaskDependencyPreview = { render(model: any) { if (model) received = model; } } as any;
  h.element("refresh").click();
  await expect.poll(() => received).toBeTruthy();
  expect(received).toMatchObject({ taskCount: 2, focusLabel: "后端实现", shown: 2 });
  expect(received.svg.querySelectorAll(".dag-node")).toHaveLength(2);
  received.onOpen();
  expect((h.element("dag-dialog") as HTMLDialogElement).open).toBe(true);
});

it("sends current task cards to the React board bridge while retaining existing task actions", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { status: "failed", health: { state: "exited", checkedAt: new Date().toISOString() }, tasks: [{ taskId: "spec", title: "接口文档", status: "failed", dependsOn: [], attempts: [{ attemptId: "attempt-1" }], currentAttempt: { attemptId: "attempt-1", runnerId: "codex", reportedModel: "gpt-6.1-sol", reason: "退出码 1", activity: "构建失败" } }] };
  let received: any;
  h.w.tokenCouponTaskBoard = { render(model: any) { received = model; } } as any;
  h.element("refresh").click();
  await expect.poll(() => received).toBeTruthy();
  const failed = received.groups.find((group: any) => group.id === "errors").tasks[0];
  expect(failed).toMatchObject({ taskId: "spec", title: "接口文档", statusLabel: "失败", outcome: "错误结论：任务失败" });
  expect(failed.runnerModel).toContain("codex / gpt-6.1-sol");
  expect(failed.actions.map((action: any) => action.label)).toEqual(["查看明细", "查看回复与工具活动", "重试 spec"]);
  failed.actions[0].onClick();
  expect((h.element("dag-task-dialog") as HTMLDialogElement).open).toBe(true);
});

it("sends Session pause and cancel controls through the React bridge", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { status: "running", health: { state: "active", checkedAt: new Date().toISOString() }, tasks: [{ taskId: "backend", status: "running", attempts: [] }] };
  let received: any;
  h.w.tokenCouponSessionControls = { render(model: any) { received = model; } } as any;
  h.element("refresh").click();
  await expect.poll(() => received?.buttons?.length).toBe(2);
  expect(received.buttons.map((button: any) => button.label)).toEqual(["暂停会话", "取消会话"]);
  expect(received.buttons.every((button: any) => !button.disabled)).toBe(true);
});

it("sends the current resume decision to React and keeps the existing confirmation dialog", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { sessionId: "paused-session", status: "paused", health: { state: "exited", checkedAt: new Date().toISOString() }, tasks: [{ taskId: "spec", title: "接口文档", status: "planned", attempts: [] }] };
  let received: any;
  h.w.tokenCouponSessionContinue = { render(model: any) { received = model; } } as any;
  h.element("refresh").click();
  await expect.poll(() => received).toBeTruthy();
  expect(received).toMatchObject({ label: "从断点继续执行", disabled: false, message: "继续调度剩余任务，保留全部已完成任务。" });
  received.onContinue();
  expect((h.element("session-continue-dialog") as HTMLDialogElement).open).toBe(true);
  expect((h.element("session-continue-target") as HTMLSelectElement).value).toBe("__resume__");
});

it("publishes pending approval counts and guidance to the React overview bridge", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  h.setInteractions([
    { requestId: "question", owner: { runnerId: "codex", taskId: "spec" }, request: { kind: "question", title: "需要确认", questions: [{ id: "scope", text: "是否包含冲突检测？" }] } },
    { requestId: "approval", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "运行测试", operation: { command: "npm test" }, cwd: "/workspace" } },
  ]);
  let received: any;
  h.w.tokenCouponPendingApprovalOverview = { render(model: any) { received = model; } } as any;
  h.element("refresh").click();
  await expect.poll(() => received?.count).toBe(2);
  expect(received.summary).toContain("1 项任务提问、1 项工具审批");
  expect(h.element("pending-approval-box").classList.contains("has-pending")).toBe(true);
});

it("sends approval reasons and commands to the React text bridge and releases roots before rerender", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  const rendered: any[] = [];
  let unmounts = 0;
  h.w.tokenCouponPendingApprovalText = {
    render(mount: HTMLElement, model: any) { rendered.push(model); mount.textContent = model.text; },
    unmountWithin() { unmounts++; },
  } as any;
  h.setInteractions([{ requestId: "approval-text", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "运行测试", summary: "请核对该测试命令是否符合当前环境。", operation: { command: "npm test -- --runInBand" }, cwd: "/workspace" } }]);
  h.element("refresh").click();
  await expect.poll(() => rendered.length).toBe(2);
  expect(rendered.map(item => item.title)).toEqual(["审批说明", "待审批命令"]);
  expect(rendered[1]).toMatchObject({ className: "approval-command", code: true, text: "npm test -- --runInBand" });

  h.setInteractions([{ requestId: "approval-text-next", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "运行构建", operation: { command: "npm run build" } } }]);
  h.element("refresh").click();
  await expect.poll(() => unmounts).toBe(1);
  await expect.poll(() => rendered.length).toBe(3);
});

it("routes React approval decisions through the existing interaction API", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  const original = h.w.fetch;
  let requests: any[] = [{ requestId: "react-approval", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "运行测试", operation: { command: "npm test" } } }];
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.includes("/interactions/")) {
      if (init?.method === "POST") { h.posts.push({ path: raw, body: JSON.parse(init.body) }); return Response.json({ ok: true }); }
      return Response.json(requests);
    }
    return original(raw, init);
  }) as any;
  let decision: any;
  let unmounts = 0;
  h.w.tokenCouponPendingApprovalDecision = {
    render(mount: HTMLElement, model: any) { decision = model; mount.textContent = "React actions"; },
    unmountWithin() { unmounts++; },
  } as any;
  h.element("refresh").click();
  await expect.poll(() => decision).toBeTruthy();
  decision.onAllow();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/workspaces/project/interactions/react-approval", body: { kind: "approval", decision: "allow-once" } });

  requests = [{ requestId: "react-approval-next", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "approval", title: "运行构建", operation: { command: "npm run build" } } }];
  h.element("refresh").click();
  await expect.poll(() => unmounts).toBe(1);
});

it("routes Runner question answers from React through the existing interaction API", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  let unmounts = 0;
  h.w.tokenCouponPendingRunnerQuestions = {
    render(mount: HTMLElement, model: any) { received = model; mount.textContent = "React question form"; },
    unmountWithin() { unmounts++; },
  } as any;
  h.setInteractions([{ requestId: "react-question", owner: { runnerId: "codex", taskId: "design" }, request: { kind: "question", questions: [{ id: "approval", text: "4177 是否已批准？", required: true, allowFreeText: true, options: [{ id: "yes", label: "已批准" }] }] } }]);
  h.element("refresh").click();
  await expect.poll(() => received).toBeTruthy();
  expect(received).toMatchObject({ requestId: "react-question", questions: [{ id: "approval", text: "4177 是否已批准？" }] });
  received.onSubmit([{ questionId: "approval", text: "已批准，恢复连接后继续" }]);
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/workspaces/project/interactions/react-question", body: { kind: "question", answers: [{ questionId: "approval", text: "已批准，恢复连接后继续" }] } });
  h.setInteractions([]);
  h.element("refresh").click();
  await expect.poll(() => unmounts).toBe(1);
});

it.each([
  ["approval", { kind: "approval", decision: "deny", guidance: "重新检查命令参数" }],
  ["elicitation", { kind: "elicitation", action: "decline", guidance: "不要提交外部表单" }],
  ["question", { kind: "question", answers: [], guidance: "先读取已有设计文件" }],
] as const)("maps React guidance for %s to the existing reply protocol", async (kind, expectedReply) => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  let unmounts = 0;
  h.w.tokenCouponPendingInteractionGuidance = {
    render(mount: HTMLElement, model: any) { received = model; mount.textContent = "React guidance"; },
    unmountWithin() { unmounts++; },
  } as any;
  h.setInteractions([{ requestId: `guidance-${kind}`, owner: { runnerId: "codex", taskId: "backend" }, request: { kind, title: "需要调整", ...(kind === "question" ? { questions: [] } : {}) } }]);
  h.element("refresh").click();
  await expect.poll(() => received?.kind).toBe(kind);
  const guidance = kind === "approval" ? "重新检查命令参数" : kind === "elicitation" ? "不要提交外部表单" : "先读取已有设计文件";
  received.onSubmit(guidance);
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: `/api/v1/workspaces/project/interactions/guidance-${kind}`, body: expectedReply });
  h.setInteractions([]);
  h.element("refresh").click();
  await expect.poll(() => unmounts).toBe(1);
});

it("routes React elicitation forms and URL confirmation through the existing interaction API", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  let unmounts = 0;
  h.w.tokenCouponPendingElicitation = {
    render(mount: HTMLElement, model: any) { received = model; mount.textContent = `React ${model.mode}`; },
    unmountWithin() { unmounts++; },
  } as any;
  h.setInteractions([{ requestId: "react-form", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "elicitation", elicitation: { mode: "form", requestedSchema: { type: "object", properties: { token: { type: "string" } } } } } }]);
  h.element("refresh").click();
  await expect.poll(() => received?.mode).toBe("form");
  received.onSubmit({ token: "local-only" });
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/workspaces/project/interactions/react-form", body: { kind: "elicitation", action: "accept", content: { token: "local-only" } } });

  h.setInteractions([{ requestId: "react-url", owner: { runnerId: "codex", taskId: "backend" }, request: { kind: "elicitation", elicitation: { mode: "url", url: "https://login.example.test/" } } }]);
  h.element("refresh").click();
  await expect.poll(() => received?.mode).toBe("url");
  received.onAcceptUrl();
  await expect.poll(() => h.posts.length).toBe(2);
  expect(h.posts[1]).toMatchObject({ path: "/api/v1/workspaces/project/interactions/react-url", body: { kind: "elicitation", action: "accept" } });
  expect(unmounts).toBeGreaterThan(0);
});

it("publishes the current Attempt status and diagnosis callback to the React overview", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  let onDiagnose: (() => void) | undefined;
  h.w.tokenCouponAttemptOverview = { render(model: any, diagnose: () => void) { received = model; onDiagnose = diagnose; } } as any;
  h.w.eval(`
    __testState.attemptView = {
      workspaceId: "project", planningId: "first", attemptId: "attempt-overview",
      attempt: { runnerId: "codex", status: "failed", reason: "缺少完成标记", exitCode: 0, reportedModel: "gpt-6.1-sol", reportedModelSource: "codex" },
      messages: new Map(), textStream: "", finalText: "", semanticMessages: false,
      tools: [], raw: [], toolsPage: 0, rawPage: 0, notice: "历史日志尚未加载完成。", hasMore: true,
    };
    renderAttemptContent();
  `);
  expect(received).toMatchObject({
    state: expect.stringContaining("gpt-6.1-sol"),
    notice: expect.stringContaining("历史日志尚未加载完成"),
    outcome: expect.stringContaining("缺少完成标记"),
    outcomeVisible: true,
    replyHeading: "模型回复",
    diagnoseVisible: true,
  });
  onDiagnose?.();
  await expect.poll(() => h.visible("diagnosis-choice-dialog")).toBe(true);
});

it("publishes deduplicated final replies to the React Attempt message list in newest-first order", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  h.w.tokenCouponAttemptMessages = { render(model: any) { received = model; } } as any;
  h.w.eval(`
    __testState.attemptView = {
      workspaceId: "project", planningId: "first", attemptId: "attempt-messages",
      attempt: { runnerId: "codex", status: "succeeded" },
      messages: new Map([
        ["older", { text: "先完成接口设计", completed: true }],
        ["latest", { text: "完成结论：全部测试通过", completed: true }],
      ]),
      finalText: "完成结论：全部测试通过", textStream: "", semanticMessages: true,
      tools: [], raw: [], toolsPage: 0, rawPage: 0, notice: "", hasMore: false,
    };
    renderAttemptContent();
  `);
  expect(received.messages.map((message: any) => message.messageId)).toEqual(["latest", "older"]);
  expect(received.messages[0]).toMatchObject({ title: "2. 最新回复 · 最终结论", text: "完成结论：全部测试通过" });
});

it("publishes the current tool page and open foldout state to the React Attempt activity list", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  h.w.tokenCouponAttemptTools = { render(model: any) { received = model; } } as any;
  h.element("attempt-tools").innerHTML = '<details data-event-key="16" open></details>';
  h.w.eval(`
    __testState.attemptView = {
      workspaceId: "project", planningId: "first", attemptId: "attempt-tools",
      attempt: { runnerId: "codex", status: "succeeded" },
      messages: new Map(), finalText: "", textStream: "", semanticMessages: false,
      tools: Array.from({ length: 16 }, (_, index) => ({ sequence: index + 1, type: index === 15 ? "command.completed" : "tool.completed", text: "command-" + (index + 1), output: index === 15 ? "2 tests passed" : undefined, exitCode: index === 15 ? 1 : 0, timestamp: "2026-10-20T03:00:00.000Z" })),
      raw: [], toolsPage: 1, rawPage: 0, notice: "", hasMore: false,
    };
    renderAttemptContent();
  `);
  expect(received.tools).toHaveLength(1);
  expect(received.tools[0]).toMatchObject({ eventKey: "16", summary: expect.stringContaining("command-16"), text: "command-16\n2 tests passed", isError: true });
  expect(received.openEventKeys).toEqual(["16"]);
  expect(h.element("attempt-tools-page").textContent).toContain("第 2 / 2 页");
});

it("publishes the filtered raw-event page to the React Attempt raw event view", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any, actions: any;
  h.w.tokenCouponAttemptRawEvents = { render(_mount: HTMLElement, model: any, callbacks: any) { received = model; actions = callbacks; } } as any;
  h.element("attempt-raw").scrollTop = 37;
  h.w.eval(`
    __testState.attemptView = {
      identity: "project:first:attempt-raw", workspaceId: "project", planningId: "first", attemptId: "attempt-raw",
      attempt: { runnerId: "codex", status: "succeeded" },
      messages: new Map(), finalText: "", textStream: "", semanticMessages: false,
      tools: [], raw: Array.from({ length: 16 }, (_, index) => ({ sequence: index + 1, type: index === 15 ? "runner.output" : "tool.completed", payload: index === 15 ? { stream: "stderr", text: "diagnostic" } : { summary: "event-" + (index + 1) } })),
      toolsPage: 0, rawPage: 1, notice: "", hasMore: false,
    };
    renderAttemptContent();
  `);
  expect(received.events).toHaveLength(16);
  expect(received.events[15]).toEqual({ line: '{"sequence":16,"type":"runner.output","payload":{"stream":"stderr","text":"diagnostic"}}', type: "runner.output", stream: "stderr" });
  expect(received.initialPage).toBe(1);
  expect(received.identity).toBe("project:first:attempt-raw:0");
  expect(h.element("attempt-raw").scrollTop).toBe(37);

  actions.onFilter("stderr");
  actions.onPageChange(0);
  expect(h.w.eval("__testState.attemptView.rawFilter")).toBe("stderr");
  expect(h.w.eval("__testState.attemptView.rawPage")).toBe(0);
});

it("publishes selected diagnosis history, pending submission, and status to the React conversation view", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  let mount: HTMLElement | undefined;
  h.w.tokenCouponAttemptDiagnosisHistory = { render(element: HTMLElement, model: any) { mount = element; received = model; }, unmountWithin() {} } as any;
  h.w.eval(`
    ensureAttemptDiagnosticUI();
    const context = {
      identity: "project:first:attempt-diagnosis", workspaceId: "project", planningId: "first", attemptId: "attempt-diagnosis",
      runnerId: "claude-code", selectedId: "diagnostic-1", running: true,
      pendingSubmission: { body: { message: "再解释一下恢复条件" } },
      data: { diagnostics: [{ diagnosticId: "diagnostic-1", status: "failed", runnerId: "claude-code", error: "provider unavailable", messages: [
        { role: "user", content: "为什么失败？" },
        { role: "assistant", runnerId: "codex", modelId: "gpt-6.1-sol", content: "完成结论：需要补充一次验证" },
      ] }] },
    };
    __testState.attemptDiagnosticContext = context;
    renderAttemptDiagnosticHistory(context);
  `);
  expect(mount?.id).toBe("attempt-diagnosis-history");
  expect(received.messages).toEqual([
    { messageId: "diagnostic-1:0", role: "user", heading: "你", content: "为什么失败？" },
    { messageId: "diagnostic-1:1", role: "assistant", heading: "Codex · gpt-6.1-sol", content: "完成结论：需要补充一次验证" },
  ]);
  expect(received).toMatchObject({ pendingMessage: "再解释一下恢复条件", errorMessage: "分析未完成：provider unavailable", running: true, showEmptyMessage: false });
  expect(h.element("attempt-diagnosis-history-select").value).toBe("diagnostic-1");
});

it("binds the React diagnosis composer to the saved draft and existing form submit flow", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  let changed: ((value: string) => void) | undefined;
  let submit: (() => void) | undefined;
  let mount: HTMLElement | undefined;
  h.w.tokenCouponAttemptDiagnosisComposer = { render(element: HTMLElement, model: any, onChange: (value: string) => void, onSubmit: () => void) { mount = element; received = model; changed = onChange; submit = onSubmit; }, setValue() {}, unmountWithin() {} } as any;
  h.w.eval(`
    ensureAttemptDiagnosticUI();
    const context = { identity: "project:first:composer", workspaceId: "project", planningId: "first", attemptId: "attempt-composer", unsentText: "恢复后保留的草稿", data: { diagnostics: [] } };
    __testState.attemptDiagnosticContext = context;
    renderAttemptDiagnosticHistory(context);
  `);
  expect(mount?.id).toBe("attempt-diagnosis-composer-root");
  expect(received).toMatchObject({ initialValue: "恢复后保留的草稿", placeholder: "输入问题、补充事实，或讨论处理方案…" });
  changed?.("追加的诊断事实");
  expect(h.w.eval("__testState.attemptDiagnosticContext.unsentText")).toBe("追加的诊断事实");
  expect(submit).toBeTypeOf("function");
});

it("publishes diagnosis history and model choices from the current diagnostic context to React", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let historyModel: any;
  let historyChange: ((id: string) => void) | undefined;
  let controlsModel: any;
  let controlsCallbacks: any;
  h.w.tokenCouponAttemptDiagnosisControls = {
    renderHistory(_mount: HTMLElement, diagnostics: any, selectedId: string, disabled: boolean, onChange: (id: string) => void) { historyModel = { diagnostics, selectedId, disabled }; historyChange = onChange; },
    renderModels(_mount: HTMLElement, model: any, callbacks: any) { controlsModel = model; controlsCallbacks = callbacks; },
    unmountWithin() {},
  } as any;
  h.w.eval(`
    ensureAttemptDiagnosticUI();
    const context = {
      identity: "project:first:controls", workspaceId: "project", planningId: "first", attemptId: "attempt-controls",
      runnerId: "codex", selectedId: "diagnostic-2", running: false, pendingSubmission: null,
      diagnosisRunnerId: "claude-code", diagnosisModelId: "deepseek-flash", diagnosisModels: [{ id: "deepseek-flash", label: "DeepSeek Flash" }],
      data: { diagnostics: [
        { diagnosticId: "diagnostic-1", status: "completed", runnerId: "codex", messages: [] },
        { diagnosticId: "diagnostic-2", status: "failed", runnerId: "claude-code", messages: [] },
      ] },
    };
    __testState.attemptDiagnosticContext = context;
    renderAttemptDiagnosticHistory(context);
  `);
  expect(historyModel).toMatchObject({ selectedId: "diagnostic-2", disabled: false });
  expect(historyModel.diagnostics.map((item: any) => item.label)).toEqual(["诊断 1 · 分析完成", "诊断 2 · 分析失败"]);
  expect(controlsModel).toMatchObject({ runnerId: "claude-code", modelId: "deepseek-flash", selectedDiagnosticId: "diagnostic-2", disabled: false });
  expect(controlsModel.models).toEqual([{ id: "deepseek-flash", label: "DeepSeek Flash" }]);
  historyChange?.("diagnostic-1");
  expect(h.w.eval("__testState.attemptDiagnosticContext.selectedId")).toBe("diagnostic-1");
  controlsCallbacks.onCustomModelChange("custom-model");
  expect(h.w.eval("__testState.attemptDiagnosticContext.diagnosisCustomModelId")).toBe("custom-model");
  controlsCallbacks.onModelChange("__custom__");
  expect(h.w.eval("__testState.attemptDiagnosticContext.diagnosisModelId")).toBe("__custom__");
});

it("publishes evidence export progress and saved path to the React diagnosis export dialog", async () => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  let received: any;
  const renderModels: any[] = [];
  h.w.tokenCouponAttemptDiagnosisExport = { render(_mount: HTMLElement, model: any) { received = model; renderModels.push(model); }, unmountWithin() {} } as any;
  const original = h.w.fetch;
  h.w.fetch = (async (url: string, init?: any) => url.endsWith("/diagnostics/export") ? Response.json({ absolutePath: "/workspace/.scratch/diagnosis.md", prompt: "读取并分析证据" }) : original(url, init)) as any;
  h.w.eval(`
    ensureAttemptDiagnosticUI();
    __testState.attemptDiagnosticContext = { identity: "project:first:export", workspaceId: "project", planningId: "first", attemptId: "attempt-export" };
    void exportAttemptDiagnosis(__testState.attemptDiagnosticContext);
  `);
  await expect.poll(() => renderModels.some(model => model.status.includes("正在把诊断证据保存"))).toBe(true);
  await expect.poll(() => received?.path).toBe("/workspace/.scratch/diagnosis.md");
  await expect.poll(() => received?.copyLabel).toContain("已复制");
  expect(received.copyDisabled).toBe(false);
  expect(h.copied).toContain("读取并分析证据");
});

it.each(["approval", "question", "elicitation"])("sends explicit NO guidance for %s without accepting the pending request", async kind => {
  const h = await page({ ready: true, approved: true, hash: "#/workspaces/project/plans/first/execution" });
  const request = { kind, title: "确认实现", ...(kind === "question" ? { questions: [{ id: "q", text: "请选择", allowFreeText: false, options: [{ id: "a", label: "A" }] }] } : kind === "elicitation" ? { elicitation: { mode: "form", requestedSchema: { type: "object", properties: { token: { type: "string", minLength: 1 } }, required: ["token"] } } } : {}) };
  h.setInteractions([{ requestId: "ask-no", owner: { runnerId: "codex", taskId: "backend" }, request }]); h.element("refresh").click();
  await expect.poll(() => h.element("interaction-list").querySelector(".interaction-no")).not.toBeNull();
  h.element("interaction-list").querySelector<HTMLButtonElement>(".interaction-no")!.click();
  expect(h.posts).toHaveLength(0);
  const editor = h.element("interaction-list").querySelector<HTMLElement>(".guidance-editor")!;
  const submit = editor.querySelector<HTMLButtonElement>("button")!;
  submit.click(); expect(h.posts).toHaveLength(0);
  editor.querySelector("textarea")!.value = "不要联网，使用已有的本地资料继续"; submit.click();
  await expect.poll(() => h.posts.length).toBe(1);
  expect(h.posts[0]!.body).toEqual({ kind, guidance: "不要联网，使用已有的本地资料继续", ...(kind === "approval" ? { decision: "deny" } : kind === "question" ? { answers: [] } : { action: "decline" }) });
});

it("focuses a long DAG on running work, folds remote nodes, opens task details, and confines zoom to its viewport", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" });
  const tasks = Array.from({ length: 40 }, (_, i) => ({ taskId: `task-${i}`, title: `任务 ${i}`, status: i < 20 ? "succeeded" : i === 20 ? "running" : "blocked", dependsOn: i ? [`task-${i - 1}`] : [], attempts: [] }));
  (h.plans[0] as any).session = { status: "running", maxParallel: 2, tasks, health: { state: "active" } };
  h.element("refresh").click();
  await expect.poll(() => h.element("task-dependencies").textContent).toContain("40 个任务");
  h.element("task-dependencies").querySelector<HTMLButtonElement>("button")!.click();
  const viewport = h.element("dag-viewport");
  expect(viewport.querySelector("svg")!.dataset.focusId).toBe("task-20");
  expect(viewport.querySelectorAll(".dag-node")).toHaveLength(5);
  expect(h.element("dag-scope").textContent).toContain("显示 5/40");
  const incoming = viewport.querySelector<SVGElement>('[data-relation="incoming"]')!, outgoing = viewport.querySelector<SVGElement>('[data-relation="outgoing"]')!;
  expect(viewport.querySelectorAll(".dag-edge-label")).toHaveLength(0);
  expect(h.element("dag-dialog").querySelector(".dag-legend")!.textContent).not.toMatch(/入边|出边/);
  expect(incoming.getAttribute("stroke")).not.toBe(outgoing.getAttribute("stroke"));
  expect(viewport.querySelector('[data-task-id="task-20"]')!.textContent).toContain("◉ 运行中");
  const outsideStyle = h.element("execution-task-panel").getAttribute("style"), rootStyle = h.w.document.documentElement.getAttribute("style");
  const width = Number(viewport.querySelector("svg")!.getAttribute("width"));
  const zoom = new h.w.WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }); viewport.dispatchEvent(zoom);
  expect(zoom.defaultPrevented).toBe(true); expect(Number(viewport.querySelector("svg")!.getAttribute("width"))).toBeGreaterThan(width);
  expect(h.element("execution-task-panel").getAttribute("style")).toBe(outsideStyle); expect(h.w.document.documentElement.getAttribute("style")).toBe(rootStyle);
  const detail = viewport.querySelector<SVGElement>('[data-dag-detail="task-20"]')!; detail.dispatchEvent(new h.w.MouseEvent("click", { bubbles: true }));
  expect((h.element("dag-task-dialog") as HTMLDialogElement).open).toBe(true); expect(h.element("dag-task-title").textContent).toBe("任务 20"); expect(h.element("dag-task-content").textContent).toContain("任务 19");
  h.element("dag-task-close").click(); h.element("dag-expand").click(); expect(viewport.querySelectorAll(".dag-node")).toHaveLength(7);
  h.element("dag-collapse").click(); expect(viewport.querySelectorAll(".dag-node")).toHaveLength(5);
  const focus = h.element("dag-focus") as HTMLSelectElement; focus.value = "task-35"; focus.dispatchEvent(new h.w.Event("change"));
  expect(viewport.querySelector("svg")!.dataset.focusId).toBe("task-35");
  viewport.scrollLeft = 27; viewport.scrollTop = 19; h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 40));
  expect(viewport.scrollLeft).toBe(27); expect(viewport.scrollTop).toBe(19);
  expect(viewport.querySelector("svg")!.dataset.focusId).toBe("task-35");
  h.element("dag-current").click(); expect(viewport.querySelector("svg")!.dataset.focusId).toBe("task-20");
  h.element("dag-close").click();
  // Broad dependency fans stay bounded as well; choosing another focus reaches hidden branches.
  tasks.slice(21).forEach(task => { task.dependsOn = ["task-20"]; }); h.element("refresh").click();
  await expect.poll(() => h.element("task-dependencies").querySelectorAll(".dag-node").length).toBe(21);
  h.element("task-dependencies").querySelector<HTMLButtonElement>("button")!.click();
  expect(viewport.querySelectorAll(".dag-node")).toHaveLength(21); expect((h.element("dag-expand") as HTMLButtonElement).disabled).toBe(true);
  expect(h.posts).toHaveLength(0);
});

it("offers two diagnosis routes, uses a chat composer with model controls, and copies only the exported prompt", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first" });
  await expect.poll(() => h.element("planning-title").textContent).toContain("计划 first");
  const originalFetch = h.w.fetch, diagnosticPosts: any[] = []; let records: any[] = [], exportCalls = 0, finishDiagnosis = false;
  const exported = { absolutePath: "/projects/排课后端/.token-coupon/diagnostics/plan/attempt/evidence.txt", prompt: "请用 MCP attempt_evidence_read 分析。证据文件：/projects/evidence.txt", evidenceHash: "a".repeat(64), truncated: false };
  h.w.fetch = async (raw: any, init?: RequestInit) => {
    const path = new URL(String(raw), h.w.location.origin).pathname;
    if (path.endsWith("/jobs/diagnostic-job")) return Response.json({ jobId: "diagnostic-job", status: finishDiagnosis ? "succeeded" : "running", result: { diagnosticId: "diag-one" } });
    if (path.includes("/diagnostics")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (path.endsWith("/export")) { exportCalls++; return Response.json(exported); }
        diagnosticPosts.push(body);
        const record = records.at(-1) || { diagnosticId: "diag-one", runnerId: body.runnerId, status: "completed", messages: [] };
        record.messages.push({ role: "user", content: body.message, createdAt: new Date().toISOString() }, { role: "assistant", content: "结论：等待技术决策，请先确认数据库方案。", runnerId: body.runnerId, modelId: body.modelId, createdAt: new Date().toISOString() }); records = [record];
        return Response.json({ jobId: "diagnostic-job", status: diagnosticPosts.length === 1 ? "running" : "succeeded", result: { diagnosticId: record.diagnosticId } });
      }
      return Response.json({ diagnostics: records, evidence: { text: "不应复制的完整日志", hash: "a".repeat(64) } });
    }
    return originalFetch(raw, init);
  };
  (h.plans[0] as any).session = { sessionId: "failed-session", status: "failed", health: { state: "idle" }, tasks: [{ taskId: "spec", title: "设计", status: "failed", attempts: [{ attemptId: "failed-attempt" }], currentAttempt: { attemptId: "failed-attempt", runnerId: "codex", status: "failed" } }] };
  const diagnosticFetch = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: RequestInit) => raw.includes("/attempts/") && !raw.includes("/diagnostics") ? Response.json({ attempt: { attemptId: "failed-attempt", runnerId: "codex", status: "failed" }, fileId: "log", cursor: 1, hasMore: false, events: [] }) : diagnosticFetch(raw, init)) as any;
  h.element("refresh").click();
  await expect.poll(() => (h.element("attempt-select") as HTMLSelectElement).value).toBe("failed-attempt");
  await expect.poll(() => h.element("attempt-diagnose").classList.contains("hidden")).toBe(false);
  h.element("attempt-diagnose").click();
  expect(h.w.document.getElementById("attempt-copy")).toBeNull(); expect(h.w.document.getElementById("attempt-download")).toBeNull();
  expect((h.element("diagnosis-choice-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.element("diagnosis-choice-dialog").textContent).not.toContain("推荐");
  h.element("diagnosis-local").click();
  await expect.poll(() => h.element("attempt-diagnosis-status").textContent).toContain("输入问题");
  expect(diagnosticPosts).toHaveLength(0); expect(exportCalls).toBe(0);
  expect(h.element("attempt-diagnosis-dialog").textContent).not.toContain("复制证据");
  expect(h.element("attempt-diagnosis-reply").compareDocumentPosition(h.element("attempt-diagnosis-runner")) & h.w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const models = h.element("attempt-diagnosis-model") as HTMLSelectElement; models.value = "__custom__"; models.dispatchEvent(new h.w.Event("change"));
  (h.element("diagnosis-custom-model") as HTMLInputElement).value = "fast-model";
  (h.element("attempt-diagnosis-reply") as HTMLTextAreaElement).value = "请分析原因";
  h.element("attempt-diagnosis-form").dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => (h.element("attempt-diagnosis-reply") as HTMLTextAreaElement).value).toBe("");
  expect(h.element("attempt-diagnosis-send").textContent).toBe("分析中…");
  (h.element("attempt-diagnosis-reply") as HTMLTextAreaElement).value = "下一条草稿，不要在上一轮完成时清空";
  h.element("attempt-diagnosis-reply").dispatchEvent(new h.w.Event("input")); finishDiagnosis = true;
  await expect.poll(() => h.element("attempt-diagnosis-history").querySelectorAll(".is-assistant").length, { timeout: 3000 }).toBe(1);
  expect((h.element("attempt-diagnosis-reply") as HTMLTextAreaElement).value).toBe("下一条草稿，不要在上一轮完成时清空");
  expect(diagnosticPosts[0]).toMatchObject({ runnerId: "codex", modelId: "fast-model", message: "请分析原因" });
  const runners = h.element("attempt-diagnosis-runner") as HTMLSelectElement; runners.value = "claude-code"; runners.dispatchEvent(new h.w.Event("change"));
  await new Promise(resolve => setTimeout(resolve, 0));
  (h.element("attempt-diagnosis-reply") as HTMLTextAreaElement).value = "有哪些补救选项？";
  h.element("attempt-diagnosis-form").dispatchEvent(new h.w.Event("submit", { cancelable: true }));
  await expect.poll(() => diagnosticPosts.length).toBe(2);
  expect(diagnosticPosts[1].runnerId).toBe("claude-code");
  (h.element("attempt-diagnosis-dialog") as HTMLDialogElement).close(); h.w.eval("openAttemptDiagnosis()"); h.element("diagnosis-web").click();
  await expect.poll(() => h.copied.at(-1)).toBe(exported.prompt);
  expect((h.element("diagnosis-export-path") as HTMLInputElement).value).toBe(exported.absolutePath);
  expect(h.copied.at(-1)).not.toContain("完整日志"); expect(diagnosticPosts).toHaveLength(2); expect(exportCalls).toBe(1);
});

it("renders the diagnosis route selector through its React bridge and wires its callbacks", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution" });
  await expect.poll(() => h.w.eval('__testState.planning?.planningId')).toBe("first");
  let callbacks: { onClose(): void; onLocal(): void; onWeb(): void } | undefined;
  let dialogCallbacks: { onClose(): void; onSwitch(): void } | undefined;
  h.w.tokenCouponAttemptDiagnosisChoice = {
    render(mount: HTMLElement, next: typeof callbacks) { callbacks = next; mount.textContent = "React 选择分析方式"; },
    unmountWithin() {},
  } as any;
  h.w.tokenCouponAttemptDiagnosisDialog = {
    render(mount: HTMLElement, model: any, next: typeof dialogCallbacks) { dialogCallbacks = next; mount.innerHTML = renderToStaticMarkup(createElement(AttemptDiagnosisDialog, { model, ...next })); },
    unmountWithin() {},
  } as any;
  h.w.eval('__testState.attemptView = {workspaceId:"project",planningId:"first",attemptId:"diagnostic-attempt",attempt:{runnerId:"codex"}}; void openAttemptDiagnosis()');
  await expect.poll(() => h.visible("diagnosis-choice-dialog")).toBe(true);
  expect(h.element("diagnosis-choice-root").textContent).toContain("React 选择分析方式");
  expect(callbacks).toBeDefined();
  callbacks!.onClose(); expect(h.element("diagnosis-choice-dialog").hasAttribute("open")).toBe(false);

  h.w.eval("void openAttemptDiagnosis()");
  await expect.poll(() => h.element("diagnosis-choice-dialog").hasAttribute("open")).toBe(true);
  callbacks!.onLocal();
  await expect.poll(() => h.element("attempt-diagnosis-dialog").hasAttribute("open")).toBe(true);
  expect(h.element("diagnosis-choice-dialog").hasAttribute("open")).toBe(false);
  expect(h.element("attempt-diagnosis-dialog-root").querySelector("#attempt-diagnosis-composer-root")).not.toBeNull();
  expect(dialogCallbacks).toBeDefined();
  dialogCallbacks!.onSwitch();
  expect(h.element("attempt-diagnosis-dialog").hasAttribute("open")).toBe(false);
  expect(h.element("diagnosis-choice-dialog").hasAttribute("open")).toBe(true);
});

it("creates a linked revision from the visible source version and opens the new planning record", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first" });
  await expect.poll(() => h.element("planning-title").textContent).toContain("计划 first");
  const original = h.w.fetch; let submitted: any;
  h.w.fetch = async (raw: any, init?: RequestInit) => {
    const path = new URL(String(raw), h.w.location.origin).pathname;
    if (path.endsWith("/fork")) {
      submitted = JSON.parse(String(init?.body));
      const child = structuredClone(h.plans[1]) as any; child.planningId = "revision-plan"; child.draft.plan.title = "关联修订"; child.sourcePlanning = { planningId: "first", draftRevision: 1 };
      h.plans.push(child);
      return Response.json({ jobId: "revision-job", status: "succeeded", kind: "external.prepare", workspaceId: "project", result: { planningId: child.planningId } });
    }
    return original(raw, init);
  };
  h.w.eval("openRevisionPlanning()");
  h.element("revision-planning-create").click();
  await expect.poll(() => h.w.location.hash).toContain("revision-plan");
  expect(submitted).toMatchObject({ confirmed: true, expectedRevision: 3, expectedPlanHash: "first" });
  expect(submitted.message).toBeUndefined();
  expect(h.element("planning-source-link").textContent).toContain("修订自 first");
  expect(h.plans[0]?.planningId).toBe("first");
});

it("keeps pause and cancel beside state detection with distinct styles and clear session labels", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first/execution" });
  (h.plans[0] as any).session = { sessionId: "active-session", status: "running", health: { state: "active" }, tasks: [{ taskId: "spec", status: "running", attempts: [] }] };
  h.element("refresh").click();
  await expect.poll(() => h.element("session-controls").textContent).toContain("暂停会话");
  const pause = h.element("session-controls").querySelector<HTMLButtonElement>(".button-session-pause")!, cancel = h.element("session-controls").querySelector<HTMLButtonElement>(".button-session-cancel")!;
  expect(cancel.textContent).toBe("取消会话");
  expect(pause.closest(".button-row")).toBe(h.element("session-check").closest(".button-row"));
  expect(cancel.closest(".button-row")).toBe(h.element("session-check").closest(".button-row"));
  expect(pause.className).not.toBe(cancel.className); expect(h.posts).toHaveLength(0);
});

it("explains a decision-blocked continuation and offers its exact reply and a linked revision instead of blind retry", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project/plans/first/execution" }), original = h.w.fetch, attemptId = randomUUID();
  const session: any = { sessionId: "decision-session", status: "failed", health: { state: "idle", recoveryRequired: false }, tasks: [{ taskId: "spec", status: "succeeded", attempts: [] }, { taskId: "backend", title: "技术选型确认", status: "failed", dependsOn: ["spec"], attempts: [{ attemptId }] }] };
  (h.plans[0] as any).session = session;
  h.w.fetch = (async (raw: string, init?: any) => {
    if (raw.endsWith("/session/retry")) {
      h.posts.push({ path: raw, body: JSON.parse(init.body) }); session.status = "blocked"; session.tasks[1].status = "blocked"; session.tasks[1].reasonCode = "user_input_required";
      return Response.json({ jobId: "decision-retry", kind: "session.retry", workspaceId: "project", status: "succeeded", result: { planningId: "first", sessionId: session.sessionId, status: "blocked", waitingForUser: ["backend"] } });
    }
    if (raw.includes("/attempts/")) return Response.json({ attempt: { attemptId, runnerId: "codex", status: "needs_input", reasonCode: "user_input_required" }, events: [], fileId: "decision-log", cursor: 1, hasMore: false });
    return original(raw, init);
  }) as any;
  h.element("refresh").click(); await expect.poll(() => (h.element("session-continue") as HTMLButtonElement).disabled).toBe(false);
  h.element("session-continue").click(); h.element("session-continue-confirm").click();
  await expect.poll(() => h.element("job-label").textContent).toContain("等待用户决策（1 个任务）");
  await expect.poll(() => (h.element("session-continue") as HTMLButtonElement).disabled).toBe(true);
  expect(h.element("job-bar").dataset.state).toBe("blocked"); expect(h.element("job-view-result").textContent).toBe("查看阻塞与处理方法");
  expect(h.element("session-continue-hint").textContent).toContain("技术选型确认"); expect(h.element("session-continue-hint").textContent).toContain("重新审查并批准");
  const actions = h.element("session-blocker-actions").querySelectorAll<HTMLButtonElement>("button");
  expect(actions).toHaveLength(2); actions[1]!.click(); expect((h.element("revision-planning-dialog") as HTMLDialogElement).open).toBe(true);
  h.element("revision-planning-close").click(); actions[0]!.click();
  await expect.poll(() => h.w.location.hash).toContain("/attempts"); expect((h.element("attempt-select") as HTMLSelectElement).value).toBe(attemptId);
  expect(h.posts).toHaveLength(1);
});

it("shows saved workspace grants, preserves edits during polling, cancels locally, and returns to saved view after confirmation", async () => {
  const h = await page({ ready: true, multiple: true });
  h.setGrants([{ grantId: "saved-grant", source: "chatgpt", workspaceIds: ["project"], expiresAt: Date.now() + 600000 }]); h.element("remote-refresh").click();
  await expect.poll(() => h.element("remote-grants").querySelector(".grant-state")?.textContent).toBe("已保存");
  h.w.document.querySelector<HTMLButtonElement>('[data-connection-tab="authorization"]')!.click();
  const card = h.element("remote-grants").querySelector<HTMLElement>("article")!, editor = card.querySelector<HTMLElement>(".grant-editor")!;
  expect(editor.classList.contains("hidden")).toBe(true); expect(card.querySelector(".grant-saved-summary")!.textContent).toContain("排课后端");
  const save = card.querySelector<HTMLButtonElement>(".grant-save")!, cancel = card.querySelector<HTMLButtonElement>(".grant-edit-cancel")!;
  card.querySelector<HTMLButtonElement>(".grant-edit")!.click(); expect(card.dataset.mode).toBe("editing"); expect(save.disabled).toBe(true);
  const checkbox = card.querySelector<HTMLInputElement>('input[value="other"]')!; checkbox.checked = true; checkbox.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  expect(save.disabled).toBe(false); checkbox.focus(); h.element("remote-refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.element("remote-grants").querySelector("article")).toBe(card); expect(checkbox.checked).toBe(true); expect(h.w.document.activeElement).toBe(checkbox);
  cancel.click(); expect(card.dataset.mode).toBe("saved"); expect(checkbox.checked).toBe(false); expect(h.posts).toHaveLength(0);
  card.querySelector<HTMLButtonElement>(".grant-edit")!.click(); checkbox.checked = true; checkbox.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  save.click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true);
  expect(h.posts).toHaveLength(0); h.element("confirm-action-no").click();
  await expect.poll(() => save.disabled).toBe(false); expect(card.dataset.mode).toBe("editing");
  expect(checkbox.checked).toBe(true); expect(h.posts).toHaveLength(0);
  save.click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => h.posts.length).toBe(1);
  await expect.poll(() => h.element("remote-grants").querySelector("article")?.dataset.mode).toBe("saved");
  const saved = h.element("remote-grants").querySelector<HTMLElement>("article")!;
  expect(saved.querySelector(".grant-state")!.textContent).toBe("已保存"); expect(saved.querySelector(".grant-editor")!.classList.contains("hidden")).toBe(true);
  expect(saved.querySelector(".grant-workspace-summary")!.textContent).toContain("其他项目");
  expect(h.posts[0]).toMatchObject({ path: "/api/v1/remote-connection/grants/saved-grant", body: { workspaceIds: ["project", "other"] } });
  h.element("remote-refresh").click(); await new Promise(resolve => setTimeout(resolve, 30)); expect(h.element("remote-grants").querySelector("article")?.dataset.mode).toBe("saved");
});

it("retains failed grant edits, validates an empty selection, and rejects stale authorization drafts", async () => {
  const h = await page({ ready: true, multiple: true }), grant = { grantId: "failed-grant", source: "chatgpt", workspaceIds: ["project"], expiresAt: Date.now() + 600000 };
  h.setGrants([grant]); h.element("remote-refresh").click();
  await expect.poll(() => h.element("remote-grants").querySelector("article")).not.toBeNull();
  const card = h.element("remote-grants").querySelector<HTMLElement>("article")!, save = card.querySelector<HTMLButtonElement>(".grant-save")!;
  card.querySelector<HTMLButtonElement>(".grant-edit")!.click();
  const current = card.querySelector<HTMLInputElement>('input[value="project"]')!, other = card.querySelector<HTMLInputElement>('input[value="other"]')!;
  current.checked = false; current.dispatchEvent(new h.w.Event("change", { bubbles: true })); expect(save.disabled).toBe(true); expect(card.querySelector(".grant-editor-feedback")!.textContent).toContain("至少选择一个");
  other.checked = true; other.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  const original = h.w.fetch; h.w.fetch = (async (raw: string, init?: any) => raw.endsWith("/grants/failed-grant") && init?.method === "POST" ? Response.json({ error: "保存服务暂不可用" }, { status: 503 }) : original(raw, init)) as any;
  save.click(); await expect.poll(() => (h.element("confirm-action-dialog") as HTMLDialogElement).open).toBe(true); h.element("confirm-action-yes").click();
  await expect.poll(() => card.querySelector(".grant-editor-feedback")!.textContent).toContain("保存未完成");
  expect(card.dataset.mode).toBe("editing"); expect(other.checked).toBe(true); expect(save.disabled).toBe(false);
  h.setGrants([{ ...grant, workspaceIds: ["project", "other"] }]); h.element("remote-refresh").click();
  await expect.poll(() => card.dataset.stale).toBe("true"); expect(save.disabled).toBe(true); expect(card.querySelector(".grant-editor-feedback")!.textContent).toContain("取消编辑后重新核对");
  card.querySelector<HTMLButtonElement>(".grant-edit-cancel")!.click();
  expect(h.element("remote-grants").querySelector("article")?.dataset.mode).toBe("saved"); expect(h.element("remote-grants").querySelector(".grant-workspace-summary")!.textContent).toContain("其他项目");
});

it.each([["https://claude.ai", "claude"], ["https://chatgpt.com", "chatgpt"], ["https://claude.ai.evil.example", ""], ["https://unknown.example", ""]])("infers the display source from callback origin %s and allows manual changes", async (redirectHost, expected) => {
  const h = await page({ ready: true });
  h.setApprovals([{ requestId: "source", clientId: "source-client", clientName: "untrusted client label", redirectHost, requestedScopes: ["planning:read"], createdAt: Date.now(), expiresAt: Date.now() + 60000 }]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelector(".remote-source-select")).not.toBeNull();
  const select = h.element("remote-approvals").querySelector<HTMLSelectElement>(".remote-source-select")!;
  expect(select.value).toBe(expected); select.value = "other"; select.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 20)); expect(select.value).toBe("other"); expect(h.posts).toHaveLength(0);
});

it("selects only displayed permission scopes in one click, supports partial changes and clearing, and keeps workspace explicit", async () => {
  const h = await page({ ready: true });
  h.setApprovals([{ requestId: "all-scopes", clientId: "claude-client", clientName: "Claude", redirectHost: "https://claude.ai", requestedScopes: ["repository:read", "planning:read", "planning:write", "session:read", "session:control"], createdAt: Date.now(), expiresAt: Date.now() + 60000 }]); h.element("refresh").click();
  await expect.poll(() => h.element("remote-approvals").querySelector(".remote-scopes-all")).not.toBeNull();
  const card = h.element("remote-approvals").querySelector("article")!, all = card.querySelector<HTMLInputElement>(".remote-scopes-all")!, scopes = card.querySelectorAll<HTMLInputElement>(".remote-scope input");
  expect(scopes).toHaveLength(4); expect([...scopes].every(input => !input.checked)).toBe(true);
  expect(all.type).toBe("checkbox"); expect(all.parentElement!.textContent).toBe("全选");
  all.click(); expect([...scopes].every(input => input.checked)).toBe(true); expect(all.checked).toBe(true); expect(all.indeterminate).toBe(false);
  scopes[0]!.checked = false; scopes[0]!.dispatchEvent(new h.w.Event("change", { bubbles: true })); expect(all.checked).toBe(false); expect(all.indeterminate).toBe(true);
  all.click(); expect([...scopes].every(input => input.checked)).toBe(true);
  const allow = [...card.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "授权所选权限")!; expect(allow.disabled).toBe(true);
  card.querySelector<HTMLSelectElement>(".remote-workspace-select")!.value = "project"; card.dispatchEvent(new h.w.Event("change", { bubbles: true })); expect(allow.disabled).toBe(false);
  all.click(); expect([...scopes].every(input => !input.checked)).toBe(true); expect(all.checked).toBe(false); expect(all.indeterminate).toBe(false); expect(allow.disabled).toBe(true); expect(h.posts).toHaveLength(0);
});

it("shows a token-exchange pending grant as incomplete even though its local permissions were saved", async () => {
  const h = await page({ ready: true, hash: "#/workspaces/project" });
  h.setGrants([{ grantId: "pending-token", source: "claude", workspaceIds: ["project"], expiresAt: Date.now() + 60000, oauthState: "awaiting_token" }]);
  h.setRemote({ validGrants: 1, pendingTokenExchanges: 1, remoteClientVerified: false, recentCalls: [{ traceId: "test", at: Date.now(), stage: "oauth", method: "authorization_code", outcome: "error", code: "oauth_resource_missing", httpStatus: 500, requestFields: ["client_id", "code_verifier"] }] });
  h.element("refresh").click();
  await expect.poll(() => h.element("connection-reuse-status").textContent).toContain("网页待完成连接");
  expect(h.element("connection-action-title").textContent).toBe("本机已批准，网页尚未完成连接");
  expect(h.element("remote-grants").querySelector(".grant-state")!.textContent).toBe("已保存");
  expect(h.element("remote-grants").querySelector(".grant-oauth-state")!.textContent).toBe("网页待完成连接");
  expect(h.element("remote-authorization-status").textContent).toContain("等待网页完成连接");
  expect((h.element("remote-grant-details") as HTMLDetailsElement).open).toBe(false);
  expect(h.element("connection-recent-calls").textContent).toContain("OAuth 换取令牌失败"); expect(h.element("connection-recent-calls").textContent).toContain("oauth_resource_missing");
  expect(h.visible("connection-verify-web")).toBe(false);
});

it("summarizes observed OAuth and tool results once, keeps old pending records collapsed, and preserves expanded details", async () => {
  const h = await page({ ready: true });
  const old = { grantId: "old", clientId: "old-client", source: "claude", workspaceIds: ["project"], expiresAt: Date.now() + 60000, oauthState: "awaiting_token" };
  const ready = { ...old, grantId: "current", clientId: "current-client", oauthState: "token_issued" };
  h.setGrants([old, ready]); h.setRemote({ validGrants: 2, pendingTokenExchanges: 1, remoteClientVerified: true, recentCalls: [] }); h.element("refresh").click();
  await expect.poll(() => h.element("remote-authorization-status").textContent).toContain("网页已连通");
  expect(h.element("remote-grant-count").textContent).toBe("1 个已授权 · 1 个待完成");
  expect(h.element("remote-grants").textContent).not.toContain("请在原网页连接中完成或重新连接");
  const details = h.element("remote-grant-details") as HTMLDetailsElement; expect(details.open).toBe(false); details.open = true;
  h.setRemote({ recentCalls: [{ stage: "oauth", outcome: "error", clientId: "current-client", code: "invalid_client" }] }); h.element("refresh").click();
  await expect.poll(() => h.element("remote-authorization-status").textContent).toContain("最近一次网页授权失败（invalid_client）"); expect(details.open).toBe(true);
  h.setRemote({ recentCalls: [{ stage: "oauth", outcome: "success", clientId: "current-client", code: "oauth_token_issued" }], remoteClientVerified: false }); h.element("refresh").click();
  await expect.poll(() => h.element("remote-authorization-status").textContent).toContain("授权成功 · 等待首次工具调用验证");
  h.setRemote({ remoteClientVerified: true }); h.element("refresh").click(); await expect.poll(() => h.element("remote-authorization-status").textContent).toContain("网页已连通");
});

it("dismisses each notification using its accessible X without changing execution state", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => h.element("planning-list").children.length).toBeGreaterThan(0);
  const original = JSON.stringify(h.plans);
  h.w.eval('showToast("网络暂不可用", true); showActionFeedback("请补全", "请选择模型", "validation"); showToast("已保存");');
  for (const [panel, button] of [["page-error", "page-error-dismiss"], ["action-feedback", "action-feedback-close"], ["toast", "toast-close"]]) {
    expect(h.visible(panel!)).toBe(true);
    expect(h.element(button!).textContent).toBe("×");
    expect(h.element(button!).getAttribute("aria-label")).toBe("关闭提示");
    h.element(button!).click(); expect(h.visible(panel!)).toBe(false);
  }
  h.w.eval('showToast("新的连接错误", true)');
  expect(h.visible("page-error")).toBe(true);
  expect(JSON.stringify(h.plans)).toBe(original); expect(h.posts).toHaveLength(0);
});

it("shows observed execution status, approval badges and actual creation time in the sidebar", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => h.element("planning-list").querySelectorAll(".planning-list-state").length).toBe(2);
  (h.w as any).__testState.plannings = h.plans;
  const first: any = h.plans[0], second: any = h.plans[1];
  first.session = { status: "running" }; second.session = { status: "succeeded" };
  h.w.eval("renderPlanningList()");
  const states = () => [...h.element("planning-list").querySelectorAll(".planning-list-state")].map(node => node.textContent);
  expect(states()).toEqual(["运行中", "已完成"]);
  const created = h.element("planning-list").querySelector("time")!;
  expect(created.getAttribute("datetime")).toBe(first.createdAt);
  expect(created.textContent).toContain("2026/10/18");
  first.interactions = [{ request: { kind: "approval" } }];
  h.w.eval("renderPlanningList()"); expect(states()).toEqual(["待审批", "已完成"]);
  first.session = { status: "interrupted", savedStatus: "running" };
  h.w.eval("renderPlanningList()"); expect(states()).toEqual(["已中断", "已完成"]);
  first.session = { status: "unavailable", savedStatus: "running" };
  h.w.eval("renderPlanningList()"); expect(states()[0]).toBe("状态待核验");
  first.session = { status: "paused" }; first.interactions = [];
  h.w.eval("renderPlanningList()"); expect(states()[0]).toBe("已暂停");
  first.createdAt = "bad timestamp"; second.createdAt = undefined;
  h.w.eval("renderPlanningList()");
  expect(h.element("planning-list").querySelectorAll("time")).toHaveLength(0);
  expect(h.element("planning-list").textContent).toContain("创建时间未记录");
});

it("distinguishes waiting for review and approval before any Session exists", async () => {
  const h = await page({ hash: "#/workspaces/project", ready: true });
  await expect.poll(() => h.element("planning-list").querySelectorAll(".planning-list-state").length).toBe(2);
  (h.w as any).__testState.plannings = h.plans;
  const first: any = h.plans[0], second: any = h.plans[1];
  first.workflow = { stage: "review_prepared", label: "等待网页领取审查" };
  second.workflow = { stage: "awaiting_approval", label: "审查已完成，待核对与批准" };
  h.w.eval("renderPlanningList()");
  const buttons = h.element("planning-list").querySelectorAll(":scope > button");
  expect(buttons[0]!.querySelector(".planning-list-state")!.textContent).toBe("待网页审查");
  expect(buttons[1]!.querySelector(".planning-list-state")!.textContent).toBe("待批准");
  expect(buttons[0]!.getAttribute("title")).toContain("等待网页领取审查");
  (buttons[1] as HTMLButtonElement).click();
  await expect.poll(() => h.w.location.hash).toContain("/plans/second");
});

it("shows local planning phases, real model, silence warning and safe reply updates without scrolling", async () => {
  const h = await page({ hash: "#/workspaces/project/new", ready: true });
  await expect.poll(() => h.visible("composer-page")).toBe(true);
  const now = new Date().toISOString(), startedAt = new Date(Date.now() - 75_000).toISOString();
  const progress = { planningId: "first", operationId: "turn-first", role: "plan", stage: "waiting_model", runnerId: "codex", configuredModel: "runner-default", reportedModel: "fixture-fast", startedAt, updatedAt: now, requestId: 1 };
  const job = { jobId: "planning-job", workspaceId: "project", planningId: "first", kind: "planning.start", status: "running", createdAt: startedAt, updatedAt: now, progress };
  const state = (h.w as any).__testState; state.activeJob = job;
  (h.w as any).__progressFixture = { workspaceId: "project", planningId: "first", payload: { jobId: job.jobId, kind: job.kind, progress } };
  h.w.eval("consumePlanningProgress(window.__progressFixture)");
  expect(h.visible("planning-progress")).toBe(true); expect(h.element("planning-progress-stage").textContent).toBe("等待模型回复");
  expect(h.element("planning-progress-metrics").textContent).toContain("fixture-fast（实际报告）");
  expect(h.visible("planning-progress-idle")).toBe(true); expect(h.element("planning-progress-idle").textContent).toContain("不代表上游网络或模型健康");
  let scrolled = 0; h.w.HTMLElement.prototype.scrollIntoView = () => { scrolled++; };
  progress.stage = "receiving"; Object.assign(progress, { lastOutputAt: now, replyPreview: "请先确认范围\n<img src=x onerror=alert(1)>", rawPreview: '{"message":"请先确认范围"}' });
  h.w.eval("consumePlanningProgress(window.__progressFixture)");
  expect(h.element("planning-progress-preview").textContent).toContain("请先确认范围"); expect(h.element("planning-progress-preview").querySelector("img")).toBeNull();
  expect(h.visible("planning-progress-idle")).toBe(false); expect((h.element("planning-progress-raw") as HTMLDetailsElement).open).toBe(false);
  (h.element("planning-progress-raw") as HTMLDetailsElement).open = true;
  progress.stage = "repairing"; Object.assign(progress, { detail: "业务规则确认提案需要修正" });
  h.w.eval("consumePlanningProgress(window.__progressFixture)");
  expect(h.element("planning-progress-stage").textContent).toBe("自动修正回复"); expect((h.element("planning-progress-raw") as HTMLDetailsElement).open).toBe(true); expect(scrolled).toBe(0);
  progress.stage = "cancelled"; h.w.eval("consumePlanningProgress(window.__progressFixture)");
  expect(h.element("planning-progress-stage").textContent).toBe("取消收尾中"); expect(h.visible("planning-progress-retry")).toBe(false);
  state.activeJob = null;
});

it("fences stale planning progress and hides it outside the corresponding Plan", async () => {
  const h = await page({ hash: "#/workspaces/project/new", ready: true });
  await expect.poll(() => h.visible("composer-page")).toBe(true);
  const state = (h.w as any).__testState, now = new Date().toISOString();
  const job = { jobId: "planning-job", workspaceId: "project", planningId: "first", kind: "planning.start", status: "failed", createdAt: now, updatedAt: now, error: "planner_timed_out：规划超过配置期限", progress: { planningId: "first", role: "plan", stage: "failed", startedAt: now, updatedAt: now } };
  (h.w as any).__progressJob = job; h.w.eval("acceptPlanningJob(window.__progressJob)");
  expect(h.visible("planning-progress-retry")).toBe(true);
  (h.w as any).__lateProgress = { workspaceId: "project", planningId: "first", payload: { jobId: job.jobId, kind: job.kind, progress: { ...job.progress, stage: "receiving" } } };
  h.w.eval("consumePlanningProgress(window.__lateProgress)");
  expect(h.element("planning-progress-stage").textContent).toBe("失败"); expect(state.planningProgressJob.status).toBe("failed");
  state.route = { page: "plan", workspaceId: "project", planningId: "second" }; h.w.eval("renderPlanningProgress()");
  expect(h.visible("planning-progress")).toBe(false); expect(h.posts).toHaveLength(0);
});

it("restores a saved interrupted planning call after refresh and retries the original Planning only on click", async () => {
  const h = await page({ hash: "#/workspaces/project/new", ready: true });
  await expect.poll(() => h.visible("composer-page")).toBe(true);
  const state = (h.w as any).__testState, now = new Date().toISOString(); state.plannerProgressSupported = true;
  const job = { jobId: "saved-planning", workspaceId: "project", planningId: "first", kind: "planning.start", status: "interrupted", createdAt: now, updatedAt: now, error: "daemon_restarted：服务重启后不会自动重放操作", progress: { planningId: "first", role: "plan", stage: "waiting_model", startedAt: now, updatedAt: now } };
  h.w.sessionStorage.setItem("tc-planning-job-project", job.jobId);
  const originalFetch = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: RequestInit) => {
    if (String(raw).endsWith("/jobs/saved-planning")) return Response.json(job);
    if (String(raw).endsWith("/planner-retry")) { h.posts.push({ path: String(raw), body: JSON.parse(String(init?.body)) }); return Response.json({ ...job, jobId: "retry-finished", status: "failed", error: "fixture retry stopped" }); }
    return originalFetch(raw, init);
  }) as any;
  await h.w.eval("restorePlanningProgress('project')");
  expect(h.element("planning-progress-stage").textContent).toBe("已中断"); expect(h.element("planning-progress-detail").textContent).toContain("不会自动重放");
  expect(h.posts).toHaveLength(0); expect(h.visible("planning-progress-retry")).toBe(true);
  h.element("planning-progress-retry").click();
  await expect.poll(() => h.posts.some(post => post.path.endsWith("/plannings/first/planner-retry"))).toBe(true);
  expect(h.posts.some(post => post.path.endsWith("/plannings"))).toBe(false);
});

it("offers an explicit retry for a legacy local planning timeout without a new Job progress record", async () => {
  const h = await page({ hash: "#/workspaces/project/plans/first", ready: true });
  await expect.poll(() => h.element("planning-title").textContent).toBe("计划 first");
  const state = (h.w as any).__testState;
  state.planning.config.provider = "codex-agent";
  state.planning.turns = [{ turnId: "legacy-turn", status: "timed_out", reasonCode: "planner_timed_out" }];
  h.w.eval("renderPlanWorkflowBanner()");
  expect(h.element("plan-workflow-banner").textContent).toContain("保留 Planning 和原始输入"); expect(h.posts).toHaveLength(0);
  const original = h.w.fetch;
  h.w.fetch = (async (raw: string, init?: RequestInit) => {
    if (String(raw).endsWith("/planner-retry")) { h.posts.push({ path: String(raw), body: JSON.parse(String(init?.body)) }); return Response.json({ jobId: "legacy-retry", workspaceId: "project", kind: "planning.retry", status: "failed", error: "fixture stopped" }); }
    return original(raw, init);
  }) as any;
  h.element("retry-planning-turn").click();
  await expect.poll(() => h.posts.some(post => post.path.endsWith("/plannings/first/planner-retry"))).toBe(true);
  expect(h.posts.some(post => post.path.endsWith("/plannings"))).toBe(false);
});
