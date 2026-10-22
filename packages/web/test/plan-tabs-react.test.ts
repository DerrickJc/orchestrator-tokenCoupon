// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlanTabs } from "../src/plan-tabs-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(selectedTab: string, onSelect: (tab: string) => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PlanTabs, { selectedTab, onSelect })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("marks the route tab as current, including execution subpages", () => {
  const mounted = mount("attempts", () => undefined);
  expect(mounted.querySelectorAll("nav button")).toHaveLength(4);
  expect(mounted.querySelector<HTMLButtonElement>('[data-plan-tab="execution"]')?.getAttribute("aria-current")).toBe("page");
  expect(mounted.querySelector<HTMLButtonElement>('[data-plan-tab="review"]')?.getAttribute("aria-current")).toBe("false");
});

it("sends tab selection to the existing navigation callback", () => {
  const onSelect = vi.fn();
  const mounted = mount("overview", onSelect);
  mounted.querySelector<HTMLButtonElement>('[data-plan-tab="review"]')!.click();
  expect(onSelect).toHaveBeenCalledWith("review");
});
