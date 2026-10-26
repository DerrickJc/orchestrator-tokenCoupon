// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskBoardModel } from "../src/api-client-contracts.js";
import { TaskBoard } from "../src/task-board-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: TaskBoardModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(TaskBoard, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const task = (taskId: string, title: string, onRetry = () => undefined) => ({
  taskId,
  icon: "!",
  iconTone: "failed",
  title,
  runnerModel: "codex / gpt-6.1-sol",
  attemptSummary: "2 次 attempt",
  elapsed: " · 耗时 8 秒",
  activity: "任务已失败",
  resultSummary: "验证摘要",
  resultTruncated: true,
  dependencyLabel: "等待前置任务完成：",
  dependencies: [{ label: "接口设计（已完成）", tone: "badge-success" }],
  statusLabel: "任务失败",
  statusTone: "badge-error",
  outcome: "错误结论：任务失败",
  actions: [{ label: `重试 ${taskId}`, onClick: onRetry }],
});

it("renders grouped tasks, concise dependency state, and a bounded overflow list", () => {
  const mounted = mount({ groups: [
    { id: "completed", label: "已完成", tasks: [] },
    { id: "running", label: "运行中", tasks: [] },
    { id: "pending", label: "未开始 / 等待依赖", tasks: [task("a", "接口与数据库设计"), task("b", "后端实现"), task("c", "集成验证"), task("d", "交付材料")] },
    { id: "errors", label: "错误 / 中断", tasks: [] },
  ] });
  const pending = mounted.querySelector<HTMLElement>('[data-group="pending"]')!;
  expect(pending.querySelectorAll(":scope > .task-board-rows > .task-row")).toHaveLength(3);
  expect(pending.querySelectorAll(".task-board-extra > .task-row")).toHaveLength(1);
  expect(pending.querySelector(".task-board-count")?.textContent).toBe(" 4");
  expect(pending.querySelector(".task-dependency-chips")?.textContent).toContain("等待前置任务完成：接口设计（已完成）");
  expect(pending.querySelector(".task-outcome")?.textContent).toBe("错误结论：任务失败");
  expect(pending.querySelector(".task-row pre")?.textContent).toBe("验证摘要");
});

it("preserves task-card disclosure and routes task actions through callbacks", () => {
  const retry = vi.fn();
  const model: TaskBoardModel = { groups: [{ id: "errors", label: "错误 / 中断", tasks: [task("backend", "后端实现", retry)] }] };
  const mounted = mount(model);
  const result = mounted.querySelector<HTMLDetailsElement>(".task-row details")!;
  result.open = true;
  mounted.querySelector<HTMLButtonElement>(".task-row button")!.click();
  act(() => root?.render(createElement(TaskBoard, { model: { groups: [{ ...model.groups[0], tasks: [task("backend", "后端实现", retry)] }] } })));
  expect(mounted.querySelector<HTMLDetailsElement>(".task-row details")?.open).toBe(true);
  expect(retry).toHaveBeenCalledOnce();
});

it("renders the existing pre-run empty state", () => {
  const mounted = mount({ emptyMessage: "草案已批准，点击“运行计划”启动。", groups: [] });
  expect(mounted.querySelector(".empty-state")?.textContent).toContain("运行计划");
  expect(mounted.querySelector(".task-board")).toBeNull();
});
