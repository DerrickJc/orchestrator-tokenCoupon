import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PendingInteractionGuidanceBridge, PendingInteractionGuidanceModel } from "./api-client-contracts.js";
import { PendingInteractionGuidance } from "./pending-interaction-guidance-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: PendingInteractionGuidanceBridge = {
  render(mount: HTMLElement, model: PendingInteractionGuidanceModel) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(PendingInteractionGuidance, { model })));
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

globalThis.tokenCouponPendingInteractionGuidance = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponPendingInteractionGuidance;
  });
}
