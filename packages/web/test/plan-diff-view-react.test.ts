// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { PlanDiffModel } from "../src/api-client-contracts.js";
import { PlanDiffView } from "../src/plan-diff-view-ui.js";

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

it("renders plan title, field, addition, and deletion changes in separate sections", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const model: PlanDiffModel = {
    titleChange: { from: "草案 A", to: "草案 B" },
    changed: [{ taskId: "api · v2", label: "验收标准" }],
    addedTasks: ["verify"],
    removedTasks: ["obsolete"],
  };
  act(() => root?.render(createElement(PlanDiffView, { model })));

  expect(host.textContent).toContain("修改 1 项 / 新增 1 项 / 删除 1 项");
  expect(host.querySelectorAll("section")).toHaveLength(4);
  expect(host.textContent).toContain("草案 A → 草案 B");
  expect(host.textContent).toContain("任务 api · v2 · 验收标准");
  expect(host.textContent).toContain("verify");
  expect(host.textContent).toContain("obsolete");
  expect(host.querySelector("#plan-diff-view script")).toBeNull();
});

it("shows a parse error as an accessible status instead of rendering partial diff data", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root?.render(createElement(PlanDiffView, { model: { changed: [], addedTasks: [], removedTasks: [], error: "unexpected token" } })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("unexpected token");
  expect(host.textContent).not.toContain("草案差异");
});
