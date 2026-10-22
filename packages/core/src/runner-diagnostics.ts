import { spawnNative } from "./native-command.js";
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
    let child;
    try { child = spawnNative(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch { resolve({ ok: false, text: "" }); return; }
    let text = "", limited = false, settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: ok && !limited, text: text.trim() }); };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 5000);
    const append = (chunk: string) => { text += chunk; if (text.length > 64 * 1024) { text = text.slice(0, 64 * 1024); limited = true; child.kill(); } };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
  });
}
