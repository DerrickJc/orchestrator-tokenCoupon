import { expect, it } from "vitest";
import { publicJobRecord, publicRecoveryJobResult, publicSessionDiagnosis, publicSessionRecovery } from "../src/session-diagnosis.js";
import type { SessionDiagnosis } from "@token-coupon/core";

it("does not expose lock tokens or token-derived identities in public diagnostics", () => {
  const token = "private-owner-token-should-never-leave-the-daemon";
  const internal = {
    sessionId: "session", savedStatus: "running", revision: 4, isolation: "shared", maxParallel: 1,
    state: "active", locks: [{ path: "/workspace/.token-coupon/workspace.lock", exists: true, state: "active", reason: "owner active",
      identity: `1:2:${token}`, owner: { pid: 123, token, sessionId: "session", acquiredAt: "2026-10-20T00:00:00.000Z", hostname: "host", platform: "linux", processStart: "10" } }],
    attempts: [],
  } satisfies SessionDiagnosis;

  const result = publicSessionDiagnosis(internal);
  expect(result.locks[0]).not.toHaveProperty("identity");
  expect(result.locks[0]?.owner).toEqual({ pid: 123, sessionId: "session" });
  expect(JSON.stringify(result)).not.toContain(token);
});

it("redacts internal lock identity from recovery and persisted job result shapes", () => {
  const token = "private-recovery-token";
  const diagnosis = {
    sessionId: "session", savedStatus: "interrupted", revision: 8, isolation: "shared", maxParallel: 2,
    state: "owner_exited", locks: [{ path: "/workspace/.token-coupon/workspace.lock", exists: true, state: "stale", reason: "owner exited",
      identity: `2:3:${token}`, owner: { pid: 456, token, acquiredAt: "2026-10-20T00:00:00.000Z", hostname: "host", platform: "linux", processStart: "11" } }],
    attempts: [],
  } satisfies SessionDiagnosis;

  const recovery = publicSessionRecovery({ recovered: true, recoveryId: "recovery-id", diagnosis });
  const persisted = publicRecoveryJobResult({ recovered: true, recoveryId: "recovery-id", diagnosis, privateField: token });
  const job = publicJobRecord({ jobId: "job", kind: "session.recover", result: { recovered: true, recoveryId: "recovery-id", diagnosis, privateField: token } });
  for (const result of [recovery, persisted, job]) {
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("identity");
    expect(serialized).not.toContain("hostname");
    expect(serialized).not.toContain("processStart");
  }
  expect(persisted).not.toHaveProperty("privateField");
  expect(job.result).not.toHaveProperty("privateField");
});
