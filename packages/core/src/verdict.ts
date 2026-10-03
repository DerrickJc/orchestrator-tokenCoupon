import type { AttemptStatus } from "./attempt.js";
import type { ProcessResult } from "./runner.js";

export type StopReason = "timed_out" | "cancelled" | null;

export interface VerdictInput {
  markerSeen: boolean;
  process: ProcessResult;
  stopReason: StopReason;
  recordingFailed: boolean;
}

export interface Verdict {
  status: Exclude<AttemptStatus, "created" | "running">;
  reasonCode: string;
  reason: string;
}

export function determineVerdict(input: VerdictInput): Verdict {
  if (input.recordingFailed) {
    return {
      status: "failed",
      reasonCode: "recording_failed",
      reason: "执行记录写入失败，记录可能不完整",
    };
  }

  if (input.process.terminationError !== undefined) {
    return {
      status: "failed",
      reasonCode: "process_cleanup_failed",
      reason: input.process.terminationError,
    };
  }

  if (input.stopReason === "timed_out") {
    return {
      status: "timed_out",
      reasonCode: "execution_timeout",
      reason: "执行超过配置的超时时间，进程已请求停止",
    };
  }

  if (input.stopReason === "cancelled") {
    return {
      status: "cancelled",
      reasonCode: "user_cancelled",
      reason: "用户取消了本次执行",
    };
  }

  if (input.process.startError !== undefined) {
    return {
      status: "failed",
      reasonCode: "runner_start_failed",
      reason: input.process.startError.message,
    };
  }

  if (!input.process.started) {
    return {
      status: "failed",
      reasonCode: "runner_not_started",
      reason: "Runner 未确认启动，不能判定任务成功",
    };
  }

  if (input.process.executionError !== undefined) {
    return {
      status: "failed",
      reasonCode: "runner_execution_failed",
      reason: input.process.executionError,
    };
  }

  if (input.process.exitCode !== 0) {
    return {
      status: "failed",
      reasonCode: "process_exit_nonzero",
      reason: `Runner 退出码为 ${input.process.exitCode ?? "未知"}`,
    };
  }

  if (!input.markerSeen) {
    return {
      status: "failed",
      reasonCode: "completion_marker_missing",
      reason: "Runner 正常退出，但最终回复未包含本次完成标记",
    };
  }

  return {
    status: "succeeded",
    reasonCode: "completion_protocol_satisfied",
    reason: "本次完成标记已出现，且 Runner 以退出码 0 结束",
  };
}
