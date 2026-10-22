import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptOverviewBridge, AttemptOverviewModel } from "./api-client-contracts.js";
import { AttemptOverview } from "./attempt-overview-ui.js";

const mount = document.getElementById("attempt-overview-root");
if (!mount) throw new Error("attempt_overview_mount_missing：找不到 Attempt 摘要挂载点");

const root: Root = createRoot(mount);
const bridge: AttemptOverviewBridge = {
  render(model: AttemptOverviewModel, onDiagnose: () => void) {
    flushSync(() => root.render(createElement(AttemptOverview, { model, onDiagnose })));
  },
};

globalThis.tokenCouponAttemptOverview = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponAttemptOverview;
  });
}
