import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptToolsBridge, AttemptToolsModel } from "./api-client-contracts.js";
import { AttemptTools } from "./attempt-tools-ui.js";

const mount = document.getElementById("attempt-tools");
if (!mount) throw new Error("attempt_tools_mount_missing：找不到 Attempt 工具活动挂载点");

const root: Root = createRoot(mount);
const bridge: AttemptToolsBridge = {
  render(model: AttemptToolsModel) {
    flushSync(() => root.render(createElement(AttemptTools, { model })));
  },
};

globalThis.tokenCouponAttemptTools = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponAttemptTools;
  });
}
