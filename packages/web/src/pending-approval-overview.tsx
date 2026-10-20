import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PendingApprovalOverviewBridge, PendingApprovalOverviewModel } from "./api-client-contracts.js";
import { PendingApprovalOverview } from "./pending-approval-overview-ui.js";

const mount = document.getElementById("pending-approval-overview-root");
if (!mount) throw new Error("pending_approval_overview_mount_missing：找不到审批摘要挂载点");

const root: Root = createRoot(mount);
const bridge: PendingApprovalOverviewBridge = {
  render(model: PendingApprovalOverviewModel) { flushSync(() => root.render(createElement(PendingApprovalOverview, { model }))); },
};

globalThis.tokenCouponPendingApprovalOverview = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponPendingApprovalOverview;
  });
}
