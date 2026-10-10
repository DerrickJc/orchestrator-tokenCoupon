import { describe, expect, it } from "vitest";
import { CompletionMarkerDetector, createCompletionProtocol } from "../src/completion-marker.js";
import type { TaskDefinition } from "../src/task.js";

describe("CompletionMarkerDetector", () => {
  const marker = "<<<TOKEN_COUPON_DONE:abc123>>>";
  it("makes the exact completion marker copy requirements explicit", () => {
    const task = {
      id: "marker-prompt",
      title: "Marker prompt",
      prompt: "Write a test",
      execution: { runnerId: "mock" },
    } as TaskDefinition;
    const protocol = createCompletionProtocol(task);
    expect(protocol.prompt).toContain("标记必须单独一行，不加引号或代码围栏");
    expect(protocol.prompt).toContain("保留开头三个 < 和末尾三个 >");
    expect(protocol.prompt.split("\n")).toContain(protocol.marker);
  });

  it("accepts an exact marker split across chunks with CRLF or EOF", () => {
    const detector = new CompletionMarkerDetector(marker);
    expect(detector.push(`中文内容\r\n${marker.slice(0, 11)}`)).toBe(false);
    expect(detector.push(marker.slice(11))).toBe(false);
    expect(detector.finish()).toBe(true);
  });

  it("rejects quoted and overlong lines", () => {
    const quoted = new CompletionMarkerDetector(marker);
    quoted.push(`回复中引用：${marker}\n`);
    expect(quoted.finish()).toBe(false);
    const longLine = new CompletionMarkerDetector(marker, 20);
    longLine.push(`${"x".repeat(21)}\n${marker}\n`);
    expect(longLine.finish()).toBe(false);
  });

  it("rejects the real failed reply with one missing closing bracket", () => {
    const exact = "<<<TOKEN_COUPON_DONE:8c1d021326e3adeaafc1149fb970325f13a5dbcf0ebd7fe6>>>";
    const detector = new CompletionMarkerDetector(exact);
    detector.push("2 tests passed, 0 failed\n\n" + exact.slice(0, -1));
    expect(detector.finish()).toBe(false);
  });
});
