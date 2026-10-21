import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveDesktopUserData } from "../src/desktop-profile.js";

describe("desktop user data profiles", () => {
  it("keeps development and installed Chromium profiles separate", () => {
    const directory = join(tmpdir(), "Token Coupon");
    expect(resolveDesktopUserData(directory, true, {})).toBe(directory);
    expect(resolveDesktopUserData(directory, false, {})).toBe(`${directory}-development`);
  });

  it("accepts an explicit isolated profile and rejects ambiguous paths", () => {
    const configured = join(tmpdir(), "独立 桌面");
    expect(resolveDesktopUserData(tmpdir(), true, { TOKEN_COUPON_DESKTOP_HOME: configured })).toBe(resolve(configured));
    for (const value of ["", " ", "./profile"]) {
      expect(() => resolveDesktopUserData(tmpdir(), true, { TOKEN_COUPON_DESKTOP_HOME: value })).toThrow("desktop_user_data_invalid");
    }
    expect(() => resolveDesktopUserData("relative", true, {})).toThrow("desktop_user_data_unavailable");
  });
});
