import { describe, expect, it } from "vitest";
import { createTrayIco, createTrayPng } from "../scripts/generate-icons.mjs";

describe("desktop tray icon resources", () => {
  it("generates transparent PNG resources and a multi-resolution Windows ICO", () => {
    const png = createTrayPng(32), ico = createTrayIco();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(ico.readUInt16LE(0)).toBe(0); expect(ico.readUInt16LE(2)).toBe(1); expect(ico.readUInt16LE(4)).toBe(8);
    expect(ico[6]).toBe(16); expect(ico[7]).toBe(16); expect(ico[6 + 7 * 16]).toBe(0); expect(ico[6 + 7 * 16 + 1]).toBe(0);
  });
});
