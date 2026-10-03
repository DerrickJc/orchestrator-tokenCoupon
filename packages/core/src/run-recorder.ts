import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptRecord } from "./attempt.js";
import type { TaskDefinition } from "./task.js";

export interface RunRecorderOptions {
  cwd: string;
  attemptId: string;
  task: TaskDefinition;
  prompt: string;
  initialAttempt: AttemptRecord;
  maxQueuedBytes?: number;
}

interface EventQueueItem {
  line: string;
  byteLength: number;
}

export class RunRecorder {
  readonly artifactDir: string;
  private readonly eventsPath: string;
  private readonly maxQueuedBytes: number;
  private nextSequence = 0;
  private queuedBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private snapshotTail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private readonly attemptId: string;

  private constructor(artifactDir: string, attemptId: string, maxQueuedBytes: number) {
    this.artifactDir = artifactDir;
    this.attemptId = attemptId;
    this.eventsPath = join(artifactDir, "events.jsonl");
    this.maxQueuedBytes = maxQueuedBytes;
  }

  static async create(options: RunRecorderOptions): Promise<RunRecorder> {
    const artifactDir = join(options.cwd, ".token-coupon", "runs", options.attemptId);
    const recorder = new RunRecorder(artifactDir, options.attemptId, options.maxQueuedBytes ?? 1024 * 1024);

    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "task.json"), `${JSON.stringify(options.task, null, 2)}\n`, {
      flag: "wx",
    });
    await writeFile(join(artifactDir, "prompt.txt"), options.prompt, { flag: "wx" });
    await writeFile(recorder.eventsPath, "", { flag: "wx" });
    await recorder.writeAttempt({ ...options.initialAttempt, artifactDir });
    await recorder.appendEvent("attempt.created", {
      taskId: options.task.id,
      cwd: options.cwd,
      runnerId: options.task.execution.runnerId,
      inputBytes: options.initialAttempt.inputBytes,
    });

    return recorder;
  }

  appendEvent(type: string, payload: unknown): Promise<void> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    const line = `${JSON.stringify({
      sequence: ++this.nextSequence,
      timestamp: new Date().toISOString(),
      attemptId: this.attemptId,
      type,
      payload,
    })}\n`;
    const byteLength = Buffer.byteLength(line, "utf8");
    if (this.queuedBytes + byteLength > this.maxQueuedBytes) {
      const error = new Error(`事件日志队列超过 ${this.maxQueuedBytes} 字节上限`);
      this.failure ??= error;
      return Promise.reject(error);
    }

    this.queuedBytes += byteLength;
    const write = this.tail.then(async () => {
      if (this.failure !== undefined) {
        throw this.failure;
      }
      await appendFile(this.eventsPath, line, "utf8");
    });
    this.tail = write.catch((error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    });

    return write.finally(() => {
      this.queuedBytes -= byteLength;
    });
  }

  writeAttempt(attempt: AttemptRecord): Promise<void> {
    const snapshotPath = join(this.artifactDir, "attempt.json");
    const temporaryPath = join(this.artifactDir, `.attempt-${randomUUID()}.tmp`);
    const write = this.snapshotTail.then(async () => {
      await writeFile(temporaryPath, `${JSON.stringify(attempt, null, 2)}\n`, { flag: "wx" });
      await rename(temporaryPath, snapshotPath);
    });
    this.snapshotTail = write.catch((error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    });
    return write;
  }

  async flush(): Promise<void> {
    await Promise.all([this.tail, this.snapshotTail]);
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  get recordingError(): Error | undefined {
    return this.failure;
  }
}
