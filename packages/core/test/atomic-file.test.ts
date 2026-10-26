import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { atomicWrite } from "../src/atomic-file.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
afterEach(async () => { Object.defineProperty(process, "platform", platform); vi.mocked(rename).mockRestore(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "tc-atomic-")); roots.push(root); const path = join(root, "conversation.json"); await writeFile(path, "old snapshot"); return { root, path }; }

it("retries transient Windows file locks and exposes only a complete old or new snapshot", async () => {
  const { root, path } = await fixture(); Object.defineProperty(process, "platform", { value: "win32" });
  vi.mocked(rename).mockImplementationOnce(async () => { expect(await readFile(path, "utf8")).toBe("old snapshot"); throw Object.assign(new Error("locked"), { code: "EPERM" }); })
    .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
  await atomicWrite(path, "new snapshot");
  expect(rename).toHaveBeenCalledTimes(3); expect(await readFile(path, "utf8")).toBe("new snapshot"); expect(await readdir(root)).toEqual(["conversation.json"]);
});

it("bounds persistent Windows permission failures, preserving the previous file and removing its own temporary file", async () => {
  const { root, path } = await fixture(); Object.defineProperty(process, "platform", { value: "win32" });
  vi.mocked(rename).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  await expect(atomicWrite(path, "unpublished")).rejects.toMatchObject({ code: "EACCES" });
  expect(rename).toHaveBeenCalledTimes(8); expect(await readFile(path, "utf8")).toBe("old snapshot"); expect(await readdir(root)).toEqual(["conversation.json"]);
});

it("does not retry unrelated I/O failures or POSIX permission failures", async () => {
  for (const [os, code] of [["win32", "ENOSPC"], ["linux", "EPERM"]]) {
    const { root, path } = await fixture(); Object.defineProperty(process, "platform", { value: os });
    vi.mocked(rename).mockClear().mockRejectedValue(Object.assign(new Error("failed"), { code }));
    await expect(atomicWrite(path, "unpublished")).rejects.toMatchObject({ code });
    expect(rename).toHaveBeenCalledTimes(1); expect(await readFile(path, "utf8")).toBe("old snapshot"); expect(await readdir(root)).toEqual(["conversation.json"]);
  }
});
