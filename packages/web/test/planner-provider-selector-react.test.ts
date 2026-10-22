// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PlannerProviderSelectorModel } from "../src/api-client-contracts.js";
import { PlannerProviderSelector } from "../src/planner-provider-selector-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PlannerProviderSelectorModel, onChange = vi.fn()) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root?.render(createElement(PlannerProviderSelector, { model, onChange })));
  return { host, onChange };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined; host?.remove(); host = undefined;
});

const model: PlannerProviderSelectorModel = {
  standalone: [{ id: "web-mcp", label: "ChatGPT 网页 MCP", disabled: false }],
  localAgents: [
    { id: "codex-agent", label: "Codex 本机 Agent", disabled: false },
    { id: "claude-agent", label: "Claude Code 本机 Agent · 未连接", disabled: true },
  ],
  apiProviders: [{ id: "deepseek-api", label: "DeepSeek API", disabled: false }],
  selectedProviderId: "web-mcp",
};

it("preserves standalone providers, grouped choices, disabled availability and selection", () => {
  const { host } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#planner-provider")!;
  expect(select.value).toBe("web-mcp");
  expect([...select.querySelectorAll("optgroup")].map(group => group.label)).toEqual(["本机 Agent（只读规划／审查）", "模型 API / 离线演示"]);
  expect(select.querySelector<HTMLOptionElement>('option[value="claude-agent"]')?.disabled).toBe(true);
  expect(select.querySelector<HTMLOptionElement>('option[value="web-mcp"]')?.parentElement?.tagName).toBe("SELECT");
});

it("reports a new provider selection to the existing application flow", () => {
  const { host, onChange } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#planner-provider")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(select.ownerDocument.defaultView!.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "deepseek-api"); select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("deepseek-api");
});
