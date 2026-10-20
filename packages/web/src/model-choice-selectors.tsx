import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ModelChoiceSelectorModel, ModelChoiceSelectorsBridge } from "./api-client-contracts.js";
import { ModelChoiceSelector } from "./model-choice-selectors-ui.js";

const mounts = {
  planner: document.getElementById("planner-model-choice-root"),
  runner: document.getElementById("runner-model-choice-root"),
};
if (!mounts.planner || !mounts.runner) throw new Error("model_choice_mount_missing：找不到规划/执行模型选择挂载点");

const roots: Record<"planner" | "runner", Root> = {
  planner: createRoot(mounts.planner),
  runner: createRoot(mounts.runner),
};
const bridge: ModelChoiceSelectorsBridge = {
  render(prefix: "planner" | "runner", model: ModelChoiceSelectorModel, onChange) {
    flushSync(() => roots[prefix].render(createElement(ModelChoiceSelector, { prefix, model, onChange })));
  },
};

globalThis.tokenCouponModelChoiceSelectors = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    roots.planner.unmount();
    roots.runner.unmount();
    delete globalThis.tokenCouponModelChoiceSelectors;
  });
}
