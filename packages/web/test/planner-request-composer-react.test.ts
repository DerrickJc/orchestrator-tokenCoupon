// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SubmitTextarea } from "../src/planner-request-composer-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(onSubmit: () => void, onValueChange: (value: string) => void = () => undefined) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(SubmitTextarea, {
    id: "planner-request-input",
    rows: 4,
    maxLength: 8192,
    placeholder: "需求描述",
    ariaLabel: "需求描述",
    initialValue: "",
    onSubmit,
    onValueChange,
  })));
  return host.querySelector<HTMLTextAreaElement>("#planner-request-input")!;
}

function keyEnter(textarea: HTMLTextAreaElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
  act(() => textarea.dispatchEvent(event));
  return event;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("submits on Enter and leaves Shift+Enter available for a newline", () => {
  const submit = vi.fn();
  const textarea = mount(submit);
  expect(keyEnter(textarea).defaultPrevented).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(keyEnter(textarea, { shiftKey: true }).defaultPrevented).toBe(false);
  expect(submit).toHaveBeenCalledTimes(1);
});

it("does not submit during IME composition or immediately after candidate confirmation", () => {
  const submit = vi.fn();
  const textarea = mount(submit);
  act(() => textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  expect(keyEnter(textarea, { isComposing: true }).defaultPrevented).toBe(false);
  act(() => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(keyEnter(textarea).defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
});

it("mirrors multiline input to the existing request store without sending on paste", () => {
  const submit = vi.fn();
  const onValueChange = vi.fn();
  const textarea = mount(submit, onValueChange);
  const pastedText = "第一行需求\n第二行约束";
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, pastedText);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("paste", { bubbles: true }));
  });
  expect(onValueChange).toHaveBeenLastCalledWith(pastedText);
  expect(submit).not.toHaveBeenCalled();
});

it("does not submit when Enter is held as a repeating key", () => {
  const submit = vi.fn();
  const textarea = mount(submit);
  keyEnter(textarea, { repeat: true });
  expect(submit).not.toHaveBeenCalled();
});
