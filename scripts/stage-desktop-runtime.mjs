// Assemble installed production files without workspace symlinks, source or test fixtures.
// This is an unpacked development stage, not a signed installer or cross-platform dependency build.
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function stageDesktopRuntime(source = fileURLToPath(new URL("../", import.meta.url))) {
  source = await realpath(source);
  const root = await mkdtemp(join(tmpdir(), "token-coupon-runtime-"));
  const skippedOptional = [], copied = [];
  async function copy(sourcePath, destination) {
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination, { recursive: true, dereference: true, filter: async candidate => {
      const child = relative(sourcePath, candidate);
      if (child.split(sep).includes("node_modules")) return false;
      const resolved = await realpath(candidate);
      const within = relative(source, resolved);
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("runtime_resource_outside_source");
      return true;
    } });
  }
  try {
    const lock = JSON.parse(await readFile(join(source, "package-lock.json"), "utf8"));
    for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
      if (!path.startsWith("node_modules/") || entry.dev || entry.link) continue;
      if (path.split("/").some(part => part === ".." || part === ".") || path.includes("\\")) throw new Error("runtime_dependency_path_invalid");
      const from = join(source, path);
      try { await lstat(from); }
      catch (error) { if (error.code === "ENOENT" && entry.optional) { skippedOptional.push(path); continue; } throw error; }
      await copy(from, join(root, path)); copied.push(path);
    }
    for (const name of ["client", "core", "daemon", "web", "cli"]) {
      const from = join(source, "packages", name), destination = join(root, "node_modules", "@token-coupon", name);
      await mkdir(destination, { recursive: true });
      await copy(join(from, "package.json"), join(destination, "package.json"));
      await copy(join(from, "dist"), join(destination, "dist"));
      if (name === "core") await copy(join(from, "resources"), join(destination, "resources"));
      copied.push(`@token-coupon/${name}`);
    }
    const manifest = { format: 1, kind: "unpacked-development-stage", hostPlatform: process.platform, hostArch: process.arch, packages: copied, skippedOptional,
      daemonEntry: "node_modules/@token-coupon/daemon/dist/main.js",
      releaseReady: false };
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { root, ...manifest, daemonEntry: join(root, manifest.daemonEntry) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await stageDesktopRuntime()));
