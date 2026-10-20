import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LiveTaskRepliesBridge, LiveTaskRepliesModel } from "./api-client-contracts.js";
import { LiveTaskReplies } from "./live-task-replies-ui.js";

const mount = document.getElementById("live-task-replies");
if (!mount) throw new Error("live_task_replies_mount_missing：找不到执行回复挂载点");

const root: Root = createRoot(mount);
const bridge: LiveTaskRepliesBridge = {
  render(model: LiveTaskRepliesModel) { root.render(createElement(LiveTaskReplies, { model })); },
};

globalThis.tokenCouponLiveTaskReplies = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponLiveTaskReplies;
  });
}
