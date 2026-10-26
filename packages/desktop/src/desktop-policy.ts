export interface DesktopAttachment {
  origin: string;
  port: number;
  epoch: string;
  profileId: string;
  protocol: { major: number; minor: number };
  applicationVersion: string;
  buildId: string;
}

export interface DesktopNotificationInput { title: string; body: string; workspaceId?: string; planningId?: string; taskId?: string }
export interface DesktopNotificationTarget { workspaceId: string; planningId: string; taskId?: string }

export const DESKTOP_IPC = Object.freeze({
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

export function isDesktopClipboardText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1_048_576;
}

export function isAllowedDaemonOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.username === "" && url.password === "" &&
      url.pathname === "/" && url.search === "" && url.hash === "" && Number(url.port) >= 1024 && Number(url.port) <= 65535;
  } catch { return false; }
}

export function isTrustedRendererUrl(value: string, expectedOrigin: string): boolean {
  try { return new URL(value).origin === expectedOrigin && isAllowedDaemonOrigin(expectedOrigin); }
  catch { return false; }
}

export function isTrustedIpcContext(senderIsWindow: boolean, frameIsMainFrame: boolean, frameUrl: string, expectedOrigin: string): boolean {
  return senderIsWindow && frameIsMainFrame && isTrustedRendererUrl(frameUrl, expectedOrigin);
}

export function isDesktopNotificationInput(value: unknown): value is DesktopNotificationInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<DesktopNotificationInput>;
  const hasWorkspace = typeof input.workspaceId === "string", hasPlanning = typeof input.planningId === "string";
  return typeof input.title === "string" && input.title.trim().length > 0 && input.title.length <= 80 &&
    typeof input.body === "string" && input.body.length <= 240 && hasWorkspace === hasPlanning &&
    (!hasWorkspace || /^[A-Za-z0-9_-]{1,128}$/.test(input.workspaceId!)) &&
    (!hasPlanning || /^[0-9a-f-]{36}$/i.test(input.planningId!)) &&
    (input.taskId === undefined || typeof input.taskId === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(input.taskId) && hasWorkspace && hasPlanning);
}

export function describeAttachmentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 600 ? message : `${message.slice(0, 599)}…`;
}
