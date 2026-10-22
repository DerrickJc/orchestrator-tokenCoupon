// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskDependencyPreviewModel } from "../src/api-client-contracts.js";
import { TaskDependencyPreview } from "../src/task-dependency-preview-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: TaskDependencyPreviewModel | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(TaskDependencyPreview, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders the bounded DAG preview and transfers the existing SVG node", () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-label", "任务依赖图");
  const onOpen = vi.fn();
  const model = { taskCount: 7, focusLabel: "当前运行任务", shown: 5, svg, onOpen };
  const mounted = mount(model);
  expect(mounted.querySelector("h4")?.textContent).toBe("任务依赖 · 7 个任务");
  expect(mounted.querySelector(".dag-mini-map svg")).toBe(svg);
  expect(mounted.querySelector(".hint")?.textContent).toContain("当前运行任务");
  mounted.querySelector<HTMLButtonElement>(".task-dag-full")!.click();
  expect(onOpen).toHaveBeenCalledOnce();
  act(() => root?.render(createElement(TaskDependencyPreview, { model: null })));
  expect(mounted.querySelector("svg")).toBeNull();
});
