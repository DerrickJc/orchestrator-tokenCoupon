import { Agent, EnvHttpProxyAgent } from "undici";

/** Proxy support is local to downloads/probes; it does not change core or Runner traffic. */
export function createNetworkClient(environment: NodeJS.ProcessEnv = process.env, fetcher: typeof globalThis.fetch = globalThis.fetch) {
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? "";
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? "";
  const noProxy = environment.no_proxy ?? environment.NO_PROXY ?? "";
  let dispatcher: EnvHttpProxyAgent | undefined;
  let directDispatcher: Agent | undefined;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // The local control plane must never be routed through an external proxy.
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      directDispatcher ??= new Agent();
      return fetcher(input, { ...init, dispatcher: directDispatcher } as RequestInit);
    }
    if (!httpProxy && !httpsProxy) return fetcher(input, init);
    dispatcher ??= new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
    return fetcher(input, { ...init, dispatcher } as RequestInit);
  };
  return { fetch, close: async () => { await Promise.all([dispatcher?.close(), directDispatcher?.close()]); } };
}

// Configuration is read on first use, after daemon environment loading.
let client: ReturnType<typeof createNetworkClient> | undefined;
export const networkFetch: typeof fetch = (input, init) => (client ??= createNetworkClient()).fetch(input, init);

/** Only expose known error codes; raw messages can contain proxy credentials or URLs. */
export function networkErrorCode(error: unknown): string | undefined {
  const allowed = new Set(["EACCES", "EPERM", "ENOSPC", "ENOENT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_INVALID_ARG", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"]);
  const visited = new Set<unknown>();
  const visit = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || visited.has(value)) return undefined;
    visited.add(value);
    const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof item.code === "string" && allowed.has(item.code)) return item.code;
    if (item.name === "TimeoutError") return "ETIMEDOUT";
    for (const child of [item.cause, ...(Array.isArray(item.errors) ? item.errors : [])]) { const code = visit(child); if (code) return code; }
    return undefined;
  };
  return visit(error);
}
