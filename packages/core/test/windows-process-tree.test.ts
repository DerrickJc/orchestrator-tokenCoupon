import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "win32")("cleans owned Windows descendants on cancel, normal exit and parent crash", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/desktop-process-tree-smoke.mjs")], { encoding: "utf8", timeout: 45000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ stdio: "byte-exact", cancelTree: "passed", normalExit: "passed", parentCrash: "passed", unrelatedProcess: "preserved" });
}, 50000);
