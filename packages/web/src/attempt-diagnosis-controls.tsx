import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptDiagnosisControlsBridge, AttemptDiagnosisControlsModel } from "./api-client-contracts.js";
import { AttemptDiagnosisHistorySelect, AttemptDiagnosisModelSelectors } from "./attempt-diagnosis-controls-ui.js";

const roots = new Map<HTMLElement, Root>();

function render(mount: HTMLElement, element: ReturnType<typeof createElement>) {
  let root = roots.get(mount);
  if (!root) {
    root = createRoot(mount);
    roots.set(mount, root);
  }
  flushSync(() => root?.render(element));
}

const bridge: AttemptDiagnosisControlsBridge = {
  renderHistory(mount, diagnostics, selectedId, disabled, onChange) {
    render(mount, createElement(AttemptDiagnosisHistorySelect, { diagnostics, selectedId, disabled, onChange }));
  },
  renderModels(mount, model: AttemptDiagnosisControlsModel, callbacks) {
    render(mount, createElement(AttemptDiagnosisModelSelectors, { model, callbacks }));
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

globalThis.tokenCouponAttemptDiagnosisControls = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAttemptDiagnosisControls;
  });
}
