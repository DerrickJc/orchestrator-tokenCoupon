import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConnectionObservation {
  traceId: string; at: number; endpoint: string;
  stage: "authentication" | "transport" | "tool";
  outcome: "success" | "error" | "received";
  code?: string; tool?: string; method?: string; httpStatus?: number; durationMs?: number;
  grantId?: string; clientId?: string;
}

/** Bounded local audit metadata. Never accepts request arguments, headers or response bodies. */
export class ConnectionDiagnostics {
  private records: ConnectionObservation[] = [];
  private queue: Promise<void> = Promise.resolve();
  storageUnavailable = false;
  constructor(private readonly directory: string) {}
  async initialize(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, "remote-mcp-diagnostics.json"), "utf8"));
      if (!Array.isArray(value)) throw new Error("invalid_diagnostics");
      this.records = value.slice(-100).map(item => this.project(item));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.storageUnavailable = true; }
  }
  recent(): ConnectionObservation[] { return this.records.map(item => ({ ...item })); }
  record(value: ConnectionObservation): Promise<void> {
    const entry = this.project(value);
    this.records = [...this.records, entry].slice(-100);
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, "remote-mcp-diagnostics.json"), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.records, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, path); this.storageUnavailable = false;
    }).catch(() => { this.storageUnavailable = true; });
    return this.queue;
  }
  flush(): Promise<void> { return this.queue; }
  private project(value: ConnectionObservation): ConnectionObservation {
    if (!value || !/^[a-f0-9-]{36}$/i.test(value.traceId) || !Number.isFinite(value.at) || !["authentication", "transport", "tool"].includes(value.stage) || !["success", "error", "received"].includes(value.outcome)) throw new Error("invalid_connection_observation");
    const url = new URL(value.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("invalid_diagnostic_endpoint");
    const result: ConnectionObservation = { traceId: value.traceId, at: value.at, endpoint: url.href, stage: value.stage, outcome: value.outcome };
    for (const key of ["code", "tool", "method"] as const) if (value[key] && /^[a-zA-Z0-9_/.:-]{1,80}$/.test(value[key]!)) result[key] = value[key];
    for (const key of ["grantId", "clientId"] as const) if (value[key] && /^[a-f0-9-]{36}$/i.test(value[key]!)) result[key] = value[key];
    for (const key of ["httpStatus", "durationMs"] as const) if (Number.isFinite(value[key]) && value[key]! >= 0) result[key] = value[key]!;
    return result;
  }
}
