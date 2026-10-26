import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readDaemonOwnerCredential } from "../src/node.js";

it.runIf(process.platform !== "win32")("reads only an owner key protected by the current user's file and directory permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-discovery-"));
  const profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
  const ownerFile = join(profile, "daemon-owner.json");
  const value = { pid: 123, hostname: "test-host", platform: process.platform, processStart: "123456", port: 4177, token: "123e4567-e89b-42d3-a456-426614174000" };
  try {
    await writeFile(ownerFile, JSON.stringify(value), { mode: 0o600 });
    await expect(readDaemonOwnerCredential(profile)).resolves.toMatchObject({ token: value.token, owner: { pid: value.pid, processStart: value.processStart, port: value.port } });
    await writeFile(ownerFile, JSON.stringify({ ...value, port: 70000 }), { mode: 0o600 });
    await expect(readDaemonOwnerCredential(profile)).rejects.toThrow("daemon_discovery_owner_invalid");
    await writeFile(ownerFile, JSON.stringify(value), { mode: 0o600 });
    await chmod(ownerFile, 0o644);
    await expect(readDaemonOwnerCredential(profile)).rejects.toThrow("daemon_discovery_profile_unprotected");
    await chmod(ownerFile, 0o600); await chmod(profile, 0o777);
    await expect(readDaemonOwnerCredential(profile)).rejects.toThrow("daemon_discovery_profile_unprotected");
  } finally { await chmod(profile, 0o700); await rm(root, { recursive: true, force: true }); }
});
