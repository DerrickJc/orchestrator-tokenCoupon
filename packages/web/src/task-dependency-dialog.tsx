import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { TaskDependencyDialog } from "./task-dependency-dialog-ui.js";

const mount = document.getElementById("dag-dialog-root");
if (!mount) throw new Error("task_dependency_dialog_mount_missing：找不到完整 DAG 弹窗挂载点");

const root: Root = createRoot(mount);
flushSync(() => root.render(createElement(TaskDependencyDialog)));

if (import.meta.hot) {
  import.meta.hot.dispose(() => root.unmount());
}
