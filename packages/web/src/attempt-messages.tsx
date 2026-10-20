import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptMessagesBridge, AttemptMessagesModel } from "./api-client-contracts.js";
import { AttemptMessages } from "./attempt-messages-ui.js";

const mount = document.getElementById("attempt-messages");
if (!mount) throw new Error("attempt_messages_mount_missing：找不到 Attempt 回复挂载点");

const root: Root = createRoot(mount);
const bridge: AttemptMessagesBridge = {
  render(model: AttemptMessagesModel) {
    flushSync(() => root.render(createElement(AttemptMessages, { model })));
  },
};

globalThis.tokenCouponAttemptMessages = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponAttemptMessages;
  });
}
