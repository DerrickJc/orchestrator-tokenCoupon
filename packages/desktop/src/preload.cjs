const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  attachment: "token-coupon:attachment",
  chooseFolder: "token-coupon:choose-folder",
  notification: "token-coupon:notification",
});

if (!process.isMainFrame) return;

contextBridge.exposeInMainWorld("tokenCouponDesktop", Object.freeze({
  getAttachment: () => ipcRenderer.invoke(channels.attachment),
  chooseWorkspaceFolder: () => ipcRenderer.invoke(channels.chooseFolder),
  showNotification: input => ipcRenderer.invoke(channels.notification, input),
}));
