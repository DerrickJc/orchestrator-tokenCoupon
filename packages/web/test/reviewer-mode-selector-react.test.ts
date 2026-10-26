// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewerModeSelectorModel } from "../src/api-client-contracts.js";
import { ReviewerModeSelector } from "../src/reviewer-mode-selector-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: ReviewerModeSelectorModel, onChange = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(ReviewerModeSelector, { model, onChange })));
  return { host, root, onChange };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

it("renders review methods and returns the selected mode", () => {
  const { host, onChange } = mount({ options: [{ id: "planning", label: "沿用规划方式" }, { id: "codex-agent", label: "Codex 本机 Agent" }, { id: "web-claude", label: "Claude 网页 MCP" }], selectedMode: "planning" });
  const select = host.querySelector<HTMLSelectElement>("#reviewer-mode")!;
  expect(select.options).toHaveLength(3);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(select.ownerDocument.defaultView!.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "web-claude"); select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("web-claude");
});

it("syncs when the application policy changes the review mode", () => {
  const model: ReviewerModeSelectorModel = { options: [{ id: "planning", label: "沿用规划方式" }, { id: "codex-agent", label: "Codex 本机 Agent" }], selectedMode: "planning" };
  const { host, root } = mount(model);
  act(() => root.render(createElement(ReviewerModeSelector, { model: { ...model, selectedMode: "codex-agent" }, onChange: vi.fn() })));
  expect(host.querySelector<HTMLSelectElement>("#reviewer-mode")?.value).toBe("codex-agent");
});
