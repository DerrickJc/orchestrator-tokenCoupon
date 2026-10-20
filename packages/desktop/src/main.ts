import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, session, Tray } from "electron";
import { discoverOwnedDaemon } from "@token-coupon/client/node";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAttachmentFailure, DESKTOP_IPC, isAllowedDaemonOrigin, isDesktopNotificationInput, isTrustedIpcContext, isTrustedRendererUrl, type DesktopAttachment } from "./desktop-policy.js";
import { restoreWindowBounds, type DisplayWorkArea } from "./window-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultHome = app.getPath("home") || homedir();
const profileDirectory = daemonProfileDirectory(process.argv, process.env, defaultHome);
let window: BrowserWindow | undefined;
let attachment: DesktopAttachment | undefined;
let tray: Tray | undefined;
let windowStatePath: string | undefined;
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

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!attachment || !url || !isTrustedIpcContext(event.sender === window?.webContents,
      !!event.senderFrame && event.senderFrame === event.sender.mainFrame, url, attachment.origin)) {
    throw new Error("desktop_ipc_sender_rejected：只接受当前本机应用主页面的请求");
  }
}

function registerIpc(): void {
  ipcMain.handle(DESKTOP_IPC.attachment, event => { assertTrustedSender(event); return attachment; });
  ipcMain.handle(DESKTOP_IPC.chooseFolder, async event => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(window!, { title: "选择工作区文件夹", properties: ["openDirectory"] });
    return { canceled: result.canceled, path: result.canceled ? undefined : result.filePaths[0] };
  });
  ipcMain.handle(DESKTOP_IPC.notification, (event, input: unknown) => {
    assertTrustedSender(event);
    if (!isDesktopNotificationInput(input)) throw new Error("desktop_notification_invalid：通知标题或内容超出允许范围");
    if (!Notification.isSupported()) return false;
    new Notification({ title: input.title, body: input.body }).show();
    return true;
  });
}

async function connectOrExplain(): Promise<DesktopAttachment | undefined> {
  for (;;) {
    try { return await findDaemon(); }
    catch (error) {
      const result = await dialog.showMessageBox({
        type: "warning", title: "Token Coupon 后台尚未就绪",
        message: "没有找到可安全附着的本机 daemon。应用只会连接 owner 身份和 HMAC 挑战均通过验证的后台。",
        detail: `${describeAttachmentFailure(error)}\n\n确认后台已启动后选择“重试”。`,
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

function installTray(): void {
  if (tray) return;
  try {
    const icon = join(here, process.platform === "win32" ? "token-coupon.ico" : "token-coupon.png");
    tray = new Tray(icon);
    tray.setToolTip("Token Coupon");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Token Coupon", click: showMainWindow },
      { type: "separator" },
      { label: "退出应用", click: () => { quitting = true; app.quit(); } },
    ]));
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
  await app.whenReady();
  windowStatePath = join(app.getPath("userData"), "window-state.json");
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const current = await connectOrExplain();
  if (!current) app.quit();
  else {
    attachment = current;
    registerIpc();
    window = await createWindow(current.origin);
    installTray();
  }
  app.on("activate", () => { if (!window && attachment) void createWindow(attachment.origin).then(created => { window = created; }); else showMainWindow(); });
  app.on("before-quit", () => { quitting = true; if (stateSaveTimer) clearTimeout(stateSaveTimer); saveWindowBounds(); });
  app.on("will-quit", () => { tray?.destroy(); tray = undefined; });
  app.on("window-all-closed", () => { if (!tray) app.quit(); });
}
