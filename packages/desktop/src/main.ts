import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, session, Tray } from "electron";
import { API_PROTOCOL, EPOCH_HEADER, PROTOCOL_HEADER } from "@token-coupon/client";
import { discoverOwnedDaemon } from "@token-coupon/client/node";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAttachmentFailure, DESKTOP_IPC, isAllowedDaemonOrigin, isDesktopNotificationInput, isTrustedIpcContext, isTrustedRendererUrl, type DesktopAttachment } from "./desktop-policy.js";
import { resolveDevelopmentDaemonRuntime, resolvePackagedDaemonRuntime } from "./daemon-runtime.js";
import { startManagedDaemon } from "./managed-daemon.js";
import { restoreWindowBounds, type DisplayWorkArea } from "./window-state.js";
import { resolveDesktopUserData } from "./desktop-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const desktopUserData = resolveDesktopUserData(app.getPath("userData"), app.isPackaged);
mkdirSync(join(desktopUserData, "chromium"), { recursive: true, mode: 0o700 });
app.setPath("userData", desktopUserData);
app.setPath("sessionData", join(desktopUserData, "chromium"));
const defaultHome = app.getPath("home") || homedir();
const profileDirectory = daemonProfileDirectory(process.argv, process.env, defaultHome);
let window: BrowserWindow | undefined;
let attachment: DesktopAttachment | undefined;
let managedDaemon: ChildProcess | undefined;
let tray: Tray | undefined;
let windowStatePath: string | undefined;
let preferencesPath: string | undefined;
let stateSaveTimer: NodeJS.Timeout | undefined;
let quitting = false;

function daemonProfileDirectory(args: readonly string[], environment: NodeJS.ProcessEnv, home: string): string {
  const index = args.indexOf("--data-dir");
  const argument = index >= 0 ? args[index + 1] : args.find(value => value.startsWith("--data-dir="))?.slice("--data-dir=".length);
  const explicit = argument ?? environment.TOKEN_COUPON_DAEMON_HOME;
  if (explicit !== undefined) {
    if (!explicit.trim() || !isAbsolute(explicit)) throw new Error("desktop_data_directory_invalid：后台数据目录必须是非空绝对路径");
    return resolve(explicit);
  }
  if (!home || !isAbsolute(home)) throw new Error("desktop_home_unavailable：无法确定用户主目录");
  return join(home, ".token-coupon", "daemon");
}

async function findDaemon(): Promise<DesktopAttachment> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const found = await discoverOwnedDaemon(profileDirectory, { timeoutMs: 900 });
      if (!isAllowedDaemonOrigin(found.origin)) throw new Error("desktop_daemon_origin_invalid：后台地址不是受信任的本机地址");
      return found;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
    }
  }
  throw new Error(describeAttachmentFailure(lastError));
}

async function discoverDaemonOnce(): Promise<DesktopAttachment> {
  const found = await discoverOwnedDaemon(profileDirectory, { timeoutMs: 1_200 });
  if (!isAllowedDaemonOrigin(found.origin)) throw new Error("desktop_daemon_origin_invalid：后台地址不是受信任的本机地址");
  return found;
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!attachment || !url || !isTrustedIpcContext(event.sender === window?.webContents,
      !!event.senderFrame && event.senderFrame === event.sender.mainFrame, url, attachment.origin)) {
    throw new Error("desktop_ipc_sender_rejected：只接受当前本机应用主页面的请求");
  }
}

function registerIpc(): void {
  ipcMain.handle(DESKTOP_IPC.attachment, event => { assertTrustedSender(event); return attachment; });
  ipcMain.handle(DESKTOP_IPC.notificationsEnabled, (event, enabled?: unknown) => {
    assertTrustedSender(event);
    if (enabled === undefined) return readNotificationPreference();
    if (typeof enabled !== "boolean") throw new Error("desktop_notification_preference_invalid：提醒设置必须是开关值");
    writeNotificationPreference(enabled);
    return enabled;
  });
  ipcMain.handle(DESKTOP_IPC.chooseFolder, async event => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(window!, { title: "选择工作区文件夹", properties: ["openDirectory"] });
    return { canceled: result.canceled, path: result.canceled ? undefined : result.filePaths[0] };
  });
  ipcMain.handle(DESKTOP_IPC.notification, (event, input: unknown) => {
    assertTrustedSender(event);
    if (!isDesktopNotificationInput(input)) throw new Error("desktop_notification_invalid：通知标题或内容超出允许范围");
    if (!Notification.isSupported()) return false;
    const notice = new Notification({ title: input.title, body: input.body });
    notice.on("click", () => {
      showMainWindow();
      if (input.workspaceId && input.planningId) window?.webContents.send(DESKTOP_IPC.navigateToTask, {
        workspaceId: input.workspaceId, planningId: input.planningId, ...(input.taskId ? { taskId: input.taskId } : {}),
      });
    });
    notice.show();
    return true;
  });
}

function readNotificationPreference(): boolean {
  if (!preferencesPath) return false;
  try { const value = JSON.parse(readFileSync(preferencesPath, "utf8")); return value?.notificationsEnabled === true; }
  catch { return false; }
}

function writeNotificationPreference(enabled: boolean): void {
  if (!preferencesPath) throw new Error("desktop_preferences_unavailable：桌面设置尚未就绪");
  mkdirSync(dirname(preferencesPath), { recursive: true });
  const temporary = `${preferencesPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, notificationsEnabled: enabled })}\n`, { mode: 0o600 });
  renameSync(temporary, preferencesPath);
}

async function connectOrExplain(): Promise<DesktopAttachment | undefined> {
  for (;;) {
    try {
      try { return await findDaemon(); }
      catch {
        const runtime = app.isPackaged
          ? resolvePackagedDaemonRuntime(process.resourcesPath)
          : resolveDevelopmentDaemonRuntime(app.getAppPath(), process.env);
        const started = await startManagedDaemon({
          runtime,
          dataDirectory: profileDirectory,
          logPath: join(app.getPath("userData"), "logs", "daemon.log"),
          discover: discoverDaemonOnce,
        });
        managedDaemon = started.child.exitCode === null ? started.child : undefined;
        started.child.once("exit", () => { if (managedDaemon === started.child) { managedDaemon = undefined; refreshTrayMenu(); } });
        return started.attachment;
      }
    }
    catch (error) {
      const result = await dialog.showMessageBox({
        type: "warning", title: "Token Coupon 后台尚未就绪",
        message: "没有找到可复用的后台，应用也未能启动随包 daemon。",
        detail: `${describeAttachmentFailure(error)}\n\n桌面应用只连接通过 owner 身份和 HMAC 挑战验证的后台。查看日志后可选择重试；日志位于 ${join(app.getPath("userData"), "logs", "daemon.log")}。`,
        buttons: ["重试", "退出应用"], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (result.response !== 0) return undefined;
    }
  }
}

function readWindowBounds(): unknown {
  if (!windowStatePath) return undefined;
  try { return JSON.parse(readFileSync(windowStatePath, "utf8")); } catch { return undefined; }
}

function currentWorkAreas(): DisplayWorkArea[] { return screen.getAllDisplays().map(display => display.workArea); }

function saveWindowBounds(instance = window): void {
  if (!instance || !windowStatePath) return;
  try {
    mkdirSync(dirname(windowStatePath), { recursive: true });
    const temporary = `${windowStatePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(instance.getNormalBounds())}\n`, { mode: 0o600 });
    renameSync(temporary, windowStatePath);
  } catch { /* A failed preference write must not prevent the application from closing. */ }
}

function scheduleWindowBoundsSave(instance: BrowserWindow): void {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => { stateSaveTimer = undefined; if (window === instance) saveWindowBounds(instance); }, 400);
}

function showMainWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "打开 Token Coupon", click: showMainWindow },
    { type: "separator" },
    { label: managedDaemon ? "退出应用（后台继续运行）" : "退出应用（不停止已连接后台）", click: () => { quitting = true; app.quit(); } },
  ];
  if (managedDaemon) items.push({ label: "停止本机后台并退出", click: () => { void stopManagedDaemonFromTray(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function stopManagedDaemonFromTray(): Promise<void> {
  if (!managedDaemon || !attachment || !window) return;
  const confirm = await dialog.showMessageBox(window, {
    type: "warning", title: "停止本机后台？",
    message: "这会停止由桌面应用启动的本机后台。",
    detail: "仅当没有运行中的操作时才能停止；若任务仍在运行，应用会列出阻断项且不会关闭后台。",
    buttons: ["取消", "检查并停止"], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (confirm.response !== 1) return;
  try {
    const cookies = await session.defaultSession.cookies.get({ url: attachment.origin });
    const localCookie = cookies.find(cookie => cookie.name === "tc_local");
    if (!localCookie) throw new Error("桌面页面尚未建立本机授权，请先等待页面加载后重试。");
    const response = await fetch(`${attachment.origin}/api/v1/daemon/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Origin: attachment.origin,
        Cookie: `tc_local=${localCookie.value}`,
        [PROTOCOL_HEADER]: String(API_PROTOCOL.major), [EPOCH_HEADER]: attachment.epoch,
      },
      body: JSON.stringify({ confirmed: true, expectedEpoch: attachment.epoch }),
    });
    const result = await response.json() as { error?: string; activeJobs?: Array<{ kind: string; planningId?: string }>; activeMutations?: number };
    if (response.status === 409 && result.error?.startsWith("daemon_busy")) {
      const active = (result.activeJobs ?? []).map(job => `${job.kind}${job.planningId ? ` · Planning ${job.planningId}` : ""}`).join("\n");
      const detail = active || (result.activeMutations ? `${result.activeMutations} 项写操作正在处理，请稍后重试。` : result.error);
      await dialog.showMessageBox(window, { type: "info", title: "后台仍有操作", message: "没有停止后台，当前任务会继续运行。", detail, buttons: ["知道了"], noLink: true });
      return;
    }
    if (!response.ok) throw new Error(result.error || `后台拒绝停止（HTTP ${response.status}）`);
    quitting = true;
    app.quit();
  } catch (error) {
    await dialog.showMessageBox(window, { type: "error", title: "停止后台失败", message: "桌面应用仍保持打开。", detail: describeAttachmentFailure(error), buttons: ["知道了"], noLink: true });
  }
}

function installTray(): void {
  if (tray) return;
  try {
    const icon = join(here, process.platform === "win32" ? "token-coupon.ico" : "token-coupon.png");
    tray = new Tray(icon);
    tray.setToolTip("Token Coupon");
    refreshTrayMenu();
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
  } catch { tray = undefined; }
}

async function createWindow(origin: string): Promise<BrowserWindow> {
  const target = new URL(origin);
  if (!isAllowedDaemonOrigin(target.origin)) throw new Error("desktop_daemon_origin_invalid：拒绝加载非本机后台页面");
  const workAreas = currentWorkAreas();
  const bounds = restoreWindowBounds(readWindowBounds(), workAreas);
  const visibleArea = workAreas.find(area => bounds.x + bounds.width / 2 >= area.x && bounds.x + bounds.width / 2 <= area.x + area.width && bounds.y + bounds.height / 2 >= area.y && bounds.y + bounds.height / 2 <= area.y + area.height) ?? workAreas[0] ?? { width: 1440, height: 960 };
  const instance = new BrowserWindow({
    ...bounds, minWidth: Math.min(900, visibleArea.width), minHeight: Math.min(640, visibleArea.height), show: false,
    icon: join(here, process.platform === "win32" ? "token-coupon.ico" : "token-coupon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  instance.webContents.on("will-frame-navigate", event => { if (!isTrustedRendererUrl(event.url, target.origin)) event.preventDefault(); });
  instance.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  instance.once("ready-to-show", () => instance.show());
  instance.on("move", () => scheduleWindowBoundsSave(instance));
  instance.on("resize", () => scheduleWindowBoundsSave(instance));
  instance.on("close", event => {
    saveWindowBounds(instance);
    if (tray && !quitting) { event.preventDefault(); instance.hide(); }
  });
  instance.on("closed", () => { if (window === instance) window = undefined; });
  void instance.loadURL(target.origin);
  return instance;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showMainWindow);
  // Awaiting ready at ESM module top level prevents Electron from completing startup.
  void app.whenReady().then(async () => {
    windowStatePath = join(app.getPath("userData"), "window-state.json");
    preferencesPath = join(app.getPath("userData"), "desktop-preferences.json");
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const current = await connectOrExplain();
    if (!current) app.quit();
    else {
      attachment = current;
      registerIpc();
      window = await createWindow(current.origin);
      installTray();
    }
  }).catch(error => {
    dialog.showErrorBox("Token Coupon 启动失败", describeAttachmentFailure(error));
    quitting = true;
    app.quit();
  });
  app.on("activate", () => { if (!window && attachment) void createWindow(attachment.origin).then(created => { window = created; }); else showMainWindow(); });
  app.on("before-quit", () => { quitting = true; if (stateSaveTimer) clearTimeout(stateSaveTimer); saveWindowBounds(); });
  app.on("will-quit", () => { tray?.destroy(); tray = undefined; });
  app.on("window-all-closed", () => { if (!tray) app.quit(); });
}
