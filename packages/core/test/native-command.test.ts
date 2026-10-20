import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveNativeExecutable } from "../src/native-command.js";

it("resolves a real executable and does not treat a directory as a command", async () => {
  expect(await resolveNativeExecutable(process.execPath)).toBe(process.execPath);
  const root = await mkdtemp(join(tmpdir(), "token-coupon-command-test-"));
  try {
    await mkdir(join(root, "not-a-file"));
    await expect(resolveNativeExecutable(join(root, "not-a-file"))).rejects.toThrow();
    await expect(resolveNativeExecutable("absent", "missing", { PATH: "" })).rejects.toThrow("missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves arguments and blocks shell injection through a platform command shim", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/desktop-command-smoke.mjs")], { encoding: "utf8", timeout: 20000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ pathLookup: "passed", arguments: "passed", shellInjection: "blocked" });
}, 25000);
