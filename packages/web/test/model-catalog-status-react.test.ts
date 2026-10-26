// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelCatalogStatus } from "../src/model-catalog-status-ui.js";

const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(kind: "planner" | "runner", message: string, loading = false) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(ModelCatalogStatus, { kind, model: { message, loading } })));
  return { host, root };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

it("renders planner directory feedback as an accessible live status", () => {
  const { host, root } = mount("planner", "4 个本机候选模型");
  expect(host.querySelector("#planner-model-hint")?.textContent).toBe("4 个本机候选模型");
  expect(host.querySelector("#planner-model-hint")?.getAttribute("aria-live")).toBe("polite");
  act(() => root.render(createElement(ModelCatalogStatus, { kind: "planner", model: { message: "读取失败，可自定义模型 ID。", loading: false } })));
  expect(host.querySelector("#planner-model-hint")?.textContent).toContain("读取失败");
});

it("disables refresh while reading and dispatches the application refresh event", () => {
  const refresh = vi.fn(); document.addEventListener("token-coupon:refresh-models", refresh);
  try {
    const { host, root } = mount("runner", "正在读取本机工具的模型目录…", true);
    const button = host.querySelector<HTMLButtonElement>("#refresh-models")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("正在读取");
    act(() => root.render(createElement(ModelCatalogStatus, { kind: "runner", model: { message: "3 个候选模型", loading: false } })));
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(refresh).toHaveBeenCalledOnce();
  } finally { document.removeEventListener("token-coupon:refresh-models", refresh); }
});
