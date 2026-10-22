import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { SystemPolicyRoutingBridge, SystemPolicyRoutingCallbacks, SystemPolicyRoutingModel } from "./api-client-contracts.js";
import { SystemPolicyRouting } from "./system-policy-routing-ui.js";

const roots = new Map<HTMLElement, Root>();
const bridge: SystemPolicyRoutingBridge = {
  render(mount: HTMLElement, model: SystemPolicyRoutingModel, callbacks: SystemPolicyRoutingCallbacks) {
    let root = roots.get(mount);
    if (!root) { root = createRoot(mount); roots.set(mount, root); }
    flushSync(() => root?.render(createElement(SystemPolicyRouting, { model, callbacks })));
  },
  unmount(mount: HTMLElement) {
    const root = roots.get(mount);
    if (!root) return;
    root.unmount(); roots.delete(mount);
  },
};

globalThis.tokenCouponSystemPolicyRouting = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponSystemPolicyRouting;
  });
}
