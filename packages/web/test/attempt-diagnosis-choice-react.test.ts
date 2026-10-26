// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptDiagnosisChoice } from "../src/attempt-diagnosis-choice-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

function mount(element: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(() => element)));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders both diagnosis routes and sends the selected action", () => {
  const onClose = vi.fn(), onLocal = vi.fn(), onWeb = vi.fn();
  const mounted = mount(createElement(AttemptDiagnosisChoice, { onClose, onLocal, onWeb }));

  expect(mounted.textContent).toContain("在此页面分析");
  expect(mounted.textContent).toContain("复制提示到网页分析");
  mounted.querySelector<HTMLButtonElement>("[data-diagnosis-close]")!.click();
  mounted.querySelector<HTMLButtonElement>("#diagnosis-local")!.click();
  mounted.querySelector<HTMLButtonElement>("#diagnosis-web")!.click();

  expect(onClose).toHaveBeenCalledOnce();
  expect(onLocal).toHaveBeenCalledOnce();
  expect(onWeb).toHaveBeenCalledOnce();
});
