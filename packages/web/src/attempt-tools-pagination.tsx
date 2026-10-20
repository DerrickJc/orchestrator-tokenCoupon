import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptToolsPaginationBridge, AttemptToolsPaginationModel } from "./api-client-contracts.js";
import { AttemptToolsPagination } from "./attempt-tools-pagination-ui.js";

const mount = document.getElementById("attempt-tools-pagination-root");
if (!mount) throw new Error("attempt_tools_pagination_mount_missing：找不到工具活动分页挂载点");

const root: Root = createRoot(mount);
const bridge: AttemptToolsPaginationBridge = {
  render(model: AttemptToolsPaginationModel, callbacks) {
    flushSync(() => root.render(createElement(AttemptToolsPagination, { model, ...callbacks })));
  },
};

globalThis.tokenCouponAttemptToolsPagination = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponAttemptToolsPagination;
  });
}
