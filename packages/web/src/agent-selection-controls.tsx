import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentSelectionControlsBridge, AgentSelectionControlsCallbacks, AgentSelectionControlsModel } from "./api-client-contracts.js";
import { AgentSelectionControls } from "./agent-selection-controls-ui.js";

const roots = new Map<HTMLElement, Root>();
const bridge: AgentSelectionControlsBridge = {
  render(mount: HTMLElement, model: AgentSelectionControlsModel, callbacks: AgentSelectionControlsCallbacks) {
    let root = roots.get(mount);
    if (!root) { root = createRoot(mount); roots.set(mount, root); }
    flushSync(() => root?.render(createElement(AgentSelectionControls, { model, callbacks })));
  },
  unmount(mount: HTMLElement) {
    const root = roots.get(mount);
    if (!root) return;
    root.unmount(); roots.delete(mount);
  },
};

globalThis.tokenCouponAgentSelectionControls = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const root of roots.values()) root.unmount();
    roots.clear();
    delete globalThis.tokenCouponAgentSelectionControls;
  });
}
