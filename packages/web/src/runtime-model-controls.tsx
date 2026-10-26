import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RuntimeModelControlsBridge, RuntimeModelControlsCallbacks, RuntimeModelControlsModel } from "./api-client-contracts.js";
import { RuntimeModelControls } from "./runtime-model-controls-ui.js";

let root: Root | undefined;
const bridge: RuntimeModelControlsBridge = {
  render(model: RuntimeModelControlsModel, callbacks: RuntimeModelControlsCallbacks) {
    const mount = document.getElementById("runtime-model-controls-root");
    if (!mount) return;
    root ??= createRoot(mount);
    flushSync(() => root?.render(createElement(RuntimeModelControls, { model, callbacks })));
  },
};

globalThis.tokenCouponRuntimeModelControls = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root?.unmount(); root = undefined;
    delete globalThis.tokenCouponRuntimeModelControls;
  });
}
