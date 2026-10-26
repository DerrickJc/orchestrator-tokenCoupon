import { expect, it, vi } from "vitest";
import { DesktopReconnector, type DesktopConnectionState } from "../src/desktop-reconnect.js";
import type { DesktopAttachment } from "../src/desktop-policy.js";

const attachment: DesktopAttachment = { origin: "http://127.0.0.1:4321", port: 4321, epoch: "new-epoch", profileId: "a".repeat(24), protocol: { major: 1, minor: 0 }, applicationVersion: "0.1.0", buildId: "build" };
const snapshot = JSON.stringify({ version: 1, route: "#/workspaces/example/plans/plan/draft", requestText: "未提交需求", planEdit: { text: "待修订内容" } });

function fixture(connect = vi.fn(async () => attachment)) {
  const states: DesktopConnectionState[] = [], load = vi.fn(async (_attachment: DesktopAttachment, _route: string) => {});
  const controller = new DesktopReconnector({ connect, expectedProfileId: () => attachment.profileId, load, changed: value => states.push(value) });
  return { controller, connect, load, states };
}

it("deduplicates explicit reconnects and retains a scoped draft until the new renderer acknowledges restoration", async () => {
  let ready!: (value: DesktopAttachment) => void;
  const h = fixture(vi.fn(() => new Promise<DesktopAttachment>(resolve => { ready = resolve; })));
  h.controller.disconnected(); expect(h.connect).not.toHaveBeenCalled();
  const first = h.controller.reconnect(snapshot), second = h.controller.reconnect("ignored duplicate");
  expect(first).toBe(second); await Promise.resolve(); expect(h.connect).toHaveBeenCalledTimes(1);
  ready(attachment); await first;
  expect(h.load).toHaveBeenCalledWith(attachment, "#/workspaces/example/plans/plan/draft");
  const saved = h.controller.recoverySnapshot!; expect(saved.snapshot).toBe(snapshot);
  h.controller.acknowledgeSnapshot("stale"); expect(h.controller.recoverySnapshot).toEqual(saved);
  h.controller.acknowledgeSnapshot(saved.id); expect(h.controller.recoverySnapshot).toBeUndefined();
  expect(h.states.map(value => value.phase)).toEqual(["disconnected", "reconnecting", "connected"]);
});

it("retains inputs after a failed connection and waits for an explicit retry", async () => {
  const h = fixture(vi.fn().mockRejectedValueOnce(new Error("owner unavailable")).mockResolvedValueOnce(attachment));
  await expect(h.controller.reconnect(snapshot)).rejects.toThrow("owner unavailable");
  expect(h.load).not.toHaveBeenCalled(); expect(h.connect).toHaveBeenCalledTimes(1);
  expect(h.controller.connectionState.phase).toBe("disconnected");
  expect(h.controller.recoverySnapshot?.snapshot).toBe(snapshot);
  await h.controller.reconnect(); expect(h.connect).toHaveBeenCalledTimes(2);
});

it("refuses another profile and retains drafts after a navigation failure", async () => {
  const h = fixture(vi.fn().mockResolvedValueOnce({ ...attachment, profileId: "b".repeat(24) }).mockResolvedValueOnce(attachment));
  await expect(h.controller.reconnect(snapshot)).rejects.toThrow("desktop_recovery_profile_changed");
  expect(h.load).not.toHaveBeenCalled();
  h.load.mockRejectedValueOnce(new Error("load failed"));
  await expect(h.controller.reconnect()).rejects.toThrow("load failed");
  expect(h.controller.recoverySnapshot?.snapshot).toBe(snapshot);
});

it("rejects invalid or oversized snapshots before starting any connection", () => {
  const h = fixture();
  for (const value of ["broken", "null", JSON.stringify({ version: 1, route: "https://evil.test" }), JSON.stringify({ version: 1, route: "#/x", text: "x".repeat(1024 * 1024) })]) {
    expect(() => h.controller.reconnect(value)).toThrow("desktop_recovery_state_invalid");
  }
  expect(h.connect).not.toHaveBeenCalled();
});
