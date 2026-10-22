// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionContinueModel } from "../src/api-client-contracts.js";
import { SessionContinueButton, SessionContinueInfo } from "../src/session-continue-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let buttonRoot: Root | undefined;
let infoRoot: Root | undefined;
let buttonHost: HTMLDivElement | undefined;
let infoHost: HTMLDivElement | undefined;

function mount(model: SessionContinueModel) {
  buttonHost = document.createElement("div"); infoHost = document.createElement("div");
  document.body.append(buttonHost, infoHost);
  buttonRoot = createRoot(buttonHost); infoRoot = createRoot(infoHost);
  act(() => {
    buttonRoot?.render(createElement(SessionContinueButton, { model }));
    infoRoot?.render(createElement(SessionContinueInfo, { model }));
  });
  return { buttonHost, infoHost };
}

afterEach(() => {
  if (buttonRoot) act(() => buttonRoot?.unmount());
  if (infoRoot) act(() => infoRoot?.unmount());
  buttonRoot = undefined; infoRoot = undefined;
  buttonHost?.remove(); infoHost?.remove();
  buttonHost = undefined; infoHost = undefined;
});

it("shows continue status, blocker actions, and keeps the confirmation flow behind a callback", () => {
  const onContinue = vi.fn(), onView = vi.fn(), onRevise = vi.fn();
  const model: SessionContinueModel = {
    label: "从断点继续执行",
    disabled: false,
    message: "等待用户决策：接口设计。",
    blockers: [{ taskId: "spec", label: "查看阻塞回复", onView }],
    onContinue,
    onRevise,
  };
  const mounted = mount(model);
  const button = mounted.buttonHost.querySelector<HTMLButtonElement>("#session-continue")!;
  expect(button.textContent).toBe("从断点继续执行");
  expect(mounted.infoHost.querySelector("#session-continue-hint")?.textContent).toContain("等待用户决策");
  mounted.infoHost.querySelector<HTMLButtonElement>("button")!.click();
  mounted.infoHost.querySelector<HTMLButtonElement>("button:last-child")!.click();
  button.click();
  expect(onView).toHaveBeenCalledOnce();
  expect(onRevise).toHaveBeenCalledOnce();
  expect(onContinue).toHaveBeenCalledOnce();
});

it("disables continue while the server is still processing", () => {
  const mounted = mount({ label: "从断点继续执行", disabled: true, message: "执行中或状态尚未核实。", blockers: [], onContinue: () => undefined, onRevise: () => undefined });
  expect(mounted.buttonHost.querySelector<HTMLButtonElement>("#session-continue")?.disabled).toBe(true);
  expect(mounted.infoHost.querySelector("#session-blocker-actions")?.classList.contains("hidden")).toBe(true);
});
