// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingApprovalDecisionModel } from "../src/api-client-contracts.js";
import { PendingApprovalDecisionActions } from "../src/pending-approval-decision-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PendingApprovalDecisionModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PendingApprovalDecisionActions, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("shows explicit allow-once and deny actions and invokes only the chosen callback", () => {
  const onAllow = vi.fn(), onDeny = vi.fn();
  const mounted = mount({ onAllow, onDeny });
  const buttons = [...mounted.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map(button => button.textContent)).toEqual(["本次允许", "拒绝本次操作"]);
  expect(buttons.map(button => button.className)).toEqual(["button button-primary", "button button-quiet"]);
  act(() => buttons[1].click());
  expect(onDeny).toHaveBeenCalledOnce();
  expect(onAllow).not.toHaveBeenCalled();
});
