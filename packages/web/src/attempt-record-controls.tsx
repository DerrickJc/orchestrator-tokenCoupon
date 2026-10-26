import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptRecordControlsBridge, AttemptRecordControlsModel } from "./api-client-contracts.js";
import { AttemptLoadMoreButton, AttemptRefreshButton } from "./attempt-record-controls-ui.js";

const refreshMount = document.getElementById("attempt-refresh-root");
const moreMount = document.getElementById("attempt-more-root");
if (!refreshMount || !moreMount) throw new Error("attempt_record_controls_mount_missing：找不到 Attempt 记录控制挂载点");

const refreshRoot: Root = createRoot(refreshMount);
const moreRoot: Root = createRoot(moreMount);
const bridge: AttemptRecordControlsBridge = {
  render(model: AttemptRecordControlsModel, callbacks) {
    flushSync(() => {
      refreshRoot.render(createElement(AttemptRefreshButton, { loading: model.loading, onRefresh: callbacks.onRefresh }));
      moreRoot.render(createElement(AttemptLoadMoreButton, { model, onMore: callbacks.onMore }));
    });
  },
};

globalThis.tokenCouponAttemptRecordControls = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    refreshRoot.unmount();
    moreRoot.unmount();
    delete globalThis.tokenCouponAttemptRecordControls;
  });
}
