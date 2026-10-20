import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PendingApprovalDecisionBridge, PendingApprovalDecisionModel } from "./api-client-contracts.js";
import { PendingApprovalDecisionActions } from "./pending-approval-decision-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: PendingApprovalDecisionBridge = {
  render(mount: HTMLElement, model: PendingApprovalDecisionModel) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(PendingApprovalDecisionActions, { model })));
  },
  unmountWithin(container: HTMLElement) {
    for (const [mount, root] of roots) {
      if (mount === container || container.contains(mount)) {
        root.unmount();
        roots.delete(mount);
      }
    }
  },
};

globalThis.tokenCouponPendingApprovalDecision = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponPendingApprovalDecision;
  });
}
