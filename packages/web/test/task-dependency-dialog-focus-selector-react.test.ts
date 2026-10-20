// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DagFocusSelector } from "../src/task-dependency-dialog-focus-selector-ui.js";

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

it("keeps DAG focus options and the selected task controlled by React", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onChange = vi.fn();
  const options = [
    { id: "design", label: "✓ 设计 · 已完成" },
    { id: "api", label: "◉ API · 运行中" },
  ];
  act(() => root?.render(createElement(DagFocusSelector, { options, selectedId: "api", onChange })));

  const select = host.querySelector<HTMLSelectElement>("#dag-focus")!;
  expect(select.value).toBe("api");
  expect([...select.options].map(option => option.textContent)).toEqual(options.map(option => option.label));
  select.value = "design";
  act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  expect(onChange).toHaveBeenCalledWith("design");

  act(() => root?.render(createElement(DagFocusSelector, { options: [...options, { id: "test", label: "○ 测试 · 未开始" }], selectedId: "test", onChange })));
  expect(select.value).toBe("test");
  expect(select.options).toHaveLength(3);
});
