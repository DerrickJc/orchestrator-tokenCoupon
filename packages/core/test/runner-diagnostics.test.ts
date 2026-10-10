import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { diagnoseNativeCli } from "../src/runner-diagnostics.js";

describe("local Runner diagnostics", () => {
  it("reports version and configured authentication without exposing command output or credentials", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runner-doctor-"));
    try {
      const executable = join(cwd, "fake-cli");
      await writeFile(executable, '#!/usr/bin/env node\nconsole.log(process.argv[2]==="--version"?"codex-cli 0.162.0":"Logged in using API key: sensitive-credential");', { mode: 0o700 });
      const result = await diagnoseNativeCli(executable, "codex", cwd);
      expect(result).toMatchObject({ version: "0.162.0", authentication: "configured", inference: "unverified" });
      expect(JSON.stringify(result)).not.toContain("sensitive-credential");
      await writeFile(executable, '#!/usr/bin/env node\nconsole.log(process.argv[2]==="--version"?"codex-cli 0.162.0":"Not logged in");', { mode: 0o700 });
      expect((await diagnoseNativeCli(executable, "codex", cwd)).authentication).toBe("missing");
      await writeFile(executable, '#!/usr/bin/env node\nconsole.log(process.argv[2]==="--version"?"2.1.287":{"loggedIn":true,"apiKey":"sensitive-credential"});', { mode: 0o700 });
      // A noisy or unsupported JSON format stays unknown; it must not imply model access.
      expect((await diagnoseNativeCli(executable, "claude-code", cwd)).authentication).toBe("unknown");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
