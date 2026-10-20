import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptDiagnosisChoiceBridge } from "./api-client-contracts.js";
import { AttemptDiagnosisChoice } from "./attempt-diagnosis-choice-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: AttemptDiagnosisChoiceBridge = {
  render(mount, callbacks) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(AttemptDiagnosisChoice, callbacks)));
  },
  unmountWithin(container) {
    for (const [mount, root] of roots) {
      if (mount === container || container.contains(mount)) {
        root.unmount();
        roots.delete(mount);
      }
    }
  },
};

globalThis.tokenCouponAttemptDiagnosisChoice = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAttemptDiagnosisChoice;
  });
}
