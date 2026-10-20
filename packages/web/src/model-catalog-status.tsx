import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ModelCatalogKind, ModelCatalogStatusBridge, ModelCatalogStatusModel } from "./api-client-contracts.js";
import { ModelCatalogStatus } from "./model-catalog-status-ui.js";

const mounts: Record<ModelCatalogKind, HTMLElement | null> = {
  planner: document.getElementById("planner-model-hint-root"),
  runner: document.getElementById("runner-model-hint-root"),
};
if (!mounts.planner || !mounts.runner) throw new Error("model_catalog_mount_missing：找不到规划/执行模型目录状态挂载点");

const roots: Record<ModelCatalogKind, Root> = {
  planner: createRoot(mounts.planner),
  runner: createRoot(mounts.runner),
};
const models: Record<ModelCatalogKind, ModelCatalogStatusModel> = {
  planner: { message: mounts.planner.querySelector("#planner-model-hint")?.textContent || "", loading: false },
  runner: {
    message: mounts.runner.querySelector("#runner-model-hint")?.textContent || "",
    loading: mounts.runner.querySelector<HTMLButtonElement>("#refresh-models")?.disabled || false,
  },
};
const renderAll = () => {
  flushSync(() => {
    for (const kind of ["planner", "runner"] as const) {
      roots[kind].render(createElement(ModelCatalogStatus, { kind, model: models[kind] }));
    }
  });
};
const bridge: ModelCatalogStatusBridge = {
  render(kind, model) {
    models[kind] = model;
    renderAll();
  },
};

globalThis.tokenCouponModelCatalogStatus = bridge;
renderAll();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    roots.planner.unmount();
    roots.runner.unmount();
    delete globalThis.tokenCouponModelCatalogStatus;
  });
}
