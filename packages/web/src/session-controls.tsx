import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { SessionControlsBridge, SessionControlsModel } from "./api-client-contracts.js";
import { SessionControls } from "./session-controls-ui.js";

const mount = document.getElementById("session-controls");
if (!mount) throw new Error("session_controls_mount_missing：找不到 Session 操作挂载点");

const root: Root = createRoot(mount);
const bridge: SessionControlsBridge = {
  render(model: SessionControlsModel) { flushSync(() => root.render(createElement(SessionControls, { model }))); },
};

globalThis.tokenCouponSessionControls = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponSessionControls;
  });
}
