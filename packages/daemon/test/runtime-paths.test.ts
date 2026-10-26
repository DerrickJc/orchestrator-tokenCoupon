import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveDaemonDataDirectory } from "../src/runtime-paths.js";

it("resolves explicit and environment paths consistently before acquiring an owner", () => {
  expect(resolveDaemonDataDirectory("explicit", { TOKEN_COUPON_DAEMON_HOME: "environment" })).toBe(resolve("explicit"));
  expect(resolveDaemonDataDirectory(undefined, { TOKEN_COUPON_DAEMON_HOME: "environment" })).toBe(resolve("environment"));
});

it("uses the OS user directory without a HOME variable and refuses ambiguous empty defaults", () => {
  expect(resolveDaemonDataDirectory(undefined, {})).toBe(join(homedir(), ".token-coupon", "daemon"));
  expect(() => resolveDaemonDataDirectory(undefined, {}, "")).toThrow("daemon_home_unavailable");
  expect(() => resolveDaemonDataDirectory(undefined, {}, "relative-home")).toThrow("daemon_home_unavailable");
  expect(() => resolveDaemonDataDirectory(" ", {})).toThrow("daemon_data_directory_invalid");
  expect(() => resolveDaemonDataDirectory(undefined, { TOKEN_COUPON_DAEMON_HOME: "" })).toThrow("daemon_data_directory_invalid");
});
