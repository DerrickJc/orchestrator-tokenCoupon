import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PlanDiffBridge, PlanDiffModel } from "./api-client-contracts.js";
import { PlanDiffView } from "./plan-diff-view-ui.js";

const roots = new Map<HTMLElement, Root>();
const bridge: PlanDiffBridge = {
  render(mount: HTMLElement, model: PlanDiffModel) {
    let root = roots.get(mount);
    if (!root) { root = createRoot(mount); roots.set(mount, root); }
    flushSync(() => root?.render(createElement(PlanDiffView, { model })));
  },
  unmount(mount: HTMLElement) {
    const root = roots.get(mount);
    if (!root) return;
    root.unmount(); roots.delete(mount);
  },
};

globalThis.tokenCouponPlanDiff = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponPlanDiff;
  });
}
