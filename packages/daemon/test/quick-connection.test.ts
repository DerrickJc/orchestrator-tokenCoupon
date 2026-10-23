import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";
import { installCloudflared } from "../src/cloudflared-component.js";
import { RemoteMcpConnection, type ConnectionPhase } from "../src/oauth-gateway.js";
import { discoverQuickOrigin, QuickTunnelAdapter, type TunnelAdapter } from "../src/quick-tunnel.js";
import { PersistentQuickTunnelAdapter } from "../src/persistent-tunnel.js";
import { probeRemoteMcp, ProbeError, type PublicProbe } from "../src/remote-probe.js";

const cleanups: Array<() => Promise<void>> = [];
const persistentWait = process.platform === "win32" ? 30000 : 5000;
const persistentTimeout = process.platform === "win32" ? 90000 : 15000;
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function fixture(options: { probe?: "real" | "fail" | "pause"; tunnel?: TunnelAdapter; componentExecutable?: string; healthIntervalMs?: number; probeImpl?: PublicProbe; retryDelaysMs?: number[]; probeBudgetMs?: number; startupBudgetMs?: number; startupRetryDelayMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-quick-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project"); await mkdir(path);
  const dataDirectory = join(root, "state");
  const service = new ApplicationService({ dataDirectory }); await service.initialize();
  const workspace = await service.addWorkspace(path);
  const port = await freePort();
  let starts = 0, stops = 0, offline = false, lastProbeToken: string | undefined, exit: (() => void) | undefined;
  const origin = "https://example-quick.trycloudflare.com";
  const tunnel: TunnelAdapter = options.tunnel ?? { async start(_executable, localPort, _directory, _signal, exited) {
    expect(localPort).toBe(port); starts++; exit = exited;
    return { origin, async stop() { stops++; } };
  } };
  const proxyFetch: typeof fetch = async (input, init) => {
    const remote = new Request(input, init);
    const url = new URL(remote.url);
    const local = new URL(remote.url); local.protocol = "http:"; local.hostname = "127.0.0.1"; local.port = String(port);
    const headers = new Headers(remote.headers); headers.set("host", url.host);
    return fetch(new Request(local, { method: remote.method, headers, body: remote.body, duplex: "half", signal: remote.signal } as RequestInit));
  };
  const probe = options.probeImpl ?? (options.probe === "fail" ? async () => { throw new Error("remote_probe_metadata：测试公网不可达"); }
    : options.probe === "pause" ? async (_origin: string, _token: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }) : (url: string, token: string, signal: AbortSignal) => {
      lastProbeToken = token;
      if (offline) throw new Error("remote_probe_metadata：暂时断网");
      return probeRemoteMcp(url, token, signal, proxyFetch);
    });
  const dependencies = {
    component: { async get(_signal, stage) { stage("checking"); return { executable: options.componentExecutable ?? "/fake/cloudflared", version: "cloudflared version 2026.10.0", source: "existing" as const }; } },
    tunnel, probe, retryDelaysMs: options.retryDelaysMs ?? [10], probeBudgetMs: options.probeBudgetMs ?? 45000, healthIntervalMs: options.healthIntervalMs ?? 0, startupBudgetMs: options.startupBudgetMs ?? 0, startupRetryDelayMs: options.startupRetryDelayMs ?? 5,
  } satisfies import("../src/oauth-gateway.js").ConnectionDependencies;
  if (options.componentExecutable === process.execPath) {
    const directory = join(dataDirectory, "components", "tunnel-runtime"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "tunnel"), "setTimeout(()=>process.stderr.write('https://example-quick.trycloudflare.com\\n'),800);setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));");
  }
  const remote = new RemoteMcpConnection(service, dataDirectory, port, dependencies);
  await remote.initialize(); cleanups.push(() => remote.shutdown());
  const waitFor = async (phase: ConnectionPhase) => {
    for (let i = 0; i < (process.platform === "win32" ? 1500 : 150); i++) {
      if (remote.status().transport === phase) return remote.status();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${phase}, got ${JSON.stringify(remote.status())}`);
  };
  return { root, dataDirectory, dependencies, service, workspace, remote, port, origin, proxyFetch, waitFor, probeToken: () => lastProbeToken, counters: () => ({ starts, stops }), setOffline: (value: boolean) => { offline = value; }, exit: () => exit?.() };
}

async function authorize(h: Awaited<ReturnType<typeof fixture>>, scopes: string[], options: { clientName?: string; redirectUri?: string; authMethod?: "none" | "client_secret_post" | "omit" } = {}) {
  const redirectUri = options.redirectUri || "https://chatgpt.com/connector/oauth/test";
  const register = await h.proxyFetch(`${h.origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    client_name: options.clientName || "integration browser", redirect_uris: [redirectUri], ...(options.authMethod === "omit" ? {} : { token_endpoint_auth_method: options.authMethod || "none" }), grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }) });
  expect(register.status).toBe(201);
  const client = await register.json() as { client_id: string; token_endpoint_auth_method: string; client_secret?: string; client_secret_expires_at?: number };
  const verifier = "v".repeat(64);
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: `${h.origin}/mcp`, scope: scopes.join(" "), state: randomUUID() });
  const request = await h.proxyFetch(`${h.origin}/authorize?${params}`);
  expect(request.status).toBe(200);
  const pending = h.remote.approvals().at(-1)!;
  return { pending, client, verifier, redirectUri, params };
}

describe("Quick Tunnel connection", () => {
  it("traces Host and route rejection, missing credentials and one authenticated tool call without logging secrets", async () => {
    const h = await fixture(); await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const wrongHost = await new Promise<{ status: number | undefined; trace: string | string[] | undefined }>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${h.port}/mcp`, { headers: { Host: "not-allowed.example" } }, response => {
        response.resume(); response.once("end", () => resolve({ status: response.statusCode, trace: response.headers["x-token-coupon-trace"] }));
      }); request.once("error", reject); request.end();
    });
    expect(wrongHost.status).toBe(421); const hostTrace = wrongHost.trace;
    const missing = await h.proxyFetch(`${h.origin}/PRIVATE_ROUTE?secret=PRIVATE_QUERY`); expect(missing.status).toBe(404); await missing.body?.cancel();
    const denied = await h.proxyFetch(`${h.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": "PRIVATE_SESSION", "Mcp-Protocol-Version": "PRIVATE_VERSION", "X-Token-Coupon-Trace": "forged-trace" }, body: JSON.stringify({ method: "tools/call", params: { secret: "PRIVATE_BODY" } }) });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${h.origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(extractWWWAuthenticateParams(denied).resourceMetadataUrl?.href).toBe(`${h.origin}/.well-known/oauth-protected-resource/mcp`);
    const deniedTrace = denied.headers.get("x-token-coupon-trace"); await denied.body?.cancel();
    await expect.poll(() => h.remote.status().recentCalls?.find(item => item.traceId === hostTrace && item.requestState === "completed")).toMatchObject({ stage: "ingress", httpStatus: 421, code: "remote_host_invalid" });
    expect(h.remote.status().recentCalls?.some(item => item.traceId === deniedTrace && item.stage === "authentication")).toBe(true);
    expect(h.remote.status().recentCalls?.find(item => item.traceId === deniedTrace && item.requestState === "received")).toMatchObject({ route: "/mcp", httpMethod: "POST", authorization: "missing", protocolVersion: "other", hasSessionId: true });
    const auth = await authorize(h, ["planning:read"]);
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["planning:read"] });
    const approved = await h.remote.approvalStatus(auth.pending.requestId), code = new URL(approved.redirectUrl!).searchParams.get("code")!;
    const exchange = await h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` }) });
    const tokens = await exchange.json() as { access_token: string };
    const client = new Client({ name: "ingress-trace-test", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), { fetch: h.proxyFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    expect((await client.callTool({ name: "workspace_query", arguments: {} })).isError).not.toBe(true);
    await expect.poll(() => h.remote.status().recentCalls?.find(item => item.method === "tools/call" && item.requestState === "completed")).toBeDefined();
    const tool = h.remote.status().recentCalls!.find(item => item.stage === "tool" && item.tool === "workspace_query")!;
    const related = h.remote.status().recentCalls!.filter(item => item.traceId === tool.traceId);
    expect(related).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "ingress", requestState: "received", authorization: "bearer" }), expect.objectContaining({ stage: "transport", method: "tools/call", httpStatus: 200 }), expect.objectContaining({ stage: "ingress", requestState: "completed", method: "tools/call", httpStatus: 200 })]));
    expect(h.remote.status().gatewayTracing?.lastToolAt).toBeDefined();
    const saved = await readFile(join(h.dataDirectory, "remote-mcp-diagnostics.json"), "utf8");
    for (const secret of [tokens.access_token, auth.verifier, "PRIVATE_ROUTE", "PRIVATE_QUERY", "PRIVATE_SESSION", "PRIVATE_VERSION", "PRIVATE_BODY", "forged-trace"]) expect(saved).not.toContain(secret);
  });
  it.each(["none", "client_secret_post", "omit"] as const)("keeps DCR authentication consistent through Claude callback, token exchange, refresh and MCP (%s)", async authMethod => {
    const h = await fixture(); await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const auth = await authorize(h, ["planning:read"], { clientName: "Claude", redirectUri: "https://claude.ai/api/mcp/auth_callback", authMethod });
    const confidential = authMethod !== "none";
    expect(auth.client.token_endpoint_auth_method).toBe(confidential ? "client_secret_post" : "none");
    expect(!!auth.client.client_secret).toBe(confidential);
    if (!confidential) expect(auth.client.client_secret_expires_at).toBeUndefined();
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, source: "claude", scopes: ["planning:read"] });
    const approved = await h.remote.approvalStatus(auth.pending.requestId), code = new URL(approved.redirectUrl!).searchParams.get("code")!;
    const params = { grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` };
    const send = (values: Record<string, string>) => h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
    if (confidential) {
      for (const values of [params, { ...params, client_secret: "wrong-secret" }]) { const failed = await send(values); expect(failed.status).toBe(400); expect((await failed.json() as { error: string }).error).toBe("invalid_client"); }
    }
    const credentials: Record<string, string> = confidential ? { client_secret: auth.client.client_secret! } : {};
    const exchanged = await send({ ...params, ...credentials }); expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json() as { access_token: string; refresh_token: string };
    const replay = await send({ ...params, ...credentials }); expect(replay.status).toBeGreaterThanOrEqual(400);
    const refreshed = await send({ grant_type: "refresh_token", client_id: auth.client.client_id, refresh_token: tokens.refresh_token, resource: `${h.origin}/mcp`, ...credentials });
    expect(refreshed.status).toBe(200); const fresh = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(fresh.refresh_token).not.toBe(tokens.refresh_token);
    const client = new Client({ name: "claude-dcr-regression", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), { fetch: h.proxyFetch, requestInit: { headers: { Authorization: `Bearer ${fresh.access_token}` } } }));
    const result = await client.callTool({ name: "workspace_query", arguments: {} }); expect(result.isError).not.toBe(true);
    await expect.poll(() => h.remote.status().remoteClientVerified).toBe(true);
  });

  it("repairs legacy public registrations with stray secrets without changing client IDs or grants", async () => {
    let started = false;
    const runtime = { origin: "https://example-quick.trycloudflare.com", async stop() {}, async detach() {} };
    const tunnel: TunnelAdapter = { async start() { started = true; return runtime; }, async recover() { return started ? runtime : undefined; } };
    const h = await fixture({ tunnel }); await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const auth = await authorize(h, ["planning:read"], { clientName: "Claude", redirectUri: "https://claude.ai/api/mcp/auth_callback" });
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, source: "claude", scopes: ["planning:read"] });
    await h.remote.shutdown();
    const statePath = join(h.dataDirectory, "remote-mcp-oauth.json"), state = JSON.parse(await readFile(statePath, "utf8"));
    const stored = state.clients.find((item: { client_id: string }) => item.client_id === auth.client.client_id);
    stored.client_secret = "legacy-unexpected-secret"; stored.client_secret_expires_at = Math.floor(Date.now() / 1000) + 1000;
    await writeFile(statePath, JSON.stringify(state));
    const restored = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => restored.shutdown()); await restored.initialize();
    for (let i = 0; i < 150 && restored.status().transport !== "ready"; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(restored.status().transport).toBe("ready"); expect(restored.grants()[0]?.grantId).toBe(state.grants[0].grantId);
    const response = await h.proxyFetch(`${h.origin}/authorize?${auth.params}`); expect(response.status).toBe(200);
    const request = restored.approvals().at(-1)!; await restored.decideApproval(request.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, source: "claude", scopes: ["planning:read"] });
    const approved = await restored.approvalStatus(request.requestId), code = new URL(approved.redirectUrl!).searchParams.get("code")!;
    const exchanged = await h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` }) });
    expect(exchanged.status).toBe(200); expect(restored.grants().every(grant => grant.clientId === auth.client.client_id)).toBe(true);
    const persisted = JSON.parse(await readFile(statePath, "utf8")); expect(persisted.clients[0].client_secret).toBeUndefined();
  });

  it("distinguishes local Claude approval from token exchange and records only safe exchange diagnostics", async () => {
    const h = await fixture(); await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const auth = await authorize(h, ["planning:read"], { clientName: "Claude", redirectUri: "https://claude.ai/api/mcp/auth_callback" });
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, source: "claude", scopes: ["planning:read"] });
    expect(h.remote.status().pendingTokenExchanges).toBe(1); expect(h.remote.grants()[0]?.oauthState).toBe("awaiting_token");
    expect(h.remote.status().remoteClientVerified).toBe(false);
    const approved = await h.remote.approvalStatus(auth.pending.requestId), code = new URL(approved.redirectUrl!).searchParams.get("code")!;
    const complete = { grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` };
    const send = (values: Record<string, string>) => h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
    const { resource: _resource, ...missingResource } = complete;
    const failed = await send(missingResource); expect(failed.status).toBeGreaterThanOrEqual(400); expect(failed.headers.get("x-token-coupon-trace")).toBeTruthy();
    await expect.poll(() => h.remote.status().recentCalls?.some(item => item.stage === "oauth" && item.code === "oauth_resource_missing")).toBe(true);
    expect(h.remote.status().pendingTokenExchanges).toBe(1);
    const failure = h.remote.status().recentCalls!.find(item => item.code === "oauth_resource_missing")!;
    expect(failure.requestFields).not.toContain("resource"); expect(failure.requestFields).toContain("code_verifier");
    const badVerifier = await send({ ...complete, code_verifier: "x".repeat(64) }); expect(badVerifier.status).toBeGreaterThanOrEqual(400);
    await expect.poll(() => h.remote.status().recentCalls?.some(item => item.code === "oauth_pkce_invalid")).toBe(true);
    const unknownClient = await send({ ...complete, client_id: randomUUID() }); expect(unknownClient.status).toBe(400);
    await expect.poll(() => h.remote.status().recentCalls?.some(item => item.stage === "oauth" && item.code === "invalid_client")).toBe(true);
    const issued = await send(complete); expect(issued.status).toBe(200); const tokens = await issued.json() as { access_token: string; refresh_token: string };
    await expect.poll(() => h.remote.status().recentCalls?.some(item => item.stage === "oauth" && item.outcome === "success")).toBe(true);
    expect(h.remote.status().pendingTokenExchanges).toBe(0); expect(h.remote.grants()[0]?.oauthState).toBe("token_issued");
    expect(h.remote.status().remoteClientVerified).toBe(false);
    const output = JSON.stringify(h.remote.status().recentCalls);
    for (const secret of [code, auth.verifier, tokens.access_token, tokens.refresh_token]) expect(output).not.toContain(secret);
    await expect.poll(async () => (await readFile(join(h.dataDirectory, "remote-mcp-diagnostics.json"), "utf8")).includes("oauth_token_issued")).toBe(true);
    const disk = await readFile(join(h.dataDirectory, "remote-mcp-diagnostics.json"), "utf8");
    for (const secret of [code, auth.verifier, tokens.access_token, tokens.refresh_token]) expect(disk).not.toContain(secret);
  });

  it("preserves a persistent tunnel while discovery is still pending during business shutdown", async () => {
    const executable = process.execPath;
    const tunnel = new PersistentQuickTunnelAdapter(persistentWait, 250);
    const h = await fixture({ tunnel, componentExecutable: executable }); cleanups.push(() => h.remote.stop());
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    const { readTunnelRecord } = await import("../src/persistent-tunnel.js");
    const directory = join(h.dataDirectory, "components", "tunnel-runtime");
    await expect.poll(() => readTunnelRecord(directory), { timeout: persistentWait }).toBeDefined();
    const pid = (await readTunnelRecord(directory))!.pid;
    await h.remote.shutdown();
    const restored = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => restored.stop());
    await restored.initialize(); await expect.poll(() => restored.status().transport, { timeout: persistentWait }).toBe("ready");
    expect((await readTunnelRecord(directory))!.pid).toBe(pid); expect(restored.status().connectionProcess?.recovered).toBe(true);
  }, persistentTimeout);

  it("recovers a persistent gateway with the same OAuth client, access token, refresh token and real MCP calls", async () => {
    const executable = process.execPath;
    const h = await fixture({ tunnel: new PersistentQuickTunnelAdapter(persistentWait, 250), componentExecutable: executable });
    cleanups.push(() => h.remote.stop());
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    expect(h.remote.status().connectionProcess).toEqual({ persistent: true, recovered: false });
    const auth = await authorize(h, ["repository:read", "planning:read"]);
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["repository:read", "planning:read"] });
    const approved = await h.remote.approvalStatus(auth.pending.requestId), code = new URL(approved.redirectUrl!).searchParams.get("code")!;
    const exchange = await h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` }) });
    const tokens = await exchange.json() as { access_token: string; refresh_token: string }; expect(tokens.access_token).toBeTypeOf("string");
    const grantId = h.remote.grants()[0]!.grantId;
    await h.remote.shutdown();
    const offline = await h.proxyFetch(`${h.origin}/mcp`); expect(offline.status).toBe(503); expect(offline.headers.get("retry-after")).toBe("2");
    const restored = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, { ...h.dependencies, component: { async get() { throw new Error("recovery must not download components"); } } });
    cleanups.push(() => restored.stop());
    await restored.initialize(); await expect.poll(() => restored.status().transport, { timeout: persistentWait }).toBe("ready");
    expect(restored.status().connectionProcess).toEqual({ persistent: true, recovered: true });
    expect(restored.status().mcpUrl).toBe(`${h.origin}/mcp`); expect(restored.status().addressChanged).toBe(false);
    expect(restored.grants()[0]!.grantId).toBe(grantId);
    expect(await restored.principalForToken(tokens.access_token)).toMatchObject({ workspaceId: h.workspace.workspaceId });
    const client = new Client({ name: "restart-browser-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), { fetch: h.proxyFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }) as Transport);
    try {
      const response = await client.callTool({ name: "workspace_query", arguments: {} }); expect(response.isError).not.toBe(true);
      const visible = JSON.parse((response.content as Array<{ text: string }>)[0]!.text).workspaces;
      expect(visible[0].workspaceId).toBe(h.workspace.workspaceId);
    } finally { await client.close(); }
    const refresh = await h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: auth.client.client_id, refresh_token: tokens.refresh_token, resource: `${h.origin}/mcp` }) });
    expect(refresh.status).toBe(200);
    const expiresAt = restored.grants()[0]!.expiresAt;
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    try {
      expect(restored.grants()).toHaveLength(0);
      expect((await h.proxyFetch(`${h.origin}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    } finally { clock.mockRestore(); }
    await restored.stop(); expect(restored.grants()).toHaveLength(0);
    const stopped = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => stopped.shutdown());
    await stopped.initialize(); expect(stopped.status().enabled).toBe(false);
  }, persistentTimeout);

  it("retains dynamic OAuth client metadata for reauthorization and exposes only safe request history", async () => {
    const h = await fixture();
    await h.remote.startQuick({ consent: true, connectionOnly: true }); await h.waitFor("ready");
    const first = await authorize(h, ["planning:read"]);
    await h.remote.decideApproval(first.pending.requestId, { decision: "deny" });
    const afterDeny = h.remote.status();
    expect(afterDeny.authorizationRequests?.find(item => item.requestId === first.pending.requestId)).toMatchObject({ status: "rejected", clientId: first.client.client_id });
    const statusJson = JSON.stringify(afterDeny);
    expect(statusJson).not.toMatch(/codeChallenge|redirectUri|access_token|refresh_token|authorization_code/);
    const secondResponse = await h.proxyFetch(`${h.origin}/authorize?${first.params.toString()}`);
    expect(secondResponse.status).toBe(200);
    const second = h.remote.approvals().at(-1)!;
    expect(second.clientId).toBe(first.client.client_id);
    const clock = vi.spyOn(Date, "now").mockReturnValue(second.expiresAt + 1);
    try { expect(h.remote.status().authorizationRequests?.find(item => item.requestId === second.requestId)?.status).toBe("expired"); }
    finally { clock.mockRestore(); }
  });
  it("establishes transport before choosing a workspace, then promotes access without changing the tunnel or granting implicitly", async () => {
    const h = await fixture();
    await h.remote.startQuick({ consent: true, connectionOnly: true }); await h.waitFor("ready");
    expect(h.remote.status().workspaceId).toBeUndefined(); expect(h.remote.grants()).toHaveLength(0);
    const auth = await authorize(h, ["planning:read"]);
    expect(h.remote.status().mcpUrl).toBe(`${h.origin}/mcp`); expect(h.counters().starts).toBe(1);
    expect(h.remote.grants()).toHaveLength(0);
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["planning:read"] });
    expect(h.remote.grants()).toHaveLength(1);
    await expect(h.remote.startQuick({ consent: true })).rejects.toThrow("oauth_workspace_required");
    await expect(h.remote.startQuick({ consent: true, connectionOnly: true, workspaceId: h.workspace.workspaceId })).rejects.toThrow("oauth_workspace_invalid");
  });

  it("restores connection-only intent without inventing an authorized workspace", async () => {
    const h = await fixture(); await h.remote.startQuick({ consent: true, connectionOnly: true }); await h.waitFor("ready");
    await h.remote.shutdown();
    const restored = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => restored.shutdown());
    await restored.initialize(); await expect.poll(() => restored.status().transport).toBe("ready");
    expect(restored.status().workspaceId).toBeUndefined(); expect(restored.grants()).toHaveLength(0);
  });

  it("reuses an alive tunnel after a failed probe and preserves its public address and existing grant", async () => {
    const h = await fixture(); await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const auth = await authorize(h, ["planning:read"]);
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["planning:read"] });
    h.setOffline(true); await h.remote.testConnection(); await h.waitFor("error");
    h.setOffline(false); await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    expect(h.counters()).toEqual({ starts: 1, stops: 0 }); expect(h.remote.status().mcpUrl).toBe(`${h.origin}/mcp`); expect(h.remote.grants()).toHaveLength(1);
  });

  it("restores saved intent on daemon restart, invalidates old grants after an address change, and preserves an explicit stop", async () => {
    let starts = 0;
    const h = await fixture({ tunnel: { async start() { starts++; return { origin: starts === 1 ? "https://example-quick.trycloudflare.com" : "https://new-quick.trycloudflare.com", async stop() {} }; } } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const auth = await authorize(h, ["planning:read"]);
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["planning:read"] });
    expect(h.remote.grants()).toHaveLength(1);
    await h.remote.shutdown();
    const restarted = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => restarted.shutdown());
    await restarted.initialize();
    await expect.poll(() => restarted.status().transport).toBe("ready");
    expect(restarted.status().addressChanged).toBe(true); expect(restarted.grants()).toHaveLength(0); expect(starts).toBe(2);
    await restarted.stop();
    const stopped = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => stopped.shutdown());
    await stopped.initialize(); expect(stopped.status().enabled).toBe(false); expect(starts).toBe(2);
  }, persistentTimeout);

  it("requires consent and serializes a switch from a pending tunnel to fixed HTTPS", async () => {
    const h = await fixture();
    await expect(h.remote.startQuick({ consent: false, workspaceId: h.workspace.workspaceId })).rejects.toThrow("remote_consent_required");
    await expect(h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId, scopes: ["unknown"] })).rejects.toThrow("oauth_scope_invalid");
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    await h.remote.configure("https://fixed.example.com");
    await h.waitFor("ready");
    expect(h.remote.status().mode).toBe("fixed_https"); expect(h.remote.status().mcpUrl).toBe("https://fixed.example.com/mcp");
    expect(h.counters().stops).toBeLessThanOrEqual(1); expect(h.remote.grants()).toHaveLength(0);
  });
  it("runs DCR/PKCE, narrows scopes, binds the project, rejects code and refresh replay, and revokes access", async () => {
    const h = await fixture();
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId, scopes: ["repository:read", "planning:read", "planning:write"] });
    await h.waitFor("ready");
    const otherPath = join(h.root, "other"); await mkdir(otherPath); const other = await h.service.addWorkspace(otherPath);
    const auth = await authorize(h, ["repository:read", "planning:read", "planning:write", "session:control"]);
    expect(auth.pending.requestedScopes).not.toContain("session:control");
    await expect(h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: "missing", scopes: ["planning:read"] })).rejects.toThrow("workspace_not_found");
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["repository:read", "planning:read", "planning:write"] });
    const approved = await h.remote.approvalStatus(auth.pending.requestId);
    const code = new URL(approved.redirectUrl!).searchParams.get("code")!;
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` });
    const exchange = (body: URLSearchParams) => h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const wrong = new URLSearchParams(form); wrong.set("code_verifier", "x".repeat(64));
    expect((await exchange(wrong)).ok).toBe(false);
    const wrongResource = new URLSearchParams(form); wrongResource.set("resource", `${h.origin}/different`);
    expect((await exchange(wrongResource)).ok).toBe(false);
    const tokenReply = await exchange(form); expect(tokenReply.status).toBe(200);
    const tokens = await tokenReply.json() as { access_token: string; refresh_token: string };
    expect((await exchange(form)).ok).toBe(false);
    const client = new Client({ name: "oauth-browser-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/mcp`), { fetch: h.proxyFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }) as Transport);
    cleanups.push(() => client.close());
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "planning_prepare")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "connection_probe" || tool.name === "session_control")).toBe(false);
    const workspaces = await client.callTool({ name: "workspace_query", arguments: {} });
    const visible = JSON.parse((workspaces.content as Array<{ text: string }>)[0]!.text).workspaces;
    expect(visible).toHaveLength(1); expect(visible[0].workspaceId).toBe(h.workspace.workspaceId);
    const forbidden = await client.callTool({ name: "planning_prepare", arguments: { workspaceId: other.workspaceId, requestKey: randomUUID(), role: "plan", message: "test" } });
    expect(forbidden.isError).toBe(true);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      if (result.isError) throw new Error(value.error); return value;
    };
    const prepared = await call("planning_prepare", { workspaceId: h.workspace.workspaceId, requestKey: randomUUID(), role: "plan", message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } });
    const ownership = await call("handoff_claim", { workspaceId: h.workspace.workspaceId, operationId: prepared.operation.operationId, requestKey: randomUUID() });
    const operation = ownership.context;
    const proof = { claimToken: ownership.claimToken, generation: ownership.generation };
    const execution = { runnerId: "mock", mode: "managed" };
    const reply = { kind: "draft", message: "实现并验证问候函数。", plan: { schemaVersion: 1, id: "quick-demo", title: "问候函数", tasks: [
      { task: { schemaVersion: 1, id: "implement", title: "实现", prompt: "增加问候函数，并补充测试", execution }, dependsOn: [], status: "planned" },
      { task: { schemaVersion: 1, id: "verify", title: "验证", prompt: "验证问候函数测试", execution }, dependsOn: ["implement"], status: "planned" },
    ] }, requirementsUpdate: { messageDecisions: [{ messageId: operation.sourceMessageId, kind: "requirement", reason: "功能需求" }], changes: [{ requirementId: "R-greet", text: "增加问候函数，并补充测试", status: "active", sourceMessageIds: [operation.sourceMessageId] }] }, planningAssessment: { profile: "general", classification: { rationale: "单功能示例", sourceMessageId: operation.sourceMessageId, quote: "增加问候函数，并补充测试" }, decisions: [] } };
    expect((await call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: operation.operationId, requestKey: randomUUID(), ...proof, reply })).job.status).toBe("succeeded");
    const review = await call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId: operation.planningId, requestKey: randomUUID(), role: "review" });
    const reviewClaim = await call("handoff_claim", { workspaceId: h.workspace.workspaceId, operationId: review.operation.operationId, requestKey: randomUUID() });
    expect((await call("external_submit", { workspaceId: h.workspace.workspaceId, claimToken: reviewClaim.claimToken, generation: reviewClaim.generation, operationId: review.operation.operationId, requestKey: randomUUID(), reply: { summary: "任务覆盖需求且依赖完整", findings: [], resolutions: [] } })).job.status).toBe("succeeded");
    const localPort = await freePort();
    const localServer = await createLocalServer(h.service, { port: localPort, host: "127.0.0.1", dataDirectory: h.dataDirectory, remoteMcp: h.remote });
    await new Promise<void>((resolve, reject) => { localServer.once("error", reject); localServer.listen(localPort, "127.0.0.1", resolve); });
    cleanups.push(() => new Promise<void>((resolve) => { localServer.closeAllConnections(); localServer.close(() => resolve()); }));
    const localOrigin = `http://127.0.0.1:${localPort}`;
    const page = await fetch(localOrigin); const cookie = page.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const localAction = async (action: string, body: Record<string, unknown>) => {
      const response = await fetch(`${localOrigin}/api/v1/workspaces/${h.workspace.workspaceId}/plannings/${operation.planningId}/${action}`, { method: "POST", headers: { Origin: localOrigin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID(), ...body }) });
      expect(response.status).toBe(202); const job = await response.json() as { jobId: string };
      for (let i = 0; i < 100; i++) { const status = await h.service.getJob(job.jobId); if (status.status !== "running") return status; await new Promise((resolve) => setTimeout(resolve, 20)); }
      throw new Error("local job did not finish");
    };
    const view = await call("planning_query", { workspaceId: h.workspace.workspaceId, planningId: operation.planningId });
    expect((await localAction("approve", { draftRevision: view.draft.draftRevision })).status).toBe("succeeded");
    expect((await localAction("run", { isolation: "shared", maxParallel: 1 })).status).toBe("succeeded");
    const completed = await call("planning_query", { workspaceId: h.workspace.workspaceId, planningId: operation.planningId });
    expect(completed.session).toBeUndefined(); // session:read was not granted.
    const localView = await h.service.planningView(h.workspace, operation.planningId) as { session: { status: string } };
    expect(localView.session.status).toBe("succeeded");
    h.setOffline(true); await h.remote.testConnection(); await h.waitFor("error");
    expect(h.remote.grants()).toHaveLength(1); expect(h.remote.status().mcpUrl).toBeUndefined();
    h.setOffline(false); await h.remote.testConnection(); await h.waitFor("ready");
    expect(await h.remote.principalForToken(tokens.access_token)).toBeDefined();
    const refresh = new URLSearchParams({ grant_type: "refresh_token", client_id: auth.client.client_id, refresh_token: tokens.refresh_token, resource: `${h.origin}/mcp` });
    expect((await exchange(refresh)).status).toBe(200);
    expect((await exchange(refresh)).ok).toBe(false);
    await expect(h.remote.principalForToken(tokens.access_token)).rejects.toThrow();
    await h.remote.stop(); expect(h.remote.grants()).toHaveLength(0);
  }, 15_000);

  it("keeps one public entry while ChatGPT and Claude get independently editable project grants", async () => {
    const h = await fixture();
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const otherPath = join(h.root, "second"); await mkdir(otherPath); const other = await h.service.addWorkspace(otherPath);
    const scopes = ["repository:read", "planning:read", "planning:write"];
    const first = await authorize(h, scopes);
    await h.remote.decideApproval(first.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, source: "chatgpt", scopes });
    expect(h.remote.status().mcpUrl).toBe(`${h.origin}/mcp`); expect(h.counters()).toEqual({ starts: 1, stops: 0 });
    expect(h.remote.grants()).toHaveLength(1);
    const second = await authorize(h, scopes);
    await h.remote.decideApproval(second.pending.requestId, { decision: "allow", workspaceId: other.workspaceId, workspaceIds: [h.workspace.workspaceId, other.workspaceId], source: "claude", scopes });
    const grants = h.remote.grants(); expect(grants.map(item => item.source).sort()).toEqual(["chatgpt", "claude"]);
    expect(grants.map(item => item.createdAt)).toEqual(grants.map(item => item.createdAt).sort((a, b) => b - a));
    const firstGrant = grants.find(item => item.clientId === first.client.client_id)!;
    expect(firstGrant.workspaceIds).toEqual([h.workspace.workspaceId]);
    expect(h.remote.status().authorizationStates?.map(item => item.status)).toEqual(["active", "active"]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Math.max(...grants.map(item => item.expiresAt)) + 1);
    try { expect(h.remote.status().authorizationStates?.map(item => item.status)).toEqual(["expired", "expired"]); }
    finally { clock.mockRestore(); }
    await h.remote.updateGrant(firstGrant.grantId, { workspaceIds: [h.workspace.workspaceId, other.workspaceId], source: "chatgpt", alias: "我的 ChatGPT" });
    expect(h.remote.grants().find(item => item.grantId === firstGrant.grantId)?.alias).toBe("我的 ChatGPT");
    await h.remote.updateGrant(firstGrant.grantId, { workspaceIds: [h.workspace.workspaceId, other.workspaceId], source: "chatgpt", alias: "" });
    expect(h.remote.grants().find(item => item.grantId === firstGrant.grantId)?.alias).toBeUndefined();
    const exchange = async (auth: typeof first) => {
      const approval = await h.remote.approvalStatus(auth.pending.requestId);
      expect(approval, JSON.stringify({ approval, grants: h.remote.grants(), requestId: auth.pending.requestId })).toHaveProperty("redirectUrl");
      const code = new URL(approval.redirectUrl!).searchParams.get("code")!;
      const response = await h.proxyFetch(`${h.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.client.client_id, code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${h.origin}/mcp` }) });
      expect(response.status).toBe(200); return await response.json() as { access_token: string };
    };
    const tokens = await exchange(first), principal = (await h.remote.principalForToken(tokens.access_token))!;
    expect(principal.workspaceIds).toHaveLength(2);
    await h.remote.updateGrant(firstGrant.grantId, { workspaceIds: [h.workspace.workspaceId], source: "chatgpt" });
    await expect(principal.assertActive!(other.workspaceId)).rejects.toThrow("mcp_workspace_forbidden");
    const claudeTokens = await exchange(second);
    await h.remote.revokeGrant(firstGrant.grantId);
    expect(h.remote.status().authorizationStates?.find(item => item.grantId === firstGrant.grantId)?.status).toBe("revoked");
    expect(JSON.stringify(h.remote.status().authorizationStates)).not.toMatch(/access_token|refreshDigest|tokenHash/);
    await expect(h.remote.principalForToken(tokens.access_token)).rejects.toThrow();
    expect((await h.remote.principalForToken(claudeTokens.access_token))!.source).toBe("claude");
    expect(h.counters()).toEqual({ starts: 1, stops: 0 });
  }, 15_000);

  it("renames a connector through the local API without modifying authorization or reconnecting", async () => {
    const h = await fixture();
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    const auth = await authorize(h, ["planning:read"], { clientName: "ChatGPT" });
    await h.remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["planning:read"] });
    const original = h.remote.grants()[0]!;
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const server = await createLocalServer(h.service, { port, host: "127.0.0.1", dataDirectory: h.dataDirectory, remoteMcp: h.remote });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const cookie = (await fetch(origin)).headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const route = `${origin}/api/v1/remote-connection/grants/${original.grantId}/name`;
    const rename = (alias: unknown, headers: Record<string, string> = { Cookie: cookie, Origin: origin }) => fetch(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ alias }) });
    expect((await rename("demo1", { Origin: origin })).status).toBe(403);
    expect((await rename("demo1", { Cookie: cookie, Origin: "https://evil.test" })).status).toBe(403);
    expect((await rename("  demo1  ")).status).toBe(200);
    expect(h.remote.grants()[0]).toEqual({ ...original, alias: "demo1" });
    expect(h.remote.status().clients?.find(item => item.grantId === original.grantId)?.name).toBe("demo1");
    for (const invalid of [42, "x".repeat(81), "name\ncontrol"]) expect((await rename(invalid)).status).toBe(400);
    expect(h.remote.grants()[0]?.alias).toBe("demo1");
    expect((await rename("")).status).toBe(200); expect(h.remote.grants()[0]).toEqual(original);
    expect(h.counters()).toEqual({ starts: 1, stops: 0 }); expect(h.remote.status().mcpUrl).toBe(`${h.origin}/mcp`);
    await h.remote.revokeGrant(original.grantId);
    expect((await rename("revoked" )).ok).toBe(false);
  }, 15_000);

  it("requires a local browser session and Origin to start or approve a connection", async () => {
    const h = await fixture(); const port = await freePort();
    const secondPath = join(h.root, "second-project"); await mkdir(secondPath);
    const secondWorkspace = await h.service.addWorkspace(secondPath);
    const server = await createLocalServer(h.service, { port, host: "127.0.0.1", dataDirectory: h.dataDirectory, remoteMcp: h.remote });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const origin = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ consent: true, workspaceId: h.workspace.workspaceId, workspaceIds: [secondWorkspace.workspaceId] });
    const start = (headers: Record<string, string>) => fetch(`${origin}/api/v1/remote-connection/quick`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    expect((await start({ Origin: origin })).status).toBe(403);
    const landing = await fetch(origin); const cookie = landing.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    expect((await start({ Cookie: cookie, Origin: "https://evil.test" })).status).toBe(403);
    const accepted = await start({ Cookie: cookie, Origin: origin }); expect(accepted.status).toBe(202);
    await h.waitFor("ready");
    expect(h.remote.status().workspaceIds).toEqual([h.workspace.workspaceId, secondWorkspace.workspaceId]);
    expect((await h.proxyFetch(`${h.origin}/api/v1/remote-connection`)).status).toBe(404);
    const auth = await authorize(h, ["planning:read"]);
    const route = `${origin}/api/v1/remote-connection/approvals/${auth.pending.requestId}`;
    expect((await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ decision: "allow", workspaceId: h.workspace.workspaceId, scopes: ["planning:read"] }) })).status).toBe(403);
    const deny = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify({ decision: "deny" }) });
    expect(deny.status).toBe(200); expect((await h.remote.approvalStatus(auth.pending.requestId)).status).toBe("rejected");
  }, 15_000);
  it("verifies the real HTTP OAuth metadata, challenge and MCP probe before exposing an address", async () => {
    const h = await fixture();
    const pending = await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId, scopes: ["repository:read", "planning:read"] });
    expect(pending.mcpUrl).toBeUndefined();
    const ready = await h.waitFor("ready");
    expect(ready.mcpUrl).toBe(`${h.origin}/mcp`);
    expect(ready.lastProbeAt).toBeTypeOf("number");
    expect((await h.proxyFetch(`${h.origin}/mcp`, { headers: { Authorization: `Bearer ${h.probeToken()}` } })).status).toBe(401);
    expect(h.counters()).toEqual({ starts: 1, stops: 0 });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId, scopes: ["repository:read", "planning:read"] });
    expect(h.counters().starts).toBe(1);
    const unauth = await h.proxyFetch(`${h.origin}/mcp`);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain(`${h.origin}/.well-known/oauth-protected-resource/mcp`);
    await h.remote.stop();
    expect(h.remote.status().mcpUrl).toBeUndefined();
    expect(h.counters().stops).toBe(1);
  }, 15_000);

  it("does not publish a busy port and keeps the address hidden after a failed probe", async () => {
    const h = await fixture({ probe: "fail" });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    const failed = await h.waitFor("error");
    expect(failed.mcpUrl).toBeUndefined();
    expect(failed.lastError).toContain("remote_probe_metadata");
    await expect.poll(async () => {
      const events = (await readFile(join(h.dataDirectory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      return events.findLast((event) => event.type === "remote_connection.updated" && event.payload?.phase === "error")?.payload?.error;
    }).toBe(failed.lastError);
    await h.remote.stop();
    const occupied = createServer((_request, response) => response.end("other service"));
    await new Promise<void>((resolve) => occupied.listen(h.port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    await expect(h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId })).rejects.toThrow("EADDRINUSE");
    expect(h.counters().starts).toBe(1);
  });

  it("cancels a pending probe and revokes the URL when the tunnel exits", async () => {
    const h = await fixture({ probe: "pause" });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    await h.waitFor("probing");
    await h.remote.stop();
    expect(h.remote.status().transport).toBe("stopped");
    expect(h.counters().stops).toBe(1);
    const resumed = await fixture();
    await resumed.remote.startQuick({ consent: true, workspaceId: resumed.workspace.workspaceId });
    await resumed.waitFor("ready"); resumed.exit();
    await resumed.waitFor("disconnected");
    expect(resumed.remote.status().mcpUrl).toBeUndefined();
  }, 15_000);
});

describe("component integrity and tunnel parser", () => {
  it("cleans incomplete downloads on cancellation and refuses oversized downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-cancel-install-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const content = Buffer.from("download");
    const asset = { name: "cloudflared-linux-amd64", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
    const controller = new AbortController();
    await expect(installCloudflared(root, asset, controller.signal, () => controller.abort(), async () => new Response(content))).rejects.toThrow();
    await expect(readFile(join(root, "cloudflared"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installCloudflared(root, { ...asset, bytes: 1 }, new AbortController().signal, () => undefined, async () => new Response(content))).rejects.toThrow("component_download_too_large");
    await expect(readFile(join(root, "cloudflared"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("stops a process that fails to provide a URL and distinguishes unexpected exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-timeout-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "silent-component"); await writeFile(script, "#!/bin/sh\nexec sleep 300\n", { mode: 0o700 });
    await expect(new QuickTunnelAdapter(50).start(script, 4178, root, new AbortController().signal, () => undefined)).rejects.toThrow("tunnel_url_timeout");
    const exitScript = join(root, "exit-component"); await writeFile(exitScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(new QuickTunnelAdapter(1000).start(exitScript, 4178, root, new AbortController().signal, () => undefined)).rejects.toThrow("tunnel_process_exited");
  });
  it("rejects a tampered download before it can be installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-component-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const content = Buffer.from("official binary test bytes");
    const asset = { name: "cloudflared-linux-amd64", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
    const fetcher: typeof fetch = async () => new Response(content);
    await installCloudflared(root, asset, new AbortController().signal, () => undefined, fetcher);
    const binary = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    expect(await readFile(join(root, binary))).toEqual(content);
    const bad = { ...asset, sha256: "0".repeat(64) };
    const rejected = join(root, "rejected");
    await expect(installCloudflared(rejected, bad, new AbortController().signal, () => undefined, fetcher)).rejects.toThrow("component_integrity_failed");
    await expect(readFile(join(rejected, binary))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("recognizes only complete Quick Tunnel origins across process output chunks", async () => {
    expect(discoverQuickOrigin("URL https://sample.trycloudflare.com | ready")).toBe("https://sample.trycloudflare.com");
    expect(discoverQuickOrigin("https://sample.trycloudflare.com.evil.test")).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), "token-coupon-tunnel-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "fake-cloudflared");
    await writeFile(script, "#!/bin/sh\nprintf 'https://chunked.trycloud' >&2\nprintf 'flare.com\\n' >&2\nexec sleep 300\n", { mode: 0o700 });
    const adapter = new QuickTunnelAdapter();
    const runtime = await adapter.start(script, 4178, root, new AbortController().signal, () => undefined);
    await runtime.stop();
    expect(runtime.origin).toBe("https://chunked.trycloudflare.com");
  }, 15_000);
  it("retries only transient failures, reports progress and preserves the same tunnel", async () => {
    let calls = 0;
    const h = await fixture({ retryDelaysMs: [25, 25], probeImpl: async () => { calls++; if (calls < 3) throw new ProbeError("remote_probe_network：测试 ECONNRESET", true); } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    await h.waitFor("ready");
    expect(calls).toBe(3); expect(h.counters()).toEqual({ starts: 1, stops: 0 });
    expect(h.remote.status().probeCheck).toMatchObject({ state: "succeeded", attempt: 3, maxAttempts: 3, background: false });
    expect(h.service.eventsAfter(0).filter(event => (event.payload as any)?.phase === "reconnecting")).toHaveLength(2);
    expect(h.remote.status().remoteClientVerified).toBe(false); expect(h.remote.status().recentCalls).toEqual([]);
    let hardCalls = 0;
    const denied = await fixture({ retryDelaysMs: [1, 1], probeImpl: async () => { hardCalls++; throw new ProbeError("remote_probe_metadata：HTTP 403"); } });
    await denied.remote.startQuick({ consent: true, workspaceId: denied.workspace.workspaceId }); await denied.waitFor("error");
    expect(hardCalls).toBe(1); expect(denied.remote.status().probeCheck?.state).toBe("failed");
  });

  it("bounds checks by a total deadline and keeps ready state during a regular health check", async () => {
    const timed = await fixture({ probeBudgetMs: 40, probeImpl: async (_origin, _token, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
    await timed.remote.startQuick({ consent: true, workspaceId: timed.workspace.workspaceId }); await timed.waitFor("error");
    expect(timed.remote.status().lastError).toContain("总时间预算"); expect(timed.counters().starts).toBe(1);
    let finish: (() => void) | undefined, checks = 0;
    const h = await fixture({ probeImpl: async () => { if (++checks > 1) await new Promise<void>(resolve => { finish = resolve; }); } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    await h.remote.testConnection(); await expect.poll(() => !!finish).toBe(true);
    expect(h.remote.status()).toMatchObject({ transport: "ready", busy: false, probeCheck: { background: true, state: "checking" } });
    finish!(); await expect.poll(() => h.remote.status().probeCheck?.state).toBe("succeeded");
  });

  it("rechecks an initial transient failure and recovers without rebuilding its tunnel", async () => {
    let calls = 0;
    const h = await fixture({ healthIntervalMs: 80, retryDelaysMs: [], probeImpl: async () => { if (++calls === 1) throw new ProbeError("remote_probe_metadata：HTTP 530", true); } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    await h.waitFor("error"); const origin = h.remote.status().publicOrigin;
    await h.waitFor("ready");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(h.remote.status().publicOrigin).toBe(origin);
    expect(h.remote.status().lastError).toBeUndefined();
    expect(h.counters()).toEqual({ starts: 1, stops: 0 });
  });

  it("keeps fresh Quick Tunnel discovery unready during transient warmup and only succeeds after a full probe", async () => {
    let calls = 0;
    let complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const h = await fixture({ startupBudgetMs: 2000, retryDelaysMs: [], startupRetryDelayMs: 15, probeImpl: async () => { if (++calls < 4) throw new ProbeError("remote_probe_network：ECONNRESET", true); await gate; } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId });
    await expect.poll(() => !!h.remote.status().startupReadiness).toBe(true);
    expect(h.remote.status().mcpUrl).toBeUndefined();
    expect(h.remote.status().lastError).toBeUndefined();
    await expect.poll(() => calls).toBe(4); complete();
    await h.waitFor("ready");
    expect(h.remote.status().startupReadiness).toBeUndefined();
    expect(h.counters()).toEqual({ starts: 1, stops: 0 });
    expect(h.service.eventsAfter(0).filter(event => (event.payload as any)?.phase === "error")).toHaveLength(0);
  });

  it("bounds startup readiness and never delays permanent failures or user cancellation", async () => {
    const timed = await fixture({ startupBudgetMs: 50, retryDelaysMs: [], probeImpl: async () => { throw new ProbeError("remote_probe_network：ECONNRESET", true); } });
    await timed.remote.startQuick({ consent: true, workspaceId: timed.workspace.workspaceId }); await timed.waitFor("error");
    expect(timed.remote.status().lastError).toContain("remote_probe_startup_timeout");
    expect(timed.remote.status().startupReadiness).toBeUndefined();
    let calls = 0;
    const denied = await fixture({ startupBudgetMs: 1000, probeImpl: async () => { calls++; throw new ProbeError("remote_probe_binding：错误 issuer"); } });
    await denied.remote.startQuick({ consent: true, workspaceId: denied.workspace.workspaceId }); await denied.waitFor("error");
    expect(calls).toBe(1); expect(denied.remote.status().lastError).toContain("remote_probe_binding");
    const stopped = await fixture({ startupBudgetMs: 1000, probe: "pause" });
    await stopped.remote.startQuick({ consent: true, workspaceId: stopped.workspace.workspaceId });
    await expect.poll(() => !!stopped.remote.status().startupReadiness).toBe(true); await stopped.remote.stop();
    expect(stopped.remote.status().transport).toBe("stopped"); expect(stopped.remote.status().startupReadiness).toBeUndefined();
  });

  it("cancels scheduled initial-failure recovery when the user stops the connection", async () => {
    let calls = 0;
    const h = await fixture({ healthIntervalMs: 80, retryDelaysMs: [], probeImpl: async () => { calls++; throw new ProbeError("remote_probe_metadata：HTTP 530", true); } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("error");
    await h.remote.stop(); const stoppedCalls = calls;
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(calls).toBe(stoppedCalls); expect(h.remote.status().transport).toBe("stopped");
  });

  it("recovers the same pending review after a changed URL and fresh OAuth, with truthful call diagnostics", async () => {
    let starts = 0;
    const oldOrigin = "https://old-demo.trycloudflare.com", newOrigin = "https://new-demo.trycloudflare.com";
    const h = await fixture({ tunnel: { async start() { return { origin: ++starts === 1 ? oldOrigin : newOrigin, async stop() {} }; } } });
    await h.remote.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); await h.waitFor("ready");
    expect(h.remote.status().remoteClientVerified).toBe(false); expect(h.remote.status().recentCalls).toEqual([]);
    const exchange = async (remote: RemoteMcpConnection, origin: string) => {
      const environment = { ...h, remote, origin };
      const auth = await authorize(environment, ["planning:read", "planning:write", "repository:read"]);
      await remote.decideApproval(auth.pending.requestId, { decision: "allow", workspaceId: h.workspace.workspaceId, source: "chatgpt", alias: "demo5", scopes: ["planning:read", "planning:write", "repository:read"] });
      const approval = await remote.approvalStatus(auth.pending.requestId);
      const response = await h.proxyFetch(`${origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.client.client_id, code: new URL(approval.redirectUrl!).searchParams.get("code")!, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: `${origin}/mcp` }) });
      expect(response.status).toBe(200); return await response.json() as { access_token: string; refresh_token: string };
    };
    const connect = async (origin: string, tokens: { access_token: string }) => {
      const client = new Client({ name: "web-recovery-simulation", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { fetch: h.proxyFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }) as Transport);
      cleanups.push(() => client.close());
      return { client, call: async (name: string, args: Record<string, unknown> = {}) => { const result = await client.callTool({ name, arguments: args }); const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text); expect(result.isError, value.error).not.toBe(true); return value; } };
    };
    const oldTokens = await exchange(h.remote, oldOrigin), original = await connect(oldOrigin, oldTokens);
    const prepared = await original.call("planning_prepare", { workspaceId: h.workspace.workspaceId, role: "plan", requestKey: randomUUID(), message: "增加问候函数，并补充测试", executionDefaults: { runnerId: "mock", mode: "managed" } });
    const owner = await original.call("handoff_claim", { workspaceId: h.workspace.workspaceId, operationId: prepared.operation.operationId, requestKey: randomUUID() });
    const messageId = owner.context.sourceMessageId, planningId = owner.context.planningId;
    const task = (id: string) => ({ schemaVersion: 1, id, title: id, prompt: "增加问候函数，并补充测试", execution: { runnerId: "mock", mode: "managed" } });
    const reply = { kind: "draft", message: "规划完成，接着审查", plan: { schemaVersion: 1, id: "recovery", title: "恢复原计划", tasks: [{ task: task("implement"), dependsOn: [], status: "planned" }, { task: task("verify"), dependsOn: ["implement"], status: "planned" }] }, requirementsUpdate: { messageDecisions: [{ messageId, kind: "requirement", reason: "功能需求" }], changes: [{ requirementId: "R-greet", text: "增加问候函数，并补充测试", status: "active", sourceMessageIds: [messageId] }] }, planningAssessment: { profile: "general", classification: { rationale: "简单功能", sourceMessageId: messageId, quote: "增加问候函数，并补充测试" }, decisions: [] } };
    const committed = await original.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: owner.context.operationId, claimToken: owner.claimToken, generation: owner.generation, requestKey: randomUUID(), reply }); expect(committed.job.status, committed.job.error).toBe("succeeded");
    const review = await original.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId, role: "review", requestKey: randomUUID() });
    const before = await h.service.planningView(h.workspace, planningId) as any;
    await h.remote.shutdown();
    const restarted = new RemoteMcpConnection(h.service, h.dataDirectory, h.port, h.dependencies); cleanups.push(() => restarted.shutdown()); await restarted.initialize();
    await expect.poll(() => restarted.status().transport).toBe("ready");
    expect(restarted.status()).toMatchObject({ previousMcpUrl: `${oldOrigin}/mcp`, mcpUrl: `${newOrigin}/mcp`, validGrants: 0, remoteClientVerified: false });
    await restarted.startQuick({ consent: true, workspaceId: h.workspace.workspaceId }); expect(starts).toBe(2); expect(restarted.grants()).toHaveLength(0);
    const denied = await h.proxyFetch(`${newOrigin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${oldTokens.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_query", arguments: {} } }) });
    expect(denied.status).toBe(401); expect(denied.headers.get("www-authenticate")).toContain(newOrigin); expect(denied.headers.get("x-token-coupon-trace")).toBeTruthy();
    expect(restarted.status().recentCalls?.some(item => item.stage === "authentication" && item.code === "oauth_grant_revoked")).toBe(true);
    const freshTokens = await exchange(restarted, newOrigin); expect(restarted.status().remoteClientVerified).toBe(false);
    const fresh = await connect(newOrigin, freshTokens); expect(restarted.status().remoteClientVerified).toBe(false);
    await fresh.call("workspace_query"); expect(restarted.status().remoteClientVerified).toBe(true);
    const view = await fresh.call("planning_query", { workspaceId: h.workspace.workspaceId, planningId }); expect(view.draft.planHash).toBe(before.draft.planHash); expect(view.workflow.operationId).toBe(review.operation.operationId);
    const resumed = await fresh.call("planning_prepare", { workspaceId: h.workspace.workspaceId, planningId, role: "review", requestKey: randomUUID() }); expect(resumed.operation.operationId).toBe(review.operation.operationId);
    const reviewer = await fresh.call("handoff_claim", { workspaceId: h.workspace.workspaceId, operationId: review.operation.operationId, requestKey: randomUUID() });
    const done = await fresh.call("external_submit", { workspaceId: h.workspace.workspaceId, operationId: review.operation.operationId, claimToken: reviewer.claimToken, generation: reviewer.generation, requestKey: randomUUID(), reply: { summary: "原计划恢复后审查通过", findings: [], resolutions: [] } }); expect(done.job.status, done.job.error).toBe("succeeded");
    expect(await h.service.listPlannings(h.workspace.workspaceId)).toHaveLength(1);
    const final = await h.service.planningView(h.workspace, planningId) as any; expect(final.review.current).toBe(true); expect(final.approval).toBeNull(); expect(final.execution).toBeNull();
    const diagnostics = await readFile(join(h.dataDirectory, "remote-mcp-diagnostics.json"), "utf8");
    for (const secret of [oldTokens.access_token, oldTokens.refresh_token, freshTokens.access_token, freshTokens.refresh_token, owner.claimToken, reviewer.claimToken, "增加问候函数"]) expect(diagnostics).not.toContain(secret);
    expect(diagnostics).toContain("workspace_query"); expect(diagnostics).toContain("oauth_grant_revoked");
  }, 20_000);

});
