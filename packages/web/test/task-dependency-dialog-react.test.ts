// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { TaskDependencyDialog } from "../src/task-dependency-dialog-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders the full DAG dialog controls and its native DOM integration points", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root?.render(createElement(TaskDependencyDialog)));

  for (const id of ["dag-title", "dag-close", "dag-zoom-out", "dag-zoom-value", "dag-zoom-in", "dag-fit", "dag-reset", "dag-current", "dag-focus", "dag-expand", "dag-collapse", "dag-scope", "dag-viewport"]) {
    expect(host.querySelector(`#${id}`)).not.toBeNull();
  }
  expect(host.querySelector(".dag-legend")?.textContent).toContain("前置任务 → 当前任务");
  expect(host.querySelector(".dag-legend")?.textContent).toContain("运行中");
  expect(host.querySelector("#dag-viewport")?.getAttribute("tabindex")).toBe("0");
});
