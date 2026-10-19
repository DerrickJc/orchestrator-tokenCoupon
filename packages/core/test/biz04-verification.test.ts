import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { httpAcceptancePassed, updateVerificationStatus } from "../../../scripts/biz04-verification-status.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const inspector = fileURLToPath(new URL("../../../scripts/phase7-biz04-inspect.mjs", import.meta.url));

describe("BIZ-04 result classification", () => {
  it.each(["preflight_failed", "read_error", "http_start_error"])("preserves findings when %s prevents HTTP verification", error => {
    const report = updateVerificationStatus({ checks: [{ name: "actual model missing", pass: false }], error, http: { status: "NOT_RUN" } });
    expect(report).toMatchObject({ localStatus: "FAIL_PRODUCT", status: "FAIL_PRODUCT", http: { status: "NOT_RUN" } });
  });
  it("keeps manual verification pending even after local HTTP passes", () => {
    expect(updateVerificationStatus({ checks: [{ pass: true }], sessionStatus: "succeeded", http: { status: "PASS" } })).toMatchObject({ localStatus: "PASS", status: "NOT_RUN" });
  });
  it("does not confuse successful HTTP with a clean metadata audit", () => {
    expect(updateVerificationStatus({ checks: [{ pass: false }], sessionStatus: "succeeded", http: { status: "PASS" } })).toMatchObject({ localStatus: "FAIL_PRODUCT", status: "FAIL_PRODUCT" });
  });
  it("requires all 25 fixed tests, including zero skips, cancellations and todos", () => {
    const tap = "# tests 25\n# pass 25\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
    expect(httpAcceptancePassed(tap, 0)).toBe(true);
    for (const changed of [tap.replace("tests 25", "tests 1"), tap.replace("pass 25", "pass 24"), tap.replace("fail 0", "fail 1"), tap.replace("skipped 0", "skipped 1"), tap.replace("cancelled 0", "cancelled 1"), tap.replace("todo 0", "todo 1"), ""]) {
      expect(httpAcceptancePassed(changed, 0)).toBe(false);
    }
    expect(httpAcceptancePassed(tap, 1)).toBe(false);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "biz04-inspector-")); roots.push(root);
  const repo = join(root, "biz-04-cross-dag-p3"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "Fixed fixture\n");
  git("add", "README.md"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture baseline");
  const manifest = { repositories: [{ name: "biz-04-cross-dag-p3", path: repo, maxParallel: 3, baseline: git("rev-parse", "HEAD"), protectedFiles: { "README.md": createHash("sha256").update("Fixed fixture\n").digest("hex") } }] };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, repo };
}
function inspect(root: string, args: string[] = []) {
  let stdout = "", code = 0;
  try { stdout = execFileSync(process.execPath, [inspector, "--root", root, "--repo", "p3", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { stdout = String((error as { stdout: string }).stdout); code = (error as { status: number }).status; }
  const output = JSON.parse(stdout);
  return { code, output, report: JSON.parse(readFileSync(output.report, "utf8")) };
}

describe("BIZ-04 inspector CLI with real Git fixtures", () => {
  it("reports a clean baseline without a Session as NOT_RUN, not PASS", () => {
    const { root } = fixture();
    expect(inspect(root)).toMatchObject({ code: 0, output: { localStatus: "NOT_RUN", status: "NOT_RUN", failedChecks: [] } });
  });
  it.each([{ args: [] }, { args: ["--run-http"] }])("does not hide altered fixtures on an early exit ($args)", ({ args }) => {
    const { root, repo } = fixture(); writeFileSync(join(repo, "README.md"), "Changed fixture\n");
    expect(inspect(root, args)).toMatchObject({ code: 1, output: { localStatus: "FAIL_PRODUCT", status: "FAIL_PRODUCT", httpStatus: "NOT_RUN" } });
  });
  it("preserves fixture failures when an incomplete Session causes an exception", () => {
    const { root, repo } = fixture(); writeFileSync(join(repo, "README.md"), "Changed fixture\n");
    const result = inspect(root, ["--session", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--run-http"]);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ localStatus: "FAIL_PRODUCT", status: "FAIL_PRODUCT", error: expect.stringContaining("ENOENT") });
  });
  it("does not claim PASS after an exception even when the inspected baseline was clean", () => {
    const { root } = fixture();
    expect(inspect(root, ["--session", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"])).toMatchObject({ code: 1, output: { status: "NOT_RUN", error: expect.stringContaining("ENOENT") } });
  });
});
