import { expect, it, vi } from "vitest";
import { API_PROTOCOL, createClient } from "../src/index.js";

it("negotiates versions, binds mutations to an epoch and never retries a lost response", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  let epoch = "first";
  const client = createClient({ fetch: (async (path, options) => {
    calls.push({ path: String(path), ...(options ? { options } : {}) });
    if (path === "/api/v1/health") return Response.json({ epoch, protocol: API_PROTOCOL });
    throw new Error("response_lost");
  }) as typeof fetch });
  await expect(client.api("/api/v1/workspaces", { method: "POST", body: "{}" })).rejects.toThrow("handshake_required");
  expect(calls).toHaveLength(0);
  await client.api("/api/v1/health");
  await expect(client.api("/api/v1/workspaces", { method: "POST", body: "{}" })).rejects.toThrow("response_lost");
  expect(calls).toHaveLength(2);
  expect(new Headers(calls[1]!.options?.headers).get("X-Token-Coupon-Epoch")).toBe("first");
  expect(calls[1]?.options?.credentials).toBe("same-origin");
  epoch = "second";
  await client.api("/api/v1/health");
  expect(client.connection().handshake?.epoch).toBe("second");
});

it("keeps legacy reads/writes compatible and incompatible backends read-only", async () => {
  let protocol: unknown = undefined;
  const fetcher = vi.fn(async () => Response.json({ epoch: "test", ...(protocol === undefined ? {} : { protocol }) }));
  const client = createClient({ fetch: fetcher });
  await client.api("/api/v1/health");
  expect(client.connection().compatibility).toBe("legacy");
  await client.api("/api/v1/workspaces", { method: "POST", body: "{}" });
  protocol = { major: 99, minor: 0 };
  await client.api("/api/v1/health");
  await client.api("/api/v1/workspaces");
  const before = fetcher.mock.calls.length;
  await expect(client.api("/api/v1/workspaces", { method: "POST", body: "{}" })).rejects.toThrow("protocol_incompatible");
  expect(fetcher).toHaveBeenCalledTimes(before);
});

it("invalidates a changed SSE epoch until health is queried, and never duplicates an event subscription", async () => {
  const source = new EventTarget() as EventSource;
  let epoch = "old";
  const client = createClient({ fetch: async () => Response.json({ epoch, protocol: API_PROTOCOL }), eventSource: () => source });
  await client.api("/api/v1/health");
  const received = vi.fn();
  client.openEventStream("/api/v1/events?after=5&epoch=old", { onHello: received, onMessage: received, eventTypes: ["job.started"] });
  source.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ epoch: "new" }) }));
  expect(received).toHaveBeenCalledTimes(1);
  await expect(client.api("/api/v1/run", { method: "POST" })).rejects.toThrow("handshake_required");
  epoch = "new";
  await client.api("/api/v1/health");
  expect(client.connection().compatibility).toBe("compatible");
  source.dispatchEvent(new MessageEvent("job.started", { data: "{}" }));
  expect(received).toHaveBeenCalledTimes(2);
  expect(() => client.openEventStream("https://other.example/events")).toThrow("event_path_invalid");
  await expect(client.api("https://other.example/")) .rejects.toThrow("path_invalid");
  await expect(client.api("/api/v1/%2e%2e/%2e%2e/mcp")) .rejects.toThrow("path_invalid");
});

it("does not let a late health response restore a superseded daemon identity", async () => {
  let resolveOld!: (response: Response) => void;
  let calls = 0;
  const client = createClient({ fetch: async () => ++calls === 1 ? new Promise<Response>(resolve => { resolveOld = resolve; }) : Response.json({ epoch: "new", protocol: API_PROTOCOL }) });
  const old = client.api("/api/v1/health");
  await client.api("/api/v1/health");
  resolveOld(Response.json({ epoch: "old", protocol: API_PROTOCOL }));
  await expect(old).rejects.toThrow("handshake_superseded");
  expect(client.connection().handshake?.epoch).toBe("new");
  const copy = client.connection(); copy.handshake!.epoch = "mutated";
  expect(client.connection().handshake?.epoch).toBe("new");
});

it("makes an epoch rejection require reconciliation and sends the failed mutation only once", async () => {
  const fetcher = vi.fn(async (path: string | URL | Request) => String(path).endsWith("/health")
    ? Response.json({ epoch: "old", protocol: API_PROTOCOL })
    : Response.json({ error: "daemon_epoch_changed：核对状态" }, { status: 409 }));
  const client = createClient({ fetch: fetcher });
  await client.api("/api/v1/health");
  await expect(client.api("/api/v1/run", { method: "POST" })).rejects.toThrow("epoch_changed");
  await expect(client.api("/api/v1/run", { method: "POST" })).rejects.toThrow("handshake_required");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
