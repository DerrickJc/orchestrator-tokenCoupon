import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptDiagnosisHistoryBridge, AttemptDiagnosisHistoryModel } from "./api-client-contracts.js";
import { AttemptDiagnosisHistory } from "./attempt-diagnosis-history-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: AttemptDiagnosisHistoryBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisHistoryModel) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(AttemptDiagnosisHistory, { model })));
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

globalThis.tokenCouponAttemptDiagnosisHistory = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAttemptDiagnosisHistory;
  });
}
