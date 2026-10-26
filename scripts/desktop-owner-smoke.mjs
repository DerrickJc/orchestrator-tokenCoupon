import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLockCoordination, createExecutionLock, currentOwner, inspectLock, observeOwner } from "../packages/core/dist/owner-lock.js";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "try" || process.argv[2] === "hold") {
  try {
    const release = await acquireLockCoordination([process.argv[3]], 0);
    if (process.argv[2] === "hold") { process.stdout.write("ready\n"); process.stdin.resume(); await once(process.stdin, "end"); }
    await release();
  } catch (error) { process.stderr.write(String(error)); process.exitCode = 3; }
} else {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-owner-"));
  let release, holder;
  try {
    const path = join(root, "owner.lock");
    const owner = await currentOwner();
    assert.ok(owner.processStart, "OS process-start identity is missing");
    assert.equal((await observeOwner(owner)).state, "active");
    assert.equal((await observeOwner({ ...owner, processStart: "different" })).state, "owner_identity_changed");
    assert.equal((await observeOwner({ ...owner, platform: process.platform === "win32" ? "linux" : "win32" })).state, "unknown");
    release = await acquireLockCoordination([path], 0);
    const blocked = spawnSync(process.execPath, [script, "try", process.platform === "win32" ? path.toUpperCase() : path], { encoding: "utf8", timeout: 15000 });
    assert.equal(blocked.status, 3, blocked.stderr);
    assert.ok(blocked.stderr.includes("lock_coordination_busy"));
    await release(); release = undefined;
    const afterRelease = spawnSync(process.execPath, [script, "try", path], { encoding: "utf8", timeout: 15000 });
    assert.equal(afterRelease.status, 0, afterRelease.stderr);
    holder = spawn(process.execPath, [script, "hold", path], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(holder, "close");
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("holder startup timeout")), 15000);
      holder.stdout.on("data", chunk => { output += chunk; if (output.includes("ready\n")) { clearTimeout(timer); resolve(); } });
      holder.once("error", error => { clearTimeout(timer); reject(error); });
      holder.once("close", () => { clearTimeout(timer); reject(new Error("holder exited before readiness")); });
    });
    holder.kill("SIGKILL"); await closed; holder = undefined;
    release = await acquireLockCoordination([path], 3); await release(); release = undefined;
    const unlock = await createExecutionLock(path, "native-smoke");
    assert.equal((await inspectLock(path)).state, "active");
    await unlock(); assert.equal((await inspectLock(path)).exists, false);
    console.log(JSON.stringify({ platform: process.platform, node: process.version, processIdentity: "passed", contention: "passed", crashRelease: "passed", executionLock: "passed", crossPlatformOwner: "blocked" }));
  } finally {
    holder?.kill("SIGKILL");
    await release?.();
    await rm(root, { recursive: true, force: true });
  }
}
