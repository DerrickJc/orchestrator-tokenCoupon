import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RunnerSelectorBridge, RunnerSelectorModel } from "./api-client-contracts.js";
import { RunnerSelector } from "./runner-selector-ui.js";

const mount = document.getElementById("runner-selector-root");
if (!mount) throw new Error("runner_selector_mount_missing：找不到执行 Runner 选择挂载点");

const root: Root = createRoot(mount);
const bridge: RunnerSelectorBridge = {
  render(model: RunnerSelectorModel, onChange) {
    flushSync(() => root.render(createElement(RunnerSelector, { model, onChange })));
  },
};

globalThis.tokenCouponRunnerSelector = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponRunnerSelector;
  });
}
