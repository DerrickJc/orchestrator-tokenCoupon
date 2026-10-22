import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExecutionProgressBridge, ExecutionProgressModel } from "./api-client-contracts.js";
import { ExecutionProgress } from "./execution-progress-ui.js";

const mount = document.getElementById("session-progress");
if (!mount) throw new Error("execution_progress_mount_missing：找不到执行状态挂载点");

const root: Root = createRoot(mount);
const bridge: ExecutionProgressBridge = {
  render(model: ExecutionProgressModel) { root.render(createElement(ExecutionProgress, { model })); },
};

globalThis.tokenCouponExecutionProgress = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponExecutionProgress;
  });
}
