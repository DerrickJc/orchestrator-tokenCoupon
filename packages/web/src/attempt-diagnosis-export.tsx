import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptDiagnosisExportBridge, AttemptDiagnosisExportModel } from "./api-client-contracts.js";
import { AttemptDiagnosisExport } from "./attempt-diagnosis-export-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: AttemptDiagnosisExportBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisExportModel, callbacks) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(AttemptDiagnosisExport, { model, ...callbacks })));
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

globalThis.tokenCouponAttemptDiagnosisExport = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAttemptDiagnosisExport;
  });
}
