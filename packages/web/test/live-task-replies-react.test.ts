// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveTaskRepliesModel } from "../src/api-client-contracts.js";
import { LiveTaskReplies } from "../src/live-task-replies-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: LiveTaskRepliesModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(LiveTaskReplies, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders recent replies as text and keeps additional results folded", () => {
  const mounted = mount({
    visible: [1, 2, 3].map(index => ({ attemptId: `a${index}`, heading: `任务 ${index}`, reply: index === 1 ? "<script>unsafe</script>" : `回复 ${index}`, activity: "已完成", showDiagnosis: false, onDiagnose: () => undefined })),
    overflow: [{ attemptId: "old", heading: "历史任务 · 旧任务", reply: "旧回复", activity: "已结束", showDiagnosis: false, onDiagnose: () => undefined }],
    overflowLabel: "其他任务与历史返回（1 项，不代表本次重试）",
  });
  expect(mounted.querySelectorAll(".live-task-reply")).toHaveLength(4);
  expect(mounted.querySelector("script")).toBeNull();
  expect(mounted.textContent).toContain("<script>unsafe</script>");
  expect(mounted.querySelector("details")?.open).toBe(false);
  expect(mounted.querySelector("summary")?.textContent).toContain("历史返回");
});

it("routes failure diagnosis through the existing action callback", () => {
  const diagnose = vi.fn();
  const mounted = mount({
    visible: [{ attemptId: "failed-1", heading: "构建 · 失败 · codex", reply: "模型返回：构建失败", activity: "本次任务执行已结束", error: "中断／错误原因：退出码 1", showDiagnosis: true, onDiagnose: diagnose }],
    overflow: [],
    overflowLabel: "",
  });
  expect(mounted.querySelector(".reply-error")?.textContent).toContain("退出码 1");
  mounted.querySelector<HTMLButtonElement>("button")!.click();
  expect(diagnose).toHaveBeenCalledOnce();
});
