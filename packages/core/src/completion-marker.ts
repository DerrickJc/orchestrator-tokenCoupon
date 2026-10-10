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
    "仅在你认为任务完成时，将下方标记逐字符复制为最终回复的最后一行。",
    "标记必须单独一行，不加引号或代码围栏；保留开头三个 < 和末尾三个 >，不得省略或改写任何字符。",
    marker,
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
