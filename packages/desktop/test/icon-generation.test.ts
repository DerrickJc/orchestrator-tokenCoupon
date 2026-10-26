import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTrayIco, createTrayPng } from "../scripts/generate-icons.mjs";

describe("desktop tray icon resources", () => {
  it("generates transparent PNG resources and a multi-resolution Windows ICO", () => {
    const png = createTrayPng(32), ico = createTrayIco();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(ico.readUInt16LE(0)).toBe(0); expect(ico.readUInt16LE(2)).toBe(1); expect(ico.readUInt16LE(4)).toBe(8);
    expect(createTrayPng(256)).toEqual(readFileSync(new URL("../../web/public/app-icon.png", import.meta.url)));
    for (let index = 0; index < 8; index++) { const offset = ico.readUInt32LE(6 + index * 16 + 12), width = ico[6 + index * 16] || 256; expect(ico.readUInt32BE(offset + 16)).toBe(width); }
    expect(ico[6]).toBe(16); expect(ico[7]).toBe(16); expect(ico[6 + 7 * 16]).toBe(0); expect(ico[6 + 7 * 16 + 1]).toBe(0);
  });
});
