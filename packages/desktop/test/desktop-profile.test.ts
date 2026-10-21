import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveDaemonProfileDirectory, resolveDesktopUserData, sameDaemonDirectory, secondInstanceDirectory } from "../src/desktop-profile.js";

describe("desktop user data profiles", () => {
  it("distinguishes second-instance profiles including environment-selected directories", () => {
    const home = tmpdir(), current = join(home, "daemon-a"), requested = join(home, "daemon-b");
    expect(resolveDaemonProfileDirectory([], { TOKEN_COUPON_DAEMON_HOME: current }, home)).toBe(current);
    expect(secondInstanceDirectory([], { dataDirectory: requested }, home)).toBe(requested);
    expect(sameDaemonDirectory(current, secondInstanceDirectory([], { dataDirectory: current }, home))).toBe(true);
    expect(sameDaemonDirectory(current, requested)).toBe(false);
    expect(secondInstanceDirectory(["--data-dir", requested], {}, home)).toBe(requested);
    expect(secondInstanceDirectory([`--data-dir=${requested}`], {}, home)).toBe(requested);
    expect(() => secondInstanceDirectory([], {}, home)).toThrow("desktop_second_profile_unknown");
    expect(() => secondInstanceDirectory([], { dataDirectory: "relative" }, home)).toThrow("desktop_data_directory_invalid");
    expect(() => secondInstanceDirectory([], { dataDirectory: null }, home)).toThrow("desktop_second_profile_invalid");
    for (const args of [["--data-dir"], ["--data-dir", "--other"], ["--data-dir="], ["--data-dir", current, `--data-dir=${requested}`]]) {
      expect(() => resolveDaemonProfileDirectory(args, {}, home)).toThrow("desktop_data_directory_invalid");
    }
  });
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
