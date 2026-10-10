import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunnerDiagnostics } from "./runner.js";

/** Command outputs can contain credentials; only selected status fields leave this module. */
export async function diagnoseNativeCli(executable: string, kind: "codex" | "claude-code", cwd: string): Promise<RunnerDiagnostics> {
  const [versionResult, authResult] = await Promise.all([
    capture(executable, ["--version"], cwd),
    capture(executable, kind === "codex" ? ["login", "status"] : ["auth", "status", "--json"], cwd),
  ]);
  const version = versionResult.text.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  let authentication: RunnerDiagnostics["authentication"] = "unknown";
  if (kind === "codex") {
    if (versionResult.ok && authResult.ok && /logged in/i.test(authResult.text) && !/not logged in/i.test(authResult.text)) authentication = "configured";
    else if (/not logged in/i.test(authResult.text)) authentication = "missing";
  } else {
    try {
      const auth = JSON.parse(authResult.text) as { loggedIn?: boolean };
      if (typeof auth.loggedIn === "boolean") authentication = auth.loggedIn ? "configured" : "missing";
    } catch { /* Unsupported versions and noisy output remain unknown. */ }
  }
  const candidates = kind === "codex"
    ? [join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), join(cwd, ".codex", "config.toml")]
    : [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
  const configurationSources: string[] = [];
  for (const path of candidates) if (await stat(path).then((info) => info.isFile()).catch(() => false)) configurationSources.push(path);
  return { ...(version ? { version } : {}), authentication, configurationSources, inference: "unverified" };
}

function capture(executable: string, args: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile(executable, args, { cwd, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, text: `${stdout}\n${stderr}`.trim() });
    });
  });
}
