import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { GlobalPending, type GlobalPendingModel } from "./global-pending-ui.js";
import { createDaemonApi, type PendingQueueItemDto, type PlanningTodoDto } from "@token-coupon/client";
import { createPendingQueueState } from "./pending-queue-state.js";
import { createPlanningTodoState } from "./planning-todo-state.js";

interface QueueContext { epoch: string; supported: boolean; planningSupported: boolean; authorizations: GlobalPendingModel["authorizations"]; authorizationFresh: boolean; }
declare global { var tokenCouponGlobalPending: { configure(context: QueueContext): void; refresh(): Promise<void>; unavailable(): void } | undefined; }
const mount = document.getElementById("global-pending-root");
if (!mount) throw new Error("global_pending_mount_missing");
const root = createRoot(mount);
const dialog = document.getElementById("global-pending-dialog") as HTMLDialogElement;
const open = document.getElementById("global-pending-open") as HTMLButtonElement;
const count = document.getElementById("global-pending-count")!;
const refresh = document.getElementById("global-pending-refresh") as HTMLButtonElement;
let context: QueueContext = { epoch: "", supported: false, planningSupported: false, authorizations: [], authorizationFresh: false };
let disposed = false;
const queue = createPendingQueueState(offset => createDaemonApi(globalThis.tokenCouponClient).pendingQueue(offset), render);
const plans = createPlanningTodoState(cursor => createDaemonApi(globalThis.tokenCouponClient).planningTodos(cursor), render);
function send(type: string, detail: PendingQueueItemDto | PlanningTodoDto | string) { dialog.close(); open.focus(); window.dispatchEvent(new CustomEvent(type, { detail })); }
function render() {
  if (disposed) return;
  const value = queue.current();
  open.disabled = !context.supported;
  open.title = context.supported ? "查看各工作区当前待处理请求" : "当前后台版本不支持待处理中心，请更新后台。";
  refresh.disabled = value.loading || plans.current().loading || !context.supported;
  count.textContent = value.error || !context.authorizationFresh ? "待核对" : `${value.total + context.authorizations.length} 请求`;
  open.setAttribute("aria-label", `待处理中心 · ${count.textContent}`);
  root.render(createElement(GlobalPending, { model: { ...value, authorizations: context.authorizations, authorizationFresh: context.authorizationFresh,
    onPage: offset => { void queue.refresh(offset); }, onOpen: item => send("token-coupon:pending-open", item),
    onAuthorization: requestId => send("token-coupon:authorization-open", requestId),
    ...(context.planningSupported ? { plans: { ...plans.current(), onOpen: (item: PlanningTodoDto) => send("token-coupon:planning-todo-open", item), onPage: (direction: -1 | 1) => { void plans.move(direction); } } } : {}) } }));
}
function onOpen() { dialog.showModal(); render(); void queue.refresh(0); if (context.planningSupported) void plans.first(); }
function onClose() { dialog.close(); open.focus(); }
function onRefresh() { void queue.refresh(); if (context.planningSupported) void plans.refresh(); }
open.addEventListener("click", onOpen);
document.getElementById("global-pending-close")!.addEventListener("click", onClose);
refresh.addEventListener("click", onRefresh);
const timer = setInterval(() => { if (dialog.open && context.supported) void queue.refresh(); }, 15_000);
globalThis.tokenCouponGlobalPending = {
  configure(next) { context = next; queue.reset(next.epoch); plans.reset(next.epoch); render(); },
  async refresh() { if (context.supported) await Promise.all([queue.refresh(), ...(dialog.open && context.planningSupported ? [plans.refresh()] : [])]); },
  unavailable() { context = { ...context, authorizationFresh: false }; queue.unavailable(); plans.unavailable(); },
};
if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true; queue.unavailable(); plans.unavailable();
  clearInterval(timer); open.removeEventListener("click", onOpen); refresh.removeEventListener("click", onRefresh);
  document.getElementById("global-pending-close")?.removeEventListener("click", onClose);
  root.unmount(); delete globalThis.tokenCouponGlobalPending;
});
