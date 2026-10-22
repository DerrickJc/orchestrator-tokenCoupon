import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationViewBridge, ConversationViewModel } from "./api-client-contracts.js";
import { ConversationView } from "./conversation-view-ui.js";

const mount = document.getElementById("conversation-view-root");
if (!mount) throw new Error("conversation_view_mount_missing：找不到对话列表挂载点");

const root: Root = createRoot(mount);
const bridge: ConversationViewBridge = {
  render(model: ConversationViewModel) { root.render(createElement(ConversationView, { model })); },
};

globalThis.tokenCouponConversationView = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponConversationView;
  });
}
