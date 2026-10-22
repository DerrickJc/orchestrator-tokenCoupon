// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SystemPolicyRoutingCallbacks, SystemPolicyRoutingModel } from "../src/api-client-contracts.js";
import { SystemPolicyRouting } from "../src/system-policy-routing-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: SystemPolicyRoutingModel, callbacks: SystemPolicyRoutingCallbacks) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(SystemPolicyRouting, { model, callbacks })));
  return { host, root };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

it("reports priority and web-source changes and hides web choice for Agent priority", () => {
  const callbacks: SystemPolicyRoutingCallbacks = { onPriorityChange: vi.fn(), onWebSourceChange: vi.fn() };
  const { host, root } = mount({ priority: "web", webSource: "chatgpt" }, callbacks);
  const priority = host.querySelector<HTMLSelectElement>('[data-field="priority"]')!;
  const source = host.querySelector<HTMLSelectElement>('[data-field="web-source"]')!;
  expect(source.parentElement?.classList.contains("hidden")).toBe(false);
  act(() => { source.value = "claude"; source.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(callbacks.onWebSourceChange).toHaveBeenCalledWith("claude");
  act(() => { priority.value = "agent"; priority.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(callbacks.onPriorityChange).toHaveBeenCalledWith("agent");
  act(() => root.render(createElement(SystemPolicyRouting, { model: { priority: "agent", webSource: "claude" }, callbacks })));
  expect(source.parentElement?.classList.contains("hidden")).toBe(true);
});

it("syncs a saved priority and source when the application rerenders", () => {
  const callbacks: SystemPolicyRoutingCallbacks = { onPriorityChange: vi.fn(), onWebSourceChange: vi.fn() };
  const { host, root } = mount({ priority: "web", webSource: "chatgpt" }, callbacks);
  act(() => root.render(createElement(SystemPolicyRouting, { model: { priority: "agent", webSource: "claude" }, callbacks })));
  expect(host.querySelector<HTMLSelectElement>('[data-field="priority"]')?.value).toBe("agent");
  expect(host.querySelector<HTMLSelectElement>('[data-field="web-source"]')?.value).toBe("claude");
});
