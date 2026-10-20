// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { PendingApprovalOverviewModel } from "../src/api-client-contracts.js";
import { PendingApprovalOverview } from "../src/pending-approval-overview-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PendingApprovalOverviewModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PendingApprovalOverview, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders a compact empty-queue summary", () => {
  const mounted = mount({ count: 0, summary: "当前没有待处理请求。" });
  expect(mounted.querySelector("#pending-approval-heading")?.textContent).toContain("需要你的决定");
  expect(mounted.querySelector("#pending-approval-count")?.textContent).toBe("0 项");
  expect(mounted.querySelector("#pending-approval-summary")?.textContent).toBe("当前没有待处理请求。");
});

it("summarizes mixed pending requests without changing their decision forms", () => {
  const mounted = mount({ count: 3, summary: "1 项任务提问、1 项工具审批、1 项表单／网页确认，请分别处理。" });
  expect(mounted.querySelector("#pending-approval-count")?.textContent).toBe("3 项");
  expect(mounted.querySelector("#pending-approval-summary")?.textContent).toContain("工具审批");
});
