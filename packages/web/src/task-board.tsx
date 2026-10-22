import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { TaskBoardBridge, TaskBoardModel } from "./api-client-contracts.js";
import { TaskBoard } from "./task-board-ui.js";

const mount = document.getElementById("task-list");
if (!mount) throw new Error("task_board_mount_missing：找不到任务看板挂载点");

const root: Root = createRoot(mount);
const bridge: TaskBoardBridge = {
  render(model: TaskBoardModel) { flushSync(() => root.render(createElement(TaskBoard, { model }))); },
};

globalThis.tokenCouponTaskBoard = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponTaskBoard;
  });
}
