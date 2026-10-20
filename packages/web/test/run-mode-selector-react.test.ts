// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RunModeSelectorModel } from "../src/api-client-contracts.js";
import { RunModeSelector } from "../src/run-mode-selector-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: RunModeSelectorModel, onChange = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(RunModeSelector, { model, onChange })));
  return { host, root, onChange };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

const options = [
  { id: "default" as const, title: "使用推荐默认值", description: "隔离执行、并发 1。" },
  { id: "custom" as const, title: "自定义本次启动参数", description: "设置隔离、并发和验证任务。" },
];

it("renders the two run modes as radio cards and reports the selected value", () => {
  const { host, onChange } = mount({ options, selectedMode: "default" });
  const radios = host.querySelectorAll<HTMLInputElement>('input[name="run-mode-choice"]');
  expect(radios).toHaveLength(2);
  expect(radios[0]?.checked).toBe(true);
  act(() => radios[1]!.click());
  expect(onChange).toHaveBeenCalledWith("custom");
  expect(radios[1]?.checked).toBe(true);
});

it("syncs a saved run mode supplied by the application", () => {
  const model: RunModeSelectorModel = { options, selectedMode: "" };
  const { host, root } = mount(model);
  act(() => root.render(createElement(RunModeSelector, { model: { ...model, selectedMode: "custom" }, onChange: vi.fn() })));
  expect(host.querySelector<HTMLInputElement>('input[name="run-mode-choice"][value="custom"]')?.checked).toBe(true);
});
