import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PendingElicitationBridge, PendingElicitationModel } from "./api-client-contracts.js";
import { PendingElicitation } from "./pending-elicitation-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: PendingElicitationBridge = {
  render(mount: HTMLElement, model: PendingElicitationModel) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(PendingElicitation, { model })));
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

globalThis.tokenCouponPendingElicitation = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponPendingElicitation;
  });
}
