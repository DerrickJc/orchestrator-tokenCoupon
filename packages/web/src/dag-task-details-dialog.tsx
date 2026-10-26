import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { DagTaskDetailsBridge, DagTaskDetailsModel } from "./api-client-contracts.js";
import { DagTaskDetailsDialog } from "./dag-task-details-dialog-ui.js";

const roots = new Map<HTMLElement, Root>();
const bridge: DagTaskDetailsBridge = {
  render(mount: HTMLElement, model: DagTaskDetailsModel, onViewAttempt: () => void) {
    let root = roots.get(mount);
    if (!root) { root = createRoot(mount); roots.set(mount, root); }
    flushSync(() => root?.render(createElement(DagTaskDetailsDialog, { model, onViewAttempt })));
  },
  unmount(mount: HTMLElement) {
    const root = roots.get(mount);
    if (!root) return;
    root.unmount(); roots.delete(mount);
  },
};

globalThis.tokenCouponDagTaskDetails = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponDagTaskDetails;
  });
}
