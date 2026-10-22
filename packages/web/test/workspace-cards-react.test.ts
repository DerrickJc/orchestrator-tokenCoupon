// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { WorkspaceCards, WorkspaceNavigation } from "../src/workspace-cards-ui.js";

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

it("renders workspace cards with the selected project and delegates navigation", () => {
  const selected: string[] = [];
  mount(createElement(WorkspaceCards, {
    workspaces: [
      { workspaceId: "one", label: "课程项目", path: "/projects/course" },
      { workspaceId: "two", label: "教师项目", path: "/projects/teacher" },
    ],
    selectedWorkspaceId: "two",
    onSelect: workspaceId => selected.push(workspaceId),
  }));

  const cards = [...host!.querySelectorAll<HTMLButtonElement>(".project-card")];
  expect(cards).toHaveLength(2);
  expect(cards[1]?.getAttribute("aria-current")).toBe("true");
  expect(cards[1]?.textContent).toContain("/projects/teacher");
  act(() => cards[0]?.click());
  expect(selected).toEqual(["one"]);
});

it("shows the workspace onboarding empty state", () => {
  mount(createElement(WorkspaceCards, { workspaces: [], onSelect: () => undefined }));
  expect(host?.textContent).toBe("添加一个项目目录，或先完成上一步连接。");
});

it("renders the sidebar switcher with the same selected workspace", () => {
  mount(createElement(WorkspaceNavigation, {
    workspaces: [{ workspaceId: "project", label: "排课系统", path: "/projects/schedule" }],
    selectedWorkspaceId: "project",
    onSelect: () => undefined,
  }));
  const button = host!.querySelector<HTMLButtonElement>("button.workspace-item")!;
  expect(button.getAttribute("aria-current")).toBe("page");
  expect(button.textContent).toContain("排课系统");
});
