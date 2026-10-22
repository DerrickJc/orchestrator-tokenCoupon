import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APPLICATION_VERSION } from "@token-coupon/client";

type BuildInfo = { format: 1; applicationVersion: string; buildId: string };
const validBuildId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 120 && /^[a-zA-Z0-9._+-]+$/.test(value);
function loadBuildInfo(): BuildInfo {
  try {
    const value = JSON.parse(readFileSync(fileURLToPath(new URL("./build-info.json", import.meta.url)), "utf8")) as Partial<BuildInfo>;
    if (value.format === 1 && value.applicationVersion === APPLICATION_VERSION && validBuildId(value.buildId)) return value as BuildInfo;
  } catch { /* Source-mode tests and older unpacked builds use an explicit fallback. */ }
  const configured = process.env.TOKEN_COUPON_BUILD_ID?.trim();
  return { format: 1, applicationVersion: APPLICATION_VERSION, buildId: validBuildId(configured) ? configured : "development" };
}

export const DAEMON_BUILD_INFO = Object.freeze(loadBuildInfo());
