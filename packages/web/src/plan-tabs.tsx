import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlanTabsBridge } from "./api-client-contracts.js";
import { PlanTabs } from "./plan-tabs-ui.js";

const mount = document.getElementById("plan-tabs-root");
if (!mount) throw new Error("plan_tabs_mount_missing：找不到计划导航挂载点");

const root: Root = createRoot(mount);
const bridge: PlanTabsBridge = {
  render(selectedTab: string, onSelect: (tab: string) => void) {
    root.render(createElement(PlanTabs, { selectedTab, onSelect }));
  },
};

globalThis.tokenCouponPlanTabs = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponPlanTabs;
  });
}
