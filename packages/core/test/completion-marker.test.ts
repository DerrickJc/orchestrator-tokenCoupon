import { describe, expect, it } from "vitest";
import { CompletionMarkerDetector } from "../src/completion-marker.js";

describe("CompletionMarkerDetector", () => {
  const marker = "<<<TOKEN_COUPON_DONE:abc123>>>";
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
});
