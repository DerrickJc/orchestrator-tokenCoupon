import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { existingDesktopDirectory } from "../src/desktop-folders.js";

it("opens only a real absolute directory and rejects files, URLs and command text", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-desktop-folder-"));
  try {
    expect(await existingDesktopDirectory(root)).toBeTruthy();
    const file = join(root, "source.txt"); await writeFile(file, "keep");
    await expect(existingDesktopDirectory(file)).rejects.toThrow("只能打开文件夹");
    for (const value of ["relative", "https://example.test", "shell:startup", "file:///tmp", "explorer.exe /tmp", `${root}\0`, {}, null]) {
      await expect(existingDesktopDirectory(value)).rejects.toThrow("绝对目录");
    }
    await expect(existingDesktopDirectory(join(root, "missing"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
