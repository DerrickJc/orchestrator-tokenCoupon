import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RunParametersBridge, RunParametersModel } from "./api-client-contracts.js";
import { RunParameters } from "./run-parameters-ui.js";

const mount = document.getElementById("run-advanced-options-root");
if (!mount) throw new Error("run_parameters_mount_missing：找不到并发/隔离/验证参数挂载点");
const root: Root = createRoot(mount);
const bridge: RunParametersBridge = {
  render(model: RunParametersModel, onChange) {
    flushSync(() => root.render(createElement(RunParameters, { model, onChange })));
  },
};

globalThis.tokenCouponRunParameters = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponRunParameters;
  });
}
