import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectionObservation } from "./connection-diagnostics.js";

interface RequestTrace { traceId: string; method?: string; code?: string; }
const traces = new WeakMap<IncomingMessage, RequestTrace>();
export const gatewayTrace = (request: IncomingMessage) => traces.get(request);
const routes = new Set(["/mcp", "/token", "/register", "/authorize", "/oauth/approval.js", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]);
const versions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const statusCodes: Record<number, string> = { 400: "gateway_bad_request", 404: "remote_route_not_found", 405: "remote_method_not_allowed", 406: "mcp_accept_invalid", 413: "mcp_body_limit", 415: "mcp_content_type_invalid", 421: "remote_host_invalid", 429: "gateway_rate_limited", 500: "gateway_internal_error", 503: "remote_not_ready" };

/** Record at the first application boundary, before Host, routing or OAuth checks. */
export function traceGatewayRequest(request: IncomingMessage, response: ServerResponse, endpoint: string, record: (entry: ConnectionObservation) => Promise<void>, internal = false): RequestTrace {
  const trace: RequestTrace = { traceId: randomUUID() }; traces.set(request, trace);
  response.setHeader("X-Token-Coupon-Trace", trace.traceId);
  const path = (request.url ?? "").split("?", 1)[0]!;
  const route = routes.has(path) ? path : /^\/oauth\/approval\/[0-9a-f-]{36}$/i.test(path) ? "/oauth/approval/:requestId" : "other";
  const headers = request.headers, auth = headers.authorization, accept = String(headers.accept ?? "").toLowerCase(), type = String(headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const version = headers["mcp-protocol-version"], ray = headers["cf-ray"];
  const metadata: Partial<ConnectionObservation> = {
    httpMethod: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method ?? "") ? (request.method ?? "OTHER") : "OTHER", route,
    authorization: !auth ? "missing" : /^Bearer\s+\S+$/i.test(auth) ? "bearer" : "other",
    accept: !accept ? "missing" : accept.includes("application/json") && accept.includes("text/event-stream") ? "json_and_sse" : accept.includes("application/json") ? "json" : accept.includes("text/event-stream") ? "sse" : "other",
    contentType: !type ? "missing" : type === "application/json" ? "json" : type === "application/x-www-form-urlencoded" ? "form" : "other",
    protocolVersion: !version ? "missing" : typeof version === "string" && versions.has(version) ? version : "other",
    hasSessionId: typeof headers["mcp-session-id"] === "string", ...(typeof ray === "string" ? { cloudflareRay: ray } : {}),
  };
  const quiet = internal || route.startsWith("/.well-known/") || route.startsWith("/oauth/approval");
  const startedAt = Date.now(); let finished = false;
  const emit = (entry: Partial<ConnectionObservation>) => {
    try { void record({ traceId: trace.traceId, at: Date.now(), endpoint, stage: "ingress", outcome: "received", ...metadata, ...entry }).catch(() => undefined); } catch { /* Observability must not fail a request. */ }
  };
  if (!quiet) emit({ requestState: "received" });
  const complete = (aborted: boolean) => {
    if (finished) return; finished = true;
    if (internal || quiet && !aborted && response.statusCode < 400) return;
    const code = aborted ? "gateway_connection_aborted" : trace.code ?? statusCodes[response.statusCode] ?? (response.statusCode >= 400 ? "gateway_http_error" : undefined);
    emit({ requestState: aborted ? "aborted" : "completed", outcome: aborted || response.statusCode >= 400 ? "error" : "received", durationMs: Date.now() - startedAt,
      ...(!aborted ? { httpStatus: response.statusCode } : {}), ...(trace.method ? { method: trace.method } : {}), ...(code ? { code } : {}) });
  };
  response.once("finish", () => complete(false));
  response.once("close", () => complete(!response.writableFinished));
  return trace;
}
