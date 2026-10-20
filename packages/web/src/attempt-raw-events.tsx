import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AttemptRawEventsBridge, AttemptRawEventsModel } from "./api-client-contracts.js";
import { AttemptRawEvents } from "./attempt-raw-events-ui.js";

const mount = document.getElementById("attempt-raw-root");
if (!mount) throw new Error("attempt_raw_events_mount_missing：找不到 Attempt 原始事件挂载点");

const root: Root = createRoot(mount);
const bridge: AttemptRawEventsBridge = {
  render(mountElement: HTMLElement, model: AttemptRawEventsModel, callbacks) {
    if (mountElement !== mount) return;
    flushSync(() => root.render(createElement(AttemptRawEvents, { model, ...callbacks })));
  },
};

globalThis.tokenCouponAttemptRawEvents = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponAttemptRawEvents;
  });
}
