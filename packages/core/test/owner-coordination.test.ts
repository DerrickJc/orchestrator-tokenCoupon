import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("coordinates independent processes and releases a crashed owner's guard", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/desktop-owner-smoke.mjs")], { encoding: "utf8", timeout: 40000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ processIdentity: "passed", contention: "passed", crashRelease: "passed", executionLock: "passed", crossPlatformOwner: "blocked" });
}, 45000);
