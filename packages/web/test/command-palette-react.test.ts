// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { PaletteResults } from "../src/command-palette-results.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders filtered palette options with selection state and delegates the chosen action", () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const selected: string[] = [];
  const entries = [
    { label: "计划 · 概览", hint: "查看当前计划", run: () => undefined },
    { label: "任务 2 · 接口测试", hint: "等待执行", run: () => undefined },
  ];

  act(() => root?.render(createElement(PaletteResults, { entries, selectedIndex: 1, onSelect: entry => selected.push(entry.label) })));

  const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map(option => option.textContent)).toEqual(["计划 · 概览查看当前计划", "任务 2 · 接口测试等待执行"]);
  expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  act(() => options[1]?.click());
  expect(selected).toEqual(["任务 2 · 接口测试"]);
});

it("shows a concise empty state when the query has no matching page or action", () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PaletteResults, { entries: [], selectedIndex: 0, onSelect: () => undefined })));
  expect(host.textContent).toBe("没有匹配的页面或操作。");
});
