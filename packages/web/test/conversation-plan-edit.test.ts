import { createClient } from "@token-coupon/client";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";

const windows: JSDOM[] = [];
afterEach(async () => { await new Promise(resolve => setImmediate(resolve)); for (const dom of windows.splice(0)) dom.window.close(); });
async function page(options: { mcp?: boolean; failReply?: boolean; failSave?: boolean; asyncSave?: boolean; handoff?: boolean; unconnected?: boolean } = {}) {
  const [html, clientScript, script] = await Promise.all([readFile(new URL("../public/index.html", import.meta.url), "utf8"), readFile(new URL("../public/api-client.js", import.meta.url), "utf8"), readFile(new URL("../public/app.js", import.meta.url), "utf8")]);
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4177/#/workspaces/workspace/plans/plan/draft", runScripts: "outside-only", pretendToBeVisual: true }); windows.push(dom);
  const w = dom.window;
  Object.assign(w, { Headers, EventSource: class { addEventListener() {} close() {} } });
  Object.defineProperty(w.crypto, "randomUUID", { value: randomUUID });
  w.confirm = () => true;
  const copied: string[] = []; Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  w.HTMLElement.prototype.scrollIntoView = () => undefined;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const plan = { schemaVersion: 1, id: "demo", title: "原始计划", tasks: [{ task: { schemaVersion: 1, id: "implement", title: "实现", prompt: "实现功能", execution: { runnerId: "mock", mode: "managed" } }, dependsOn: [], status: "planned" }] };
  const view: any = { planningId: "plan", status: "draft_ready", revision: 3, config: { provider: options.handoff ? "web-mcp" : options.mcp ? "chatgpt-mcp" : "mock", model: "test" },
    handoffs: options.handoff ? [{ role: "plan", target: "chatgpt", state: "prepared", code: "TC-1234567890", pendingInputs: 1, owner: null, prompt: "接手 TC-1234567890" }] : [],
    messages: [{ messageId: "initial", role: "user", content: "原始需求" }], externalOperations: [] as Array<Record<string, unknown>>,
    draft: { plan, planHash: "original-hash", draftRevision: 1 }, review: { current: true, findings: [] } };
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  let saveInput: Record<string, any> | undefined;
  const applyEdits = (base: any, edits: any) => {
    const plan = structuredClone(base);
    if (edits.title !== undefined) plan.title = edits.title;
    for (const change of edits.tasks || []) {
      const target = plan.tasks.find((entry: any) => entry.task.id === change.taskId);
      Object.assign(target.task, change.fields);
      for (const [key, value] of Object.entries(change.fields)) if (key === "notes" && value === null) delete target.task.notes;
    }
    return plan;
  };
  const saveResult = () => {
    if (options.failSave || saveInput?.expectedPlanHash !== view.draft.planHash) return { jobId: "save", status: "failed", error: "计划依赖校验失败或版本已变化" };
    view.draft = { plan: applyEdits(view.draft.plan, saveInput!.edits), planHash: "saved-hash", draftRevision: view.draft.draftRevision + 1 }; view.revision++; view.review.current = false;
    return { jobId: "save", kind: "planning.draft.save", status: "succeeded", result: { planningId: "plan" } };
  };
  w.fetch = async (raw: string, init?: RequestInit) => {
    const path = new URL(raw, w.location.origin).pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); requests.push({ path, body });
      if (path.endsWith("/replies")) {
        if (options.failReply) return Response.json({ jobId: "reply", status: "failed", error: "测试：回复提交失败" });
        if (options.mcp) { view.externalOperations = [{ operationId: "operation", role: "plan", state: "prepared", sourceMessageId: "reply-message", expectedRevision: view.revision, message: body.message }]; }
        else view.messages.push({ messageId: "reply-message", role: "user", content: body.message }, { messageId: "answer", role: "assistant", content: "新的模型回复" });
        return Response.json({ jobId: "reply", kind: options.mcp ? "external.prepare" : "planning.reply", status: "succeeded", result: { planningId: "plan", ...(options.mcp ? { nextAction: "external_context" } : {}) } });
      }
      if (path.endsWith("/revise")) {
        view.workflow = { role: "plan", stage: "plan_prepared", label: "等待网页领取规划／修订", detail: "修订请求已登记，尚未生成新草案" };
        return Response.json({ jobId: "revise", workspaceId: "workspace", kind: "external.prepare", status: "succeeded", result: { planningId: "plan", nextAction: "handoff_claim" } });
      }
      if (path.endsWith("/handoff")) return Response.json({ jobId: "handoff", status: "succeeded", result: { planningId: "plan", prompt: `交给 ${body.target} 接手 TC-1234567890` } });
      if (path.endsWith("/draft")) { saveInput = body; return Response.json(options.asyncSave ? { jobId: "save", status: "running" } : saveResult()); }
      throw new Error(`unexpected POST ${path}`);
    }
    if (path === "/api/v1/health") return Response.json({ epoch: "test", workspaceEnvironment: { currentDirectory: "/project" }, mcp: { url: "local" } });
    if (path === "/api/v1/workspaces") return Response.json([{ workspaceId: "workspace", label: "项目", path: "/project" }]);
    if (path === "/api/v1/providers") return Response.json([{ id: "mock", label: "离线", available: true }]);
    if (path === "/api/v1/runners") return Response.json([{ id: "mock", available: true }]);
    if (path.endsWith("/models")) return Response.json({ models: [], customAllowed: true });
    if (path === "/api/v1/remote-connection") return Response.json({ enabled: false, transport: "stopped", pendingApprovals: 0, validGrants: 0 });
    if (path.endsWith("/grants") && options.handoff && !options.unconnected) return Response.json([{ grantId: "grant", source: "claude", clientName: "Claude", workspaceId: "workspace", workspaceIds: ["workspace"], scopes: ["planning:read", "planning:write"], expiresAt: Date.now() + 60000 }]);
    if (path.endsWith("/grants") || path.endsWith("/approvals") || path.includes("/interactions/")) return Response.json([]);
    if (path.endsWith("/plannings")) return Response.json([view]);
    if (path.endsWith("/plannings/plan")) return Response.json(view);
    if (path.endsWith("/jobs/save")) return Response.json(saveResult());
    throw new Error(`unexpected GET ${path}`);
  };
  Object.assign(w, { createClient: () => createClient({ fetch: ((path, options) => w.fetch(String(path), options)) as typeof fetch, eventSource: (path) => new w.EventSource(path) }) });
  w.eval(clientScript.replace(/^import .*;$/m, "")); w.eval(script);
  const element = (id: string) => w.document.getElementById(id)!;
  const value = (id: string) => (element(id) as HTMLTextAreaElement).value;
  const input = (id: string, text: string) => { (element(id) as HTMLTextAreaElement).value = text; element(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  const edit = (title: string) => { element("toggle-plan-edit").click(); const titleField = element("plan-text-editor").querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!; titleField.value = title; titleField.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const reply = (text: string) => { input("reply-text", text); element("reply-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); };
  await expect.poll(() => element("planning-panel").classList.contains("hidden")).toBe(false);
  return { w, view, requests, copied, element, value, input, edit, reply };
}

it("shows a registered MCP reply and a persistent wait state, then replaces it with committed history without duplicates", async () => {
  const h = await page({ mcp: true });
  expect(h.element("supplement-input").classList.contains("hidden")).toBe(true);
  h.reply("采用默认方案");
  await expect.poll(() => h.element("conversation").textContent).toContain("采用默认方案");
  await expect.poll(() => h.value("reply-text")).toBe("");
  expect(h.element("conversation").textContent).toContain("已登记，等待网页");
  expect(h.element("reply-status").textContent).toContain("等待网页");
  expect(h.element("toast").textContent).toContain("等待网页");
  h.view.messages.push({ messageId: "reply-message", role: "user", content: "采用默认方案" }, { messageId: "answer", role: "assistant", content: "生成了新草案" });
  h.view.externalOperations[0]!.state = "succeeded"; h.element("refresh").click();
  await expect.poll(() => h.element("conversation").textContent).toContain("生成了新草案");
  expect(h.element("conversation").textContent?.match(/采用默认方案/g)).toHaveLength(1);
});

it("keeps a failed reply for retry, reports empty input, and renders a normal Planner response", async () => {
  const h = await page({ failReply: true });
  expect(h.element("supplement-input").classList.contains("hidden")).toBe(false);
  h.reply("保留这条回复");
  await expect.poll(() => h.element("toast").textContent).toContain("回复提交失败");
  expect(h.value("reply-text")).toBe("保留这条回复");
  await expect.poll(() => (h.element("send-reply") as HTMLButtonElement).disabled).toBe(false);
  h.reply(" "); await expect.poll(() => h.element("toast").textContent).toContain("请先填写回复");
  const normal = await page(); normal.reply("补充测试");
  await expect.poll(() => normal.element("conversation").textContent).toContain("新的模型回复");
});

it("waits for asynchronous validation before restoring the saved plan cards", async () => {
  const h = await page({ asyncSave: true }); h.edit("修改后的计划"); h.element("save-plan").click();
  await expect.poll(() => h.requests.length).toBe(1);
  expect(h.element("plan-editor-wrap").classList.contains("hidden")).toBe(false);
  expect((h.element("plan-editor") as HTMLTextAreaElement).disabled).toBe(true);
  await expect.poll(() => h.element("plan-editor-wrap").classList.contains("hidden"), { timeout: 5000 }).toBe(true);
  expect(h.element("plan-view").classList.contains("hidden")).toBe(false);
  expect(h.element("toggle-plan-edit").textContent).toBe("编辑草案");
  expect(h.element("planning-title").textContent).toBe("修改后的计划");
  expect(h.requests[0]!.body).toMatchObject({ expectedPlanHash: "original-hash", expectedDraftRevision: 1, edits: { title: "修改后的计划" } });
  expect(h.requests[0]!.body).not.toHaveProperty("plan");
});

it("keeps field edits visible when server validation rejects a field-only patch", async () => {
  const h = await page({ failSave: true }); h.edit("服务器拒绝的修改"); h.element("save-plan").click();
  await expect.poll(() => h.element("toast").textContent).toContain("计划依赖校验失败");
  expect(h.requests).toHaveLength(1); expect(h.requests[0]!.body).toHaveProperty("edits.title", "服务器拒绝的修改");
  expect(h.value("plan-editor")).toContain("服务器拒绝的修改"); expect(h.element("plan-editor-wrap").classList.contains("hidden")).toBe(false);
});

it("prompts only for actual changes and supports continuing or discarding before navigation", async () => {
  const h = await page(); h.element("toggle-plan-edit").click(); h.element("toggle-plan-edit").click();
  await expect.poll(() => h.element("plan-editor-wrap").classList.contains("hidden")).toBe(true);
  expect(h.element("unsaved-plan-dialog").hasAttribute("open")).toBe(false);
  h.edit("未保存内容"); h.element("new-task").click();
  await expect.poll(() => h.element("unsaved-plan-dialog").hasAttribute("open")).toBe(true);
  h.element("unsaved-plan-cancel").click(); expect(h.value("plan-editor")).toContain("未保存内容");
  expect(h.element("planning-panel").classList.contains("hidden")).toBe(false);
  h.element("new-task").click(); await expect.poll(() => h.element("unsaved-plan-dialog").hasAttribute("open")).toBe(true);
  h.element("unsaved-plan-discard").click(); await expect.poll(() => h.element("planning-panel").classList.contains("hidden")).toBe(true);
  expect(h.requests).toHaveLength(0); expect(h.view.draft.plan.title).toBe("原始计划");
});

it("saves before leaving, and stays in the editor when validation fails", async () => {
  const h = await page({ asyncSave: true }); h.edit("导航前保存"); h.element("new-task").click();
  await expect.poll(() => h.element("unsaved-plan-dialog").hasAttribute("open")).toBe(true); h.element("unsaved-plan-save").click();
  await expect.poll(() => h.element("planning-panel").classList.contains("hidden")).toBe(true); expect(h.view.draft.plan.title).toBe("导航前保存");
  const bad = await page({ failSave: true }); bad.edit("不能保存"); bad.element("new-task").click();
  await expect.poll(() => bad.element("unsaved-plan-dialog").hasAttribute("open")).toBe(true); bad.element("unsaved-plan-save").click();
  await expect.poll(() => bad.element("toast").textContent).toContain("依赖校验失败");
  expect(bad.element("planning-panel").classList.contains("hidden")).toBe(false); expect(bad.value("plan-editor")).toContain("不能保存");
});

it("preserves edits across refresh and rejects a save against a changed baseline", async () => {
  const h = await page({ mcp: true }); h.edit("本地未保存");
  h.view.draft = { ...h.view.draft, planHash: "remote-hash", draftRevision: 2, plan: { ...h.view.draft.plan, title: "外部新版本" } }; h.view.revision++;
  h.view.externalOperations = [{ role: "plan", state: "prepared", expectedRevision: 3, operationId: "old", message: "旧的回复" }];
  h.element("refresh").click(); await expect.poll(() => h.element("plan-edit-status").textContent).toContain("当前草案已更新");
  expect(h.value("plan-editor")).toContain("本地未保存"); expect(h.element("external-operation-list").textContent).toContain("上下文已过期");
  h.element("save-plan").click(); await expect.poll(() => h.element("toast").textContent).toContain("版本已变化");
  expect(h.requests[0]!.body.expectedPlanHash).toBe("original-hash");
});

it("warns before closing the browser only while unsaved changes exist", async () => {
  const h = await page(); let event = new h.w.Event("beforeunload", { cancelable: true }); h.w.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  h.edit("需要保存"); event = new h.w.Event("beforeunload", { cancelable: true }); h.w.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
});


it("shows independent role handoffs and copies one short prompt after the local action", async () => {
  const h = await page({ handoff: true });
  expect(h.element("handoff-panel").textContent).toContain("交给 ChatGPT继续规划");
  const button = [...h.element("handoff-panel").querySelectorAll("button")].find(item => item.textContent === "交给 Claude审查")!;
  button.click();
  await expect.poll(() => h.copied.length).toBe(1);
  expect(h.requests[0]!.body).toMatchObject({ role: "review", target: "claude" });
  expect(h.copied[0]).toContain("TC-1234567890"); expect(h.copied[0]).not.toContain("claimToken");
});

it("guides an unconfigured target to connection authorization instead of creating a handoff", async () => {
  const h = await page({ handoff: true, unconnected: true });
  [...h.element("handoff-panel").querySelectorAll("button")].find(item => item.textContent === "交给 Claude继续规划")!.click();
  await expect.poll(() => h.element("toast").textContent).toContain("请先在连接区");
  expect(h.requests).toHaveLength(0);
});

it("does not hand over a dirty editor until the user decides how to handle changes", async () => {
  const h = await page({ handoff: true }); h.edit("未保存变更");
  [...h.element("handoff-panel").querySelectorAll("button")].find(item => item.textContent === "交给 Claude审查")!.click();
  await expect.poll(() => h.element("unsaved-plan-dialog").hasAttribute("open")).toBe(true);
  expect(h.requests).toHaveLength(0);
  h.element("unsaved-plan-cancel").click(); expect(h.value("plan-editor")).toContain("未保存变更");
});


it("edits prose without changing execution or source metadata, and preserves it during polling", async () => {
  const h = await page(); const original = structuredClone(h.view.draft.plan);
  h.element("toggle-plan-edit").click();
  const fields = h.element("plan-text-editor").querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
  expect(fields).toHaveLength(3);
  fields[2]!.value = "实现功能，增加空值回归测试"; fields[2]!.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  const edited = JSON.parse(h.value("plan-editor"));
  expect(edited.tasks[0].task.execution).toEqual(original.tasks[0].task.execution); expect(edited.id).toBe(original.id);
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 30));
  expect((h.element("plan-text-editor").querySelector("textarea") as HTMLTextAreaElement).value).toContain("空值回归");
  expect(h.element("plan-diff").textContent).toContain("implement");
});

it("keeps review choices inside findings across refresh, then invalidates them on a new version", async () => {
  const h = await page({ mcp: true });
  h.view.review = { reviewId: "review-1", current: true, findings: [
    { findingId: "F1", severity: "warning", description: "缺少测试", suggestion: "增加真实 HTTP 测试，检查响应及数据库状态", basis: "计划验收要求" },
    { findingId: "F2", severity: "error", description: "技术栈冲突", suggestion: "统一为 Java + Spring Boot", basis: "有效需求" },
  ] };
  h.element("refresh").click(); await expect.poll(() => h.element("review-view").querySelectorAll(".finding-choice").length).toBe(2);
  let row = h.element("review-view").querySelector<HTMLElement>('[data-finding-id="F1"]')!;
  expect(row.closest(".finding")!.textContent).toContain("真实 HTTP");
  const select = row.querySelector("select")!; select.value = "custom"; select.dispatchEvent(new h.w.Event("change"));
  const input = row.querySelector("textarea")!; input.value = "覆盖新增后再次查询"; input.dispatchEvent(new h.w.Event("input"));
  const defer = h.element("review-view").querySelector<HTMLSelectElement>('[data-finding-id="F2"] select')!; defer.value = "defer"; defer.dispatchEvent(new h.w.Event("change"));
  h.element("refresh").click(); await new Promise(resolve => setTimeout(resolve, 40));
  row = h.element("review-view").querySelector<HTMLElement>('[data-finding-id="F1"]')!;
  expect(row.querySelector("select")!.value).toBe("custom"); expect(row.querySelector("textarea")!.value).toBe("覆盖新增后再次查询");
  expect(h.element("review-view").querySelector<HTMLSelectElement>('[data-finding-id="F2"] select')!.value).toBe("defer");
  input.value = ""; // detached input cannot mutate the current control
  const current = row.querySelector("textarea")!; current.value = ""; current.dispatchEvent(new h.w.Event("input"));
  h.element("review-actions").querySelector("button")!.click(); await expect.poll(() => row.querySelector(".field-error")!.classList.contains("hidden")).toBe(false);
  expect(h.requests).toHaveLength(0);
  h.view.draft.planHash = "new-hash"; h.view.review.reviewId = "review-2";
  h.element("refresh").click(); await expect.poll(() => h.element("toast").textContent).toContain("重新确认");
  expect(h.element("review-view").querySelector<HTMLSelectElement>("select")!.value).toBe("accept");
});

it("explains a prepared review and copies its continuation without preparing another one", async () => {
  const h = await page({ mcp: true }); h.view.review = null;
  h.view.workflow = { stage: "review_prepared", role: "review", operationId: "current-review", label: "等待网页领取审查", detail: "已准备当前版本的审查，尚未收到结果", approvalNotice: "旧版批准不适用于本版" };
  h.element("refresh").click(); await expect.poll(() => h.element("review-button").textContent).toBe("继续当前审查");
  expect(h.element("review-view").textContent).toContain("尚未收到结果");
  expect(h.element("plan-workflow-banner").textContent).toContain("旧版批准不适用");
  h.element("review-button").click(); await expect.poll(() => h.copied.length).toBe(1); expect(h.requests).toHaveLength(0);
  expect(h.copied[0]).toContain("有待处理操作时");
  h.view.status = "approved"; h.view.workflow = { stage: "approved", label: "已批准 draft-1，尚未执行", detail: "点击运行创建 Session" };
  h.view.approval = { draftRevision: 1, planHash: "original-hash", approvedAt: new Date().toISOString(), reviewId: "current-review" };
  h.view.review = { current: true, findings: [] }; h.element("refresh").click();
  await expect.poll(() => h.element("plan-workflow-banner").textContent).toContain("尚未执行");
  expect(h.element("plan-workflow-banner").querySelector("button")!.textContent).toContain("运行计划");
});


it("merges review choices into one revision request and keeps deferred issues unresolved", async () => {
  const h = await page({ mcp: true });
  h.view.review = { reviewId: "review-batch", current: true, findings: [
    { findingId: "F1", severity: "warning", description: "测试", suggestion: "增加 HTTP 测试", basis: "验收" },
    { findingId: "F2", severity: "error", description: "冲突", suggestion: "统一技术栈", basis: "需求" },
  ] };
  h.element("refresh").click(); await expect.poll(() => h.element("review-view").querySelectorAll(".finding-choice").length).toBe(2);
  const defer = h.element("review-view").querySelector<HTMLSelectElement>('[data-finding-id="F2"] select')!; defer.value = "defer"; defer.dispatchEvent(new h.w.Event("change"));
  h.element("review-actions").querySelector("button")!.click(); await expect.poll(() => h.requests.length).toBe(1);
  expect(h.requests[0]!.path).toMatch(/\/revise$/);
  expect(h.requests[0]!.body).toMatchObject({ reviewId: "review-batch", expectedPlanHash: "original-hash", expectedDraftRevision: 1 });
  expect(h.requests[0]!.body.message).toContain("增加 HTTP 测试"); expect(h.requests[0]!.body.message).toContain("不得将其标记为已解决或豁免");
  await expect.poll(() => h.element("toast").textContent).toContain("等待网页");
  await expect.poll(() => (h.element("approve-button") as HTMLButtonElement).disabled).toBe(true);
  expect(h.element("web-continue").classList.contains("hidden")).toBe(false);
  expect(h.view.draft.draftRevision).toBe(1);
});
