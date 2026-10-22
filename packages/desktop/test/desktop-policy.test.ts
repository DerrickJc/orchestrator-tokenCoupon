import { describe, expect, it } from "vitest";
import { describeAttachmentFailure, isAllowedDaemonOrigin, isDesktopNotificationInput, isTrustedIpcContext, isTrustedRendererUrl } from "../src/desktop-policy.js";

describe("desktop security policy", () => {
  it("accepts only loopback HTTP origins with an explicit local port", () => {
    expect(isAllowedDaemonOrigin("http://127.0.0.1:4177")).toBe(true);
    for (const value of ["https://127.0.0.1:4177", "http://localhost:4177", "http://127.0.0.1", "http://127.0.0.1:80", "http://127.0.0.1.evil:4177", "http://user@127.0.0.1:4177"]) {
      expect(isAllowedDaemonOrigin(value)).toBe(false);
    }
  });

  it("binds renderer IPC trust to the exact verified origin", () => {
    const origin = "http://127.0.0.1:4177";
    expect(isTrustedRendererUrl(`${origin}/#/workspace`, origin)).toBe(true);
    expect(isTrustedIpcContext(true, true, `${origin}/`, origin)).toBe(true);
    expect(isTrustedIpcContext(false, true, `${origin}/`, origin)).toBe(false);
    expect(isTrustedIpcContext(true, false, `${origin}/`, origin)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:4178/", origin)).toBe(false);
    expect(isTrustedRendererUrl("https://attacker.example/", origin)).toBe(false);
    expect(isTrustedRendererUrl("file:///tmp/hostile.html", origin)).toBe(false);
  });

  it("bounds notification text and attachment error detail", () => {
    expect(isDesktopNotificationInput({ title: "待审批", body: "任务需要你的决定" })).toBe(true);
    expect(isDesktopNotificationInput({ title: "待审批", body: "任务需要你的决定", workspaceId: "a1b2c3", planningId: "123e4567-e89b-12d3-a456-426614174000", taskId: "TASK-01" })).toBe(true);
    expect(isDesktopNotificationInput({ title: " ", body: "x" })).toBe(false);
    expect(isDesktopNotificationInput({ title: "a".repeat(81), body: "x" })).toBe(false);
    expect(isDesktopNotificationInput({ title: "ok", body: "x".repeat(241) })).toBe(false);
    expect(isDesktopNotificationInput({ title: "ok", body: "x", workspaceId: "../../secret", planningId: "123e4567-e89b-12d3-a456-426614174000" })).toBe(false);
    expect(isDesktopNotificationInput({ title: "ok", body: "x", taskId: "../../secret" })).toBe(false);
    expect(describeAttachmentFailure(new Error("x".repeat(700)))).toHaveLength(600);
  });
});
