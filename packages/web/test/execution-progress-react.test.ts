// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ExecutionProgressModel } from "../src/api-client-contracts.js";
import { ExecutionProgress } from "../src/execution-progress-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: ExecutionProgressModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(ExecutionProgress, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders execution status, progress, and task metrics", () => {
  const mounted = mount({
    statusLabel: "等待用户决策",
    statusTone: "badge-warning",
    hasSession: true,
    completed: 2,
    total: 5,
    metrics: [
      { label: "成功", value: "2/5", kind: "completed" },
      { label: "运行中", value: 1, kind: "running" },
      { label: "等待回答／审批", value: 1, kind: "waiting" },
    ],
  });
  expect(mounted.querySelector(".execution-state")?.textContent).toBe("等待用户决策");
  expect(mounted.querySelector(".execution-state")?.classList.contains("badge-warning")).toBe(true);
  expect(mounted.querySelector("progress")?.value).toBe(2);
  expect(mounted.querySelector("progress")?.max).toBe(5);
  expect(mounted.querySelector('[data-kind="waiting"]')?.textContent).toBe("等待回答／审批 1");
});

it("keeps the empty-session state compact", () => {
  const mounted = mount({ statusLabel: "尚未启动 Session", statusTone: "badge-muted", hasSession: false, completed: 0, total: 0, metrics: [] });
  expect(mounted.querySelector(".execution-state")?.textContent).toBe("尚未启动 Session");
  expect(mounted.querySelector("progress")).toBeNull();
  expect(mounted.querySelector(".execution-metrics")).toBeNull();
});
