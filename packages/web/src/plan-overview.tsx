import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlanOverviewBridge, PlanOverviewModel } from "./api-client-contracts.js";
import { PlanOverviewView } from "./plan-overview-ui.js";

const mount = document.getElementById("plan-overview-root");
if (!mount) throw new Error("plan_overview_mount_missing：找不到计划概览挂载点");

const root: Root = createRoot(mount);
const bridge: PlanOverviewBridge = {
  render(model: PlanOverviewModel, onPrimaryAction: () => void, onResume: () => void) {
    root.render(createElement(PlanOverviewView, { model, onPrimaryAction, onResume }));
  },
};

globalThis.tokenCouponPlanOverview = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponPlanOverview;
  });
}
