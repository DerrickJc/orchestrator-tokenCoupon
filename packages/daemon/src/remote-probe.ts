import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { networkFetch, networkErrorCode } from "./network-fetch.js";

export class ProbeError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0) { super(message); }
}
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
// Quick Tunnel can return 530 while Cloudflare is still routing to the new tunnel.
const TRANSIENT_HTTP = new Set([408, 429, 502, 503, 504, 530]);
function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  const wait = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Math.max(0, Date.parse(value) - Date.now()) : 0;
  return Math.min(45_000, Number.isFinite(wait) ? wait : 0);
}
export function retryableProbeFailure(error: unknown): boolean {
  return error instanceof ProbeError ? error.retryable : TRANSIENT_CODES.has(networkErrorCode(error) ?? "");
}

export type PublicProbe = (origin: string, token: string, signal: AbortSignal) => Promise<void>;
export async function probeRemoteMcp(origin: string, token: string, parentSignal: AbortSignal, fetcher: typeof fetch = networkFetch): Promise<void> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
  // Never forward fetch/SDK messages: they can contain URLs or bearer credentials.
  const inspect = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) {
      parentSignal.throwIfAborted();
      if (error instanceof ProbeError) throw error;
      if (signal.aborted) throw new ProbeError(`remote_probe_timeout：${stage}超时，可重试当前地址`, true);
      const code = networkErrorCode(error);
      throw new ProbeError(code
        ? `remote_probe_network：${stage}失败（${code}）；请检查代理与 Cloudflare 公网访问，再重新测试连接`
        : `remote_probe_protocol：${stage}失败；请检查公网转发是否保留 MCP 请求和响应格式，再重新测试连接`, TRANSIENT_CODES.has(code ?? "") || TRANSIENT_HTTP.has(Number((error as { code?: unknown })?.code)));
    }
  };
  const json = async (path: string) => inspect(path.endsWith("/mcp") ? "OAuth resource 元数据读取" : "OAuth server 元数据读取", async () => {
    const response = await fetcher(`${origin}${path}`, { signal, redirect: "error", headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new ProbeError(response.status === 530
        ? "remote_probe_metadata：Cloudflare 暂时无法转发当前隧道（HTTP 530）；请先重测当前地址，无需立即重建连接或重新授权"
        : `remote_probe_metadata：公网 OAuth metadata 不可读（HTTP ${response.status}${response.ok ? "，响应不是 JSON" : ""}），请检查网络或代理路径`, TRANSIENT_HTTP.has(response.status), retryAfterMs(response));
    }
    const body = await response.text();
    if (body.length > 32_768) throw new ProbeError("remote_probe_metadata：metadata 超过限制");
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new ProbeError("remote_probe_metadata：公网 OAuth metadata 不是合法 JSON，请检查代理返回内容"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError("remote_probe_metadata：公网 OAuth metadata 必须是 JSON 对象");
    return value as Record<string, unknown>;
  });
  const [authorization, resource] = await Promise.all([json("/.well-known/oauth-authorization-server"), json("/.well-known/oauth-protected-resource/mcp")]);
  // The SDK serializes the root issuer as URL.href, including its trailing slash.
  const issuers = [origin, `${origin}/`];
  if (!issuers.includes(authorization.issuer as string) || authorization.authorization_endpoint !== `${origin}/authorize` || authorization.token_endpoint !== `${origin}/token` || resource.resource !== `${origin}/mcp` || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(authorization.issuer)) throw new Error("remote_probe_binding：公网 OAuth issuer/resource 与当前地址不一致");
  const challenge = await inspect("MCP 认证保护检查", () => fetcher(`${origin}/mcp`, { signal, redirect: "error", cache: "no-store", headers: { "X-Token-Coupon-Probe": token } }));
  await challenge.body?.cancel();
  if (TRANSIENT_HTTP.has(challenge.status)) throw new ProbeError(`remote_probe_network：MCP 认证保护检查失败（HTTP ${challenge.status}），可重试当前地址`, true, retryAfterMs(challenge));
  if (challenge.status !== 401 || extractWWWAuthenticateParams(challenge).resourceMetadataUrl?.href !== `${origin}/.well-known/oauth-protected-resource/mcp`) throw new Error("remote_probe_auth：公网 MCP 必须要求 OAuth 并返回可解析且匹配当前地址的认证提示，未通过认证保护检查");
  const client = new Client({ name: "token-coupon-connection-probe", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal },
    fetch: fetcher,
  });
  try {
    await inspect("MCP initialize", () => client.connect(transport as Transport));
    const tools = await inspect("MCP tools/list", () => client.listTools({}, { signal }));
    if (tools.tools.length !== 1 || tools.tools[0]?.name !== "connection_probe") throw new Error("remote_probe_mcp：公网 MCP 探测工具列表无效");
    const result = await inspect("MCP tools/call", () => client.callTool({ name: "connection_probe", arguments: {} }, undefined, { signal }));
    if (result.isError) throw new Error("remote_probe_mcp：公网 MCP 工具探测失败");
  } finally { await client.close().catch(() => undefined); }
}

/** Internal probe tokens cannot read a project or perform any business action. */
export function createProbeMcpServer(): McpServer {
  const server = new McpServer({ name: "token-coupon-connection-probe", version: "1" });
  server.registerTool("connection_probe", { description: "无项目数据的连接检查", inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, () => ({ content: [{ type: "text", text: "MCP connection reachable" }] }));
  return server;
}
