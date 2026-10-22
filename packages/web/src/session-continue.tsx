import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { SessionContinueBridge, SessionContinueModel } from "./api-client-contracts.js";
import { SessionContinueButton, SessionContinueInfo } from "./session-continue-ui.js";

const buttonMount = document.getElementById("session-continue-button-root");
const infoMount = document.getElementById("session-continue-info-root");
if (!buttonMount || !infoMount) throw new Error("session_continue_mount_missing：找不到断点继续挂载点");

const buttonRoot: Root = createRoot(buttonMount);
const infoRoot: Root = createRoot(infoMount);
const bridge: SessionContinueBridge = {
  render(model: SessionContinueModel) {
    flushSync(() => {
      buttonRoot.render(createElement(SessionContinueButton, { model }));
      infoRoot.render(createElement(SessionContinueInfo, { model }));
    });
  },
};

globalThis.tokenCouponSessionContinue = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    buttonRoot.unmount();
    infoRoot.unmount();
    delete globalThis.tokenCouponSessionContinue;
  });
}
