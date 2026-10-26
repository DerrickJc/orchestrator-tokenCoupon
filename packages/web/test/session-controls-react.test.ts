// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionControlsModel } from "../src/api-client-contracts.js";
import { SessionControls } from "../src/session-controls-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: SessionControlsModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(SessionControls, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders distinct pause and cancel controls with pending-state labels", () => {
  const pause = vi.fn(), cancel = vi.fn();
  const mounted = mount({ buttons: [
    { label: "等待当前任务收尾…", className: "button button-session-pause", title: "停止继续派发任务。", disabled: true, onClick: pause },
    { label: "取消会话", className: "button button-session-cancel", disabled: false, onClick: cancel },
  ] });
  const buttons = [...mounted.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map(button => button.textContent)).toEqual(["等待当前任务收尾…", "取消会话"]);
  expect(buttons[0].disabled).toBe(true);
  expect(buttons[0].title).toContain("停止继续派发");
  buttons[1].click();
  expect(cancel).toHaveBeenCalledOnce();
  expect(pause).not.toHaveBeenCalled();
});

it("renders delivery only when the existing session model supplies that action", () => {
  const onClick = vi.fn();
  const mounted = mount({ buttons: [{ label: "生成交付报告", className: "button button-primary", disabled: true, onClick }] });
  const button = mounted.querySelector<HTMLButtonElement>("button")!;
  expect(button.className).toContain("button-primary");
  expect(button.disabled).toBe(true);
});
