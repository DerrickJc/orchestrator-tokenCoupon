// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GlobalPending, type GlobalPendingModel } from "../src/global-pending-ui.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
afterEach(() => { act(() => root.render(null)); });
function model(overrides: Partial<GlobalPendingModel> = {}): GlobalPendingModel {
  return { items: [{ requestId: "request", workspaceId: "project", workspaceLabel: "<script>project</script>", planningId: "plan", taskId: "design", runnerId: "codex", kind: "question", createdAt: "2026-10-21T01:00:00Z" }],
    total: 1, offset: 0, nextOffset: null, loading: false, error: null, authorizations: [], authorizationFresh: true,
    onOpen: vi.fn(), onAuthorization: vi.fn(), onPage: vi.fn(), ...overrides };
}
it("escapes labels and opens the owning request without an approval action", () => {
  const value = model(); act(() => root.render(createElement(GlobalPending, { model: value })));
  expect(host.querySelector("script")).toBeNull(); expect(host.textContent).toContain("<script>project</script>");
  const button = host.querySelector<HTMLButtonElement>(".global-pending-item")!; act(() => button.click());
  expect(value.onOpen).toHaveBeenCalledWith(value.items[0]); expect(button.textContent).toContain("模型提问 · design");
});
it("disables stale rows, exposes paging, and distinguishes unverified authorization from none", () => {
  const value = model({ total: 102, offset: 100, error: "读取失败", authorizationFresh: false });
  act(() => root.render(createElement(GlobalPending, { model: value })));
  expect(host.querySelector<HTMLButtonElement>(".global-pending-item")!.disabled).toBe(true);
  expect(host.textContent).toContain("授权状态尚未核实");
  const previous = [...host.querySelectorAll("button")].find(button => button.textContent === "上一页")!; act(() => previous.click());
  expect(value.onPage).toHaveBeenCalledWith(0);
});
it("routes web authorizations by request ID separately", () => {
  const value = model({ items: [], authorizations: [{ requestId: "oauth", label: "Claude demo1" }] });
  act(() => root.render(createElement(GlobalPending, { model: value })));
  act(() => host.querySelector<HTMLButtonElement>(".global-pending-item")!.click());
  expect(value.onAuthorization).toHaveBeenCalledWith("oauth"); expect(value.onOpen).not.toHaveBeenCalled();
});
