import { expect, it, vi } from "vitest";
import { runDaemonCli } from "../src/daemon-cli.js";

it("rejects invalid daemon commands before connecting and never treats them as legacy commands", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const args of [["planning", "run"], ["planning", "pause", "--workspace-id", "w", "--planning-id", "p", "--accept-edits"],
      ["pending", "--offset", "-1"], ["pending", "--data-dir", "one", "--data-dir", "two"],
      ["status", "--url", "https://untrusted.example"], ["planning", "approve", "--workspace-id", "w", "--planning-id", "p", "--draft-revision", "bad"]]) {
      expect(await runDaemonCli(args)).toBe(2);
    }
    expect(log.mock.calls.flat().join(" ")).not.toContain("daemon_discovery");
  } finally { log.mockRestore(); }
});

it("documents a fail-closed shared-owner mode and asynchronous job receipts", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runDaemonCli(["--help"])).toBe(0);
    expect(log.mock.calls.flat().join(" ")).toContain("不启动第二个调度器");
    expect(log.mock.calls.flat().join(" ")).toContain("daemon job show");
  } finally { log.mockRestore(); }
});
