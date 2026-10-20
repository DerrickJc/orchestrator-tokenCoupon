// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { PlanDraftViewModel } from "../src/api-client-contracts.js";
import { PlanDraftView } from "../src/plan-draft-view-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: PlanDraftViewModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PlanDraftView, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const model: PlanDraftViewModel = {
  contextKey: "planning:draft-hash",
  tasks: [
    {
      taskId: "design",
      title: "接口与数据库设计",
      schemaLabel: "结构化任务",
      sections: [
        { label: "需求目标", value: "描述所需接口" },
        { label: "实施步骤", value: ["整理实体", "定义接口"] },
        { label: "约束", value: "不添加前端" },
      ],
      dependsOn: [],
      runnerLabel: "Codex",
      modelLabel: "gpt-6-luna",
    },
    {
      taskId: "test",
      title: "兼容 <img src=x onerror=alert(1)>",
      schemaLabel: "旧版正文",
      sections: [{ label: "任务正文", value: "验证 API" }],
      dependsOn: ["design"],
      runnerLabel: "Claude Code",
      modelLabel: "Runner 默认模型",
    },
  ],
};

it("renders structured and legacy plan fields, dependencies, and execution defaults", () => {
  mount(model);
  expect(host?.querySelectorAll("details.plan-card")).toHaveLength(2);
  expect(host?.querySelector(".plan-card .plan-field-preview")?.textContent).toContain("1. 整理实体\n2. 定义接口");
  expect(host?.querySelectorAll(".plan-field-preview section")).toHaveLength(4);
  expect(host?.querySelector(".task-meta")?.textContent).toContain("Codex / gpt-6-luna");
  expect(host?.querySelectorAll(".task-meta")[1]?.textContent).toContain("依赖：design · Claude Code / Runner 默认模型");
  expect(host?.querySelector("img")).toBeNull();
  expect(host?.textContent).toContain("兼容 <img src=x onerror=alert(1)>");
});

it("keeps a task foldout open across a refreshed model with stable task IDs", () => {
  const mounted = mount(model);
  const first = mounted.querySelector<HTMLDetailsElement>('[data-task-id="design"]')!;
  act(() => {
    first.open = true;
    first.dispatchEvent(new Event("toggle"));
  });
  act(() => root?.render(createElement(PlanDraftView, { model: { ...model, contextKey: "planning:new-view-state" } })));
  expect(mounted.querySelector<HTMLDetailsElement>('[data-task-id="design"]')?.open).toBe(true);
});

it("shows the appropriate empty state before a draft exists", () => {
  const mounted = mount({ contextKey: "planning:empty", emptyMessage: "等待网页生成草案", tasks: [] });
  expect(mounted.querySelector(".empty-state")?.textContent).toBe("等待网页生成草案");
  expect(mounted.querySelectorAll("details.plan-card")).toHaveLength(0);
});
