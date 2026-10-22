// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeModelControlsCallbacks, RuntimeModelControlsModel } from "../src/api-client-contracts.js";
import { RuntimeModelControls } from "../src/runtime-model-controls-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: RuntimeModelControlsModel, callbacks: RuntimeModelControlsCallbacks) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(RuntimeModelControls, { model, callbacks })));
  return { host, root };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

const model: RuntimeModelControlsModel = {
  tasks: [{ id: "build", label: "构建" }, { id: "verify", label: "验证" }],
  selectedTaskId: "build",
  models: [{ id: "", label: "沿用 Session 启动模型" }, { id: "gpt-6-luna", label: "GPT 6 Luna" }, { id: "__custom__", label: "自定义模型…" }],
  selectedModelId: "", customModelId: "",
};

it("renders task and model lists and reports selection changes", () => {
  const callbacks: RuntimeModelControlsCallbacks = { onTaskChange: vi.fn(), onModelChange: vi.fn(), onCustomModelChange: vi.fn() };
  const { host } = mount(model, callbacks);
  const task = host.querySelector<HTMLSelectElement>("#runtime-model-task")!;
  const choice = host.querySelector<HTMLSelectElement>("#runtime-model-choice")!;
  expect([...task.options].map(option => option.value)).toEqual(["build", "verify"]);
  expect([...choice.options].map(option => option.value)).toEqual(["", "gpt-6-luna", "__custom__"]);
  act(() => { task.value = "verify"; task.dispatchEvent(new Event("change", { bubbles: true })); });
  act(() => { choice.value = "gpt-6-luna"; choice.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(callbacks.onTaskChange).toHaveBeenCalledWith("verify");
  expect(callbacks.onModelChange).toHaveBeenCalledWith("gpt-6-luna");
});

it("shows and synchronizes the custom model field only for custom selection", () => {
  const callbacks: RuntimeModelControlsCallbacks = { onTaskChange: vi.fn(), onModelChange: vi.fn(), onCustomModelChange: vi.fn() };
  const { host, root } = mount(model, callbacks);
  expect(host.querySelector("#runtime-model-custom")?.parentElement?.classList.contains("hidden")).toBe(true);
  const custom = { ...model, selectedModelId: "__custom__", customModelId: "fast-local" };
  act(() => root.render(createElement(RuntimeModelControls, { model: custom, callbacks })));
  const input = host.querySelector<HTMLInputElement>("#runtime-model-custom")!;
  expect(input.parentElement?.classList.contains("hidden")).toBe(false); expect(input.value).toBe("fast-local");
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => { setInputValue?.call(input, "another-model"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(callbacks.onCustomModelChange).toHaveBeenCalledWith("another-model");
});
