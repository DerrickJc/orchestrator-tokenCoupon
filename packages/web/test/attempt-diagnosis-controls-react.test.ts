// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptDiagnosisControlsModel } from "../src/api-client-contracts.js";
import { AttemptDiagnosisHistorySelect, AttemptDiagnosisModelSelectors } from "../src/attempt-diagnosis-controls-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

function mount(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  hosts.push(host); roots.push(root);
  act(() => root.render(createElement(() => element)));
  return host;
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  for (const host of hosts) host.remove();
  hosts = [];
});

const base: AttemptDiagnosisControlsModel = {
  diagnostics: [{ id: "d1", label: "诊断 1 · 已完成" }, { id: "d2", label: "诊断 2 · 失败" }],
  selectedDiagnosticId: "d2",
  runnerId: "claude-code",
  modelId: "__custom__",
  models: [{ id: "deepseek-flash", label: "DeepSeek Flash" }],
  customModelId: "deepseek-v4-flash",
  disabled: false,
};

it("renders history options and returns the selected diagnostic id", () => {
  const onChange = vi.fn();
  const mounted = mount(createElement(AttemptDiagnosisHistorySelect, { diagnostics: base.diagnostics, selectedId: "d2", disabled: false, onChange }));
  const select = mounted.querySelector<HTMLSelectElement>("#attempt-diagnosis-history-select")!;
  expect(select.value).toBe("d2");
  expect([...select.options].map(option => option.textContent)).toEqual(["诊断 1 · 已完成", "诊断 2 · 失败"]);
  act(() => { select.value = "d1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith("d1");
});

it("renders runner, catalog/custom model choices and disables controls while a request is pending", () => {
  const callbacks = { onRunnerChange: vi.fn(), onModelChange: vi.fn(), onCustomModelChange: vi.fn() };
  const mounted = mount(createElement(AttemptDiagnosisModelSelectors, { model: base, callbacks }));
  const runner = mounted.querySelector<HTMLSelectElement>("#attempt-diagnosis-runner")!;
  const model = mounted.querySelector<HTMLSelectElement>("#attempt-diagnosis-model")!;
  const custom = mounted.querySelector<HTMLInputElement>("#diagnosis-custom-model")!;
  expect(runner.value).toBe("claude-code");
  expect([...model.options].map(option => option.value)).toEqual(["", "deepseek-flash", "__custom__"]);
  expect(model.value).toBe("__custom__");
  expect(mounted.querySelector("#diagnosis-custom-wrap")?.classList.contains("hidden")).toBe(false);
  expect(custom.value).toBe("deepseek-v4-flash");
  act(() => { runner.value = "codex"; runner.dispatchEvent(new Event("change", { bubbles: true })); });
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => { setInputValue?.call(custom, "gpt-custom"); custom.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(callbacks.onRunnerChange).toHaveBeenCalledWith("codex");
  expect(callbacks.onCustomModelChange).toHaveBeenCalledWith("gpt-custom");

  const disabled = mount(createElement(AttemptDiagnosisModelSelectors, { model: { ...base, disabled: true }, callbacks }));
  expect(disabled.querySelector<HTMLSelectElement>("#attempt-diagnosis-runner")?.disabled).toBe(true);
  expect(disabled.querySelector<HTMLInputElement>("#diagnosis-custom-model")?.disabled).toBe(true);
});
