import { randomUUID } from "node:crypto";
import type { DesktopAttachment } from "./desktop-policy.js";

export type DesktopConnectionState = { phase: "connected" | "disconnected" | "reconnecting"; error?: string };
export type DesktopRecoverySnapshot = { id: string; snapshot: string };

function recoveryRoute(snapshot: unknown): string {
  if (typeof snapshot !== "string" || Buffer.byteLength(snapshot, "utf8") > 1024 * 1024) throw new Error("desktop_recovery_state_invalid：未提交内容过大或格式无效，请先保留文本后重试");
  let value: { version?: unknown; route?: unknown };
  try { value = JSON.parse(snapshot) as typeof value; } catch { throw new Error("desktop_recovery_state_invalid：未提交内容格式无效"); }
  if (!value || value.version !== 1 || typeof value.route !== "string" || value.route.length > 2048 || !value.route.startsWith("#/") || /[\x00-\x1f]/.test(value.route)) throw new Error("desktop_recovery_state_invalid：恢复目标必须是本机页面内的路由");
  return value.route;
}

/** Explicit reconnection only. Drafts stay in memory and no business command is replayed. */
export class DesktopReconnector {
  private pending: Promise<DesktopAttachment> | undefined;
  private recovery: DesktopRecoverySnapshot | undefined;
  private state: DesktopConnectionState = { phase: "connected" };

  constructor(private readonly options: {
    connect(): Promise<DesktopAttachment>;
    expectedProfileId(): string | undefined;
    load(attachment: DesktopAttachment, route: string): Promise<void>;
    changed(state: DesktopConnectionState): void;
  }) {}

  get inFlight(): boolean { return !!this.pending; }
  get connectionState(): DesktopConnectionState { return { ...this.state }; }
  get recoverySnapshot(): DesktopRecoverySnapshot | undefined { return this.recovery ? { ...this.recovery } : undefined; }
  acknowledgeSnapshot(id: string): void { if (this.recovery?.id === id) this.recovery = undefined; }

  disconnected(error = "本机后台已退出或失联，请重新连接。未提交内容仍保留在当前窗口。"): void {
    this.setState({ phase: "disconnected", error });
  }

  reconnect(snapshot?: string): Promise<DesktopAttachment> {
    if (this.pending) return this.pending;
    if (snapshot !== undefined) {
      recoveryRoute(snapshot);
      this.recovery = { id: randomUUID(), snapshot };
    }
    const route = this.recovery ? recoveryRoute(this.recovery.snapshot) : "#/connect";
    const expectedProfileId = this.options.expectedProfileId();
    this.setState({ phase: "reconnecting" });
    const operation = Promise.resolve().then(async () => {
      try {
        const attachment = await this.options.connect();
        if (expectedProfileId && attachment.profileId !== expectedProfileId) throw new Error("desktop_recovery_profile_changed：后台目录身份已变化，未向其他 profile 恢复输入，请核对目录后重试");
        await this.options.load(attachment, route);
        this.setState({ phase: "connected" });
        return attachment;
      } catch (error) {
        this.disconnected(error instanceof Error ? error.message.slice(0, 600) : "后台重新连接失败，请重试。");
        throw error;
      }
    });
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined; }).catch(() => undefined);
    return operation;
  }

  private setState(state: DesktopConnectionState): void { this.state = state; this.options.changed({ ...state }); }
}
