import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PendingApprovalTextBridge, PendingApprovalTextModel } from "./api-client-contracts.js";
import { PendingApprovalText } from "./pending-approval-text-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: PendingApprovalTextBridge = {
  render(mount: HTMLElement, model: PendingApprovalTextModel) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(PendingApprovalText, { model })));
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

globalThis.tokenCouponPendingApprovalText = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponPendingApprovalText;
  });
}
