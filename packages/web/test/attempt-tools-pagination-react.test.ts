// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptToolsPaginationModel } from "../src/api-client-contracts.js";
import { AttemptToolsPagination } from "../src/attempt-tools-pagination-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: AttemptToolsPaginationModel, onPrevious = vi.fn(), onNext = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptToolsPagination, { model, onPrevious, onNext })));
  return { host, onPrevious, onNext };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders the activity page and disables navigation at its boundaries", () => {
  const { host } = mount({ pageLabel: "第 2 / 3 页 · 已加载 34 条", previousDisabled: false, nextDisabled: false });
  expect(host.querySelector("#attempt-tools-page")?.textContent).toBe("第 2 / 3 页 · 已加载 34 条");
  expect(host.querySelector<HTMLButtonElement>("#attempt-tools-prev")?.disabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>("#attempt-tools-next")?.disabled).toBe(false);
  act(() => root?.render(createElement(AttemptToolsPagination, { model: { pageLabel: "第 1 / 1 页 · 已加载 0 条", previousDisabled: true, nextDisabled: true }, onPrevious: () => undefined, onNext: () => undefined })));
  expect(host.querySelector<HTMLButtonElement>("#attempt-tools-prev")?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>("#attempt-tools-next")?.disabled).toBe(true);
});

it("routes previous and next actions to the application", () => {
  const { host, onPrevious, onNext } = mount({ pageLabel: "第 1 / 2 页", previousDisabled: false, nextDisabled: false });
  act(() => host.querySelector<HTMLButtonElement>("#attempt-tools-prev")!.click());
  act(() => host.querySelector<HTMLButtonElement>("#attempt-tools-next")!.click());
  expect(onPrevious).toHaveBeenCalledOnce();
  expect(onNext).toHaveBeenCalledOnce();
});
