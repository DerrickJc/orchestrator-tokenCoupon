// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RunAgentModeModel } from "../src/api-client-contracts.js";
import { RunAgentModeSelector } from "../src/run-agent-mode-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: RunAgentModeModel, onChange = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(RunAgentModeSelector, { model, onChange })));
  return { host, root, onChange };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

const model: RunAgentModeModel = { selectedMode: "plan", options: [
  { id: "plan", label: "沿用已批准草案", disabled: false },
  { id: "unified", label: "统一配置所有任务", disabled: false },
  { id: "per-task", label: "逐任务单独配置", disabled: true },
] };

it("renders the supported launch configuration modes and reports changes", () => {
  const { host, onChange } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#run-agent-mode")!;
  expect([...select.options].map(option => [option.value, option.disabled])).toEqual([
    ["plan", false], ["unified", false], ["per-task", true],
  ]);
  select.value = "unified";
  act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  expect(onChange).toHaveBeenCalledWith("unified");
});

it("syncs the mode and backend capability changes", () => {
  const { host, root } = mount(model);
  const next: RunAgentModeModel = { ...model, selectedMode: "per-task", options: model.options.map(option => ({ ...option, disabled: false })) };
  act(() => root.render(createElement(RunAgentModeSelector, { model: next, onChange: vi.fn() })));
  const select = host.querySelector<HTMLSelectElement>("#run-agent-mode")!;
  expect(select.value).toBe("per-task"); expect(select.options[2]?.disabled).toBe(false);
});
