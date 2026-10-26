import { describe, expect, it } from "vitest";
import { restoreWindowBounds } from "../src/window-state.js";

const primary = { x: 0, y: 0, width: 1920, height: 1080 };

describe("desktop window bounds recovery", () => {
  it("restores and clamps a saved window on the display where most of it remained visible", () => {
    const other = { x: -1600, y: -120, width: 1600, height: 900 };
    expect(restoreWindowBounds({ x: -1550, y: 20, width: 1500, height: 800 }, [primary, other])).toEqual({ x: -1550, y: -20, width: 1500, height: 800 });
    expect(restoreWindowBounds({ x: 1750, y: 900, width: 1600, height: 900 }, [primary])).toEqual({ x: 320, y: 180, width: 1600, height: 900 });
  });

  it("recenters a removed-monitor window and clamps sizes on a smaller display", () => {
    expect(restoreWindowBounds({ x: -3000, y: 20, width: 1500, height: 900 }, [primary])).toEqual({ x: 210, y: 90, width: 1500, height: 900 });
    expect(restoreWindowBounds({ x: 0, y: 0, width: 5000, height: 3000 }, [{ x: 0, y: 0, width: 1200, height: 700 }])).toEqual({ x: 0, y: 0, width: 1200, height: 700 });
  });

  it("ignores malformed state and uses a centered default", () => {
    expect(restoreWindowBounds({ x: "left", y: 0 }, [{ x: 100, y: 50, width: 1600, height: 900 }])).toEqual({ x: 180, y: 50, width: 1440, height: 900 });
    expect(restoreWindowBounds(null, [])).toEqual({ x: 0, y: 0, width: 1440, height: 960 });
  });
});
