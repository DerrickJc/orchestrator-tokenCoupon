import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PlannerProviderSelectorBridge, PlannerProviderSelectorModel } from "./api-client-contracts.js";
import { PlannerProviderSelector } from "./planner-provider-selector-ui.js";

const mount = document.getElementById("planner-provider-root");
if (!mount) throw new Error("planner_provider_mount_missing：找不到规划方式挂载点");

const root: Root = createRoot(mount);
const bridge: PlannerProviderSelectorBridge = {
  render(model: PlannerProviderSelectorModel, onChange) {
    flushSync(() => root.render(createElement(PlannerProviderSelector, { model, onChange })));
  },
};

globalThis.tokenCouponPlannerProviderSelector = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponPlannerProviderSelector;
  });
}
