import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(packageDirectory, "../..");
const packageInfo = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
function git(args) {
  try { return execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim(); }
  catch { return ""; }
}
const explicit = process.env.TOKEN_COUPON_BUILD_ID?.trim();
const commit = git(["rev-parse", "--short=12", "HEAD"]);
const dirty = commit ? git(["status", "--porcelain"]).length > 0 : false;
const buildId = explicit || (commit ? `${commit}${dirty ? "-dirty" : ""}` : "development");
if (buildId.length > 120 || !/^[a-zA-Z0-9._+-]+$/.test(buildId)) throw new Error("build_id_invalid：TOKEN_COUPON_BUILD_ID 只能包含字母、数字、点、下划线、加号或连字符，且不超过 120 字符");
const output = join(packageDirectory, "dist", "build-info.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ format: 1, applicationVersion: packageInfo.version, buildId }, null, 2)}\n`);
