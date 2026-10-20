// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptDiagnosisDialog } from "../src/attempt-diagnosis-dialog-ui.js";
import type { AttemptDiagnosisDialogModel } from "../src/api-client-contracts.js";

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
  const model: AttemptDiagnosisDialogModel = { contextText: "Attempt 123 · 只读分析", statusText: "输入问题并发送后开始分析。", sendLabel: "发送", sendDisabled: false };
  const mounted = mount(createElement(AttemptDiagnosisDialog, { model, onClose, onSwitch }));

  for (const id of ["attempt-diagnosis-context", "attempt-diagnosis-history-controls-root", "attempt-diagnosis-status", "attempt-diagnosis-history", "attempt-diagnosis-composer-root", "attempt-diagnosis-model-controls-root", "attempt-diagnosis-send"]) {
    expect(mounted.querySelector(`#${id}`)).not.toBeNull();
  }
  expect(mounted.querySelector("#attempt-diagnosis-context")?.textContent).toBe(model.contextText);
  expect(mounted.querySelector("#attempt-diagnosis-status")?.textContent).toBe(model.statusText);
  expect(mounted.querySelector<HTMLButtonElement>("#attempt-diagnosis-send")?.disabled).toBe(false);
  mounted.querySelector<HTMLButtonElement>('button:not([data-diagnosis-close])')!.click();
  mounted.querySelector<HTMLButtonElement>("[data-diagnosis-close]")!.click();

  expect(onSwitch).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();

  const nestedRoots = ["attempt-diagnosis-history-controls-root", "attempt-diagnosis-history", "attempt-diagnosis-composer-root", "attempt-diagnosis-model-controls-root"].map(id => {
    const slot = mounted.querySelector<HTMLElement>(`#${id}`)!, child = document.createElement("span"); slot.replaceChildren(child); return { slot, child };
  });
  const updated = { ...model, statusText: "正在分析…", sendLabel: "分析中…", sendDisabled: true };
  act(() => root?.render(createElement(AttemptDiagnosisDialog, { model: updated, onClose, onSwitch })));
  for (const { slot, child } of nestedRoots) expect(slot.firstChild).toBe(child);
  expect(mounted.querySelector("#attempt-diagnosis-status")?.textContent).toBe(updated.statusText);
  expect(mounted.querySelector<HTMLButtonElement>("#attempt-diagnosis-send")?.disabled).toBe(true);
  expect(mounted.querySelector<HTMLButtonElement>("#attempt-diagnosis-send")?.textContent).toBe(updated.sendLabel);
});
