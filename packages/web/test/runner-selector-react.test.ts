// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RunnerSelectorModel } from "../src/api-client-contracts.js";
import { RunnerSelector } from "../src/runner-selector-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: RunnerSelectorModel, onChange = vi.fn()) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root?.render(createElement(RunnerSelector, { model, onChange })));
  return { host, onChange };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined; host?.remove(); host = undefined;
});

const model: RunnerSelectorModel = {
  options: [
    { id: "codex", label: "Codex", disabled: false },
    { id: "claude-code", label: "Claude Code · 未就绪", disabled: true },
    { id: "mock", label: "离线模拟", disabled: false },
  ],
  selectedRunnerId: "codex",
};

it("preserves Runner availability labels, disabled state and selected value", () => {
  const { host } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#runner-id")!;
  expect(select.value).toBe("codex");
  expect(select.querySelector<HTMLOptionElement>('option[value="claude-code"]')?.disabled).toBe(true);
  expect(select.querySelector<HTMLOptionElement>('option[value="claude-code"]')?.textContent).toContain("未就绪");
});

it("routes Runner changes to the application model-catalog flow", () => {
  const { host, onChange } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#runner-id")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(select.ownerDocument.defaultView!.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "mock"); select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("mock");
});
