import { diagnoseSession, type SessionSnapshot } from "@token-coupon/core";

/** Observe process identity without rewriting checkpoints or moving execution locks. */
export async function observeSession(workspace: string, snapshot: SessionSnapshot) {
  const checkedAt = new Date().toISOString();
  const needsCheck = ["running", "pausing"].includes(snapshot.status) || snapshot.tasks.some(task => task.status === "running" || task.activeAttemptId);
  if (!needsCheck) return { status: snapshot.status, health: { state: "idle", checkedAt, recoveryRequired: false, message: "当前没有记录中的活动执行。" }, tasks: new Map<string, string>() };
  try {
    const diagnosis = await diagnoseSession(workspace, snapshot.sessionId);
    if (diagnosis.revision !== snapshot.revision) throw new Error("session_changed_during_observation");
    const stopped = ["owner_exited", "idle"].includes(diagnosis.state);
    const uncertain = ["unknown", "identity_conflict"].includes(diagnosis.state);
    const tasks = new Map<string, string>();
    for (const task of snapshot.tasks.filter(item => item.status === "running")) {
      const owner = diagnosis.attempts.find(item => item.taskId === task.taskId)?.owner;
      if (stopped || owner && ["owner_exited", "owner_identity_changed"].includes(owner.state)) tasks.set(task.taskId, "interrupted");
      else if (uncertain) tasks.set(task.taskId, "unavailable");
    }
    return { status: stopped ? "interrupted" : uncertain ? "unavailable" : snapshot.status, tasks,
      health: { state: diagnosis.state, checkedAt, recoveryRequired: stopped, message: stopped
        ? "原执行 owner 已退出或身份变化，保存的运行状态已过期。请先核验 Runner 已停止并修复状态，再重试中断任务、继续剩余任务。"
        : uncertain ? "执行身份无法确认或存在冲突，暂不能判断正在运行，也不能安全解锁或恢复。请核对原执行进程。"
        : "执行 owner 存活且身份一致。", attempts: diagnosis.attempts.map(item => ({ taskId: item.taskId, attemptId: item.attemptId, state: item.owner.state, reason: item.owner.reason })) } };
  } catch {
    return { status: "unavailable", tasks: new Map(snapshot.tasks.filter(task => task.status === "running").map(task => [task.taskId, "unavailable"])),
      health: { state: "unknown", checkedAt, recoveryRequired: false, message: "执行状态检测失败，请重新检查；不能将旧记录视为正在运行。" } };
  }
}
