import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RunModeSelectorBridge, RunModeSelectorModel } from "./api-client-contracts.js";
import { RunModeSelector } from "./run-mode-selector-ui.js";

const mount = document.getElementById("run-mode-selector-root");
if (!mount) throw new Error("run_mode_mount_missing：找不到执行方式选择挂载点");
const root: Root = createRoot(mount);
const bridge: RunModeSelectorBridge = {
  render(model: RunModeSelectorModel, onChange) {
    flushSync(() => root.render(createElement(RunModeSelector, { model, onChange })));
  },
};

globalThis.tokenCouponRunModeSelector = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponRunModeSelector;
  });
}
