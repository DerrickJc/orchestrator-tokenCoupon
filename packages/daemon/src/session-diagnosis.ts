import type { SessionDiagnosis } from "@token-coupon/core";
import type { SessionDiagnosisDto } from "@token-coupon/client";

/** Remove internal lock identities and owner tokens before exposing diagnostics to HTTP clients. */
export function publicSessionDiagnosis(value: SessionDiagnosis): SessionDiagnosisDto {
  return {
    sessionId: value.sessionId, savedStatus: value.savedStatus, revision: value.revision, isolation: value.isolation, maxParallel: value.maxParallel, state: value.state,
    locks: value.locks.map(lock => ({
      path: lock.path, exists: lock.exists, state: lock.state, reason: lock.reason,
      ...(lock.owner ? { owner: { pid: lock.owner.pid, ...(lock.owner.sessionId !== undefined ? { sessionId: lock.owner.sessionId } : {}) } } : {}),
    })),
    attempts: value.attempts.map(attempt => ({ taskId: attempt.taskId, attemptId: attempt.attemptId, status: attempt.status, owner: { state: attempt.owner.state, reason: attempt.owner.reason } })),
  };
}

export function publicSessionRecovery(value: { diagnosis: SessionDiagnosis; recovered: boolean; recoveryId?: string }) {
  return { recovered: value.recovered, ...(value.recoveryId ? { recoveryId: value.recoveryId } : {}), diagnosis: publicSessionDiagnosis(value.diagnosis) };
}

export function publicRecoveryJobResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>, diagnosis = result.diagnosis;
  const safe: Record<string, unknown> = { recovered: result.recovered === true };
  if (typeof result.recoveryId === "string") safe.recoveryId = result.recoveryId;
  if (isSessionDiagnosis(diagnosis)) safe.diagnosis = publicSessionDiagnosis(diagnosis);
  return safe;
}

export function publicJobRecord<T extends { kind: string; result?: unknown }>(job: T): T {
  if (job.kind !== "session.recover" || job.result === undefined) return job;
  const { result, ...safeJob } = job;
  const safeResult = publicRecoveryJobResult(result);
  return { ...safeJob, ...(safeResult === undefined ? {} : { result: safeResult }) } as T;
}

function isSessionDiagnosis(value: unknown): value is SessionDiagnosis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.sessionId === "string" && typeof item.savedStatus === "string" && Number.isSafeInteger(item.revision) &&
    typeof item.isolation === "string" && Number.isSafeInteger(item.maxParallel) &&
    ["active", "owner_exited", "unknown", "identity_conflict", "idle"].includes(String(item.state)) && Array.isArray(item.locks) && Array.isArray(item.attempts);
}
