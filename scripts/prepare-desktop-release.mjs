import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Release assets are selected from a verified build report, never a directory glob.
export async function prepareDesktopRelease({ inputDirectory, outputDirectory, expectedBuildId }) {
  if (!/^[a-f0-9]{40}$/.test(expectedBuildId ?? "")) throw new Error("desktop_release_build_id_invalid");
  const report = JSON.parse(await readFile(join(inputDirectory, "desktop-build.json"), "utf8"));
  if (report.format !== 1 || report.platform !== "win32" || report.arch !== "x64" || report.mode !== "installer" || report.buildId !== expectedBuildId) {
    throw new Error("desktop_release_build_mismatch");
  }
  if (!Array.isArray(report.runtimeSmoke) || !report.runtimeSmoke.length || report.runtimeSmoke.some(smoke =>
    smoke.result?.daemonEntry !== "passed" || smoke.result?.mockPlanReviewApproveRun !== "passed" ||
    smoke.result?.restart !== "passed" || smoke.result?.staleWrite !== "rejected" ||
    smoke.size?.bundledAgentExecutables !== false)) throw new Error("desktop_release_smoke_missing");
  const filename = `Token-Coupon-${report.applicationVersion}-x64-preview-setup.exe`;
  if (!/^Token-Coupon-\d+\.\d+\.\d+-x64-preview-setup\.exe$/.test(filename)) throw new Error("desktop_release_filename_invalid");
  const installers = report.artifacts?.filter(asset => asset.path?.endsWith(".exe"));
  if (installers?.length !== 1 || installers[0].path !== filename || basename(installers[0].path) !== installers[0].path) {
    throw new Error("desktop_release_installer_invalid");
  }
  const artifact = installers[0], source = join(inputDirectory, filename), entry = await lstat(source);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== artifact.bytes || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
    throw new Error("desktop_release_integrity_failed");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256) throw new Error("desktop_release_integrity_failed");
  await mkdir(outputDirectory); // Existing release staging is never overwritten.
  try {
    await copyFile(source, join(outputDirectory, filename));
    await writeFile(join(outputDirectory, "SHA256SUMS"), `${artifact.sha256}  ${filename}\n`);
    await writeFile(join(outputDirectory, "RELEASE_NOTES.md"), `Windows x64 desktop preview\n\n` +
      `Build commit: \`${expectedBuildId}\`\n\n` +
      `Download **${filename}** below; you do not need the source archives or the Actions artifact ZIP.\n\n` +
      `SHA-256: \`${artifact.sha256}\` (${artifact.bytes} bytes).\n\n` +
      `This is an unsigned preview, not a stable release. Native Windows/Linux CI, packaged-runtime smoke and GUI checks must pass before publication. Clean-machine installation/upgrades and real business Runner acceptance remain pending.\n\n` +
      `Electron and Node are included. Codex/Claude Code are optional: reuse local tools, or open System Settings > Agent components. Optional automatic installation requires npm; login is separate.\n\n` +
      `Native Windows quick tunnels are not supported in this preview. User workspaces are retained on uninstall.\n\n` +
      `PowerShell checksum check:\n\n\`\`\`powershell\nGet-FileHash .\\${filename} -Algorithm SHA256\n\`\`\`\n`);
    return { filename, sha256: artifact.sha256, bytes: artifact.bytes, buildId: expectedBuildId };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, expectedBuildId, ...extra] = process.argv.slice(2);
  if (!input || !output || !expectedBuildId || extra.length) throw new Error("Usage: prepare-desktop-release.mjs <artifact-directory> <new-output-directory> <expected-commit>");
  console.log(JSON.stringify(await prepareDesktopRelease({ inputDirectory: resolve(input), outputDirectory: resolve(output), expectedBuildId })));
}
