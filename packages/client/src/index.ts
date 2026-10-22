import { createDaemonApi, createDaemonCommands } from "./contracts.js";
import type { ApiRequestOptions } from "./contracts.js";
export { createDaemonApi, createDaemonCommands };
export type * from "./contracts.js";

/** Transport/version contracts shared by browser, desktop and future CLI clients. */
export const APPLICATION_VERSION = "0.1.0";
export const API_PROTOCOL = Object.freeze({ major: 1, minor: 0 });
export const PROTOCOL_HEADER = "X-Token-Coupon-Protocol";
export const EPOCH_HEADER = "X-Token-Coupon-Epoch";
export type ProtocolVersion = { major: number; minor: number };
export type DaemonHandshake = {
  epoch: string;
  protocol?: ProtocolVersion;
  applicationVersion?: string;
  buildId?: string;
  instanceId?: string;
  profile?: { id: string; kind: "native" | "wsl"; platform: string };
  capabilities?: Record<string, number>;
};
export type DaemonChallenge = {
  format: 1;
  nonce: string;
  origin: string;
  host: string;
  port: number;
  issuedAt: string;
  owner: { pid: number; hostname: string; platform: string; processStart: string };
  epoch: string;
  profileId: string;
  protocol: ProtocolVersion;
  applicationVersion: string;
  buildId: string;
  proof: string;
};
/** Canonical signed fields shared by the daemon and Node desktop host. */
export function daemonChallengePayload(value: Omit<DaemonChallenge, "proof">): string {
  return JSON.stringify({ format: value.format, nonce: value.nonce, origin: value.origin, host: value.host, port: value.port,
    issuedAt: value.issuedAt, owner: { pid: value.owner.pid, hostname: value.owner.hostname, platform: value.owner.platform, processStart: value.owner.processStart },
    epoch: value.epoch, profileId: value.profileId, protocol: { major: value.protocol.major, minor: value.protocol.minor },
    applicationVersion: value.applicationVersion, buildId: value.buildId });
}
export type EventStreamHandlers = {
  onHello?: (event: Event) => void;
  onOpen?: (event: Event) => void;
  onError?: (event: Event) => void;
  onMessage?: (event: Event) => void;
  eventTypes?: readonly string[];
};
export class ClientError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "ClientError"; }
}
export function protocolCompatible(value: unknown): value is ProtocolVersion {
  if (!value || typeof value !== "object") return false;
  const protocol = value as Partial<ProtocolVersion>;
  return protocol.major === API_PROTOCOL.major && Number.isSafeInteger(protocol.minor) && protocol.minor! >= 0;
}
export function createClient(options: { fetch?: typeof fetch; eventSource?: (path: string) => EventSource } = {}) {
  let handshake: DaemonHandshake | undefined;
  let compatibility: "unverified" | "compatible" | "legacy" | "incompatible" = "unverified";
  let handshakeRequest = 0, observation = 0, streamVersion = 0;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const api = async <T = unknown>(path: string, request: ApiRequestOptions = {}): Promise<T | null> => {
    // Never retry a mutation, including a network failure after the server accepted it.
    if (!path.startsWith("/api/v1/") || path.includes("\\") || !new URL(path, "http://localhost").pathname.startsWith("/api/v1/")) throw new ClientError("client_path_invalid：仅允许本机 API 相对路径");
    const healthRequest = path === "/api/v1/health" ? ++handshakeRequest : undefined;
    const observedAtRequest = observation;
    const write = !["GET", "HEAD"].includes((request.method ?? "GET").toUpperCase());
    if (write && compatibility === "unverified") throw new ClientError("daemon_handshake_required：请先重新连接并核对后台状态");
    if (write && compatibility === "incompatible") throw new ClientError("daemon_protocol_incompatible：界面与后台版本不兼容，请更新后重新打开；仍可查看记录");
    const headers = new Headers(request.headers);
    headers.set(PROTOCOL_HEADER, String(API_PROTOCOL.major));
    if (write && handshake?.protocol) headers.set(EPOCH_HEADER, handshake.epoch);
    if (request.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetcher(path, { ...request, headers, credentials: "same-origin", cache: "no-store" });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && String(data?.error).startsWith("daemon_epoch_changed")) { compatibility = "unverified"; observation++; }
      if (response.status === 426) compatibility = "incompatible";
      throw new ClientError(data?.error || `HTTP ${response.status}`, response.status);
    }
    if (path === "/api/v1/health") {
      if (healthRequest !== handshakeRequest || observation !== observedAtRequest) throw new ClientError("daemon_handshake_superseded：后台身份已变化，请重新核对状态");
      if (!data || typeof data.epoch !== "string" || !data.epoch) throw new ClientError("daemon_handshake_invalid：后台身份响应无效");
      handshake = data as DaemonHandshake;
      compatibility = data.protocol === undefined ? "legacy" : protocolCompatible(data.protocol) ? "compatible" : "incompatible";
    }
    return data as T | null;
  };
  return Object.freeze({
    connection: () => ({ handshake: handshake ? structuredClone(handshake) : undefined, compatibility }),
    api,
    domain: createDaemonApi({ api }),
    commands: createDaemonCommands({ api }),
    openEventStream(path: string, handlers: EventStreamHandlers = {}): EventSource {
      if (!path.startsWith("/api/v1/events?") && path !== "/api/v1/events") throw new ClientError("client_event_path_invalid");
      const source = options.eventSource ? options.eventSource(path) : new EventSource(path);
      const version = ++streamVersion;
      source.addEventListener("hello", event => {
        if (version !== streamVersion) return;
        try {
          const value = JSON.parse((event as MessageEvent<string>).data) as { epoch?: string };
          if (handshake && value.epoch !== handshake.epoch) { compatibility = "unverified"; observation++; }
        } catch { compatibility = "unverified"; observation++; }
        handlers.onHello?.(event);
      });
      source.onopen = handlers.onOpen ?? null;
      source.onerror = handlers.onError ?? null;
      source.onmessage = handlers.onMessage ?? null;
      if (handlers.onMessage) for (const type of handlers.eventTypes ?? []) source.addEventListener(type, event => handlers.onMessage?.(event));
      return source;
    },
  });
}
