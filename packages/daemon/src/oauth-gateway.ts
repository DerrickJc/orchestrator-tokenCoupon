import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { sanitizeOutput, type ApplicationService } from "./application-service.js";
import { createMcpServer } from "./mcp-server.js";
import type { RemoteMcpPrincipal, RemoteMcpScope } from "./mcp-server.js";
import { CloudflaredComponent, type ComponentInfo, type ComponentProvider } from "./cloudflared-component.js";
import { PRESERVE_TUNNEL, type TunnelAdapter, type TunnelRuntime } from "./quick-tunnel.js";
import { PersistentQuickTunnelAdapter } from "./persistent-tunnel.js";
import { createProbeMcpServer, probeRemoteMcp, ProbeError, retryableProbeFailure, type PublicProbe } from "./remote-probe.js";
import { ConnectionDiagnostics, type ConnectionObservation } from "./connection-diagnostics.js";

const require = createRequire(import.meta.url);
const express = require("express") as ExpressFactory;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const GRANT_TTL_MS = 72 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 2 * 60 * 1000;
const AUTH_CODE_TTL_MS = 60 * 1000;
const SUPPORTED_SCOPES: RemoteMcpScope[] = ["repository:read", "planning:read", "planning:write", "session:read", "session:control"];

type ExpressRequest = IncomingMessage & { method: string; url?: string; headers: IncomingMessage["headers"]; body?: unknown; params: Record<string, string>; query: Record<string, unknown> };
type ExpressResponse = ServerResponse & { status(code: number): ExpressResponse; type(value: string): ExpressResponse; send(value: string | object): void; json(value: unknown): void };
type Handler = (request: ExpressRequest, response: ExpressResponse, next: (error?: unknown) => void) => void;
interface ExpressApp { use(...handlers: unknown[]): void; get(path: string, handler: Handler): void; post(path: string, handler: Handler): void; all(path: string, handler: Handler): void; }
interface ExpressFactory { (): ExpressApp; Router(): unknown; json(options?: { limit?: string | number }): Handler; }

interface StoredClient extends OAuthClientInformationFull { }
interface AuthorizationRequest {
  requestId: string; clientId: string; clientName: string; redirectUri: string; state?: string;
  codeChallenge: string; resource: string; requestedScopes: RemoteMcpScope[];
  createdAt: number; expiresAt: number; decision?: "approved" | "rejected";
}
type WebSource = "chatgpt" | "claude" | "other";
interface StoredGrant {
  grantId: string; clientId: string; workspaceId: string; workspaceIds?: string[]; source?: WebSource; alias?: string; redirectHost: string; scopes: RemoteMcpScope[]; resource: string;
  createdAt: number; expiresAt: number; revokedAt?: number;
  access: Array<{ digest: string; expiresAt: number }>;
  refreshDigest?: string; previousRefreshDigests: string[];
}
interface StoredCode { digest: string; grantId: string; clientId: string; redirectUri: string; codeChallenge: string; resource: string; expiresAt: number; usedAt?: number; }
interface PersistedState { version: 1; clients: StoredClient[]; requests: AuthorizationRequest[]; grants: StoredGrant[]; codes: StoredCode[]; }

export interface RemoteConnectionStatus {
  configured: boolean; enabled: boolean; publicOrigin?: string; mcpUrl?: string; gateway: "stopped" | "running" | "error";
  gatewayAddress?: string; lastError?: string; pendingApprovals: number; validGrants: number;
  remoteClientVerified: boolean;
  pendingTokenExchanges: number;
  mode: "quick_tunnel" | "fixed_https";
  transport: ConnectionPhase;
  busy: boolean;
  workspaceId?: string;
  workspaceIds?: string[];
  scopes?: RemoteMcpScope[];
  component?: { version: string; source: "existing" | "managed" };
  connectionProcess?: { persistent: boolean; recovered: boolean };
  lastProbeAt?: number;
  nextProbeAt?: number;
  startupReadiness?: { startedAt: number; deadlineAt: number; round: number };
  addressChanged: boolean;
  previousMcpUrl?: string;
  probeCheck?: { state: "checking" | "retrying" | "succeeded" | "failed"; attempt: number; maxAttempts: number; background: boolean; startedAt: number; retryAt?: number; lastError?: string };
  clients?: Array<{ grantId: string; clientId: string; name: string; source: string; workspaceIds: string[]; mcpUrl: string; createdAt: number; expiresAt: number; status: "active" | "expired" | "revoked" | "address_changed"; oauthState: "awaiting_token" | "token_issued"; lastCall?: ConnectionObservation }>;
  recentCalls?: ConnectionObservation[];
  diagnosticsUnavailable?: boolean;
  authorizationRequests?: Array<{ requestId: string; clientId: string; clientName: string; createdAt: number; expiresAt: number; status: "pending" | "approved" | "rejected" | "expired" }>;
  authorizationStates?: Array<{ grantId: string; source: string; workspaceIds: string[]; status: "active" | "expired" | "revoked" }>;
}
export type ConnectionPhase = "stopped" | "checking" | "downloading" | "verifying" | "starting" | "discovering" | "probing" | "ready" | "reconnecting" | "disconnected" | "error";
interface ConnectionConfig { mode: "quick_tunnel" | "fixed_https"; publicOrigin?: string; previousOrigin?: string; enabled: boolean; port: number; workspaceId?: string; workspaceIds?: string[]; scopes?: RemoteMcpScope[]; connectionOnly?: boolean; }
export interface ConnectionDependencies { component?: ComponentProvider; tunnel?: TunnelAdapter; probe?: PublicProbe; healthIntervalMs?: number; retryDelaysMs?: number[]; probeBudgetMs?: number; startupBudgetMs?: number; startupRetryDelayMs?: number; }

/** Owns the remote gateway and its separate, project-scoped OAuth grants. */
export class RemoteMcpConnection {
  private readonly configPath: string;
  private readonly statePath: string;
  private state: PersistedState = { version: 1, clients: [], requests: [], grants: [], codes: [] };
  private stateQueue: Promise<void> = Promise.resolve();
  private server: Server | undefined;
  private gatewaySocket: string | undefined;
  private gatewaySocketDirectory: string | undefined;
  private config: ConnectionConfig | undefined;
  private startupError: string | undefined;
  private loadFailed = false;
  private readonly approvalRedirects = new Map<string, string>();
  private readonly provider: OAuthServerProvider;
  private readonly clientsStore: OAuthServerProvider["clientsStore"];
  private gatewayHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  private connectionQueue: Promise<void> = Promise.resolve();
  private controller: AbortController | undefined;
  private background: Promise<void> | undefined;
  private healthTask: Promise<void> | undefined;
  private healthTimer: ReturnType<typeof setTimeout> | undefined;
  private runtime: TunnelRuntime | undefined;
  private componentInfo: ComponentInfo | undefined;
  private recoveredTunnel = false;
  private phase: ConnectionPhase = "stopped";
  private lastProbeAt: number | undefined;
  private addressChanged = false;
  private readonly probeTokens = new Map<string, number>();
  private readonly component: ComponentProvider;
  private readonly tunnel: TunnelAdapter;
  private readonly probe: PublicProbe;
  private readonly healthInterval: number;
  private readonly retryDelays: number[];
  private readonly probeBudget: number;
  private readonly startupBudget: number;
  private readonly startupRetryDelay: number;
  private startupReadiness: RemoteConnectionStatus["startupReadiness"];
  private nextProbeAt: number | undefined;
  private probeCheck: RemoteConnectionStatus["probeCheck"];
  private readonly diagnostics: ConnectionDiagnostics;
  private readonly tokenExchangeContext = new AsyncLocalStorage<{ code?: string }>();

  constructor(private readonly service: ApplicationService, private readonly dataDirectory: string, private port = 4178, dependencies: ConnectionDependencies = {}) {
    this.configPath = join(dataDirectory, "remote-mcp-connection.json");
    this.statePath = join(dataDirectory, "remote-mcp-oauth.json");
    this.component = dependencies.component ?? new CloudflaredComponent(dataDirectory);
    this.tunnel = dependencies.tunnel ?? new PersistentQuickTunnelAdapter();
    this.probe = dependencies.probe ?? probeRemoteMcp;
    this.healthInterval = dependencies.healthIntervalMs ?? 30_000;
    this.retryDelays = dependencies.retryDelaysMs ?? [1000, 3000];
    this.probeBudget = dependencies.probeBudgetMs ?? 45_000;
    this.startupBudget = dependencies.startupBudgetMs ?? 120_000;
    this.startupRetryDelay = dependencies.startupRetryDelayMs ?? 5000;
    this.diagnostics = new ConnectionDiagnostics(dataDirectory);
    const owner = this;
    this.clientsStore = {
      getClient: (clientId) => owner.state.clients.find((client) => client.client_id === clientId),
      registerClient: (client) => owner.registerClient(client),
    };
    this.provider = {
      get clientsStore() { return owner.clientsStore; },
      skipLocalPkceValidation: true,
      authorize: (client, params, response) => owner.beginAuthorization(client, params, response),
      challengeForAuthorizationCode: (client, code) => owner.challengeForAuthorizationCode(client, code),
      exchangeAuthorizationCode: (client, code, verifier, redirectUri, resource) => owner.diagnoseTokenExchange(() => owner.exchangeAuthorizationCode(client, code, verifier, redirectUri, resource)),
      exchangeRefreshToken: (client, token, scopes, resource) => owner.diagnoseTokenExchange(() => owner.exchangeRefreshToken(client, token, scopes, resource)),
      verifyAccessToken: (token) => owner.verifyAccessToken(token),
      revokeToken: (client, request) => owner.revokeToken(client, request),
    };
  }

  async initialize(): Promise<void> {
    await this.diagnostics.initialize();
    try {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
      this.state = await this.readJson<PersistedState>(this.statePath, { version: 1, clients: [], requests: [], grants: [], codes: [] });
      if (this.state.version !== 1 || !Array.isArray(this.state.clients) || !Array.isArray(this.state.requests) || !Array.isArray(this.state.grants) || !Array.isArray(this.state.codes)) throw new Error("remote_oauth_state_invalid：授权状态文件格式无效，远程访问保持关闭");
      // Older registration responses advertised public clients but retained SDK-generated
      // secrets. Honor that advertised method without changing IDs, grants or PKCE checks.
      for (const client of this.state.clients) if (client.token_endpoint_auth_method === "none") {
        delete client.client_secret; delete client.client_secret_expires_at;
      }
      const savedConfig = await this.readJson<ConnectionConfig | undefined>(this.configPath, undefined);
      if (savedConfig) {
        this.port = validateGatewayPort(savedConfig.port ?? this.port);
        this.config = { ...savedConfig, mode: savedConfig.mode ?? "fixed_https", port: this.port };
        if (!["quick_tunnel", "fixed_https"].includes(this.config.mode) || typeof this.config.enabled !== "boolean") throw new Error("remote_config_invalid：连接配置损坏");
        if (this.config.publicOrigin) this.config.publicOrigin = validatePublicOrigin(this.config.publicOrigin);
        if (this.config.mode === "quick_tunnel" && ((!this.config.workspaceId && this.config.connectionOnly !== true) || !this.config.scopes?.length || this.config.scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope)))) throw new Error("remote_config_invalid：快捷连接缺少有效项目或权限");
      }
      // Authorization codes are single-use and must not survive a daemon restart.
      this.state.codes = [];
    } catch (error) {
      this.loadFailed = true;
      this.startupError = error instanceof Error ? error.message : String(error);
      return;
    }
    if (this.config?.enabled) {
      try {
        if (this.config.mode === "quick_tunnel") await this.startQuick({ consent: true, ...(this.config.workspaceId ? { workspaceId: this.config.workspaceId, workspaceIds: this.config.workspaceIds ?? [this.config.workspaceId] } : { connectionOnly: true }), scopes: this.config.scopes!, port: this.port });
        else if (this.config.publicOrigin) await this.configure(this.config.publicOrigin, this.port);
        else throw new Error("remote_config_invalid：固定连接缺少 HTTPS Origin");
      } catch (error) { this.startupError = safeConnectionError(error); this.phase = "error"; }
    }
  }

  status(): RemoteConnectionStatus {
    const now = Date.now();
    const active = this.state.grants.filter((grant) => !grant.revokedAt && grant.expiresAt > now && grant.resource === `${this.config?.publicOrigin}/mcp`);
    const grants = active.length;
    const pendingApprovals = this.state.requests.filter((request) => !request.decision && request.expiresAt > now).length;
    const busy = ["checking", "downloading", "verifying", "starting", "discovering", "probing", "reconnecting"].includes(this.phase);
    const base: RemoteConnectionStatus = { configured: Boolean(this.config), enabled: Boolean(this.config?.enabled), gateway: this.server?.listening ? "running" : this.startupError ? "error" : "stopped", pendingApprovals, validGrants: grants, pendingTokenExchanges: active.filter(grant => !grant.refreshDigest && !grant.access.length).length, remoteClientVerified: false, mode: this.config?.mode ?? "quick_tunnel", transport: this.phase, busy, addressChanged: this.addressChanged };
    const authorizationHistory = [...this.state.requests].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(request => {
      const status: NonNullable<RemoteConnectionStatus["authorizationRequests"]>[number]["status"] = request.decision ?? (request.expiresAt <= now ? "expired" : "pending");
      return { requestId: request.requestId, clientId: request.clientId, clientName: request.clientName, createdAt: request.createdAt, expiresAt: request.expiresAt, status };
    });
    base.authorizationRequests = authorizationHistory;
    base.authorizationStates = this.state.grants.slice(-100).map(grant => ({ grantId: grant.grantId, source: grant.source || "来源待确认", workspaceIds: grant.workspaceIds ?? [grant.workspaceId], status: grant.revokedAt ? "revoked" : grant.expiresAt <= now ? "expired" : "active" }));
    const calls = this.diagnostics.recent();
    base.clients = [...this.state.grants].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(grant => {
      const lastCall = calls.filter(item => item.grantId === grant.grantId && item.endpoint === grant.resource && item.stage === "tool").at(-1);
      return { grantId: grant.grantId, clientId: grant.clientId, name: grant.alias || this.state.clients.find(item => item.client_id === grant.clientId)?.client_name || "历史网页客户端", source: grant.source || "来源待确认", workspaceIds: grant.workspaceIds ?? [grant.workspaceId], mcpUrl: grant.resource, createdAt: grant.createdAt, expiresAt: grant.expiresAt, oauthState: grant.refreshDigest || grant.access.length ? "token_issued" as const : "awaiting_token" as const,
        status: grant.revokedAt ? "revoked" as const : grant.expiresAt <= now ? "expired" as const : grant.resource !== `${this.config?.publicOrigin}/mcp` ? "address_changed" as const : "active" as const, ...(lastCall ? { lastCall } : {}) };
    });
    base.remoteClientVerified = base.clients.some(item => item.status === "active" && item.lastCall?.outcome === "success");
    base.recentCalls = calls.filter(item => item.endpoint === `${this.config?.publicOrigin}/mcp`).slice(-20).reverse();
    base.diagnosticsUnavailable = this.diagnostics.storageUnavailable;
    if (this.probeCheck) base.probeCheck = { ...this.probeCheck };
    if (this.startupReadiness) base.startupReadiness = { ...this.startupReadiness };
    if (this.nextProbeAt) base.nextProbeAt = this.nextProbeAt;
    const previous = this.config?.previousOrigin ? `${this.config.previousOrigin}/mcp` : [...this.state.grants].reverse().find(grant => grant.resource !== `${this.config?.publicOrigin}/mcp`)?.resource;
    if (previous) base.previousMcpUrl = previous;
    if (this.config?.publicOrigin) { base.publicOrigin = this.config.publicOrigin; if (this.phase === "ready" || this.phase === "probing" && this.lastProbeAt) base.mcpUrl = `${this.config.publicOrigin}/mcp`; }
    if (this.config?.workspaceId) { base.workspaceId = this.config.workspaceId; base.workspaceIds = this.config.workspaceIds ?? [this.config.workspaceId]; }
    if (this.config?.scopes) base.scopes = this.config.scopes;
    if (this.componentInfo) base.component = { version: this.componentInfo.version, source: this.componentInfo.source };
    if (this.runtime) base.connectionProcess = { persistent: this.runtime.persistent === true, recovered: this.recoveredTunnel };
    if (this.lastProbeAt) base.lastProbeAt = this.lastProbeAt;
    base.gatewayAddress = `http://127.0.0.1:${this.port}`;
    if (this.startupError) base.lastError = this.startupError;
    return base;
  }

  async configure(publicOrigin: string, requestedPort = this.config?.port ?? this.port): Promise<RemoteConnectionStatus> {
    if (this.loadFailed) throw new Error("remote_connection_state_invalid：授权状态加载失败，请先检查 daemon 状态与本地授权文件");
    const origin = validatePublicOrigin(publicOrigin);
    const port = validateGatewayPort(requestedPort);
    return this.runConnection(async () => {
      const revoke = this.config?.mode === "quick_tunnel" || this.config?.publicOrigin !== origin;
      await this.endRuntime(); await this.tunnel.stopSaved?.(join(this.dataDirectory, "components", "tunnel-runtime")); if (revoke) await this.revokeAll();
      const previousOrigin = this.config?.publicOrigin;
      this.port = port; this.config = { mode: "fixed_https", publicOrigin: origin, enabled: true, port, ...(previousOrigin && previousOrigin !== origin ? { previousOrigin } : {}) };
      await this.writeJson(this.configPath, this.config); this.startupError = undefined; this.addressChanged = Boolean(previousOrigin && previousOrigin !== origin); this.lastProbeAt = undefined;
      this.controller = new AbortController();
      try { await this.startGateway(origin); }
      catch (error) { this.startupError = safeConnectionError(error); this.phase = "error"; throw error; }
      this.setPhase("probing"); this.background = this.checkPublic(this.controller.signal).catch((error) => this.recordFailure(error));
      return this.status();
    });
  }

  async startQuick(input: { consent: boolean; workspaceId?: string; connectionOnly?: boolean; workspaceIds?: string[]; scopes?: string[]; port?: number }): Promise<RemoteConnectionStatus> {
    if (this.loadFailed) throw new Error("remote_connection_state_invalid：请先检查本地授权状态");
    if (input.consent !== true) throw new Error("remote_consent_required：请确认使用 Cloudflare 和自动下载官方连接组件");
    if (!input.workspaceId && input.connectionOnly !== true) throw new Error("oauth_workspace_required：请选择项目，或显式选择仅建立连接");
    if (input.connectionOnly && (input.workspaceId || input.workspaceIds?.length)) throw new Error("oauth_workspace_invalid：仅建立连接不能同时指定项目");
    if (input.workspaceId) await this.service.getWorkspace(input.workspaceId);
    for (const id of input.workspaceIds ?? []) await this.service.getWorkspace(id);
    const scopes = input.scopes ?? ["repository:read", "planning:read", "planning:write"];
    if (!scopes.length || scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope as RemoteMcpScope)) || scopes.includes("session:control") && !scopes.includes("planning:read")) throw new Error("oauth_scope_invalid：快捷连接权限无效");
    const port = validateGatewayPort(input.port ?? this.port);
    return this.runConnection(async () => {
      if (this.config?.enabled && this.config.mode === "quick_tunnel" && this.port === port && (this.status().busy || this.runtime && this.server?.listening)) {
        this.config.scopes = [...new Set([...(this.config.scopes ?? []), ...scopes])] as RemoteMcpScope[];
        this.config.workspaceIds = [...new Set([...(this.config.workspaceIds ?? (this.config.workspaceId ? [this.config.workspaceId] : [])), ...(input.workspaceId ? [input.workspaceId] : []), ...(input.workspaceIds ?? [])])];
        if (input.workspaceId) { this.config.workspaceId ??= input.workspaceId; delete this.config.connectionOnly; }
        await this.writeJson(this.configPath, this.config);
        if (this.phase === "error" && this.runtime && this.server?.listening) this.scheduleProbe();
        return this.status();
      }
      const previousOrigin = this.config?.publicOrigin;
      await this.endRuntime();
      this.port = port; this.config = { mode: "quick_tunnel", enabled: true, port, ...(input.workspaceId ? { workspaceId: input.workspaceId, workspaceIds: [...new Set([input.workspaceId, ...(input.workspaceIds ?? [])])] } : { connectionOnly: true, workspaceIds: [] }), scopes: [...new Set(scopes)] as RemoteMcpScope[], ...(previousOrigin ? { publicOrigin: previousOrigin } : {}) };
      await this.writeJson(this.configPath, this.config); this.startupError = undefined; this.lastProbeAt = undefined;
      this.controller = new AbortController(); const signal = this.controller.signal;
      try { await this.reserveGateway(); } // Never tunnel to another process that occupies this port.
      catch (error) { this.startupError = safeConnectionError(error); this.phase = "error"; throw error; }
      this.setPhase("checking");
      this.background = this.beginQuick(signal, previousOrigin).catch(async (error) => {
        if (!signal.aborted) { this.recordFailure(error); if (!this.runtime) await this.stopGateway(); }
      });
      return this.status();
    });
  }

  async stop(): Promise<RemoteConnectionStatus> {
    this.controller?.abort();
    return this.runConnection(async () => {
      await this.endRuntime(); await this.tunnel.stopSaved?.(join(this.dataDirectory, "components", "tunnel-runtime")); await this.revokeAll();
      if (this.config) { this.config = { ...this.config, enabled: false }; await this.writeJson(this.configPath, this.config); }
      this.startupError = undefined; this.setPhase("stopped");
      await this.service.publish({ type: "remote_connection.stopped" }); return this.status();
    });
  }

  private async revokeAll(): Promise<void> {
    await this.withState(async (state) => {
      state.requests = state.requests.map((request) => request.decision ? request : { ...request, decision: "rejected" });
      state.grants = state.grants.map((grant) => grant.revokedAt ? grant : { ...grant, revokedAt: Date.now() });
      state.codes = [];
    });
    this.approvalRedirects.clear();
    this.probeTokens.clear();
  }

  /** Business shutdown detaches the persistent tunnel; only explicit stop revokes access. */
  async shutdown(): Promise<void> { this.controller?.abort(PRESERVE_TUNNEL); await this.runConnection(() => this.endRuntime(true)); await this.diagnostics.flush(); }

  async testConnection(): Promise<RemoteConnectionStatus> {
    return this.runConnection(async () => {
      if (!this.config?.enabled || !this.config.publicOrigin || !this.server?.listening || this.config.mode === "quick_tunnel" && !this.runtime) throw new Error("remote_not_running：请先开启连接");
      if (!this.healthTask && !this.status().busy) this.scheduleProbe();
      return this.status();
    });
  }

  private async beginQuick(signal: AbortSignal, previousOrigin?: string): Promise<void> {
    const directory = join(this.dataDirectory, "components", "tunnel-runtime");
    const exited = () => {
      if (!signal.aborted) { this.controller?.abort(); void this.runConnection(async () => { this.runtime = undefined; await this.endRuntime(); await this.revokeAll(); this.startupError = "tunnel_process_exited：常驻隧道已退出，请重新开启；新地址需要在网页更新并授权"; this.setPhase("disconnected"); }).catch(() => undefined); }
    };
    let runtime = await this.tunnel.recover?.(this.port, directory, signal, exited);
    this.recoveredTunnel = Boolean(runtime);
    if (!runtime) {
      // Fresh tunnels change the OAuth resource. Saved grants only survive verified recovery.
      await this.revokeAll();
      this.componentInfo = await this.component.get(signal, (stage) => { if (!signal.aborted) this.setPhase(stage); }); signal.throwIfAborted();
      this.setPhase("discovering");
      runtime = await this.tunnel.start(this.componentInfo.executable, this.port, directory, signal, exited);
    }
    if (signal.aborted) { if (signal.reason === PRESERVE_TUNNEL && runtime.detach) await runtime.detach(); else await runtime.stop(); signal.throwIfAborted(); }
    this.runtime = runtime;
    if (runtime.attach && this.gatewaySocket) await runtime.attach(this.gatewaySocket);
    const origin = validatePublicOrigin(runtime.origin);
    if (!/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(origin)) throw new Error("tunnel_origin_invalid：组件未返回有效 Quick Tunnel 地址");
    if (this.recoveredTunnel && previousOrigin !== origin) await this.revokeAll();
    this.addressChanged = Boolean(previousOrigin && previousOrigin !== origin);
    this.config = { ...this.config!, publicOrigin: origin, ...(previousOrigin && previousOrigin !== origin ? { previousOrigin } : {}) }; await this.writeJson(this.configPath, this.config); signal.throwIfAborted();
    await this.startGateway(origin); signal.throwIfAborted(); this.setPhase("probing"); await this.checkQuickReadiness(signal);
  }

  /** A URL announcement is discovery, not proof that DNS and Cloudflare routing are ready. */
  private async checkQuickReadiness(parentSignal: AbortSignal): Promise<void> {
    if (this.startupBudget <= 0) return this.checkPublic(parentSignal);
    const startedAt = Date.now(), deadlineAt = startedAt + this.startupBudget;
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(this.startupBudget)]);
    this.startupReadiness = { startedAt, deadlineAt, round: 0 };
    let failure: unknown;
    try {
      while (!signal.aborted) {
        this.startupReadiness.round++;
        try { await this.checkPublic(signal); return; }
        catch (error) {
          parentSignal.throwIfAborted(); failure = error;
          if (signal.aborted) break;
          if (!retryableProbeFailure(error)) throw error;
        }
        const delay = Math.min(this.startupRetryDelay, Math.max(1, deadlineAt - Date.now()));
        if (this.probeCheck) this.probeCheck = { ...this.probeCheck, state: "retrying", retryAt: Date.now() + delay, lastError: safeConnectionError(failure) };
        this.setPhase("reconnecting");
        try { await abortableDelay(delay, signal); }
        catch { parentSignal.throwIfAborted(); break; }
      }
      parentSignal.throwIfAborted();
      throw new ProbeError(`remote_probe_startup_timeout：新地址在 ${Math.ceil(this.startupBudget / 1000)} 秒内仍未通过公网校验；入口尚不可用，将保留地址后台复检。${failure ? `最近诊断：${safeConnectionError(failure)}` : ""}`, true);
    } finally { this.startupReadiness = undefined; }
  }

  private async checkPublic(parentSignal: AbortSignal, background = false): Promise<void> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(this.probeBudget)]);
    const assertActive = () => {
      parentSignal.throwIfAborted();
      if (signal.aborted) throw new ProbeError("remote_probe_timeout：本次公网验证已达到总时间预算；可重测当前地址，无需重建隧道");
    };
    const origin = this.config?.publicOrigin; if (!origin) throw new Error("remote_origin_missing");
    let failure: unknown;
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      assertActive();
      this.probeCheck = { state: "checking", attempt: attempt + 1, maxAttempts: this.retryDelays.length + 1, background, startedAt };
      const token = randomBytes(32).toString("base64url"), key = digest(token);
      this.probeTokens.set(key, Date.now() + 30_000);
      try {
        await this.probe(origin, token, signal); assertActive();
        this.probeCheck.state = "succeeded"; this.lastProbeAt = Date.now(); this.startupError = undefined; this.setPhase("ready"); this.armHealthCheck(); return;
      } catch (error) { failure = error; assertActive(); }
      finally { this.probeTokens.delete(key); }
      if (!retryableProbeFailure(failure)) break;
      if (attempt < this.retryDelays.length) {
        const delay = Math.max(this.retryDelays[attempt]!, failure instanceof ProbeError ? failure.retryAfterMs : 0);
        this.probeCheck = { ...this.probeCheck, state: "retrying", retryAt: Date.now() + delay, lastError: safeConnectionError(failure) };
        if (!background) this.setPhase("reconnecting");
        await abortableDelay(delay, signal).catch(error => { assertActive(); throw error; });
      }
    }
    throw failure;
  }

  private scheduleProbe(): void {
    this.nextProbeAt = undefined;
    if (this.healthTask || !this.controller || this.controller.signal.aborted) return;
    const background = this.phase === "ready" && !!this.lastProbeAt;
    if (!background) this.setPhase("probing"); const signal = this.controller.signal;
    this.healthTask = this.checkPublic(signal, background).catch((error) => { if (!signal.aborted) this.recordFailure(error); }).finally(() => { this.healthTask = undefined; this.armHealthCheck(); });
  }

  private armHealthCheck(): void {
    clearTimeout(this.healthTimer);
    this.nextProbeAt = undefined;
    if (this.healthInterval > 0 && this.config?.enabled && this.controller && !this.controller.signal.aborted) {
      this.nextProbeAt = Date.now() + this.healthInterval;
      this.healthTimer = setTimeout(() => this.scheduleProbe(), this.healthInterval); this.healthTimer.unref();
    }
  }
  private recordFailure(error: unknown): void {
    if (this.controller?.signal.aborted) return;
    if (this.probeCheck) this.probeCheck = { ...this.probeCheck, state: "failed", lastError: safeConnectionError(error) };
    this.startupError = safeConnectionError(error); this.setPhase("error");
    // Initial discovery failures used to leave a healthy running tunnel stuck in error
    // forever: health checks were only armed after the first successful probe.
    if (retryableProbeFailure(error) && this.server?.listening && (this.config?.mode === "fixed_https" || this.runtime)) this.armHealthCheck();
  }
  private setPhase(phase: ConnectionPhase): void {
    this.phase = phase;
    void this.service.publish({ type: "remote_connection.updated", payload: { phase, ...(["error", "disconnected"].includes(phase) && this.startupError ? { error: this.startupError } : {}) } }).catch(() => undefined);
  }
  private runConnection<T>(action: () => Promise<T>): Promise<T> {
    const next = this.connectionQueue.then(action);
    this.connectionQueue = next.then(() => undefined, () => undefined); return next;
  }
  private async endRuntime(preserveTunnel = false): Promise<void> {
    this.controller?.abort(preserveTunnel ? PRESERVE_TUNNEL : undefined); clearTimeout(this.healthTimer);
    this.nextProbeAt = undefined;
    try {
      // Closing the private socket also makes an unreachable supervisor return 503.
      if (preserveTunnel && this.runtime?.detach) await this.runtime.detach().catch(() => undefined); else await this.runtime?.stop();
      await this.background; await this.healthTask;
    } finally {
      this.runtime = undefined; this.background = undefined; this.controller = undefined; this.probeCheck = undefined; this.probeTokens.clear();
      await this.stopGateway();
    }
  }

  approvals(): Array<{ requestId: string; clientName: string; clientId: string; redirectHost: string; requestedScopes: RemoteMcpScope[]; createdAt: number; expiresAt: number; workspaceId?: string }> {
    return this.state.requests.filter((request) => !request.decision && request.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt).map((request) => ({ requestId: request.requestId, clientName: request.clientName, clientId: request.clientId, redirectHost: new URL(request.redirectUri).origin, requestedScopes: request.requestedScopes, createdAt: request.createdAt, expiresAt: request.expiresAt, ...(this.config?.mode === "quick_tunnel" && this.config.workspaceId ? { workspaceId: this.config.workspaceId, workspaceIds: this.config.workspaceIds ?? [this.config.workspaceId] } : {}) }));
  }

  grants(): Array<{ workspaceIds: string[]; source?: WebSource; alias?: string; grantId: string; clientName: string; clientId: string; redirectHost: string; workspaceId: string; workspaceLabel: string; scopes: RemoteMcpScope[]; createdAt: number; expiresAt: number; oauthState: "awaiting_token" | "token_issued" }> {
    const labels = new Map(this.service.listWorkspaces().map((workspace) => [workspace.workspaceId, workspace.label]));
    return this.state.grants.filter((grant) => !grant.revokedAt && grant.expiresAt > Date.now() && grant.resource === `${this.config?.publicOrigin}/mcp`).sort((a, b) => b.createdAt - a.createdAt).map((grant) => ({
      grantId: grant.grantId, clientName: this.state.clients.find((client) => client.client_id === grant.clientId)?.client_name || "未命名网页客户端",
      clientId: grant.clientId, redirectHost: grant.redirectHost, workspaceId: grant.workspaceId, workspaceIds: grant.workspaceIds ?? [grant.workspaceId], ...(grant.source ? { source: grant.source } : {}), ...(grant.alias ? { alias: grant.alias } : {}),
      workspaceLabel: labels.get(grant.workspaceId) || "项目已移除", scopes: grant.scopes, createdAt: grant.createdAt, expiresAt: grant.expiresAt, oauthState: grant.refreshDigest || grant.access.length ? "token_issued" : "awaiting_token",
    }));
  }

  /** Only called by the authenticated local console, never by a remote tool. */
  async updateGrant(grantId: string, input: { workspaceIds: string[]; source: WebSource; alias?: string }): Promise<void> {
    if (!["chatgpt", "claude", "other"].includes(input.source) || !input.workspaceIds.length) throw new Error("oauth_grant_update_invalid");
    for (const id of input.workspaceIds) {
      await this.service.getWorkspace(id);
    }
    await this.withState(async (state) => {
      const grant = state.grants.find((item) => item.grantId === grantId && !item.revokedAt && item.expiresAt > Date.now());
      if (!grant) throw new Error("oauth_grant_not_found");
      if (!this.config?.enabled || grant.resource !== `${this.config.publicOrigin}/mcp`) throw new Error("oauth_resource_invalid：此授权不属于当前连接，请在网页重新授权");
      await this.includeAuthorizedWorkspaces(input.workspaceIds);
      grant.workspaceIds = [...new Set(input.workspaceIds)]; grant.workspaceId = grant.workspaceIds[0]!; grant.source = input.source;
      if (input.alias !== undefined) { if (input.alias.trim()) grant.alias = input.alias.trim().slice(0, 80); else delete grant.alias; }
    });
    await this.service.publish({ type: "remote_authorization.updated", payload: { grantId } });
  }

  private async includeAuthorizedWorkspaces(workspaceIds: string[]): Promise<void> {
    if (!this.config?.enabled) throw new Error("remote_not_ready：请先建立连接");
    if (!workspaceIds.length) throw new Error("oauth_workspace_required");
    for (const id of workspaceIds) await this.service.getWorkspace(id);
    const next = { ...this.config, connectionOnly: false, workspaceId: this.config.workspaceId ?? workspaceIds[0]!, workspaceIds: [...new Set([...(this.config.workspaceIds ?? []), ...workspaceIds])] };
    await this.writeJson(this.configPath, next);
    this.config = next;
  }

  async revokeGrant(grantId: string): Promise<void> {
    let found = false;
    await this.withState(async (state) => {
      const grant = state.grants.find((item) => item.grantId === grantId && !item.revokedAt);
      if (!grant) throw new Error("oauth_grant_not_found：网页授权不存在或已撤销");
      found = true; grant.revokedAt = Date.now(); grant.access = []; delete grant.refreshDigest; grant.previousRefreshDigests = [];
    });
    if (found) await this.service.publish({ type: "remote_authorization.revoked", payload: { grantId } });
  }

  async decideApproval(requestId: string, input: { decision: "allow" | "deny"; workspaceId?: string; workspaceIds?: string[]; source?: WebSource; alias?: string; scopes?: string[] }): Promise<void> {
    let redirectUrl: string | undefined;
    await this.withState(async (state) => {
      const pending = state.requests.find((request) => request.requestId === requestId);
      if (!pending || pending.decision || pending.expiresAt <= Date.now()) throw new Error("oauth_approval_expired：授权请求已处理或过期");
      if (input.decision === "deny") { pending.decision = "rejected"; return; }
      if (!this.config?.enabled || this.config.mode === "quick_tunnel" && this.phase !== "ready") throw new Error("remote_not_ready：公网入口尚未就绪，请完成连接测试后重新授权");
      if (!input.workspaceId) throw new Error("oauth_workspace_required：授权前必须选择项目");
      const workspace = await this.service.getWorkspace(input.workspaceId);
      const workspaceIds = [...new Set(input.workspaceIds ?? [input.workspaceId])];
      if (!workspaceIds.length || !workspaceIds.includes(input.workspaceId)) throw new Error("oauth_workspace_required");
      for (const id of workspaceIds) {
        await this.service.getWorkspace(id);
      }
      if (input.source && !["chatgpt", "claude", "other"].includes(input.source)) throw new Error("oauth_source_invalid");
      const selected = [...new Set((input.scopes ?? []).filter((scope): scope is RemoteMcpScope => SUPPORTED_SCOPES.includes(scope as RemoteMcpScope)))];
      if (!selected.length || selected.some((scope) => !pending.requestedScopes.includes(scope))) throw new Error("oauth_scope_invalid：只能授予网页客户端申请且本服务支持的权限");
      if (selected.includes("session:control") && !selected.includes("planning:read")) throw new Error("oauth_scope_invalid：执行权限必须同时包含规划只读权限");
      await this.includeAuthorizedWorkspaces(workspaceIds);
      const now = Date.now();
      const grant: StoredGrant = { grantId: randomUUID(), clientId: pending.clientId, workspaceId: workspace.workspaceId, workspaceIds, ...(input.source ? { source: input.source } : {}), ...(input.alias ? { alias: input.alias.slice(0, 80) } : {}), redirectHost: new URL(pending.redirectUri).origin, scopes: selected,
        resource: pending.resource, createdAt: now, expiresAt: now + GRANT_TTL_MS, access: [], previousRefreshDigests: [] };
      state.grants.push(grant);
      const code = randomBytes(32).toString("base64url");
      state.codes.push({ digest: digest(code), grantId: grant.grantId, clientId: pending.clientId, redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge, resource: pending.resource, expiresAt: now + AUTH_CODE_TTL_MS });
      const callback = new URL(pending.redirectUri);
      callback.searchParams.set("code", code);
      if (pending.state) callback.searchParams.set("state", pending.state);
      redirectUrl = callback.href;
      pending.decision = "approved";
    });
    if (redirectUrl) this.approvalRedirects.set(requestId, redirectUrl);
    await this.service.publish({ type: "remote_authorization.decided", payload: { requestId, decision: input.decision } });
  }

  async approvalStatus(requestId: string): Promise<{ status: "pending" | "approved" | "rejected" | "expired"; redirectUrl?: string }> {
    const request = this.state.requests.find((item) => item.requestId === requestId);
    if (!request || request.expiresAt <= Date.now()) return { status: "expired" };
    if (request.decision === "approved") {
      const redirectUrl = this.approvalRedirects.get(requestId);
      return redirectUrl ? { status: "approved", redirectUrl } : { status: "expired" };
    }
    return request.decision === "rejected" ? { status: "rejected", redirectUrl: errorRedirect(request, "access_denied") } : { status: "pending" };
  }

  async principalForToken(token: string): Promise<RemoteMcpPrincipal | undefined> {
    const info = await this.verifyAccessToken(token);
    if (!this.config?.enabled || info.resource?.href !== `${this.config.publicOrigin}/mcp`) return undefined;
    const extra = info.extra ?? {};
    if (typeof extra.grantId !== "string" || typeof extra.workspaceId !== "string") return undefined;
    const grant = this.state.grants.find((item) => item.grantId === extra.grantId)!;
    const originalSource = grant.source;
    return { grantId: extra.grantId, clientId: info.clientId, workspaceId: extra.workspaceId, workspaceIds: grant.workspaceIds ?? [grant.workspaceId],
      ...(grant.source ? { source: grant.source } : {}),
      assertActive: async (workspaceId?: string) => {
        await this.verifyAccessToken(token);
        const current = this.state.grants.find((item) => item.grantId === extra.grantId)!;
        if (workspaceId && !(current.workspaceIds ?? [current.workspaceId]).includes(workspaceId)) throw new Error("mcp_workspace_forbidden：项目授权已移除");
        if (current.source !== originalSource) throw new Error("mcp_source_changed：来源已变更，请重新连接并领取");
      },
      scopes: info.scopes as RemoteMcpScope[], expiresAt: (info.expiresAt ?? 0) * 1000 };
  }

  private async startGateway(publicOrigin: string): Promise<void> {
    const origin = validatePublicOrigin(publicOrigin);
    const app = express();
    const allowedHosts = new Set([new URL(origin).host, `127.0.0.1:${this.port}`, `localhost:${this.port}`]);
    app.use(((request: ExpressRequest, response: ExpressResponse, next: (error?: unknown) => void) => {
      const host = request.headers.host?.toLowerCase();
      if (!host || !allowedHosts.has(host)) { response.status(421).json({ error: "remote_host_invalid" }); return; }
      response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("Cache-Control", "no-store");
      next();
    }) as unknown as Handler);
    app.get("/oauth/approval.js", (_request, response) => {
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      response.type("application/javascript; charset=utf-8").send("const id=document.body.dataset.requestId;const status=document.querySelector('#status');async function poll(){try{const r=await fetch('/oauth/approval/'+encodeURIComponent(id),{cache:'no-store'});const d=await r.json();if(d.redirectUrl){status.textContent=d.status==='approved'?'授权已在本机确认，正在返回客户端…':'授权未获准';location.replace(d.redirectUrl);return}status.textContent=d.status==='expired'?'请求已过期，请返回客户端重新连接':'等待你在 Token Coupon 本机控制台确认…'}catch{status.textContent='连接中断，正在重试…'}setTimeout(poll,1500)}void poll();");
    });
    app.get("/oauth/approval/:requestId", async (request, response) => {
      const requestId = request.params.requestId ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) { response.status(404).json({ error: "not_found" }); return; }
      response.json(await this.approvalStatus(requestId));
    });
    // Token diagnostics persist field names and machine codes, never credential values.
    app.use(((request: ExpressRequest, response: ExpressResponse, next: () => void) => {
      if (request.method !== "POST" || (request.url || "").split("?", 1)[0] !== "/token") { next(); return; }
      const traceId = randomUUID(), startedAt = Date.now(), context: { code?: string } = {};
      response.setHeader("X-Token-Coupon-Trace", traceId);
      const json = response.json.bind(response);
      response.json = (value: unknown) => {
        const error = value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
        if (!context.code && typeof error === "string" && /^[a-z_]{1,80}$/.test(error)) context.code = error;
        json(value);
      };
      response.once("finish", () => {
        const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
        const method = body.grant_type === "authorization_code" || body.grant_type === "refresh_token" ? body.grant_type : "token_request";
        const clientId = typeof body.client_id === "string" && /^[a-f0-9-]{36}$/i.test(body.client_id) ? body.client_id : undefined;
        const record = method === "authorization_code" && typeof body.code === "string" ? this.state.codes.find(code => code.digest === digest(body.code as string)) : undefined;
        void this.diagnostics.record({ traceId, at: Date.now(), endpoint: `${origin}/mcp`, stage: "oauth", outcome: response.statusCode < 400 ? "success" : "error", method,
          code: context.code || (response.statusCode < 400 ? "oauth_token_issued" : "oauth_token_request_failed"), httpStatus: response.statusCode, durationMs: Date.now() - startedAt,
          ...(clientId ? { clientId } : {}), ...(record ? { grantId: record.grantId } : {}),
          requestFields: ["client_id", "code", "code_verifier", "redirect_uri", "resource", "refresh_token"].filter(field => typeof body[field] === "string" && !!body[field]) });
      });
      this.tokenExchangeContext.run(context, next);
    }) as unknown as Handler);
    app.use(mcpAuthRouter({ provider: this.provider, issuerUrl: new URL(origin), baseUrl: new URL(origin), resourceServerUrl: new URL(`${origin}/mcp`), scopesSupported: SUPPORTED_SCOPES, resourceName: "Token Coupon local project tools" }) as unknown as Handler);
    app.all("/mcp", async (request, response) => {
      const traceId = randomUUID(), startedAt = Date.now(), endpoint = `${origin}/mcp`;
      response.setHeader("X-Token-Coupon-Trace", traceId);
      const authorization = request.headers.authorization;
      const token = typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, "") : "";
      const probe = token && (this.probeTokens.get(digest(token)) ?? 0) > Date.now();
      const challengeToken = request.headers["x-token-coupon-probe"];
      const internalChallenge = request.method === "GET" && typeof challengeToken === "string" && (this.probeTokens.get(digest(challengeToken)) ?? 0) > Date.now();
      let principal: RemoteMcpPrincipal | undefined;
      if (token && !probe) principal = await this.principalForToken(token).catch(() => undefined);
      if (!principal && !probe) {
        const known = token && token.length <= 256 ? this.state.grants.find(grant => grant.access.some(access => safeEqual(access.digest, digest(token)))) : undefined;
        const code = known?.revokedAt ? "oauth_grant_revoked" : known && known.resource !== endpoint ? "oauth_resource_changed" : known ? "oauth_token_expired" : "oauth_authorization_required";
        if (!internalChallenge) await this.diagnostics.record({ traceId, at: Date.now(), endpoint, stage: "authentication", outcome: "error", code, httpStatus: 401,
          ...(known ? { grantId: known.grantId, clientId: known.clientId } : {}) });
        const metadata = `https://${new URL(origin).host}/.well-known/oauth-protected-resource/mcp`;
        response.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": `Bearer resource_metadata=\"${metadata}\"` });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "OAuth authorization required", data: { traceId, code: "oauth_authorization_required" } } })); return;
      }
      const identity = principal ? { grantId: principal.grantId, clientId: principal.clientId } : {};
      if (!probe && this.config?.mode === "quick_tunnel" && (!this.lastProbeAt || ["error", "disconnected", "stopped"].includes(this.phase))) {
        await this.diagnostics.record({ traceId, at: Date.now(), endpoint, stage: "transport", outcome: "error", code: "remote_not_ready", httpStatus: 503, ...identity });
        response.status(503).json({ error: "remote_not_ready", traceId }); return;
      }
      let method = "unknown";
      if (!probe) response.once("finish", () => {
        void this.diagnostics.record({ traceId, at: Date.now(), endpoint, stage: "transport", outcome: response.statusCode >= 400 ? "error" : "received", method, httpStatus: response.statusCode, durationMs: Date.now() - startedAt, ...identity });
      });
      try {
        const body = request.method === "POST" ? await parseBody(request, 256 * 1024) : undefined;
        const proposed = (body as { method?: unknown } | undefined)?.method;
        if (typeof proposed === "string" && ["initialize", "tools/list", "tools/call", "notifications/initialized", "ping"].includes(proposed)) method = proposed;
        const server = probe ? createProbeMcpServer() : createMcpServer(this.service, principal!, { traceId, record: event => this.diagnostics.record({ ...event, at: Date.now(), endpoint, stage: "tool", ...identity }) });
        const transport = new (await import("@modelcontextprotocol/sdk/server/streamableHttp.js")).StreamableHTTPServerTransport({ enableJsonResponse: true });
        response.once("close", () => { void server.close().catch(() => undefined); });
        await server.connect(transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
        await transport.handleRequest(request, response, body);
      } catch {
        if (!probe) await this.diagnostics.record({ traceId, at: Date.now(), endpoint, stage: "transport", outcome: "error", code: "mcp_transport_failed", durationMs: Date.now() - startedAt, ...identity });
        if (!response.headersSent) response.status(500).json({ error: "mcp_transport_failed", traceId });
        else response.end();
      }
    });
    app.use(((_request: ExpressRequest, response: ExpressResponse) => response.status(404).json({ error: "not_found" })) as unknown as Handler);
    await this.reserveGateway();
    this.gatewayHandler = app as unknown as (request: IncomingMessage, response: ServerResponse) => void;
    this.startupError = undefined;
  }

  private async reserveGateway(): Promise<void> {
    if (this.server?.listening) return;
    const server = createServer((request, response) => {
      if (this.gatewayHandler) this.gatewayHandler(request, response);
      else { response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end('{"error":"remote_not_ready"}'); }
    });
    const privateGateway = this.tunnel.persistentGateway && this.config?.mode === "quick_tunnel";
    if (privateGateway) {
      this.gatewaySocketDirectory = await mkdtemp(join(tmpdir(), "tc-gateway-"));
      await chmod(this.gatewaySocketDirectory, 0o700);
      this.gatewaySocket = join(this.gatewaySocketDirectory, "gateway.sock");
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        const ready = () => { server.removeListener("error", reject); resolve(); };
        if (this.gatewaySocket) server.listen(this.gatewaySocket, ready); else server.listen(this.port, "127.0.0.1", ready);
      });
    } catch (error) { await this.clearGatewaySocket(); throw error; }
    this.server = server;
  }

  private async stopGateway(): Promise<void> {
    this.gatewayHandler = undefined;
    const server = this.server; this.server = undefined;
    if (server?.listening) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    await this.clearGatewaySocket();
  }

  private async clearGatewaySocket(): Promise<void> {
    if (this.gatewaySocketDirectory) await rm(this.gatewaySocketDirectory, { recursive: true, force: true });
    this.gatewaySocket = undefined; this.gatewaySocketDirectory = undefined;
  }

  private async registerClient(input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): Promise<OAuthClientInformationFull> {
    const redirects = input.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 8 || redirects.some((uri) => !validRedirect(uri))) throw new Error("oauth_client_redirect_invalid：客户端回调必须使用 HTTPS 或 loopback 地址");
    if (input.client_name && Buffer.byteLength(input.client_name, "utf8") > 120) throw new Error("oauth_client_name_invalid：客户端名称过长");
    const method = input.token_endpoint_auth_method ?? "client_secret_post";
    if (!["none", "client_secret_post"].includes(method)) throw new InvalidClientMetadataError("Unsupported token_endpoint_auth_method; use none or client_secret_post");
    const registered: OAuthClientInformationFull = { ...input, token_endpoint_auth_method: method, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
    if (method === "none") { delete registered.client_secret; delete registered.client_secret_expires_at; }
    await this.withState(async (state) => {
      // A webpage retains its DCR client across token expiry and reauthorization.
      // Revoking a grant must not silently delete that independent registration.
      if (state.clients.length >= 100) throw new Error("oauth_client_limit：客户端登记已达到 100 项，请复用已有网页连接；清理不再使用的登记需管理员处理");
      state.clients.push(registered);
    });
    return registered;
  }

  private async beginAuthorization(client: OAuthClientInformationFull, params: AuthorizationParams, response: Parameters<OAuthServerProvider["authorize"]>[2]): Promise<void> {
    if (params.codeChallenge.length < 43 || params.codeChallenge.length > 128 || !/^[A-Za-z0-9_-]+$/.test(params.codeChallenge)) throw new Error("oauth_pkce_invalid：需要有效的 PKCE S256 challenge");
    let requestedScopes = [...new Set(params.scopes?.length ? params.scopes : SUPPORTED_SCOPES)] as RemoteMcpScope[];
    requestedScopes = requestedScopes.filter(scope => scope !== "session:control");
    if (requestedScopes.some((scope) => !SUPPORTED_SCOPES.includes(scope))) throw new Error("oauth_scope_invalid：请求包含本服务不支持的权限");
    if (this.config?.mode === "quick_tunnel") {
      requestedScopes = requestedScopes.filter((scope) => this.config?.scopes?.includes(scope));
      if (!requestedScopes.length) throw new Error("oauth_scope_invalid：请求权限未在此快捷连接中开放");
    }
    const resource = `${this.config?.publicOrigin}/mcp`;
    if (params.resource && params.resource.href !== resource) throw new Error("oauth_resource_invalid：授权请求的 MCP resource 与连接地址不一致");
    if (!this.config?.enabled) throw new Error("remote_connection_disabled：本机网页连接已停止");
    const pending: AuthorizationRequest = { requestId: randomUUID(), clientId: client.client_id, clientName: client.client_name || "未命名网页客户端",
      redirectUri: params.redirectUri, ...(params.state ? { state: params.state } : {}), codeChallenge: params.codeChallenge, resource,
      requestedScopes, createdAt: Date.now(), expiresAt: Date.now() + APPROVAL_TTL_MS };
    await this.withState(async (state) => {
      if (state.requests.filter((item) => !item.decision && item.expiresAt > Date.now()).length >= 20) throw new Error("oauth_approval_limit：本机待授权请求过多，请先处理现有请求");
      state.requests.push(pending);
    });
    await this.service.publish({ type: "remote_authorization.pending", payload: { requestId: pending.requestId, clientName: pending.clientName, redirectHost: new URL(pending.redirectUri).origin, scopes: requestedScopes, expiresAt: pending.expiresAt } });
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>等待本机授权 · Token Coupon</title><body data-request-id="${pending.requestId}"><main><h1>等待本机确认</h1><p id="status">正在联系 Token Coupon…</p><p>请在运行 Token Coupon 的电脑上检查客户端、项目与权限后决定是否授权。</p></main><script src="/oauth/approval.js" defer></script></body></html>`;
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Frame-Options", "DENY");
    response.status(200).type("text/html; charset=utf-8").send(html);
  }

  private async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = this.state.codes.find((item) => item.digest === digest(code) && item.clientId === client.client_id && !item.usedAt && item.expiresAt > Date.now());
    if (!record) throw new Error("oauth_code_invalid：授权码无效或已过期");
    return record.codeChallenge;
  }

  private async diagnoseTokenExchange(action: () => Promise<OAuthTokens>): Promise<OAuthTokens> {
    try { return await action(); }
    catch (error) {
      const code = error instanceof Error ? /^(oauth_[a-z_]+)[：:]/.exec(error.message)?.[1] : undefined;
      const context = this.tokenExchangeContext.getStore(); if (context && code) context.code = code;
      throw error;
    }
  }

  private async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    if (!verifier || verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) throw new Error("oauth_pkce_invalid：PKCE verifier 无效");
    return this.withState(async (state) => {
      const record = state.codes.find((item) => item.digest === digest(code) && item.clientId === client.client_id);
      if (!record || record.usedAt || record.expiresAt <= Date.now()) throw new Error("oauth_code_invalid：授权码无效、已使用或过期");
      if (!redirectUri) throw new Error("oauth_redirect_uri_missing：换令牌请求缺少 redirect_uri");
      if (record.redirectUri !== redirectUri) throw new Error("oauth_redirect_uri_mismatch：回调与授权请求不一致");
      if (!resource) throw new Error("oauth_resource_missing：换令牌请求缺少 resource");
      if (resource.href !== record.resource) throw new Error("oauth_resource_invalid：resource 与授权请求不一致");
      const actual = createHash("sha256").update(verifier).digest("base64url");
      if (!safeEqual(actual, record.codeChallenge)) throw new Error("oauth_pkce_invalid：PKCE verifier 不匹配");
      const grant = state.grants.find((item) => item.grantId === record.grantId && item.clientId === client.client_id && !item.revokedAt && item.expiresAt > Date.now());
      if (!grant) throw new Error("oauth_grant_expired：本机授权已过期或撤销");
      record.usedAt = Date.now();
      return this.issueTokens(grant);
    });
  }

  private async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, requestedScopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const tokenDigest = digest(refreshToken);
    return this.withState(async (state) => {
      const grant = state.grants.find((item) => item.clientId === client.client_id && item.refreshDigest === tokenDigest && !item.revokedAt);
      if (!grant) {
        const replay = state.grants.find((item) => item.clientId === client.client_id && item.previousRefreshDigests.includes(tokenDigest) && !item.revokedAt);
        if (replay) replay.revokedAt = Date.now();
        throw new Error("oauth_refresh_invalid：刷新凭证无效、已轮换或已撤销");
      }
      if (grant.expiresAt <= Date.now()) { grant.revokedAt = Date.now(); throw new Error("oauth_grant_expired：本机授权已过期"); }
      if (resource?.href !== grant.resource) throw new Error("oauth_resource_invalid：刷新请求的 resource 与授权不一致");
      const scopes = requestedScopes?.length ? requestedScopes as RemoteMcpScope[] : grant.scopes;
      if (scopes.some((scope) => !grant.scopes.includes(scope))) throw new Error("oauth_scope_invalid：刷新请求不能扩大授权范围");
      grant.previousRefreshDigests.push(tokenDigest);
      if (grant.previousRefreshDigests.length > 128) grant.previousRefreshDigests.shift();
      grant.scopes = scopes;
      return this.issueTokens(grant);
    });
  }

  private issueTokens(grant: StoredGrant): OAuthTokens {
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(Date.now() + ACCESS_TTL_MS, grant.expiresAt);
    grant.access = grant.access.filter((item) => item.expiresAt > Date.now());
    grant.access.push({ digest: digest(access), expiresAt });
    grant.refreshDigest = digest(refresh);
    return { access_token: access, token_type: "Bearer", expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)), refresh_token: refresh, scope: grant.scopes.join(" ") };
  }

  private async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!token || token.length > 256) throw new Error("oauth_token_invalid：access token 无效");
    const tokenDigest = digest(token);
    const grant = this.state.grants.find((item) => !item.revokedAt && item.expiresAt > Date.now() && item.access.some((candidate) => candidate.expiresAt > Date.now() && safeEqual(candidate.digest, tokenDigest)));
    if (!grant) throw new Error("oauth_token_invalid：access token 无效或已过期");
    if (!this.config?.enabled || grant.resource !== `${this.config.publicOrigin}/mcp`) throw new Error("oauth_resource_invalid：MCP 连接地址已变更或停止");
    await this.service.getWorkspace(grant.workspaceId);
    const expiry = grant.access.find((candidate) => candidate.digest === tokenDigest)!.expiresAt;
    return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: Math.floor(expiry / 1000), resource: new URL(grant.resource), extra: { grantId: grant.grantId, workspaceId: grant.workspaceId } };
  }

  private async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const tokenDigest = digest(request.token);
    await this.withState(async (state) => {
      const grant = state.grants.find((item) => item.clientId === client.client_id && (item.refreshDigest === tokenDigest || item.previousRefreshDigests.includes(tokenDigest) || item.access.some((token) => token.digest === tokenDigest)));
      if (grant) grant.revokedAt = Date.now();
    });
  }

  private async withState<T>(action: (state: PersistedState) => Promise<T> | T): Promise<T> {
    const run = this.stateQueue.then(async () => {
      let result: T | undefined;
      let actionError: unknown;
      try { result = await action(this.state); } catch (error) { actionError = error; }
      const requestNow = Date.now();
      const liveRequests = this.state.requests.filter((item) => !item.decision && item.expiresAt > requestNow);
      const finishedRequests = this.state.requests.filter((item) => item.decision || item.expiresAt <= requestNow)
        .filter((item) => item.expiresAt > requestNow - 24 * 60 * 60 * 1000).slice(-30);
      this.state.requests = [...liveRequests, ...finishedRequests].sort((left, right) => left.createdAt - right.createdAt).slice(-50);
      this.state.codes = this.state.codes.filter((item) => item.expiresAt > Date.now() && !item.usedAt);
      this.state.grants = this.state.grants.filter((item) => item.expiresAt > Date.now() + 24 * 60 * 60 * 1000 || !item.revokedAt);
      await this.writeJson(this.statePath, this.state);
      if (actionError !== undefined) throw actionError;
      return result as T;
    });
    this.stateQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(path, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  }
}

async function parseBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += value.length;
    if (length > maximumBytes) throw new Error("mcp_request_too_large"); chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("mcp_json_invalid"); }
}

function validatePublicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("remote_origin_invalid：请填写完整 HTTPS 域名，例如 https://mcp.example.com"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname.includes(".") || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("remote_origin_invalid：公网连接只接受 HTTPS 域名 Origin，不接受路径、凭据、query 或本机地址");
  return url.origin;
}

function validateGatewayPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error("remote_port_invalid：网关端口必须是 1024 到 65535 之间的整数");
  return value;
}

function validRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    return url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function errorRedirect(request: AuthorizationRequest, code: string): string {
  const url = new URL(request.redirectUri); url.searchParams.set("error", code); if (request.state) url.searchParams.set("state", request.state); return url.href;
}

function safeConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(remote_|component_|tunnel_|oauth_)[a-z_]+：/.test(message)) return sanitizeOutput(message).slice(0, 512);
  if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") return "remote_port_in_use：MCP 网关端口被占用，请在高级配置修改端口";
  return "remote_connection_failed：连接失败，请检查网络、组件和公网转发后重试";
}
async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new Error("tunnel_cancelled：连接已停止")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
