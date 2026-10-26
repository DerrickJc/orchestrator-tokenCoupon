import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PendingRunnerQuestionsBridge, PendingRunnerQuestionsModel } from "./api-client-contracts.js";
import { PendingRunnerQuestions } from "./pending-runner-questions-ui.js";

const roots = new Map<HTMLElement, Root>();

const bridge: PendingRunnerQuestionsBridge = {
  render(mount: HTMLElement, model: PendingRunnerQuestionsModel) {
    let root = roots.get(mount);
    if (!root) {
      root = createRoot(mount);
      roots.set(mount, root);
    }
    flushSync(() => root?.render(createElement(PendingRunnerQuestions, { model })));
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

globalThis.tokenCouponPendingRunnerQuestions = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponPendingRunnerQuestions;
  });
}
