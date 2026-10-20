export interface DesktopAttachment {
  origin: string;
  port: number;
  epoch: string;
  profileId: string;
  protocol: { major: number; minor: number };
  applicationVersion: string;
  buildId: string;
}

export interface DesktopNotificationInput { title: string; body: string }

export const DESKTOP_IPC = Object.freeze({
  attachment: "token-coupon:attachment",
  chooseFolder: "token-coupon:choose-folder",
  notification: "token-coupon:notification",
});

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
  return typeof input.title === "string" && input.title.trim().length > 0 && input.title.length <= 80 &&
    typeof input.body === "string" && input.body.length <= 240;
}

export function describeAttachmentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 600 ? message : `${message.slice(0, 599)}…`;
}
