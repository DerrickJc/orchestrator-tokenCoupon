// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { CommandPaletteUi, type PaletteRequest } from "../src/command-palette-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let dialog: HTMLDialogElement | undefined;
let host: HTMLDivElement | undefined;

function setup(request: PaletteRequest) {
  dialog = document.createElement("dialog");
  dialog.id = "command-palette";
  host = document.createElement("div");
  host.id = "command-palette-root";
  dialog.append(host);
  document.body.append(dialog);
  dialog.showModal = function () { this.setAttribute("open", ""); };
  dialog.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new (this.ownerDocument.defaultView!.Event)("close"));
  };
  root = createRoot(host);
  act(() => root?.render(createElement(CommandPaletteUi, { request })));
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  dialog?.remove();
  dialog = undefined;
  host = undefined;
});

it("opens the dialog, filters entries and selects with arrow keys and Enter", () => {
  const selected: string[] = [];
  setup({
    id: 1,
    entries: [
      { label: "连接中心", hint: "连接与网页授权", run: () => undefined },
      { label: "工作区与计划", hint: "选择或新建工作区", run: () => undefined },
    ],
    onSelect: entry => selected.push(entry.label),
  });

  expect(dialog?.open).toBe(true);
  const input = host!.querySelector<HTMLInputElement>("#command-palette-query")!;
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "工作区");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "工作区", inputType: "insertText" }));
  });
  expect([...host!.querySelectorAll('[role="option"]')].map(option => option.textContent)).toEqual(["工作区与计划选择或新建工作区"]);

  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(selected).toEqual(["工作区与计划"]);
  expect(dialog?.open).toBe(false);
});

it("shows a no-match state and closes on Escape", () => {
  setup({ id: 2, entries: [], onSelect: () => undefined });
  expect(host?.textContent).toContain("没有匹配的页面或操作。");
  expect(dialog?.open).toBe(true);

  act(() => dialog?.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
  expect(dialog?.open).toBe(false);
});
