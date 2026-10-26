// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingElicitationModel } from "../src/api-client-contracts.js";
import { PendingElicitation } from "../src/pending-elicitation-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PendingElicitationModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PendingElicitation, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

it("validates and submits schema-driven values with the existing coercion rules", () => {
  const onSubmit = vi.fn();
  const mounted = mount({
    mode: "form", url: undefined, onAcceptUrl: vi.fn(), onSubmit, onDecline: vi.fn(), onCancel: vi.fn(),
    schema: { required: ["language", "workers", "enabled", "scopes"], properties: {
      language: { type: "string", title: "语言", enum: ["java", "node"], enumNames: ["Java", "Node.js"] },
      workers: { type: "integer", title: "并发", minimum: 1, maximum: 4, default: 2 },
      enabled: { type: "boolean", title: "启用", default: false },
      scopes: { type: "array", title: "权限", items: { enum: ["read", "write"] }, minItems: 1 },
    } },
  });
  const form = mounted.querySelector<HTMLFormElement>("form.elicitation-form")!;
  const language = form.querySelector<HTMLSelectElement>('[data-elicitation-field="language"]')!;
  const scopes = form.querySelector<HTMLSelectElement>('[data-elicitation-field="scopes"]')!;
  expect(language.required).toBe(true);
  expect(scopes.multiple).toBe(true);
  act(() => {
    setValue(language, "node");
    scopes.options[0]!.selected = true;
    scopes.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onSubmit).toHaveBeenCalledWith({ language: "node", workers: 2, enabled: false, scopes: ["read"] });
});

it("keeps URL elicitation explicit and provides decline and cancel actions", () => {
  const onAcceptUrl = vi.fn(), onDecline = vi.fn(), onCancel = vi.fn();
  const mounted = mount({ mode: "url", url: "https://login.example.test/authorize", onAcceptUrl, onSubmit: vi.fn(), onDecline, onCancel });
  const link = mounted.querySelector<HTMLAnchorElement>("a")!;
  expect(mounted.querySelector(".elicitation-destination")?.textContent).toBe("授权或确认页面：login.example.test");
  expect(link.target).toBe("_blank");
  expect(link.rel).toContain("noopener");
  const buttons = [...mounted.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map(button => button.textContent)).toEqual(["已完成，继续执行", "拒绝", "取消此请求"]);
  act(() => buttons[0]?.click());
  act(() => buttons[1]?.click());
  act(() => buttons[2]?.click());
  expect(onAcceptUrl).toHaveBeenCalledOnce();
  expect(onDecline).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
});

it("renders a safe unsupported-schema explanation instead of a submit action", () => {
  const mounted = mount({ mode: "unsupported", onAcceptUrl: vi.fn(), onSubmit: vi.fn(), onDecline: vi.fn(), onCancel: vi.fn() });
  expect(mounted.textContent).toContain("当前表单格式不受支持");
  expect(mounted.querySelector("button")).toBeNull();
});
