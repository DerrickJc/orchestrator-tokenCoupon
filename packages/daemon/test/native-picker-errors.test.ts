import { beforeEach, expect, it, vi } from "vitest";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: execute });
  return { execFile };
});
vi.mock("../src/workspace-path.js", () => ({ workspaceEnvironment: () => ({ platform: "linux", isWsl: true }) }));
import { pickNativePath } from "../src/native-picker.js";
beforeEach(() => execute.mockReset());

it("returns an actionable locked-desktop error without leaking native output and permits a subsequent retry", async () => {
  execute.mockRejectedValueOnce({ stderr: "PowerShell details: TOKEN_COUPON_DESKTOP_UNAVAILABLE private-native-output", stdout: "TOKEN_COUPON_PICKER:starting" });
  await expect(pickNativePath("directory")).rejects.toThrow(/^native_picker_desktop_unavailable：.*远程使用请浏览后台目录/);
  expect(execute).toHaveBeenCalledTimes(1);
  execute.mockResolvedValueOnce({ stdout: 'TOKEN_COUPON_PICKER:starting\nTOKEN_COUPON_PICKER:dialog\n{"cancelled":false,"paths":["D:\\\\项目"]}\r\n' });
  const retry = await pickNativePath("directory");
  expect(retry.cancelled).toBe(false); expect(retry.paths).toHaveLength(1);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("does not open a Windows window for an already-cancelled browser request", async () => {
  const controller = new AbortController(); controller.abort();
  expect(await pickNativePath("directory", controller.signal)).toEqual({ cancelled: true, paths: [] });
  expect(execute).not.toHaveBeenCalled();
});
