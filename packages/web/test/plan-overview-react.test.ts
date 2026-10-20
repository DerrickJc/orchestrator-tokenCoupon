// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanOverviewModel } from "../src/api-client-contracts.js";
import { PlanOverviewView } from "../src/plan-overview-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PlanOverviewModel, onPrimaryAction: () => void, onResume: () => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PlanOverviewView, { model, onPrimaryAction, onResume })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const model: PlanOverviewModel = {
  stage: "等待人工处理",
  stageTone: "badge-warning",
  nextAction: "批准工具请求后任务继续。",
  taskCount: 5,
  completedTaskCount: 2,
  reviewStatus: "有效",
  primaryActionLabel: "查看执行与结果",
  resumeDisabled: false,
};

it("renders plan state and compact metrics with accessible status labels", () => {
  const mounted = mount(model, () => undefined, () => undefined);
  expect(mounted.querySelector("#plan-stage")?.textContent).toBe("等待人工处理");
  expect(mounted.querySelector("#plan-next-action")?.textContent).toBe("批准工具请求后任务继续。");
  expect(mounted.querySelector("#plan-summary")?.textContent).toContain("5计划任务2执行完成有效审查报告");
  expect(mounted.querySelector<HTMLButtonElement>("#copy-plan-resume")?.disabled).toBe(false);
});

it("routes primary and webpage-resume actions through the existing callbacks", () => {
  const primary = vi.fn(), resume = vi.fn();
  const mounted = mount(model, primary, resume);
  mounted.querySelector<HTMLButtonElement>("#plan-primary-action")!.click();
  mounted.querySelector<HTMLButtonElement>("#copy-plan-resume")!.click();
  expect(primary).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledOnce();
});
