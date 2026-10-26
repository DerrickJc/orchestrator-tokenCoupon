import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { TaskResultsBridge, TaskResultsModel } from "./api-client-contracts.js";
import { TaskResultsDialogContent } from "./task-results-dialog-ui.js";

const roots = new Map<HTMLElement, Root>();
const bridge: TaskResultsBridge = {
  render(mount: HTMLElement, model: TaskResultsModel, callbacks) {
    let root = roots.get(mount);
    if (!root) { root = createRoot(mount); roots.set(mount, root); }
    flushSync(() => root?.render(createElement(TaskResultsDialogContent, { model, callbacks })));
  },
  unmount(mount: HTMLElement) {
    const root = roots.get(mount);
    if (!root) return;
    root.unmount(); roots.delete(mount);
  },
};

globalThis.tokenCouponTaskResults = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponTaskResults;
  });
}
