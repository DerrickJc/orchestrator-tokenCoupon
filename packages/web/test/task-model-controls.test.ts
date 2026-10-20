import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";

const windows: Array<JSDOM> = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });
async function page(options: { lateCodex?: boolean; reactModelSelectors?: boolean; reactReviewerMode?: boolean } = {}) {
  const [html, clientScript, script] = await Promise.all([readFile(new URL("../public/index.html", import.meta.url), "utf8"), readFile(new URL("../public/api-client.js", import.meta.url), "utf8"), readFile(new URL("../public/app.js", import.meta.url), "utf8")]);
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4177/#/workspaces/workspace/plans/existing-plan", runScripts: "outside-only", pretendToBeVisual: true }); windows.push(dom);
  const w = dom.window;
  Object.assign(w, { Headers, EventSource: class { addEventListener() {} close() {} } });
  Object.defineProperty(w.crypto, "randomUUID", { value: randomUUID });
  const copied: string[] = []; Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  if (options.reactModelSelectors) Object.assign(w, { tokenCouponModelChoiceSelectors: { render(prefix: "planner" | "runner" | "reviewer", model: { choices: Array<{ id: string; label: string }>; selectedModelId: string }, onChange: (modelId: string) => void) {
    const select = w.document.getElementById(`${prefix}-model-choice`) as HTMLSelectElement;
    select.replaceChildren(...model.choices.map(choice => new w.Option(choice.label, choice.id)));
    select.value = model.selectedModelId;
    select.onchange = () => onChange(select.value);
  } } });
  if (options.reactReviewerMode) Object.assign(w, { tokenCouponReviewerModeSelector: { render(model: { options: Array<{ id: string; label: string }>; selectedMode: string }, onChange: (mode: string) => void) {
    const select = w.document.getElementById("reviewer-mode") as HTMLSelectElement;
    select.replaceChildren(...model.options.map(option => new w.Option(option.label, option.id)));
    select.value = model.selectedMode;
    select.onchange = () => onChange(select.value);
  } } });
  w.HTMLElement.prototype.scrollIntoView = () => undefined;
  const existing = { planningId: "existing-plan", status: "collecting", revision: 1, config: { provider: "deepseek", model: "old" }, messages: [{ role: "user", content: "已有任务" }], externalOperations: [] };
  const submitted: Array<Record<string, unknown>> = []; let resolveLate!: (reply: Response) => void;
  w.fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw, w.location.origin), path = url.pathname;
    if (init?.method === "POST" && path.endsWith("/plannings")) { submitted.push(JSON.parse(String(init.body))); return Response.json({ error: "test_request_captured" }, { status: 409 }); }
    if (path === "/api/v1/health") return Response.json({ epoch: "test-epoch", workspaceEnvironment: { currentDirectory: "/project" }, mcp: { url: "http://127.0.0.1:4177/mcp" } });
    if (path === "/api/v1/workspaces") return Response.json([{ workspaceId: "workspace", label: "项目", path: "/project" }]);
    if (path === "/api/v1/providers") return Response.json([{ id: "chatgpt-mcp", label: "ChatGPT + MCP", available: true }, { id: "deepseek-api", label: "DeepSeek", available: true, model: "deepseek-flash" }, { id: "mock", label: "离线", available: true }]);
    if (path === "/api/v1/runners") return Response.json(["codex", "claude-code", "dsh", "mock"].map(id=>({ id, available: true })));
    if (path === "/api/v1/remote-connection") return Response.json({ enabled: false, mode: "quick_tunnel", transport: "stopped", pendingApprovals: 0, validGrants: 0 });
    if (path.endsWith("/grants") || path.endsWith("/approvals") || path.includes("/interactions/")) return Response.json([]);
    if (path === "/api/v1/runners/codex/models" && options.lateCodex) return new Promise<Response>(resolve=> { resolveLate = resolve; });
    if (/\/runners\/[^/]+\/models$/.test(path)) { const id = path.split("/")[4]; return Response.json({ models: id === "mock" ? [] : [{ id: id === "codex" ? "gpt-test-fast" : `${id}-fast`, label: `${id} Fast` }], customAllowed: id !== "mock", source: "native" }); }
    if (path === "/api/v1/providers/deepseek-api/models") return Response.json({ models: [{ id: "deepseek-flash", label: "Flash" }, { id: "deepseek-pro", label: "Pro" }], customAllowed: true });
    if (path.endsWith("/plannings")) return Response.json([existing]);
    if (path.endsWith("/plannings/existing-plan")) return Response.json(existing);
    throw new Error(`unexpected request: ${path}`);
  };
  w.eval(clientScript); w.eval(script);
  const element = (id: string) => w.document.getElementById(id)!;
  const choose = (id: string, value: string) => { (element(id) as HTMLSelectElement).value = value; element(id).dispatchEvent(new w.Event("change", { bubbles: true })); };
  await expect.poll(()=>element("planning-panel").classList.contains("hidden")).toBe(false);
  return { w, element, choose, submitted, copied, completeLate: () => resolveLate(Response.json({ models: [{ id: "late-codex", label: "Late Codex" }], customAllowed: true })) };
}

it("opens webpage planning settings and copies execution configuration without registering a local request", async () => {
  const h = await page(); h.element("new-task").click();
  expect(h.element("planning-panel").classList.contains("hidden")).toBe(true);
  expect(h.element("new-planning").classList.contains("hidden")).toBe(false);
  expect(h.element("local-request-wrap").classList.contains("hidden")).toBe(true);
  expect(h.element("start-planning").classList.contains("hidden")).toBe(true);
  expect(h.w.sessionStorage.getItem("tc-planning-workspace")).toBeNull();
  await expect.poll(()=>Array.from((h.element("runner-model-choice") as HTMLSelectElement).options).some(o=>o.value==="gpt-test-fast")).toBe(true);
  h.choose("runner-model-choice", "gpt-test-fast"); h.element("copy-web-planning").click();
  await expect.poll(()=>h.copied.length).toBe(1);
  expect(h.copied[0]).toContain('"runnerId":"codex"'); expect(h.copied[0]).toContain('"modelId":"gpt-test-fast"');
  expect(h.copied[0]).toContain("repo_read"); expect(h.copied[0]).toContain("external_submit");
  expect(h.copied[0]).toContain("由本机 Runner 后续执行");
  expect(h.copied[0]).toContain("工具不可用、授权失败或连接中断时说明阻断原因");
  expect(h.copied[0]).toContain("文字回复或下载附件不能代替提交");
  expect(h.submitted).toHaveLength(0);
});

it("preserves custom model IDs per Runner and submits the selected Planner model", async () => {
  const h = await page({ reactModelSelectors: true }); h.element("new-task-sidebar").click();
  h.choose("runner-model-choice", "__custom__");
  (h.element("runner-model") as HTMLInputElement).value = "private-model";
  h.element("runner-model").dispatchEvent(new h.w.Event("change"));
  h.choose("runner-id", "claude-code");
  await expect.poll(()=>Array.from((h.element("runner-model-choice") as HTMLSelectElement).options).some(o=>o.value==="claude-code-fast")).toBe(true);
  h.choose("runner-model-choice", "claude-code-fast");
  h.choose("runner-id", "codex");
  await expect.poll(()=>(h.element("runner-model") as HTMLInputElement).value).toBe("private-model");
  expect((h.element("runner-model-choice") as HTMLSelectElement).value).toBe("__custom__");
  h.choose("planner-provider", "deepseek-api");
  expect(h.element("local-request-wrap").classList.contains("hidden")).toBe(false);
  expect(h.element("web-planning-guide").classList.contains("hidden")).toBe(true);
  await expect.poll(()=>Array.from((h.element("planner-model-choice") as HTMLSelectElement).options).some(o=>o.value==="deepseek-pro")).toBe(true);
  h.choose("planner-model-choice", "deepseek-pro");
  (h.element("request-text") as HTMLTextAreaElement).value = "另一个需求"; h.element("start-planning").click();
  await expect.poll(()=>h.submitted.length).toBe(1);
  expect(h.submitted[0]?.model).toBe("deepseek-pro"); expect(h.submitted[0]?.executionDefaults).toMatchObject({ modelId: "private-model" });
});

it("does not replace a newly selected Runner with a late model response", async () => {
  const h = await page({ lateCodex: true });
  h.choose("runner-id", "claude-code");
  await expect.poll(()=>Array.from((h.element("runner-model-choice") as HTMLSelectElement).options).some(o=>o.value==="claude-code-fast")).toBe(true);
  h.choose("runner-model-choice", "claude-code-fast"); h.completeLate();
  await new Promise(resolve=>setTimeout(resolve,20));
  expect((h.element("runner-model-choice") as HTMLSelectElement).value).toBe("claude-code-fast");
  expect((h.element("runner-model") as HTMLInputElement).value).toBe("claude-code-fast");
});

it("uses the React model selector for the reviewer model catalog", async () => {
  const h = await page({ reactModelSelectors: true });
  h.choose("reviewer-mode", "deepseek-api");
  await expect.poll(() => Array.from((h.element("reviewer-model-choice") as HTMLSelectElement).options).some(option => option.value === "deepseek-pro")).toBe(true);
  h.choose("reviewer-model-choice", "deepseek-pro");
  expect((h.element("reviewer-model") as HTMLInputElement).value).toBe("deepseek-pro");
});

it("routes reviewer-mode changes through the React selector and persists the selected method", async () => {
  const h = await page({ reactReviewerMode: true });
  expect((h.element("reviewer-mode") as HTMLSelectElement).options).toHaveLength(6);
  h.choose("reviewer-mode", "deepseek-api");
  await expect.poll(() => h.w.localStorage.getItem("tc-reviewer-mode")).toBe("deepseek-api");
  await expect.poll(() => h.element("reviewer-mode-hint").textContent).toContain("DeepSeek Planner API");
});
