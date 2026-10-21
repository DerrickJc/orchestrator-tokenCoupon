import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { GlobalPending, type GlobalPendingModel } from "./global-pending-ui.js";
import { createDaemonApi, type PendingQueueItemDto } from "@token-coupon/client";
import { createPendingQueueState } from "./pending-queue-state.js";

interface QueueContext { epoch: string; supported: boolean; authorizations: GlobalPendingModel["authorizations"]; authorizationFresh: boolean; }
declare global { var tokenCouponGlobalPending: { configure(context: QueueContext): void; refresh(): Promise<void>; unavailable(): void } | undefined; }
const mount = document.getElementById("global-pending-root");
if (!mount) throw new Error("global_pending_mount_missing");
const root = createRoot(mount);
const dialog = document.getElementById("global-pending-dialog") as HTMLDialogElement;
const open = document.getElementById("global-pending-open") as HTMLButtonElement;
const count = document.getElementById("global-pending-count")!;
const refresh = document.getElementById("global-pending-refresh") as HTMLButtonElement;
let context: QueueContext = { epoch: "", supported: false, authorizations: [], authorizationFresh: false };
const queue = createPendingQueueState(offset => createDaemonApi(globalThis.tokenCouponClient).pendingQueue(offset), render);
function send(type: string, detail: PendingQueueItemDto | string) { dialog.close(); open.focus(); window.dispatchEvent(new CustomEvent(type, { detail })); }
function render() {
  const value = queue.current();
  open.disabled = !context.supported;
  open.title = context.supported ? "查看各工作区当前待处理请求" : "当前后台版本不支持待处理中心，请更新后台。";
  refresh.disabled = value.loading || !context.supported;
  count.textContent = value.error || !context.authorizationFresh ? "待核对" : String(value.total + context.authorizations.length);
  open.setAttribute("aria-label", `待处理中心 · ${count.textContent}`);
  root.render(createElement(GlobalPending, { model: { ...value, authorizations: context.authorizations, authorizationFresh: context.authorizationFresh,
    onPage: offset => { void queue.refresh(offset); }, onOpen: item => send("token-coupon:pending-open", item),
    onAuthorization: requestId => send("token-coupon:authorization-open", requestId) } }));
}
function onOpen() { dialog.showModal(); render(); void queue.refresh(0); }
function onClose() { dialog.close(); open.focus(); }
function onRefresh() { void queue.refresh(); }
open.addEventListener("click", onOpen);
document.getElementById("global-pending-close")!.addEventListener("click", onClose);
refresh.addEventListener("click", onRefresh);
const timer = setInterval(() => { if (dialog.open && context.supported) void queue.refresh(); }, 15_000);
globalThis.tokenCouponGlobalPending = {
  configure(next) { context = next; queue.reset(next.epoch); render(); },
  refresh: () => context.supported ? queue.refresh() : Promise.resolve(),
  unavailable() { context = { ...context, authorizationFresh: false }; queue.unavailable(); },
};
if (import.meta.hot) import.meta.hot.dispose(() => {
  clearInterval(timer); open.removeEventListener("click", onOpen); refresh.removeEventListener("click", onRefresh);
  document.getElementById("global-pending-close")?.removeEventListener("click", onClose);
  root.unmount(); delete globalThis.tokenCouponGlobalPending;
});
