import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RunAgentModeBridge, RunAgentModeModel } from "./api-client-contracts.js";
import { RunAgentModeSelector } from "./run-agent-mode-ui.js";

let root: Root | undefined;
const bridge: RunAgentModeBridge = {
  render(model: RunAgentModeModel, onChange) {
    const mount = document.getElementById("run-agent-mode-root");
    if (!mount) return;
    root ??= createRoot(mount);
    flushSync(() => root?.render(createElement(RunAgentModeSelector, { model, onChange })));
  },
};

globalThis.tokenCouponRunAgentMode = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root?.unmount();
    root = undefined;
    delete globalThis.tokenCouponRunAgentMode;
  });
}
