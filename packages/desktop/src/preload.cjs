const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  attachment: "token-coupon:attachment",
  reconnect: "token-coupon:reconnect",
  reconnectRequested: "token-coupon:reconnect-requested",
  connectionState: "token-coupon:connection-state",
  recoveryState: "token-coupon:recovery-state",
  acknowledgeRecovery: "token-coupon:acknowledge-recovery",
  chooseFolder: "token-coupon:choose-folder",
  openFolder: "token-coupon:open-folder",
  copyText: "token-coupon:copy-text",
  notification: "token-coupon:notification",
  notificationsEnabled: "token-coupon:notifications-enabled",
  navigateToTask: "token-coupon:navigate-to-task",
});

if (!process.isMainFrame) return;

contextBridge.exposeInMainWorld("tokenCouponDesktop", Object.freeze({
  getAttachment: () => ipcRenderer.invoke(channels.attachment),
  reconnect: snapshot => ipcRenderer.invoke(channels.reconnect, snapshot),
  getConnectionState: () => ipcRenderer.invoke(channels.connectionState),
  getRecoveryState: () => ipcRenderer.invoke(channels.recoveryState),
  acknowledgeRecovery: id => ipcRenderer.invoke(channels.acknowledgeRecovery, id),
  chooseWorkspaceFolder: defaultPath => ipcRenderer.invoke(channels.chooseFolder, defaultPath),
  openWorkspaceFolder: path => ipcRenderer.invoke(channels.openFolder, path),
  copyText: text => ipcRenderer.invoke(channels.copyText, text),
  showNotification: input => ipcRenderer.invoke(channels.notification, input),
  getNotificationsEnabled: () => ipcRenderer.invoke(channels.notificationsEnabled),
  setNotificationsEnabled: enabled => ipcRenderer.invoke(channels.notificationsEnabled, enabled),
}));

ipcRenderer.on(channels.connectionState, (_event, state) => {
  if (!["connected", "disconnected", "reconnecting"].includes(state?.phase)) return;
  window.dispatchEvent(new CustomEvent("token-coupon:desktop-connection", { detail: Object.freeze({ phase: state.phase, ...(typeof state.error === "string" ? { error: state.error } : {}) }) }));
});
ipcRenderer.on(channels.reconnectRequested, () => window.dispatchEvent(new CustomEvent("token-coupon:desktop-reconnect")));

ipcRenderer.on(channels.navigateToTask, (_event, target) => {
  if (!target || typeof target.workspaceId !== "string" || typeof target.planningId !== "string") return;
  window.dispatchEvent(new CustomEvent("token-coupon:navigate-to-task", { detail: Object.freeze({
    workspaceId: target.workspaceId, planningId: target.planningId,
    ...(typeof target.taskId === "string" ? { taskId: target.taskId } : {}),
  }) }));
});
