import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { DagFocusOption, DagFocusSelectorBridge } from "./api-client-contracts.js";
import { TaskDependencyDialog } from "./task-dependency-dialog-ui.js";
import { DagFocusSelector } from "./task-dependency-dialog-focus-selector-ui.js";

const mount = document.getElementById("dag-dialog-root");
if (!mount) throw new Error("task_dependency_dialog_mount_missing：找不到完整 DAG 弹窗挂载点");

const root: Root = createRoot(mount);
flushSync(() => root.render(createElement(TaskDependencyDialog)));

const focusMount = document.getElementById("dag-focus-root");
if (!focusMount) throw new Error("task_dependency_dialog_focus_mount_missing：找不到 DAG 聚焦任务挂载点");
const focusRoot: Root = createRoot(focusMount);
const focusBridge: DagFocusSelectorBridge = {
  render(options: DagFocusOption[], selectedId: string, onChange: (taskId: string) => void) {
    flushSync(() => focusRoot.render(createElement(DagFocusSelector, { options, selectedId, onChange })));
  },
};
globalThis.tokenCouponDagFocusSelector = focusBridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    focusRoot.unmount();
    root.unmount();
    delete globalThis.tokenCouponDagFocusSelector;
  });
}
