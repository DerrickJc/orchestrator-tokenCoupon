// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingRunnerQuestionsModel } from "../src/api-client-contracts.js";
import { PendingRunnerQuestions } from "../src/pending-runner-questions-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PendingRunnerQuestionsModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PendingRunnerQuestions, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

function model(overrides: Partial<PendingRunnerQuestionsModel> = {}): PendingRunnerQuestionsModel {
  return {
    requestId: "runner-question",
    questions: [{ id: "scope", text: "选择测试范围", options: [{ id: "api", label: "HTTP API" }, { id: "unit", label: "单元测试" }] }],
    drafts: {},
    onSubmit: vi.fn(),
    ...overrides,
  };
}

it("requires an answer and submits only the selected single-choice option", () => {
  const onSubmit = vi.fn();
  const mounted = mount(model({ onSubmit }));
  const submit = mounted.querySelector<HTMLButtonElement>("button")!;
  expect(submit.disabled).toBe(true);
  const unit = mounted.querySelector<HTMLInputElement>('[data-option-id="unit"]')!;
  act(() => unit.click());
  expect(submit.disabled).toBe(false);
  act(() => submit.click());
  expect(onSubmit).toHaveBeenCalledWith([{ questionId: "scope", optionIds: ["unit"] }]);
});

it("preserves multiple selections, then replaces them with a custom answer", () => {
  const onSubmit = vi.fn();
  const mounted = mount(model({
    onSubmit,
    questions: [{ id: "scope", text: "选择测试范围", multiple: true, allowFreeText: true, options: [{ id: "api", label: "HTTP API" }, { id: "unit", label: "单元测试" }] }],
  }));
  const api = mounted.querySelector<HTMLInputElement>('[data-option-id="api"]')!;
  const unit = mounted.querySelector<HTMLInputElement>('[data-option-id="unit"]')!;
  act(() => { api.click(); unit.click(); });
  expect(api.checked).toBe(true);
  expect(unit.checked).toBe(true);
  const custom = mounted.querySelector<HTMLInputElement>('[id="interaction-custom:runner-question:scope"]')!;
  act(() => custom.click());
  expect(api.checked).toBe(false);
  expect(unit.checked).toBe(false);
  const answer = mounted.querySelector<HTMLInputElement>('[id="interaction-answer:runner-question:scope"]')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(answer, "只跑本地测试");
    answer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(mounted.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
  act(() => mounted.querySelector<HTMLButtonElement>("button")?.click());
  expect(onSubmit).toHaveBeenCalledWith([{ questionId: "scope", text: "只跑本地测试" }]);
});

it("restores selected options and text drafts after the interaction list is rebuilt", () => {
  const mounted = mount(model({
    questions: [{ id: "scope", text: "选择测试范围", allowFreeText: true, options: [{ id: "api", label: "HTTP API" }, { id: "unit", label: "单元测试" }] }],
    drafts: {
    "interaction-option:runner-question:scope:api": { value: "api", checked: true },
    "interaction-answer:runner-question:scope": { value: "备注", checked: false },
  } }));
  expect(mounted.querySelector<HTMLInputElement>('[data-option-id="api"]')?.checked).toBe(true);
  expect(mounted.querySelector<HTMLInputElement>('[id="interaction-answer:runner-question:scope"]')?.value).toBe("备注");
});
