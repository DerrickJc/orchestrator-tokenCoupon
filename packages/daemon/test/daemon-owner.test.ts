import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { currentOwner } from "@token-coupon/core";
import { readDaemonOwnerCredential } from "@token-coupon/client/node";
import { acquireDaemonOwner } from "../src/daemon-owner.js";
import { prepareTunnelDirectory } from "../src/private-gateway.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(process.platform === "win32" ? homedir() : tmpdir(), ".tc-owner-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Only protect the test container. The daemon profile itself must be prepared
  // by the normal production startup path, without the acceptance launcher.
  if (process.platform === "win32") await prepareTunnelDirectory(root);
  return { root, profile: join(root, "profile") };
}
async function broadAcl(path: string, directory: boolean, rights = "ReadAndExecute") {
  const encoded = Buffer.from(path).toString("base64");
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');$a=[IO.${directory ? "Directory" : "File"}]::GetAccessControl($p);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'${rights}',${directory ? "'ContainerInherit,ObjectInherit','None'," : ""}'Allow'));[IO.${directory ? "Directory" : "File"}]::SetAccessControl($p,$a)`;
  await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10000 });
}
it("creates a discoverable credential on the ordinary daemon startup path and releases it", async () => {
  const h = await fixture(), release = await acquireDaemonOwner(h.profile, 4177); cleanups.push(release);
  expect(await readDaemonOwnerCredential(h.profile)).toMatchObject({ token: release.token, owner: { pid: process.pid, port: 4177 } });
  await release();
  await expect(readFile(join(h.profile, "daemon-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);
it("keeps an active owner's credential instead of overwriting it", async () => {
  const h = await fixture(), release = await acquireDaemonOwner(h.profile); cleanups.push(release);
  const before = await readFile(join(h.profile, "daemon-owner.json"));
  await expect(acquireDaemonOwner(h.profile)).rejects.toThrow("daemon_owner_conflict");
  expect(await readFile(join(h.profile, "daemon-owner.json"))).toEqual(before);
}, 30000);
it("refuses linked profiles before writing through them", async () => {
  const h = await fixture(), target = join(h.root, "outside"); await mkdir(target);
  await symlink(target, h.profile, process.platform === "win32" ? "junction" : "dir");
  await expect(acquireDaemonOwner(h.profile)).rejects.toThrow("daemon_profile_invalid");
  expect(await readdir(target)).toEqual([]);
}, 30000);
it.runIf(process.platform === "win32")("protects an inherited broadly readable Windows profile before creating its key", async () => {
  const h = await fixture(); await mkdir(h.profile); await broadAcl(h.profile, true);
  await writeFile(join(h.profile, "workspaces.json"), "[]\n");
  const release = await acquireDaemonOwner(h.profile); cleanups.push(release);
  expect((await readDaemonOwnerCredential(h.profile)).token).toBe(release.token);
  expect(await readFile(join(h.profile, "workspaces.json"), "utf8")).toBe("[]\n");
}, 30000);
it.runIf(process.platform === "win32")("rotates a stopped legacy owner's key, retaining its record and existing state", async () => {
  const h = await fixture(); await mkdir(h.profile); await broadAcl(h.profile, true);
  const legacy = { ...await currentOwner(), pid: 2147483647, processStart: "1", token: randomUUID(), sessionId: null, acquiredAt: new Date().toISOString() };
  await writeFile(join(h.profile, "daemon-owner.json"), JSON.stringify(legacy));
  await writeFile(join(h.profile, "workspaces.json"), "[]\n");
  const release = await acquireDaemonOwner(h.profile); cleanups.push(release);
  expect((await readDaemonOwnerCredential(h.profile)).token).not.toBe(legacy.token);
  const saved = (await readdir(h.profile)).find(name => name.endsWith(".interrupted"));
  expect(saved).toBeDefined();
  expect(JSON.parse(await readFile(join(h.profile, saved!), "utf8"))).toEqual(legacy);
  expect(await readFile(join(h.profile, "workspaces.json"), "utf8")).toBe("[]\n");
}, 30000);
it.runIf(process.platform === "win32")("does not adopt an active legacy owner merely by changing its ACL", async () => {
  const h = await fixture(), release = await acquireDaemonOwner(h.profile); cleanups.push(release);
  const path = join(h.profile, "daemon-owner.json"), before = await readFile(path);
  await broadAcl(path, false);
  await expect(acquireDaemonOwner(h.profile)).rejects.toThrow("daemon_owner_conflict");
  await expect(readDaemonOwnerCredential(h.profile)).rejects.toThrow("daemon_discovery_profile_unprotected");
  expect(await readFile(path)).toEqual(before);
}, 30000);
it.runIf(process.platform === "win32")("rejects a writable parent and removes its new key without changing that parent", async () => {
  const h = await fixture(), parent = join(h.root, "shared"); await mkdir(parent); await broadAcl(parent, true, "Modify");
  const profile = join(parent, "profile");
  await expect(acquireDaemonOwner(profile)).rejects.toThrow("daemon_discovery_profile_unprotected");
  await expect(readFile(join(profile, "daemon-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);
