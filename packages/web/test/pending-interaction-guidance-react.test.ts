// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingInteractionGuidanceModel } from "../src/api-client-contracts.js";
import { PendingInteractionGuidance } from "../src/pending-interaction-guidance-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PendingInteractionGuidanceModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PendingInteractionGuidance, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("opens the optional guidance editor, rejects empty input and focuses the editor", () => {
  const onInvalid = vi.fn();
  const mounted = mount({ kind: "approval", onSubmit: vi.fn(), onInvalid });
  const toggle = mounted.querySelector<HTMLButtonElement>(".interaction-no")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const textarea = mounted.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(textarea.maxLength).toBe(4096);
  expect(document.activeElement).toBe(textarea);
  act(() => mounted.querySelector<HTMLButtonElement>(".button-primary")?.click());
  expect(onInvalid).toHaveBeenCalledOnce();
});

it("submits trimmed guidance and keeps the text when the editor is closed and reopened", () => {
  const onSubmit = vi.fn();
  const mounted = mount({ kind: "elicitation", onSubmit, onInvalid: vi.fn() });
  const toggle = mounted.querySelector<HTMLButtonElement>(".interaction-no")!;
  act(() => toggle.click());
  const textarea = mounted.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "  仅允许本地操作  ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(mounted.textContent).toContain("当前 MCP 请求会被拒绝");
  act(() => mounted.querySelector<HTMLButtonElement>(".button-row .button-quiet")?.click());
  expect(mounted.querySelector(".guidance-editor")?.className).toContain("hidden");
  act(() => toggle.click());
  expect(textarea.value).toBe("  仅允许本地操作  ");
  act(() => mounted.querySelector<HTMLButtonElement>(".button-primary")?.click());
  expect(onSubmit).toHaveBeenCalledWith("仅允许本地操作");
});
