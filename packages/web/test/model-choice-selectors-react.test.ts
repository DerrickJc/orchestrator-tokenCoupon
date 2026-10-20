// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelChoiceSelectorModel } from "../src/api-client-contracts.js";
import { ModelChoiceSelector } from "../src/model-choice-selectors-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(prefix: "planner" | "runner", model: ModelChoiceSelectorModel, onChange = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(ModelChoiceSelector, { prefix, model, onChange })));
  return { host, onChange };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

it("renders separate Planner and Runner selectors with catalog labels", () => {
  const planner = mount("planner", { choices: [{ id: "", label: "使用已配置模型" }, { id: "deepseek-fast", label: "快速模型 · deepseek-fast" }, { id: "__custom__", label: "自定义模型 ID…" }], selectedModelId: "deepseek-fast" });
  const runner = mount("runner", { choices: [{ id: "", label: "沿用 Runner 默认模型" }, { id: "codex-fast", label: "推荐 · codex-fast" }, { id: "__custom__", label: "自定义模型 ID…" }], selectedModelId: "__custom__" });
  expect(planner.host.querySelector<HTMLSelectElement>("#planner-model-choice")?.value).toBe("deepseek-fast");
  expect(planner.host.querySelector("#planner-model-choice")?.textContent).toContain("快速模型");
  expect(runner.host.querySelector<HTMLSelectElement>("#runner-model-choice")?.value).toBe("__custom__");
});

it("returns a selected model or the custom-model sentinel to the application", () => {
  const { host, onChange } = mount("runner", { choices: [{ id: "", label: "沿用默认" }, { id: "codex-fast", label: "codex-fast" }, { id: "__custom__", label: "自定义模型 ID…" }], selectedModelId: "" });
  const select = host.querySelector<HTMLSelectElement>("#runner-model-choice")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(select.ownerDocument.defaultView!.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "__custom__"); select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("__custom__");
});

it("syncs to a model selection changed by the application", () => {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  const choices = [{ id: "", label: "沿用默认" }, { id: "codex-fast", label: "codex-fast" }, { id: "codex-pro", label: "codex-pro" }];
  act(() => root.render(createElement(ModelChoiceSelector, { prefix: "runner", model: { choices, selectedModelId: "codex-fast" }, onChange: vi.fn() })));
  act(() => root.render(createElement(ModelChoiceSelector, { prefix: "runner", model: { choices, selectedModelId: "codex-pro" }, onChange: vi.fn() })));
  expect(host.querySelector<HTMLSelectElement>("#runner-model-choice")?.value).toBe("codex-pro");
});
