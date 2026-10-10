import { describe, expect, it } from "vitest";
import { determineVerdict } from "../src/verdict.js";

describe("managed completion verdict", () => {
  it("does not invent a process exit code for an SDK result", () => {
    const verdict = determineVerdict({ markerSeen: true, recordingFailed: false, stopReason: null,
      process: { started: true, transport: "sdk", exitCode: null, signal: null, nativeOutcome: "completed", cleanupStatus: "completed" } });
    expect(verdict.status).toBe("succeeded");
    expect(verdict.reason).toContain("原生执行完成");
    expect(verdict.reason).not.toContain("退出码 0");
  });
  it("retains an ordinary successful process exit description", () => {
    expect(determineVerdict({ markerSeen: true, recordingFailed: false, stopReason: null,
      process: { started: true, exitCode: 0, signal: null } }).reason).toContain("退出码 0");
  });
});
