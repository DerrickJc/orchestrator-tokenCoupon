// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ReviewViewModel } from "../src/api-client-contracts.js";
import { ReviewView } from "../src/review-view-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: ReviewViewModel, onChoiceChange: (id: string, choice: { choice: "accept" | "custom" | "defer"; custom: string }) => void, setErrors: (publish: (ids: string[]) => void) => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(ReviewView, { model, onChoiceChange, setErrors })));
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const model: ReviewViewModel = {
  contextKey: "workspace:planning:hash:review",
  summaryTitle: "有效审查 · draft-2",
  summaryText: "先补充 HTTP 回归测试。\n审查来源：Codex",
  isCurrent: true,
  findings: [{ findingId: "F1", severity: "warning", description: "测试场景不足", suggestion: "增加失败输入用例", basis: "验收未覆盖错误响应" }],
  canChoose: true,
  choices: { F1: { choice: "accept", custom: "" } },
  resolutions: [{ findingId: "F0", status: "resolved", basis: "已补充验证" }],
  history: ["draft-1 · 初次审查 · 1 个问题"],
};

it("renders review summary, findings, evidence and collapsed history", () => {
  mount(model, () => undefined, () => undefined);
  expect(host?.querySelector(".review-overview")?.textContent).toContain("有效审查 · draft-2");
  expect(host?.querySelector(".finding")?.textContent).toContain("增加失败输入用例");
  expect(host?.querySelector(".finding-basis")?.open).toBe(false);
  expect(host?.querySelector(".review-resolutions")?.open).toBe(false);
  expect(host?.querySelector("details.foldout")?.open).toBe(false);
});

it("keeps choice changes and custom revision text in the review callback", () => {
  const choices: unknown[] = [];
  mount(model, (findingId, choice) => choices.push({ findingId, ...choice }), () => undefined);
  const select = host!.querySelector<HTMLSelectElement>(".finding-choice select")!;
  act(() => {
    select.value = "custom";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host!.querySelector(".finding-choice textarea")).not.toBeNull();
  const textarea = host!.querySelector<HTMLTextAreaElement>(".finding-choice textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "补充 400 响应测试");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "补充 400 响应测试", inputType: "insertText" }));
  });
  expect(choices).toEqual([
    { findingId: "F1", choice: "custom", custom: "" },
    { findingId: "F1", choice: "custom", custom: "补充 400 响应测试" },
  ]);
});

it("shows inline validation when the parent rejects empty custom guidance", () => {
  let publishErrors: (ids: string[]) => void = () => undefined;
  mount(model, () => undefined, publish => { publishErrors = publish; });
  act(() => publishErrors(["F1"]));
  expect(host!.querySelector(".finding-choice .field-error")?.classList.contains("hidden")).toBe(false);
});
