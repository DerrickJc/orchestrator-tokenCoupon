import { randomBytes } from "node:crypto";
import type { TaskDefinition } from "./task.js";

export interface CompletionProtocol {
  token: string;
  marker: string;
  prompt: string;
}

export function createCompletionProtocol(task: TaskDefinition): CompletionProtocol {
  const token = randomBytes(24).toString("hex");
  const marker = `<<<TOKEN_COUPON_DONE:${token}>>>`;
  const prompt = [
    task.prompt.trim(),
    "",
    "完成要求：执行任务并说明修改与验证结果。",
    "仅在你认为任务完成时，在最终回复的独立一行输出本次完成标记。",
    `本次标记为：${marker}`,
    "",
  ].join("\n");

  return { token, marker, prompt };
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
