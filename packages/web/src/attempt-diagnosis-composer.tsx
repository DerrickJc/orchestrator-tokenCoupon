import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptDiagnosisComposerBridge, AttemptDiagnosisComposerModel } from "./api-client-contracts.js";
import { SubmitTextarea } from "./planner-request-composer-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: AttemptDiagnosisComposerBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisComposerModel, onValueChange: (value: string) => void, onSubmit: () => void) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(SubmitTextarea, {
      id: "attempt-diagnosis-reply",
      className: "diagnosis-chat-reply",
      rows: 3,
      maxLength: 8192,
      placeholder: model.placeholder,
      ariaLabel: "发送诊断问题",
      ariaDescribedBy: "attempt-diagnosis-status diagnosis-shortcuts",
      initialValue: model.initialValue,
      onValueChange,
      onSubmit,
    })));
  },
  setValue(mount: HTMLElement, value: string) {
    const input = mount.querySelector<HTMLTextAreaElement>("#attempt-diagnosis-reply");
    if (input) input.value = value;
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

globalThis.tokenCouponAttemptDiagnosisComposer = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAttemptDiagnosisComposer;
  });
}
