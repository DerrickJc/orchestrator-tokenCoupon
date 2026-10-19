import { randomBytes } from "node:crypto";
import type { TaskDefinition } from "./task.js";

export interface CompletionProtocol {
  token: string;
  marker: string;
  needsInputMarker: string;
  prompt: string;
}

export function createCompletionProtocol(task: TaskDefinition, executionInstructions?: string): CompletionProtocol {
  const token = randomBytes(24).toString("hex");
  const marker = `<<<TOKEN_COUPON_DONE:${token}>>>`;
  const needsInputMarker = `<<<TOKEN_COUPON_NEEDS_INPUT:${token}>>>`;
  const prompt = [
    ...(executionInstructions ? [executionInstructions, "", "当前任务："] : []),
    task.prompt.trim(),
    "",
    "结果要求：明确区分已完成与需要用户决策。不得把缺少授权、权威依据、凭证或外部信息描述成已完成。",
    "只有任务已完成且验收通过时，才将完成标记逐字符复制为最终回复的最后一行。",
    "如果必须停下来等待用户提供决定或材料，先在最终回复中说明阻塞点、缺少的信息、已完成的检查和用户需要回答的问题，然后将等待用户标记逐字符复制为最终回复的最后一行。",
    "标记必须单独一行，不加引号或代码围栏；保留开头三个 < 和末尾三个 >，不得省略或改写任何字符。每次回复只能选择一种结果标记；不能同时输出两个标记。",
    "完成标记：",
    marker,
    "等待用户决策标记：",
    needsInputMarker,
    "",
  ].join("\n");

  return { token, marker, needsInputMarker, prompt };
}

/** Detects only complete, exact marker lines while keeping one bounded line of state. */
export class CompletionMarkerDetector {
  private pendingLine = "";
  private overlongLine = false;
  private seen = false;

  constructor(
    private readonly marker: string,
    private readonly maxLineLength = 8192,
  ) {}

  push(chunk: string): boolean {
    if (this.seen || chunk.length === 0) {
      return this.seen;
    }

    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      this.appendSegment(chunk.slice(start, end));

      if (newline === -1) {
        break;
      }

      this.finishLine();
      if (this.seen) {
        return true;
      }
      start = newline + 1;
    }

    return this.seen;
  }

  finish(): boolean {
    if (!this.seen) {
      this.finishLine();
    }
    return this.seen;
  }

  private appendSegment(segment: string): void {
    if (this.overlongLine) {
      return;
    }

    if (this.pendingLine.length + segment.length > this.maxLineLength) {
      this.pendingLine = "";
      this.overlongLine = true;
      return;
    }

    this.pendingLine += segment;
  }

  private finishLine(): void {
    if (!this.overlongLine && this.pendingLine.replace(/\r$/, "") === this.marker) {
      this.seen = true;
    }
    this.pendingLine = "";
    this.overlongLine = false;
  }
}
