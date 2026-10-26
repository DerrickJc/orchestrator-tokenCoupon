// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSelectionControlsCallbacks, AgentSelectionControlsModel } from "../src/api-client-contracts.js";
import { AgentSelectionControls } from "../src/agent-selection-controls-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: AgentSelectionControlsModel, callbacks = {
  onRunnerChange: vi.fn(), onModelChoice: vi.fn(), onModelInput: vi.fn(), onRefresh: vi.fn(),
}) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(AgentSelectionControls, { model, callbacks })));
  return { host, root, callbacks };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

const model: AgentSelectionControlsModel = {
  runners: [{ id: "codex", label: "Codex", disabled: false }, { id: "claude-code", label: "Claude Code · 未就绪", disabled: true }],
  selectedRunnerId: "codex",
  modelChoices: [{ id: "", label: "沿用所选 Runner 的默认模型" }, { id: "gpt-6-luna", label: "gpt-6-luna" }, { id: "__custom__", label: "自定义模型 ID…" }],
  selectedModelChoice: "gpt-6-luna", modelId: "gpt-6-luna", showCustomModel: false, hint: "配置预览：Codex / gpt-6-luna",
};

it("renders runner and model choices and reports all interactions", () => {
  const { host, root, callbacks } = mount(model);
  const runner = host.querySelector<HTMLSelectElement>('[data-field="runner"]')!;
  expect([...runner.options].map(option => [option.value, option.disabled])).toEqual([["codex", false], ["claude-code", true]]);
  runner.value = "claude-code"; act(() => runner.dispatchEvent(new Event("change", { bubbles: true })));
  expect(callbacks.onRunnerChange).toHaveBeenCalledWith("claude-code");
  const choice = host.querySelector<HTMLSelectElement>('[data-field="model-choice"]')!;
  choice.value = "__custom__"; act(() => choice.dispatchEvent(new Event("change", { bubbles: true })));
  expect(callbacks.onModelChoice).toHaveBeenCalledWith("__custom__");
  act(() => root.render(createElement(AgentSelectionControls, { model: { ...model, selectedModelChoice: "__custom__", showCustomModel: true }, callbacks })));
  const input = host.querySelector<HTMLInputElement>('[data-field="model"]')!;
  expect(input.hidden).toBe(false);
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => { setInputValue?.call(input, "gpt-custom"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(callbacks.onModelInput).toHaveBeenCalledWith("gpt-custom");
  host.querySelector("button")!.click(); expect(callbacks.onRefresh).toHaveBeenCalledOnce();
});

it("shows custom model input and syncs changed catalog and selection", () => {
  const { host, root } = mount({ ...model, selectedModelChoice: "__custom__", modelId: "custom-model", showCustomModel: true });
  expect(host.querySelector<HTMLInputElement>('[data-field="model"]')?.hidden).toBe(false);
  const next = { ...model, selectedRunnerId: "claude-code", selectedModelChoice: "deepseek-flash", modelId: "deepseek-flash", modelChoices: [...model.modelChoices, { id: "deepseek-flash", label: "deepseek-flash" }], showCustomModel: false };
  act(() => root.render(createElement(AgentSelectionControls, { model: next, callbacks: { onRunnerChange: vi.fn(), onModelChoice: vi.fn(), onModelInput: vi.fn(), onRefresh: vi.fn() } satisfies AgentSelectionControlsCallbacks })));
  expect(host.querySelector<HTMLSelectElement>('[data-field="runner"]')?.value).toBe("claude-code");
  expect(host.querySelector<HTMLSelectElement>('[data-field="model-choice"]')?.value).toBe("deepseek-flash");
  expect(host.querySelector<HTMLInputElement>('[data-field="model"]')?.hidden).toBe(true);
});
