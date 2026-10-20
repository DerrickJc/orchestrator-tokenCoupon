const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  attachment: "token-coupon:attachment",
  chooseFolder: "token-coupon:choose-folder",
  notification: "token-coupon:notification",
  notificationsEnabled: "token-coupon:notifications-enabled",
  navigateToTask: "token-coupon:navigate-to-task",
});

if (!process.isMainFrame) return;

contextBridge.exposeInMainWorld("tokenCouponDesktop", Object.freeze({
  getAttachment: () => ipcRenderer.invoke(channels.attachment),
  chooseWorkspaceFolder: () => ipcRenderer.invoke(channels.chooseFolder),
  showNotification: input => ipcRenderer.invoke(channels.notification, input),
  getNotificationsEnabled: () => ipcRenderer.invoke(channels.notificationsEnabled),
  setNotificationsEnabled: enabled => ipcRenderer.invoke(channels.notificationsEnabled, enabled),
}));

ipcRenderer.on(channels.navigateToTask, (_event, target) => {
  if (!target || typeof target.workspaceId !== "string" || typeof target.planningId !== "string") return;
  window.dispatchEvent(new CustomEvent("token-coupon:navigate-to-task", { detail: Object.freeze({
    workspaceId: target.workspaceId, planningId: target.planningId,
    ...(typeof target.taskId === "string" ? { taskId: target.taskId } : {}),
  }) }));
});
