import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Release script exercised through actual asset preparation.
const { prepareDesktopRelease } = await import("../../../scripts/prepare-desktop-release.mjs");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const inputDirectory = await mkdtemp(join(tmpdir(), "token-coupon-release-")); roots.push(inputDirectory);
  const filename = "Token-Coupon-0.1.0-x64-preview-setup.exe", contents = Buffer.from("verified installer fixture");
  const expectedBuildId = "a".repeat(40), sha256 = createHash("sha256").update(contents).digest("hex");
  const report = { format: 1, platform: "win32", arch: "x64", mode: "installer", applicationVersion: "0.1.0", buildId: expectedBuildId,
    runtimeSmoke: [{ result: { daemonEntry: "passed", mockPlanReviewApproveRun: "passed", restart: "passed", staleWrite: "rejected" }, size: { bundledAgentExecutables: false } }],
    artifacts: [{ path: filename, bytes: contents.length, sha256 }] };
  await writeFile(join(inputDirectory, filename), contents);
  await writeFile(join(inputDirectory, "desktop-build.json"), JSON.stringify(report));
  await writeFile(join(inputDirectory, "private.log"), "not for publication");
  return { inputDirectory, outputDirectory: join(inputDirectory, "release"), expectedBuildId, filename, sha256, report };
}
describe("desktop prerelease staging", () => {
  it("publishes only the exact installer and checksum without internal reports or logs", async () => {
    const f = await fixture();
    expect(await prepareDesktopRelease(f)).toMatchObject({ filename: f.filename, sha256: f.sha256 });
    expect((await readdir(f.outputDirectory)).sort()).toEqual(["RELEASE_NOTES.md", "SHA256SUMS", f.filename].sort());
    expect(await readFile(join(f.outputDirectory, "SHA256SUMS"), "utf8")).toBe(`${f.sha256}  ${f.filename}\n`);
    const notes = await readFile(join(f.outputDirectory, "RELEASE_NOTES.md"), "utf8");
    expect(notes).toContain("unsigned preview");
    expect(notes).toContain("Native Windows quick connections are supported");
    expect(notes).toContain("Apache-2.0");
    expect(notes).not.toContain("not supported in this preview");
    await expect(prepareDesktopRelease(f)).rejects.toThrow();
  });
  it("rejects another commit, invalid paths, missing checks and corrupt installer bytes", async () => {
    const f = await fixture();
    await expect(prepareDesktopRelease({ ...f, expectedBuildId: "b".repeat(40) })).rejects.toThrow("build_mismatch");
    f.report.artifacts[0]!.path = "../" + f.filename;
    await writeFile(join(f.inputDirectory, "desktop-build.json"), JSON.stringify(f.report));
    await expect(prepareDesktopRelease(f)).rejects.toThrow("installer_invalid");
    f.report.artifacts[0]!.path = f.filename;
    f.report.runtimeSmoke[0]!.result.restart = "failed";
    await writeFile(join(f.inputDirectory, "desktop-build.json"), JSON.stringify(f.report));
    await expect(prepareDesktopRelease(f)).rejects.toThrow("smoke_missing");
    f.report.runtimeSmoke[0]!.result.restart = "passed";
    await writeFile(join(f.inputDirectory, "desktop-build.json"), JSON.stringify(f.report));
    await writeFile(join(f.inputDirectory, f.filename), Buffer.alloc(f.report.artifacts[0]!.bytes));
    await expect(prepareDesktopRelease(f)).rejects.toThrow("integrity_failed");
    await expect(readFile(join(f.outputDirectory, "SHA256SUMS"))).rejects.toThrow();
  });
});
