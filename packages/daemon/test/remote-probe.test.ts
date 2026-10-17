import { expect, it } from "vitest";
import { ProbeError, probeRemoteMcp, retryableProbeFailure } from "../src/remote-probe.js";

const origin = "https://probe.trycloudflare.com";
const token = "private-probe-token";
const signal = () => new AbortController().signal;
const reset = () => new Error(`proxy://user:secret@example.test/${token}`, { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });

function healthyFetch(fail?: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` });
    if (path === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (!request.headers.has("authorization")) {
      if (fail === "challenge") throw reset();
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const message = await request.json() as { id?: number; method: string };
    if (message.method === fail) throw reset();
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "connection_probe", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "reachable" }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

it("identifies a reset during OAuth discovery without leaking fetch credentials", async () => {
  const fetcher: typeof fetch = async () => { throw reset(); };
  let message = "";
  try { await probeRemoteMcp(origin, token, signal(), fetcher); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("remote_probe_network：OAuth server 元数据读取失败（ECONNRESET）");
  expect(message).not.toContain("secret"); expect(message).not.toContain(token); expect(message).not.toContain("example.test");
});

it("distinguishes HTTP failure, malformed JSON and a non-object metadata response", async () => {
  for (const [response, diagnostic] of [
    [new Response("denied", { status: 403 }), "HTTP 403"],
    [new Response("{bad", { headers: { "Content-Type": "application/json" } }), "不是合法 JSON"],
    [Response.json(null), "必须是 JSON 对象"],
  ] as const) {
    const body = await response.text();
    await expect(probeRemoteMcp(origin, token, signal(), async () => new Response(body, { status: response.status, headers: response.headers }))).rejects.toThrow(diagnostic);
  }
});

it("identifies failures in the challenge, initialize, list and call stages, and accepts a complete healthy probe", async () => {
  for (const [method, stage] of [["challenge", "MCP 认证保护检查"], ["initialize", "MCP initialize"], ["tools/list", "MCP tools/list"], ["tools/call", "MCP tools/call"]]) {
    await expect(probeRemoteMcp(origin, token, signal(), healthyFetch(method))).rejects.toThrow(`${stage}失败（ECONNRESET）`);
  }
  await expect(probeRemoteMcp(origin, token, signal(), healthyFetch())).resolves.toBeUndefined();
});

it("preserves explicit cancellation rather than reporting it as a connection failure", async () => {
  const controller = new AbortController(); const reason = new Error("user stopped"); controller.abort(reason);
  await expect(probeRemoteMcp(origin, token, controller.signal, async () => { throw reset(); })).rejects.toBe(reason);
});

it("retries only temporary HTTP failures and honors bounded Retry-After without exposing response bodies", async () => {
  for (const status of [408, 429, 502, 503, 504, 530, 400, 401, 403, 404, 500]) {
    const error = await probeRemoteMcp(origin, token, signal(), async () => new Response("private upstream diagnostic", { status, headers: { "Retry-After": "120" } })).catch(error => error);
    expect(error).toBeInstanceOf(ProbeError);
    expect(retryableProbeFailure(error)).toBe([408, 429, 502, 503, 504, 530].includes(status));
    expect(error.retryAfterMs).toBe(45_000);
    expect(error.message).not.toContain("private upstream diagnostic");
  }
  expect(retryableProbeFailure(reset())).toBe(true);
  expect(retryableProbeFailure(new Error("remote_probe_binding: mismatch"))).toBe(false);
  const invalidJson = await probeRemoteMcp(origin, token, signal(), async () => new Response("{bad", { headers: { "Content-Type": "application/json" } })).catch(error => error);
  expect(retryableProbeFailure(invalidJson)).toBe(false);
});

it("does not retry a wrong issuer or an unprotected public MCP endpoint", async () => {
  const healthy = healthyFetch();
  for (const broken of ["issuer", "challenge"]) {
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (broken === "issuer" && request.url.endsWith("oauth-authorization-server")) return Response.json({ issuer: "https://other.test" });
      if (broken === "challenge" && new URL(request.url).pathname === "/mcp" && !request.headers.has("authorization")) return new Response(null, { status: 200 });
      return healthy(input, init);
    };
    const error = await probeRemoteMcp(origin, token, signal(), fetcher).catch(error => error);
    expect(error.message).toContain(broken === "issuer" ? "remote_probe_binding" : "remote_probe_auth");
    expect(retryableProbeFailure(error)).toBe(false);
  }
});

it.each([503, 530])("retries a transient challenge HTTP %s without mistaking it for missing OAuth protection", async status => {
  const healthy = healthyFetch();
  const error = await probeRemoteMcp(origin, token, signal(), async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/mcp" && !request.headers.has("authorization")) return new Response(null, { status, headers: { "Retry-After": "2" } });
    return healthy(input, init);
  }).catch(error => error);
  expect(error.message).toContain(`认证保护检查失败（HTTP ${status}）`); expect(retryableProbeFailure(error)).toBe(true); expect(error.retryAfterMs).toBe(2000);
});
