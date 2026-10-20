// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptDiagnosisExportModel } from "../src/api-client-contracts.js";
import { AttemptDiagnosisExport } from "../src/attempt-diagnosis-export-ui.js";

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

const model: AttemptDiagnosisExportModel = { status: "正在保存证据…", path: "", copyLabel: "复制分析提示", copyDisabled: true };

it("renders export progress, path, and copy availability as safe text", () => {
  const onClose = vi.fn(), onCopy = vi.fn(), onSwitch = vi.fn();
  const mounted = mount(createElement(AttemptDiagnosisExport, { model: { ...model, status: "已保存", path: "/workspace/.scratch/<diagnosis>.md", copyDisabled: false }, onClose, onCopy, onSwitch }));
  expect(mounted.querySelector("#diagnosis-export-status")?.textContent).toBe("已保存");
  expect(mounted.querySelector<HTMLInputElement>("#diagnosis-export-path")?.value).toBe("/workspace/.scratch/<diagnosis>.md");
  expect(mounted.querySelector("script,img")).toBeNull();
  mounted.querySelector<HTMLButtonElement>("[data-diagnosis-close]")!.click();
  mounted.querySelector<HTMLButtonElement>("#diagnosis-export-copy")!.click();
  mounted.querySelector<HTMLButtonElement>('button:not([data-diagnosis-close])')!.click();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onCopy).toHaveBeenCalledOnce();
  expect(onSwitch).toHaveBeenCalledOnce();
});

it("keeps the copy action disabled while evidence is being written", () => {
  const mounted = mount(createElement(AttemptDiagnosisExport, { model, onClose: vi.fn(), onCopy: vi.fn(), onSwitch: vi.fn() }));
  expect(mounted.querySelector<HTMLButtonElement>("#diagnosis-export-copy")?.disabled).toBe(true);
});
