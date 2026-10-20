import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptDiagnosisDialogBridge, AttemptDiagnosisDialogModel } from "./api-client-contracts.js";
import { AttemptDiagnosisDialog } from "./attempt-diagnosis-dialog-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: AttemptDiagnosisDialogBridge = {
  render(mount, model: AttemptDiagnosisDialogModel, callbacks) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(AttemptDiagnosisDialog, { model, ...callbacks })));
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

globalThis.tokenCouponAttemptDiagnosisDialog = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAttemptDiagnosisDialog;
  });
}
