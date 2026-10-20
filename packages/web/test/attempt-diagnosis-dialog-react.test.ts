// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptDiagnosisDialog } from "../src/attempt-diagnosis-dialog-ui.js";

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

it("renders the diagnosis dialog shell with stable mounts and routes its header actions", () => {
  const onClose = vi.fn(), onSwitch = vi.fn();
  const mounted = mount(createElement(AttemptDiagnosisDialog, { onClose, onSwitch }));

  for (const id of ["attempt-diagnosis-context", "attempt-diagnosis-history-controls-root", "attempt-diagnosis-status", "attempt-diagnosis-history", "attempt-diagnosis-composer-root", "attempt-diagnosis-model-controls-root", "attempt-diagnosis-send"]) {
    expect(mounted.querySelector(`#${id}`)).not.toBeNull();
  }
  mounted.querySelector<HTMLButtonElement>('button:not([data-diagnosis-close])')!.click();
  mounted.querySelector<HTMLButtonElement>("[data-diagnosis-close]")!.click();

  expect(onSwitch).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
