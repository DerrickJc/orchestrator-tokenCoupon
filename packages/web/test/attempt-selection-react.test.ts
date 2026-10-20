// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptSelectionModel } from "../src/api-client-contracts.js";
import { AttemptSelection } from "../src/attempt-selection-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: AttemptSelectionModel, onSelect = vi.fn(), onLatest = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptSelection, { model, onSelect, onLatest })));
  return { host, onSelect, onLatest };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const model: AttemptSelectionModel = {
  choices: [
    { attemptId: "older", label: "接口文档 · 第 1 次 · older" },
    { attemptId: "latest", label: "接口文档 · 第 2 次 · latest" },
  ],
  selectedAttemptId: "older",
  contextText: "历史执行记录 · 不是本次重试返回：接口文档 · 第 1 次 · older",
  historical: true,
  latestDisabled: false,
};

it("renders the selected Attempt and marks historical results", () => {
  const { host } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#attempt-select")!;
  expect(select.value).toBe("older");
  expect([...select.options].map(option => option.textContent)).toEqual(model.choices.map(choice => choice.label));
  expect(host.querySelector("#attempt-selection-context")?.textContent).toContain("不是本次重试返回");
  expect(host.querySelector("#attempt-selection-context")?.classList.contains("is-history")).toBe(true);
  expect(host.querySelector<HTMLButtonElement>("#attempt-show-latest")?.disabled).toBe(false);
});

it("routes historical selection and latest-attempt actions to application callbacks", () => {
  const { host, onSelect, onLatest } = mount(model);
  const select = host.querySelector<HTMLSelectElement>("#attempt-select")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(select.ownerDocument.defaultView!.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "latest");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => host.querySelector<HTMLButtonElement>("#attempt-show-latest")!.click());
  expect(onSelect).toHaveBeenCalledWith("latest");
  expect(onLatest).toHaveBeenCalledOnce();
});

it("disables latest selection when the current choice is already the latest", () => {
  const { host } = mount({ ...model, selectedAttemptId: "latest", historical: false, latestDisabled: true });
  expect(host.querySelector<HTMLButtonElement>("#attempt-show-latest")?.disabled).toBe(true);
  expect(host.querySelector("#attempt-selection-context")?.classList.contains("is-history")).toBe(false);
});
