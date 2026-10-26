import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptSelectionBridge, AttemptSelectionModel } from "./api-client-contracts.js";
import { AttemptSelection } from "./attempt-selection-ui.js";

const mount = document.getElementById("attempt-selection-root");
if (!mount) throw new Error("attempt_selection_mount_missing：找不到 Attempt 选择挂载点");

const root: Root = createRoot(mount);
const bridge: AttemptSelectionBridge = {
  render(model: AttemptSelectionModel, callbacks) {
    flushSync(() => root.render(createElement(AttemptSelection, { model, ...callbacks })));
  },
};

globalThis.tokenCouponAttemptSelection = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponAttemptSelection;
  });
}
