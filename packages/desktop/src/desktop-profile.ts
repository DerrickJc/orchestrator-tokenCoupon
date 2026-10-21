import { isAbsolute, resolve } from "node:path";

/** Resolve before taking Electron's instance lock so profiles never share its Chromium lock. */
export function resolveDesktopUserData(defaultDirectory: string, packaged: boolean, environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.TOKEN_COUPON_DESKTOP_HOME;
  if (configured !== undefined) {
    if (!configured.trim() || !isAbsolute(configured)) throw new Error("desktop_user_data_invalid：TOKEN_COUPON_DESKTOP_HOME 必须是非空绝对路径");
    return resolve(configured);
  }
  if (!isAbsolute(defaultDirectory)) throw new Error("desktop_user_data_unavailable：无法确定桌面用户目录");
  return packaged ? defaultDirectory : `${defaultDirectory}-development`;
}
