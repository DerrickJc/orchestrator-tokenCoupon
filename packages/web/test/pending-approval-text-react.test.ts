// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { PendingApprovalTextModel } from "../src/api-client-contracts.js";
import { PendingApprovalText } from "../src/pending-approval-text-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PendingApprovalTextModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PendingApprovalText, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  sessionStorage.clear();
});

const model = (overrides: Partial<PendingApprovalTextModel> = {}): PendingApprovalTextModel => ({
  className: "approval-command",
  title: "待审批命令",
  text: "npm test\nnpm run build\ngit status",
  storageKey: "approval-1:command",
  maxLines: 2,
  maxChars: 30,
  code: true,
  ...overrides,
});

it("renders short approval text directly with its label and code styling", () => {
  const mounted = mount(model({ text: "npm test", maxLines: 3, maxChars: 50 }));
  expect(mounted.querySelector(".approval-field-label")?.textContent).toBe("待审批命令");
  expect(mounted.querySelector("pre.approval-command")?.textContent).toBe("npm test");
  expect(mounted.querySelector("details")).toBeNull();
});

it("folds long text, reveals the full command and remembers the choice", async () => {
  const mounted = mount(model());
  expect(mounted.querySelector("details")?.open).toBe(false);
  expect(mounted.querySelector(".approval-text-preview")?.textContent).toContain("其余内容已折叠");
  await act(async () => {
    mounted.querySelector("summary")?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(mounted.querySelector("details")?.open).toBe(true);
  expect(mounted.querySelector(".approval-text-full")?.textContent).toBe("npm test\nnpm run build\ngit status");
  expect(sessionStorage.getItem("tc-approval-fold:approval-1:command")).toBe("open");
});
