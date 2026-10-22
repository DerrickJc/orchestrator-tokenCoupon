// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DagTaskDetailsDialog } from "../src/dag-task-details-dialog-ui.js";

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

it("renders task sections as text and enables attempt navigation only when available", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onViewAttempt = vi.fn();
  const sections = [
    { label: "状态", value: "◉ 运行中" },
    { label: "前置任务", value: "接口设计\n数据库设计" },
    { label: "实施步骤", value: "1. 建立实体\n2. 增加接口" },
  ];
  act(() => root?.render(createElement(DagTaskDetailsDialog, { model: { sections, canOpenAttempt: false }, onViewAttempt })));

  expect(host.querySelectorAll("#dag-task-content section")).toHaveLength(3);
  expect(host.querySelector("#dag-task-content")?.textContent).toContain("2. 增加接口");
  const attempt = host.querySelector<HTMLButtonElement>("#dag-task-attempt")!;
  expect(attempt.disabled).toBe(true);
  act(() => root?.render(createElement(DagTaskDetailsDialog, { model: { sections, canOpenAttempt: true }, onViewAttempt })));
  expect(attempt.disabled).toBe(false);
  act(() => attempt.click());
  expect(onViewAttempt).toHaveBeenCalledOnce();
});
