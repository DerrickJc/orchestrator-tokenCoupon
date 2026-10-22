import { expect, it } from "vitest";
import { currentOwner, observeOwner } from "../src/owner-lock.js";

it("keeps owners from another operating-system profile unknown rather than recoverable", async () => {
  const current = await currentOwner();
  expect(current.platform).toBe(process.platform);
  expect((await observeOwner(current)).state).toBe("active");
  const other = process.platform === "win32" ? "linux" : "win32";
  expect((await observeOwner({ ...current, platform: other })).state).toBe("unknown");
  expect((await observeOwner({ ...current, pid: 2147483647, platform: other })).state).toBe("unknown");
});
