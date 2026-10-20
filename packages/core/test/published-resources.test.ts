import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

it("runs the built demo from a package layout containing no source or test fixtures", async () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/desktop-portability-smoke.mjs")], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ platform: process.platform, packagedDemo: "passed", sourceOrTestsRequired: false });
  const metadata = JSON.parse(await readFile(join(process.cwd(), "packages/core/package.json"), "utf8")) as { files: string[] };
  expect(metadata.files).toContain("resources");
  expect(metadata.files).not.toContain("test");
});
