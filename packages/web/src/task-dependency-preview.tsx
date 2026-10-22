import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskDependencyPreviewBridge, TaskDependencyPreviewModel } from "./api-client-contracts.js";
import { TaskDependencyPreview } from "./task-dependency-preview-ui.js";

const mount = document.getElementById("task-dependencies");
if (!mount) throw new Error("task_dependency_preview_mount_missing：找不到依赖图预览挂载点");

const root: Root = createRoot(mount);
const bridge: TaskDependencyPreviewBridge = {
  render(model: TaskDependencyPreviewModel | null) { root.render(createElement(TaskDependencyPreview, { model })); },
};

globalThis.tokenCouponTaskDependencyPreview = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponTaskDependencyPreview;
  });
}
