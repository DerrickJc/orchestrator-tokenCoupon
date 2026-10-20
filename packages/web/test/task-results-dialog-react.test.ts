// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskResultsModel } from "../src/api-client-contracts.js";
import { TaskResultsDialogContent } from "../src/task-results-dialog-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
const files = Array.from({ length: 4 }, (_, index) => ({ path: `docs/file-${index}.md`, absolutePath: `/run/docs/file-${index}.md` }));
const baseModel: TaskResultsModel = {
  summary: "发现 4 个文件\n执行目录：/run\n已显示 4/4 个文件",
  files,
  total: 4,
  hasMore: true,
  loadingMore: false,
  preview: null,
  error: "",
};

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders bounded file results, delegates actions, and displays preview text safely", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onPreview = vi.fn(), onCopyPath = vi.fn(), onLoadMore = vi.fn();
  const callbacks = { onPreview, onCopyPath, onLoadMore };
  act(() => root?.render(createElement(TaskResultsDialogContent, { model: baseModel, callbacks })));

  expect(host.querySelector("#task-results-summary")?.textContent).toContain("4/4 个文件");
  expect(host.querySelectorAll("#task-results-files > article")).toHaveLength(3);
  const overflow = host.querySelector<HTMLDetailsElement>("#task-results-files details")!;
  expect(overflow.open).toBe(false);
  expect(overflow.textContent).toContain("展开其余 1 个文件");
  host.querySelector<HTMLButtonElement>('button')!.click();
  expect(onPreview).toHaveBeenCalledWith("docs/file-0.md");
  host.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
  expect(onCopyPath).toHaveBeenCalledWith(files[0]);
  host.querySelector<HTMLButtonElement>("#task-results-more")!.click();
  expect(onLoadMore).toHaveBeenCalledOnce();

  const previewModel = { ...baseModel, hasMore: false, loadingMore: true, preview: { absolutePath: "/run/docs/file-0.md", content: "<img src=x onerror=alert(1)>" }, error: "读取时发生提示" };
  act(() => root?.render(createElement(TaskResultsDialogContent, { model: previewModel, callbacks })));
  expect(host.querySelector("#task-results-more")?.classList.contains("hidden")).toBe(true);
  expect((host.querySelector("#task-results-more") as HTMLButtonElement).disabled).toBe(true);
  expect(host.querySelector("#task-results-path")?.textContent).toBe("/run/docs/file-0.md");
  expect(host.querySelector("#task-results-preview")?.textContent).toContain("<img");
  expect(host.querySelector("#task-results-preview img")).toBeNull();
  expect(host.querySelector("#task-results-error")?.textContent).toBe("读取时发生提示");
});
