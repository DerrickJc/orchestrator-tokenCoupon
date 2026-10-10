import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentAttemptOwner, recoverAbandonedAttempt } from "../src/attempt-recovery.js";

const attemptId = "dacc5ce7-3b97-4038-936b-6b719888620f";
async function fixture(status = "running", owner?: Awaited<ReturnType<typeof currentAttemptOwner>>) {
  const workspace = await mkdtemp(join(tmpdir(), "attempt-recovery-"));
  const directory = join(workspace, ".token-coupon", "runs", attemptId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "attempt.json"), JSON.stringify({ attemptId, status, ...(owner ? { owner } : {}), markerSeen: false, finishedAt: null }));
  await writeFile(join(directory, "events.jsonl"), JSON.stringify({ sequence: 1, attemptId, type: "attempt.started", payload: {} }) + "\n");
  return { workspace, directory };
}
describe("abandoned Attempt recovery", () => {
  it("requires explicit native-process confirmation for legacy records and preserves a backup", async () => {
    const f = await fixture();
    try {
      const requestId = "d71318be-d4d9-4e93-a95d-a87ebd7b054f";
      await mkdir(join(f.directory, "interactions"));
      const requestPath = join(f.directory, "interactions", requestId + ".json");
      await writeFile(requestPath, JSON.stringify({ attemptId, requestId, status: "pending" }));
      await expect(recoverAbandonedAttempt({ workspace: f.workspace, attemptId })).rejects.toThrow("--confirm-stopped");
      const result = await recoverAbandonedAttempt({ workspace: f.workspace, attemptId, confirmedStopped: true });
      expect(result).toMatchObject({ status: "failed", reasonCode: "owner_interrupted", nativeOutcome: "incomplete", cleanupStatus: "unknown", markerSeen: false });
      expect((await readdir(f.directory)).some((name) => name.startsWith("attempt.before-recovery-"))).toBe(true);
      const events = (await readFile(join(f.directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      expect(events.at(-1)).toMatchObject({ sequence: 2, type: "attempt.recovered" });
      expect(JSON.parse(await readFile(requestPath, "utf8"))).toMatchObject({ status: "expired", reason: "owner_interrupted" });
    } finally { await rm(f.workspace, { recursive: true, force: true }); }
  });
  it("refuses to recover an active owner even with explicit confirmation", async () => {
    const f = await fixture("running", await currentAttemptOwner());
    try {
      await expect(recoverAbandonedAttempt({ workspace: f.workspace, attemptId, confirmedStopped: true })).rejects.toThrow("owner 仍在运行");
      expect(JSON.parse(await readFile(join(f.directory, "attempt.json"), "utf8")).status).toBe("running");
    } finally { await rm(f.workspace, { recursive: true, force: true }); }
  });
  it("leaves completed records untouched", async () => {
    const f = await fixture("succeeded");
    try { await expect(recoverAbandonedAttempt({ workspace: f.workspace, attemptId, confirmedStopped: true })).rejects.toThrow("已结束记录保持不变"); }
    finally { await rm(f.workspace, { recursive: true, force: true }); }
  });
});
