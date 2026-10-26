import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReviewerModeSelectorBridge, ReviewerModeSelectorModel } from "./api-client-contracts.js";
import { ReviewerModeSelector } from "./reviewer-mode-selector-ui.js";

const mount = document.getElementById("reviewer-mode-root");
if (!mount) throw new Error("reviewer_mode_mount_missing：找不到审查方式选择挂载点");
const root: Root = createRoot(mount);
const bridge: ReviewerModeSelectorBridge = {
  render(model: ReviewerModeSelectorModel, onChange) {
    flushSync(() => root.render(createElement(ReviewerModeSelector, { model, onChange })));
  },
};

globalThis.tokenCouponReviewerModeSelector = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponReviewerModeSelector;
  });
}
