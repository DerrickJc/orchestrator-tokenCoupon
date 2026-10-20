// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanDraftEditorPlan } from "../src/api-client-contracts.js";
import { PlanDraftEditor } from "../src/plan-draft-editor-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const view = input.ownerDocument.defaultView!;
  const prototype = input.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

it("edits structured task fields locally, emits a plan patch, and preserves it while disabling controls", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const plan: PlanDraftEditorPlan = {
    title: "排课系统",
    tasks: [{ task: { id: "api", title: "接口", schemaVersion: 2, execution: { runnerId: "codex", modelId: "fast" }, objective: "列出接口", steps: ["设计接口"], deliverables: ["API 文档"], constraints: ["无前端"] }, dependsOn: [] }],
  };
  const onChange = vi.fn(); const model = { identity: "project:plan:hash-1", plan, disabled: false };
  act(() => root?.render(createElement(PlanDraftEditor, { model, onChange })));

  expect(host.textContent).toContain("任务 1 · api · 依赖 无 · Codex / fast");
  const objective = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input => input.parentElement?.textContent?.includes("需求目标"))!;
  setInputValue(objective, "明确课程查询接口与错误响应");
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ title: "排课系统", tasks: [expect.objectContaining({ task: expect.objectContaining({ objective: "明确课程查询接口与错误响应" }) })] }));
  expect(plan.tasks[0]!.task.objective).toBe("列出接口");

  const steps = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input => input.parentElement?.textContent?.includes("实施步骤"))!;
  setInputValue(steps, "定义请求字段\n覆盖成功和错误响应\n");
  expect(onChange.mock.lastCall?.[0].tasks[0].task.steps).toEqual(["定义请求字段", "覆盖成功和错误响应"]);
  expect(steps.value).toBe("定义请求字段\n覆盖成功和错误响应\n");
  setInputValue(steps, steps.value + " ");
  expect(steps.value).toBe("定义请求字段\n覆盖成功和错误响应\n ");
  setInputValue(steps, steps.value + "新增一项");
  expect(onChange.mock.lastCall?.[0].tasks[0].task.steps).toEqual(["定义请求字段", "覆盖成功和错误响应", "新增一项"]);

  act(() => root?.render(createElement(PlanDraftEditor, { model: { ...model, disabled: true }, onChange })));
  expect([...host.querySelectorAll("input,textarea")].every(input => (input as HTMLInputElement).disabled)).toBe(true);
  expect([...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input => input.parentElement?.textContent?.includes("需求目标"))!.value).toBe("明确课程查询接口与错误响应");
});

it("supports legacy prompt plans and removes an optional note when its text is cleared", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const plan: PlanDraftEditorPlan = { title: "计划兼容性", tasks: [
    { task: { id: "note", title: "说明", schemaVersion: 2, notes: "补充说明" }, dependsOn: [] },
    { task: { id: "impl", title: "实现", schemaVersion: 1, prompt: "旧版完整正文" }, dependsOn: ["spec"] },
  ] };
  const onChange = vi.fn();
  act(() => root?.render(createElement(PlanDraftEditor, { model: { identity: "legacy", plan, disabled: false }, onChange })));
  expect(host.textContent).toContain("任务 2 · impl · 依赖 spec · 未设置 Runner / 默认模型");
  expect([...host.querySelectorAll("textarea")].some(input => input.parentElement?.textContent?.includes("旧版正文"))).toBe(true);
  const notes = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input => input.parentElement?.textContent?.includes("其他说明"))!;
  setInputValue(notes, "   ");
  expect(onChange.mock.lastCall?.[0].tasks[0].task).not.toHaveProperty("notes");
  expect(onChange.mock.lastCall?.[0].tasks[1].task.prompt).toBe("旧版完整正文");
});
