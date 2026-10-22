import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlanDraftViewBridge, PlanDraftViewModel } from "./api-client-contracts.js";
import { PlanDraftView } from "./plan-draft-view-ui.js";

const mount = document.getElementById("plan-view");
if (!mount) throw new Error("plan_draft_view_mount_missing：找不到执行计划挂载点");

const root: Root = createRoot(mount);
const bridge: PlanDraftViewBridge = {
  render(model: PlanDraftViewModel) { root.render(createElement(PlanDraftView, { model })); },
};

globalThis.tokenCouponPlanDraftView = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponPlanDraftView;
  });
}
