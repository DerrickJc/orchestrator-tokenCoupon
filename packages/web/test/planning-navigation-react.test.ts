// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { PlanningNavigationItem } from "../src/api-client-contracts.js";
import { PlanningCards, PlanningNavigation } from "../src/planning-navigation-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(element));
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const item: PlanningNavigationItem = {
  planningId: "planning-1",
  title: "排课后端规划",
  status: "待审查",
  statusTone: "badge-warning",
  createdAt: "2026-10-20T01:30:00.000Z",
  taskCount: 4,
  selected: true,
  workflowLabel: "网页规划已提交",
  toolsExpanded: false,
};

it("renders planning state, creation time and selected routing affordance", () => {
  mount(createElement(PlanningNavigation, {
    items: [item],
    activeTool: "models",
    onSelect: () => undefined,
    onOpenTool: () => undefined,
    onToolsToggle: () => undefined,
  }));
  const link = host!.querySelector<HTMLButtonElement>("button.workspace-item")!;
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.title).toContain("网页规划已提交");
  expect(link.textContent).toContain("待审查");
  expect(link.querySelector("time")?.dateTime).toBe("2026-10-20T01:30:00.000Z");
  expect(host!.querySelector('[data-plan-tool="models"]')?.getAttribute("aria-current")).toBe("page");
});

it("renders plan cards and delegates opening the selected plan", () => {
  const selected: string[] = [];
  mount(createElement(PlanningCards, { items: [item], onSelect: planningId => selected.push(planningId) }));
  const card = host!.querySelector<HTMLButtonElement>(".project-card")!;
  expect(card.getAttribute("aria-pressed")).toBe("true");
  expect(card.textContent).toContain("4 个任务");
  act(() => card.click());
  expect(selected).toEqual(["planning-1"]);
});

it("shows a helpful empty state when the workspace has no plans", () => {
  mount(createElement(PlanningCards, { items: [], onSelect: () => undefined }));
  expect(host?.textContent).toContain("还没有 Plan。");
});
