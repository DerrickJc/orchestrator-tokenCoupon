import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
// @ts-expect-error Maintainer script verifies actual physical file sizes.
const { directoryFootprint } = await import("../../../scripts/desktop-measurements.mjs");

it("counts UTF-8 bytes and nested files without returning filenames or content", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-desktop-metrics-"));
  try {
    await mkdir(join(root, "nested")); await writeFile(join(root, "file"), "hello"); await writeFile(join(root, "nested", "中文"), "你好");
    expect(await directoryFootprint(root)).toEqual({ logicalBytes: 11, files: 2, directories: 2, linksNotFollowed: 0 });
    await expect(directoryFootprint("relative")).rejects.toThrow("desktop_metrics_directory_invalid");
    if (process.platform !== "win32") {
      await symlink(root, join(root, "loop"));
      expect((await directoryFootprint(root)).linksNotFollowed).toBe(1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
