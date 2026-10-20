import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationService } from "./application-service.js";
import { RepositoryReader, currentOwner, parseExecutionSelection, type ExecutionSelection, type RunnerInteractionReply } from "@token-coupon/core";
import { createMcpHttpHandler } from "./mcp-server.js";
import type { RemoteMcpConnection } from "./oauth-gateway.js";
import { browseDirectories } from "./workspace-tools.js";
import { pickNativePath, nativePickerCapability, normalizePickedPaths, type NativePickerKind, type NativePickerResult } from "./native-picker.js";
import { APPLICATION_VERSION, API_PROTOCOL, daemonChallengePayload, EPOCH_HEADER, PROTOCOL_HEADER, type DaemonChallenge } from "@token-coupon/client";
import { readDaemonOwnerCredential } from "@token-coupon/client/node";

const BODY_LIMIT = 64 * 1024;
const PUBLIC_DIRECTORY = fileURLToPath(new URL("../../web/public/", import.meta.url));
const WEB_BUILD_DIRECTORY = fileURLToPath(new URL("../../web/dist/", import.meta.url));

type WebBuildEntry = { file?: unknown; css?: unknown; assets?: unknown };
type WebBuild = { html: Buffer; assets: Map<string, string> };

async function loadWebBuild(): Promise<WebBuild | undefined> {
  let rawManifest: string;
  try { rawManifest = await readFile(join(WEB_BUILD_DIRECTORY, ".vite", "manifest.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const manifest = JSON.parse(rawManifest) as Record<string, WebBuildEntry>;
  const assets = new Map<string, string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string" || candidate.startsWith("/") || candidate.includes("\\")) return;
    const parts = candidate.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) return;
    assets.set(`/${candidate}`, candidate);
  };
  for (const entry of Object.values(manifest)) {
    add(entry.file);
    if (Array.isArray(entry.css)) entry.css.forEach(add);
    if (Array.isArray(entry.assets)) entry.assets.forEach(add);
  }
  return { html: await readFile(join(WEB_BUILD_DIRECTORY, "index.html")), assets };
}

function webAssetContentType(path: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
  };
  return types[extname(path).toLowerCase()] || "application/octet-stream";
}

export async function createLocalServer(service: ApplicationService, options: { port: number; host: string; dataDirectory: string; ownerToken?: string; remoteMcp?: RemoteMcpConnection; nativePicker?: (kind: NativePickerKind, signal?: AbortSignal) => Promise<NativePickerResult> }): Promise<Server> {
  if (options.host !== "127.0.0.1" && options.host !== "::1" && options.host !== "localhost") throw new Error("daemon_bind_forbidden：本阶段服务只允许监听 loopback");
  const tokenPath = join(options.dataDirectory, "browser-session-token");
  let token: string;
  try { token = (await readFile(tokenPath, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = randomUUID() + randomUUID();
    await writeFile(tokenPath, token + "\n", { flag: "wx", mode: 0o600 });
  }
  const mcpHandler = await createMcpHttpHandler(service, options.dataDirectory);
  const webBuild = await loadWebBuild();
  const profileId = createHash("sha256").update(await realpath(options.dataDirectory)).digest("hex").slice(0, 24);
  const discoveryOwner = options.ownerToken ? await currentOwner() : undefined;
  const expectedHost = `${options.host.includes(":") ? `[${options.host}]` : options.host}:${options.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const origins = new Set([expectedOrigin, ...(options.host === "127.0.0.1" || options.host === "localhost" ? [`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`] : [])]);
  let discoveryReady = false;
  if (options.ownerToken) {
    try {
      const [credential, owner] = await Promise.all([readDaemonOwnerCredential(options.dataDirectory), currentOwner()]);
      discoveryReady = credential.token === options.ownerToken && credential.owner.pid === owner.pid && credential.owner.hostname === owner.hostname && credential.owner.platform === owner.platform && credential.owner.processStart === owner.processStart;
    } catch { /* Discovery remains unavailable unless the owner file and profile are protected. */ }
  }

  const server = createServer((request, response) => {
    void dispatch(request, response).catch((error: unknown) => sendError(response, error));
  });

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    if (!host || !origins.has(`http://${host}`)) {
      sendJson(response, 421, { error: "host_not_allowed：仅允许通过本机地址访问 daemon" }); return;
    }
    const url = new URL(request.url ?? "/", expectedOrigin);
    if (url.pathname === "/mcp") {
      if (request.method === "POST" && !request.headers.authorization) { await mcpHandler(request, response); return; }
      await mcpHandler(request, response, request.method === "POST" ? await readJsonBody(request, 256 * 1024) : undefined); return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      response.setHeader("Set-Cookie", `tc_local=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const html = webBuild?.html || await readFile(join(PUBLIC_DIRECTORY, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return;
    }
    const builtAsset = webBuild?.assets.get(url.pathname);
    const sourceAsset = ["/api-client.js", "/app.js", "/style.css"].includes(url.pathname) ? url.pathname.slice(1) : undefined;
    if (request.method === "GET" && (builtAsset || sourceAsset)) {
      const relativePath = builtAsset || sourceAsset!;
      const body = await readFile(join(builtAsset ? WEB_BUILD_DIRECTORY : PUBLIC_DIRECTORY, relativePath));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.writeHead(200, { "Content-Type": webAssetContentType(relativePath), "Cache-Control": builtAsset ? "public, max-age=31536000, immutable" : "no-cache" }); response.end(body); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/daemon-challenge") {
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!/^[0-9a-f]{64}$/i.test(nonce)) { sendJson(response, 400, { error: "daemon_discovery_nonce_invalid" }); return; }
      if (!discoveryReady || !options.ownerToken || !discoveryOwner?.processStart || !discoveryOwner.hostname || !discoveryOwner.platform) { sendJson(response, 404, { error: "daemon_discovery_unavailable：后台 owner 文件权限或进程身份无法验证" }); return; }
      const origin = `http://${host!.toLowerCase()}`;
      const unsigned: Omit<DaemonChallenge, "proof"> = { format: 1, nonce, origin, host: new URL(origin).host, port: options.port,
        issuedAt: new Date().toISOString(), owner: { pid: discoveryOwner.pid, hostname: discoveryOwner.hostname, platform: discoveryOwner.platform, processStart: discoveryOwner.processStart },
        epoch: service.epoch, profileId, protocol: API_PROTOCOL, applicationVersion: APPLICATION_VERSION, buildId: "development" };
      const proof = createHmac("sha256", options.ownerToken).update(daemonChallengePayload(unsigned)).digest("hex");
      response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff"); sendJson(response, 200, { ...unsigned, proof }); return;
    }
    if (!url.pathname.startsWith("/api/v1/")) { sendJson(response, 404, { error: "not_found" }); return; }
    if (cookieValue(request.headers.cookie, "tc_local") !== token) {
      sendJson(response, 403, { error: "local_session_required：请先从本机控制台打开页面" }); return;
    }
    if (request.method !== "GET") {
      if (!origins.has(request.headers.origin ?? "")) { sendJson(response, 403, { error: "local_origin_required：操作必须由本机控制台发起" }); return; }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) { sendJson(response, 415, { error: "content_type_json_required" }); return; }
      const protocol = request.headers[PROTOCOL_HEADER.toLowerCase()];
      // Unversioned legacy clients keep their existing /api/v1 behavior.
      if (protocol !== undefined && protocol !== String(API_PROTOCOL.major)) {
        sendJson(response, 426, { error: "daemon_protocol_incompatible：界面与后台协议不兼容，请更新后重新打开；仍可查看记录" }); return;
      }
      if (protocol !== undefined && request.headers[EPOCH_HEADER.toLowerCase()] !== service.epoch) {
        sendJson(response, 409, { error: "daemon_epoch_changed：后台已重启或尚未核对，请刷新状态后检查操作回执，再决定是否重新提交" }); return;
      }
    }
    const parts = url.pathname.split("/").filter(Boolean).slice(2);
    if (request.method === "POST" && url.pathname === "/api/v1/native-picker") {
      const body = await readJsonBody(request);
      if (body.kind !== "directory" && body.kind !== "files") throw new Error("native_picker_kind_invalid");
      const workspace = body.kind === "files" ? await service.getWorkspace(stringField(body.workspaceId, "workspaceId", 32)) : undefined;
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", disconnected);
      let picked: NativePickerResult;
      try { picked = await normalizePickedPaths(await (options.nativePicker ?? pickNativePath)(body.kind, controller.signal), body.kind, workspace?.path); }
      finally { response.removeListener("close", disconnected); }
      if (controller.signal.aborted) return;
      if (workspace && !picked.cancelled) {
        const reader = new RepositoryReader(workspace.path);
        for (const path of picked.paths) {
          const result = JSON.parse(await reader.invoke("repo_read", { path, startLine: 1, lineCount: 1 }));
          if (result.error) throw new Error(`native_picker_file_denied：${result.message || "选择中包含不可作为规划参考的文件，请避开凭证、运行记录和受保护文件。"}`);
        }
      }
      sendJson(response, 200, picked); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/directories") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("directory_offset_invalid");
      sendJson(response, 200, await browseDirectories(url.searchParams.get("path") ?? undefined, offset, url.searchParams.get("query") ?? "")); return;
    }
    if (parts[0] === "workspaces" && parts.length === 3 && parts[2] === "git") {
      if (request.method === "GET") { sendJson(response, 200, await service.gitStatus(parts[1]!)); return; }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        if (body.confirmed !== true) throw new Error("git_confirmation_required：请明确确认此 Git 操作");
        sendJson(response, 202, await service.prepareGit(parts[1]!, requestKey(request, body), stringField(body.action, "action", 40))); return;
      }
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts.length === 4 && parts[2] === "git") {
      const body = await readJsonBody(request, 512 * 1024);
      if (parts[3] === "preview") {
        sendJson(response, 200, await service.gitPreview(parts[1]!, stringField(body.mode, "mode", 20), stringArray(body.paths, "paths", 1000))); return;
      }
      if (body.confirmed !== true) throw new Error("git_confirmation_required");
      if (parts[3] === "commit") {
        if (body.mode !== "runtime" && body.mode !== "selected") throw new Error("git_commit_mode_invalid");
        sendJson(response, 202, await service.gitCommit(parts[1]!, requestKey(request, body), { mode: body.mode, paths: stringArray(body.paths, "paths", 1000), fingerprint: stringField(body.fingerprint, "fingerprint", 64), message: stringField(body.message, "message", 1024) })); return;
      }
      if (parts[3] === "identity") {
        sendJson(response, 202, await service.gitIdentity(parts[1]!, requestKey(request, body), stringField(body.name, "name", 120), stringField(body.email, "email", 200))); return;
      }
    }
    if (url.pathname === "/api/v1/settings") {
      if (request.method === "GET") { sendJson(response, 200, await service.systemSettings()); return; }
      if (request.method === "POST") { sendJson(response, 200, await service.saveSystemSettings(await readJsonBody(request))); return; }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      sendJson(response, 200, { status: "ok", epoch: service.epoch, instanceId: service.epoch, applicationVersion: APPLICATION_VERSION, buildId: "development", protocol: API_PROTOCOL,
        profile: { id: profileId, kind: service.workspaceEnvironment().isWsl ? "wsl" : "native", platform: process.platform },
        phase: "7-incremental", capabilities: { executionSelection: 1, systemSettings: 1, operationRouting: 1, plannerProgress: 1, protocolHandshake: 1, eventReconciliation: 1, daemonDiscovery: discoveryReady ? 1 : 0 }, host: options.host, workspaceEnvironment: service.workspaceEnvironment(), nativePicker: nativePickerCapability(),
        mcp: { url: `${expectedOrigin}/mcp`, transport: "Streamable HTTP / optional stdio", localReady: true, chatgptVerified: false, tokenFile: join(options.dataDirectory, "mcp-access-token") } }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/remote-connection") { sendJson(response, 200, options.remoteMcp?.status() ?? { configured: false, enabled: false, gateway: "stopped", pendingApprovals: 0, validGrants: 0, remoteClientVerified: false }); return; }
    if (request.method === "POST" && url.pathname === "/api/v1/remote-connection") {
      if (!options.remoteMcp) throw new Error("remote_connection_unavailable：MCP 远程连接服务未启动");
      const body = await readJsonBody(request);
      const gatewayPort = body.port === undefined ? undefined : integerField(body.port, "port", 1024);
      sendJson(response, 200, await options.remoteMcp.configure(stringField(body.publicOrigin, "publicOrigin", 512), gatewayPort)); return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/remote-connection/quick") {
      if (!options.remoteMcp) throw new Error("remote_connection_unavailable：MCP 远程连接服务未启动");
      const body = await readJsonBody(request);
      const project = body.connectionOnly === true ? { connectionOnly: true } : { workspaceId: stringField(body.workspaceId, "workspaceId", 32), ...(body.workspaceIds === undefined ? {} : { workspaceIds: stringArray(body.workspaceIds, "workspaceIds") }) };
      if (body.connectionOnly === true && (body.workspaceId !== undefined || body.workspaceIds !== undefined)) throw new Error("oauth_workspace_invalid：仅建立连接不能同时指定项目");
      const scopes = body.scopes === undefined ? undefined : stringArray(body.scopes, "scopes");
      const port = body.port === undefined ? undefined : integerField(body.port, "port", 1024);
      sendJson(response, 202, await options.remoteMcp.startQuick({ consent: body.consent === true, ...project, ...(scopes ? { scopes } : {}), ...(port ? { port } : {}) })); return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/remote-connection/test") {
      if (!options.remoteMcp) throw new Error("remote_connection_unavailable：MCP 远程连接服务未启动");
      sendJson(response, 202, await options.remoteMcp.testConnection()); return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/remote-connection/stop") {
      if (!options.remoteMcp) throw new Error("remote_connection_unavailable：MCP 远程连接服务未启动");
      sendJson(response, 200, await options.remoteMcp.stop()); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/remote-connection/approvals") { sendJson(response, 200, options.remoteMcp?.approvals() ?? []); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/remote-connection/grants") { sendJson(response, 200, options.remoteMcp?.grants() ?? []); return; }
    if (request.method === "POST" && parts[0] === "remote-connection" && parts[1] === "grants" && parts.length === 4 && parts[3] === "name") {
      if (!options.remoteMcp) throw new Error("remote_connection_unavailable");
      const body = await readJsonBody(request);
      if (typeof body.alias !== "string") throw new Error("oauth_alias_invalid：请填写 MCP 名称");
      await options.remoteMcp.renameGrant(parts[2]!, body.alias);
      sendJson(response, 200, { updated: true }); return;
    }
    if (request.method === "POST" && parts[0] === "remote-connection" && parts[1] === "grants" && parts.length === 3) {
      if (!options.remoteMcp) throw new Error("remote_connection_unavailable");
      const body = await readJsonBody(request);
      const source = stringField(body.source, "source", 20);
      if (source !== "chatgpt" && source !== "claude" && source !== "other") throw new Error("oauth_source_invalid");
      if (body.alias !== undefined && (typeof body.alias !== "string" || body.alias.length > 80)) throw new Error("oauth_alias_invalid：MCP 名称最多 80 字符");
      await options.remoteMcp.updateGrant(parts[2]!, { workspaceIds: stringArray(body.workspaceIds, "workspaceIds"), source, ...(typeof body.alias === "string" ? { alias: body.alias } : {}) });
      sendJson(response, 200, { updated: true }); return;
    }
    if (request.method === "POST" && parts[0] === "remote-connection" && parts[1] === "grants" && parts.length === 4 && parts[3] === "revoke") {
      if (!options.remoteMcp || !/^[0-9a-f-]{36}$/i.test(parts[2]!)) throw new Error("oauth_grant_not_found：网页授权不存在或服务未启动");
      await options.remoteMcp.revokeGrant(parts[2]!); sendJson(response, 200, { revoked: true }); return;
    }
    if (request.method === "POST" && parts[0] === "remote-connection" && parts[1] === "approvals" && parts.length === 3) {
      if (!options.remoteMcp || !/^[0-9a-f-]{36}$/i.test(parts[2]!)) throw new Error("oauth_approval_not_found：授权请求不存在或服务未启动");
      const body = await readJsonBody(request);
      if (body.decision !== "allow" && body.decision !== "deny") throw new Error("oauth_decision_invalid：decision 必须是 allow 或 deny");
      const workspaceId = body.workspaceId === undefined ? undefined : stringField(body.workspaceId, "workspaceId", 32);
      const scopes = body.scopes === undefined ? undefined : stringArray(body.scopes, "scopes");
      const workspaceIds = body.workspaceIds === undefined ? undefined : stringArray(body.workspaceIds, "workspaceIds");
      const source = body.source === "chatgpt" || body.source === "claude" || body.source === "other" ? body.source : undefined;
      await options.remoteMcp.decideApproval(parts[2]!, { decision: body.decision, ...(workspaceIds ? { workspaceIds } : {}), ...(source ? { source } : {}), ...(workspaceId ? { workspaceId } : {}), ...(scopes ? { scopes } : {}) });
      sendJson(response, 200, { accepted: true }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/providers") { sendJson(response, 200, await service.planningProviderOptions()); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/providers/deepseek-api/models") { sendJson(response, 200, await service.plannerModels(url.searchParams.get("refresh") === "1")); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/runners") { sendJson(response, 200, await service.runnerOptions()); return; }
    if (request.method === "GET" && parts[0] === "runners" && parts.length === 3 && parts[2] === "models") {
      sendJson(response, 200, await service.runnerModels(parts[1]!, url.searchParams.get("workspaceId") ?? undefined, url.searchParams.get("refresh") === "1")); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/workspaces") { sendJson(response, 200, service.listWorkspaces()); return; }
    if (request.method === "POST" && url.pathname === "/api/v1/workspaces") {
      const body = await readJsonBody(request);
      const workspace = await service.addWorkspace(stringField(body.path, "path", 4096), optionalString(body.label, "label", 80));
      sendJson(response, 201, workspace); return;
    }
    if (request.method === "PATCH" && parts[0] === "workspaces" && parts.length === 2) {
      const body = await readJsonBody(request);
      const workspace = await service.renameWorkspace(parts[1]!, stringField(body.label, "label", 80));
      sendJson(response, 200, workspace); return;
    }
    if (request.method === "DELETE" && parts[0] === "workspaces" && parts.length === 2) {
      await service.removeWorkspace(parts[1]!); sendJson(response, 200, { removed: true }); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 3 && parts[2] === "repository") {
      const workspace = await service.getWorkspace(parts[1]!);
      const tool = url.searchParams.get("tool") ?? "repo_list";
      if (tool !== "repo_list" && tool !== "repo_read") throw new Error("repository_tool_invalid：只支持目录列表和只读文件预览");
      const args: Record<string, unknown> = { path: url.searchParams.get("path") ?? "." };
      for (const name of tool === "repo_list" ? ["offset"] : ["startLine"]) if (url.searchParams.has(name)) args[name] = Number(url.searchParams.get(name));
      if (tool === "repo_list" && url.searchParams.has("query")) args.query = url.searchParams.get("query");
      const result = JSON.parse(await new RepositoryReader(workspace.path).invoke(tool, args)) as { error?: string };
      sendJson(response, result.error ? 400 : 200, result); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 3 && parts[2] === "plannings") {
      sendJson(response, 200, await service.listPlannings(parts[1]!)); return;
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts.length === 3 && parts[2] === "plannings") {
      const body = await readJsonBody(request);
      const job = await service.startPlanning(parts[1]!, requestKey(request, body), {
        request: stringField(body.request, "request", 8192), provider: stringField(body.provider, "provider", 40),
        ...(body.model === undefined ? {} : { model: stringField(body.model, "model", 120) }),
        executionDefaults: executionDefaults(body.executionDefaults),
      });
      sendJson(response, 202, job); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 4 && parts[2] === "plannings") {
      const workspace = await service.getWorkspace(parts[1]!); sendJson(response, 200, await service.planningView(workspace, parts[3]!)); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 5 && parts[2] === "plannings" && parts[4] === "events") {
      const workspace = await service.getWorkspace(parts[1]!); await service.planningView(workspace, parts[3]!);
      const events = service.eventsAfter(0).filter(event => event.workspaceId === workspace.workspaceId && event.planningId === parts[3]).slice(-150);
      sendJson(response, 200, { events, retainedWindow: true }); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 7 && parts[2] === "plannings" && parts[4] === "attempts" && parts[6] === "events") {
      sendJson(response, 200, await service.attemptEvents(parts[1]!, parts[3]!, parts[5]!, Number(url.searchParams.get("offset") ?? 0), url.searchParams.get("fileId") ?? undefined)); return;
    }
    if (parts[0] === "workspaces" && parts.length === 7 && parts[2] === "plannings" && parts[4] === "attempts" && parts[6] === "diagnostics") {
      if (request.method === "GET") { sendJson(response, 200, await service.attemptDiagnostics(parts[1]!, parts[3]!, parts[5]!)); return; }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        sendJson(response, 202, await service.analyzeAttemptFailure(parts[1]!, parts[3]!, parts[5]!, requestKey(request, body), stringField(body.runnerId, "runnerId", 32), optionalString(body.modelId, "modelId", 200), optionalString(body.message, "message", 8192))); return;
      }
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts.length === 8 && parts[2] === "plannings" && parts[4] === "attempts" && parts[6] === "diagnostics" && parts[7] === "export") {
      await readJsonBody(request);
      sendJson(response, 200, await service.exportAttemptEvidence(parts[1]!, parts[3]!, parts[5]!)); return;
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts.length === 9 && parts[2] === "plannings" && parts[4] === "attempts" && parts[6] === "diagnostics" && parts[8] === "replies") {
      const body = await readJsonBody(request);
      sendJson(response, 202, await service.replyToAttemptDiagnosis(parts[1]!, parts[3]!, parts[5]!, parts[7]!, requestKey(request, body), stringField(body.message, "message", 8192), body.runnerId === undefined ? undefined : { runnerId: stringField(body.runnerId, "runnerId", 32), ...(body.modelId ? { modelId: stringField(body.modelId, "modelId", 200) } : {}) })); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 7 && parts[2] === "plannings" && parts[4] === "tasks" && parts[6] === "files") {
      sendJson(response, 200, await service.taskResults(parts[1]!, parts[3]!, parts[5]!, url.searchParams.get("path") ?? undefined, Number(url.searchParams.get("offset") ?? 0))); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 6 && parts[2] === "plannings" && parts[4] === "session" && parts[5] === "diagnosis") {
      sendJson(response, 200, await service.sessionDiagnosis(parts[1]!, parts[3]!)); return;
    }
    if (request.method === "GET" && parts[0] === "workspaces" && parts.length === 4 && parts[2] === "interactions") {
      sendJson(response, 200, service.listInteractions(parts[1]!, parts[3])); return;
    }
    if (parts[0] === "workspaces" && parts[2] === "external" && parts.length >= 4) {
      if (request.method === "GET" && parts.length === 4) { sendJson(response, 200, await service.external.context(parts[1]!, parts[3]!)); return; }
      if (request.method === "POST" && parts.length === 5 && parts[4] === "budget") {
        const body = await readJsonBody(request);
        sendJson(response, 200, await service.external.extendReadBudget(parts[1]!, parts[3]!, body.confirmed === true)); return;
      }
      if (request.method === "POST" && parts.length === 5 && parts[4] === "reconcile") { sendJson(response, 200, await service.external.reconcile(parts[1]!, parts[3]!)); return; }
      if (request.method === "POST" && parts.length === 5 && parts[4] === "cancel") { sendJson(response, 200, await service.external.cancel(parts[1]!, parts[3]!)); return; }
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts.length === 5 && parts[2] === "plannings") {
      const [, workspaceId, , planningId, action] = parts;
      const body = await readJsonBody(request);
      const key = requestKey(request, body);
      let job;
      if (action === "fork") {
        if (body.confirmed !== true) throw new Error("revision_confirmation_required：请确认创建新的修订计划");
        job = await service.createRevisionPlanning(workspaceId!, planningId!, key, integerField(body.expectedRevision, "expectedRevision", 1), stringField(body.expectedPlanHash, "expectedPlanHash", 64), optionalString(body.message, "message", 4096));
      }
      else if (action === "handoff") {
        const role = body.role === "review" ? "review" : "plan";
        const target = body.target === "chatgpt" || body.target === "claude" || body.target === "other" || body.target === "any" ? body.target : undefined;
        if (!target) throw new Error("handoff_target_invalid");
        job = await service.external.handoff(workspaceId!, planningId!, key, role, target, optionalString(body.reason, "reason", 1024));
      }
      else if (action === "replies") job = await service.reply(workspaceId!, planningId!, key, stringField(body.message, "message", 8192), operationSelection(body.planner));
      else if (action === "web-continue") job = await service.prepareWebContinuation(workspaceId!, planningId!, key);
      else if (action === "review") {
        const reviewer = body.reviewer === undefined ? {} : objectField(body.reviewer, "reviewer");
        job = await service.review(workspaceId!, planningId!, key, {
          ...(reviewer.mode === undefined ? {} : { mode: stringField(reviewer.mode, "reviewer.mode", 40) }),
          ...(reviewer.model === undefined ? {} : { model: stringField(reviewer.model, "reviewer.model", 120) }),
        });
      }
      else if (action === "planner-retry") job = await service.retryPlanning(workspaceId!, planningId!, key);
      else if (action === "approve") job = await service.approve(workspaceId!, planningId!, key, integerField(body.draftRevision, "draftRevision", 1), stringArray(body.waivedFindingIds, "waivedFindingIds"), optionalString(body.waiverReason, "waiverReason", 1024));
      else if (action === "run") job = await service.run(workspaceId!, planningId!, key, runOptions(body));
      else if (action === "retry-task") job = await service.retryTask(workspaceId!, planningId!, key, stringField(body.taskId, "taskId", 64));
      else if (action === "draft") {
        if (body.plan !== undefined && body.edits !== undefined) throw new Error("draft_edit_invalid：只能提交字段补丁，不能同时提交完整计划");
        job = await service.saveDraft(workspaceId!, planningId!, key, { ...(body.edits !== undefined ? { edits: body.edits } : { plan: body.plan }), expectedDraftRevision: integerField(body.expectedDraftRevision, "expectedDraftRevision", 1), expectedPlanHash: stringField(body.expectedPlanHash, "expectedPlanHash", 64) });
      }
      else if (action === "revise") job = await service.revise(workspaceId!, planningId!, key, { message: stringField(body.message, "message", 8192), reviewId: stringField(body.reviewId, "reviewId", 64), expectedPlanHash: stringField(body.expectedPlanHash, "expectedPlanHash", 64), expectedDraftRevision: integerField(body.expectedDraftRevision, "expectedDraftRevision", 1), planner: operationSelection(body.planner) });
      else { sendJson(response, 404, { error: "operation_not_found" }); return; }
      sendJson(response, 202, job); return;
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts.length === 6 && parts[2] === "plannings" && parts[4] === "session") {
      const body = await readJsonBody(request); const key = requestKey(request, body);
      let job;
      if (parts[5] === "models") {
        if (body.confirmed !== true) throw new Error("session_model_confirmation_required：请明确确认模型变更");
        if (typeof body.stopAndRetry !== "boolean") throw new Error("session_model_input_invalid");
        job = await service.changeTaskModel(parts[1]!, parts[3]!, key, { taskId: stringField(body.taskId, "taskId", 64), modelId: body.modelId === null ? null : stringField(body.modelId, "modelId", 200), expectedRevision: integerField(body.expectedRevision, "expectedRevision", 0), stopAndRetry: body.stopAndRetry, ...(body.expectedAttemptId ? { expectedAttemptId: stringField(body.expectedAttemptId, "expectedAttemptId", 36) } : {}) });
      }
      else if (parts[5] === "resume") job = await service.resume(parts[1]!, parts[3]!, key);
      else if (parts[5] === "retry") job = await service.retryTask(parts[1]!, parts[3]!, key, stringField(body.taskId, "taskId", 64));
      else if (parts[5] === "pause" || parts[5] === "cancel") job = await service.controlSession(parts[1]!, parts[3]!, key, parts[5]);
      else if (parts[5] === "recover") job = await service.recover(parts[1]!, parts[3]!, key, body.confirmedStopped === true);
      else if (parts[5] === "delivery") job = await service.delivery(parts[1]!, parts[3]!, key);
      else { sendJson(response, 404, { error: "session_operation_not_found" }); return; }
      sendJson(response, 202, job); return;
    }
    if (request.method === "GET" && parts[0] === "jobs" && parts.length === 2) { sendJson(response, 200, await service.getJob(parts[1]!)); return; }
    if (request.method === "POST" && parts[0] === "jobs" && parts.length === 3 && parts[2] === "cancel") {
      const body = await readJsonBody(request); sendJson(response, 200, await service.cancelJob(parts[1]!, stringField(body.workspaceId, "workspaceId", 32))); return;
    }
    if (request.method === "POST" && parts[0] === "workspaces" && parts[1] && parts[2] === "interactions" && parts.length === 4) {
      const body = await readJsonBody(request);
      const reply = interactionReply(body);
      await service.answerInteraction(parts[1], parts[3]!, reply);
      sendJson(response, 200, { accepted: true }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/events") { streamEvents(service, request, response, url); return; }
    sendJson(response, 404, { error: "not_found" });
  }

  return server;
}

function streamEvents(service: ApplicationService, request: IncomingMessage, response: ServerResponse, url: URL): void {
  const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
  const epoch = url.searchParams.get("epoch");
  const window = service.eventWindow();
  const resetReason = epoch && epoch !== service.epoch ? "epoch_changed" : !Number.isSafeInteger(after) || after < 0 || after > window.latest ? "cursor_invalid" : after > 0 && after < window.first - 1 ? "window_lost" : undefined;
  const replayFrom = resetReason ? 0 : after;
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  response.write(`event: hello\ndata: ${JSON.stringify({ epoch: service.epoch, protocol: API_PROTOCOL, firstSequence: window.first, latestSequence: window.latest, replayFrom, ...(resetReason ? { resetReason } : {}) })}\n\n`);
  for (const event of service.eventsAfter(replayFrom)) response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = service.subscribe((event) => { if (!response.destroyed) response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
  const keepalive = setInterval(() => { if (!response.destroyed) response.write(": keepalive\n\n"); }, 15_000); keepalive.unref();
  request.once("close", () => { clearInterval(keepalive); unsubscribe(); });
}

async function readJsonBody(request: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length; if (length > limit) throw new Error(`request_too_large：单次请求最多 ${limit / 1024} KiB`);
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("json_invalid：请求必须是有效 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("json_object_required：请求体必须是对象");
  return parsed as Record<string, unknown>;
}

function requestKey(request: IncomingMessage, body: Record<string, unknown>): string {
  const value = request.headers["idempotency-key"] ?? body.requestKey;
  if (typeof value !== "string") throw new Error("idempotency_key_required：请求缺少 requestKey");
  return value;
}
function operationSelection(value: unknown): { mode?: string; model?: string } {
  if (value === undefined) return {};
  const item = objectField(value, "planner");
  if (Object.keys(item).some(key => !["mode", "model"].includes(key))) throw new Error("planner_selection_invalid");
  return { ...(item.mode === undefined ? {} : { mode: stringField(item.mode, "planner.mode", 40) }), ...(item.model === undefined ? {} : { model: stringField(item.model, "planner.model", 120) }) };
}
function objectField(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}_invalid：必须是对象`);
  return value as Record<string, unknown>;
}
function stringField(value: unknown, name: string, max: number): string { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) throw new Error(`${name}_invalid：必须是 1 到 ${max} 字节的文本`); return value; }
function optionalString(value: unknown, name: string, max: number): string | undefined { if (value === undefined) return undefined; return stringField(value, name, max); }
function integerField(value: unknown, name: string, minimum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name}_invalid：整数值无效`); return value as number; }
function stringArray(value: unknown, name: string, maximum = 64): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string")) throw new Error(`${name}_invalid：必须是最多 ${maximum} 项的字符串数组`); return value as string[]; }
function executionDefaults(value: unknown): { runnerId: string; mode: "managed"; modelId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("executionDefaults_invalid：执行配置无效");
  const item = value as Record<string, unknown>;
  const runnerId = stringField(item.runnerId, "runnerId", 64);
  if (!new Set(["codex", "claude-code", "dsh", "mock"]).has(runnerId)) throw new Error("runnerId_invalid：请选择已支持的 Runner");
  return { runnerId, mode: "managed", ...(item.modelId === undefined ? {} : { modelId: stringField(item.modelId, "modelId", 120) }) };
}
function runOptions(body: Record<string, unknown>): { isolation: "git-worktree" | "shared"; maxParallel: number; verificationTaskId?: string; executionSelection?: ExecutionSelection; expectedPlanHash?: string; expectedDraftRevision?: number } {
  const isolation = body.isolation === undefined ? "git-worktree" : body.isolation;
  if (isolation !== "git-worktree" && isolation !== "shared") throw new Error("isolation_invalid：隔离模式无效");
  const maxParallel = body.maxParallel === undefined ? 1 : integerField(body.maxParallel, "maxParallel", 1);
  if (maxParallel > 8) throw new Error("maxParallel_invalid：并发上限为 8");
  return { isolation, maxParallel, ...(body.expectedPlanHash === undefined ? {} : { expectedPlanHash: stringField(body.expectedPlanHash, "expectedPlanHash", 64) }), ...(body.expectedDraftRevision === undefined ? {} : { expectedDraftRevision: integerField(body.expectedDraftRevision, "expectedDraftRevision", 1) }), ...(body.executionSelection === undefined ? {} : { executionSelection: parseExecutionSelection(body.executionSelection) }), ...(body.verificationTaskId === undefined ? {} : { verificationTaskId: stringField(body.verificationTaskId, "verificationTaskId", 64) }) };
}
function interactionReply(body: Record<string, unknown>): RunnerInteractionReply {
  if (body.kind === "approval" && (body.decision === "allow-once" || body.decision === "deny")) {
    const guidance = body.guidance === undefined ? undefined : stringField(body.guidance, "guidance", 4096);
    if (guidance && body.decision !== "deny") throw new Error("interaction_reply_invalid：只有拒绝审批可以附带修订指导");
    return { kind: "approval", decision: body.decision, ...(guidance ? { guidance } : {}) };
  }
  if (body.kind === "question" && Array.isArray(body.answers) && body.answers.length <= 32) {
    const guidance = body.guidance === undefined ? undefined : stringField(body.guidance, "guidance", 4096);
    const answers = body.answers.map((answer, index) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error(`interaction_reply_invalid：answers[${index}] 格式无效`);
      const item = answer as Record<string, unknown>;
      const questionId = stringField(item.questionId, `answers[${index}].questionId`, 128);
      const optionIds = item.optionIds === undefined ? undefined : stringArray(item.optionIds, `answers[${index}].optionIds`);
      const text = item.text === undefined ? undefined : stringField(item.text, `answers[${index}].text`, 4096);
      return { questionId, ...(optionIds ? { optionIds } : {}), ...(text ? { text } : {}) };
    });
    return { kind: "question", answers, ...(guidance ? { guidance } : {}) };
  }
  if (body.kind === "elicitation" && ["accept", "decline", "cancel"].includes(String(body.action))) {
    const guidance = body.guidance === undefined ? undefined : stringField(body.guidance, "guidance", 4096);
    if (guidance && body.action !== "decline") throw new Error("interaction_reply_invalid：只有拒绝可以附带指导");
    if (body.content !== undefined && body.content !== null && (!body.content || typeof body.content !== "object" || Array.isArray(body.content))) throw new Error("interaction_reply_invalid：Elicitation content 必须是对象");
    let content: Record<string, string | number | boolean | string[]> | undefined;
    if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) {
      const entries = Object.entries(body.content as Record<string, unknown>);
      if (entries.length > 32) throw new Error("interaction_reply_invalid：Elicitation 字段不能超过 32 项");
      content = {};
      for (const [key, value] of entries) {
        if (!key || key.length > 128) throw new Error("interaction_reply_invalid：Elicitation 字段名无效");
        if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 8192) content[key] = value;
        else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) content[key] = value;
        else if (Array.isArray(value) && value.length <= 128 && value.every((item) => typeof item === "string" && Buffer.byteLength(item, "utf8") <= 1024)) content[key] = value as string[];
        else throw new Error("interaction_reply_invalid：Elicitation 字段 " + key + " 类型或长度无效");
      }
    }
    const action = body.action as "accept" | "decline" | "cancel";
    if (action !== "accept" && content) throw new Error("interaction_reply_invalid：拒绝或取消时不能提交表单内容");
    return { kind: "elicitation", action, ...(content ? { content } : {}), ...(guidance ? { guidance } : {}) };
  }
  throw new Error("interaction_reply_invalid：审批或回答格式无效");
}
function cookieValue(header: string | undefined, name: string): string | undefined { return header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1); }
function sendJson(response: ServerResponse, status: number, value: unknown): void { if (response.headersSent || response.destroyed) return; response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); }
function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const message = error instanceof Error ? error.message : String(error);
  const status = message.startsWith("workspace_not_found") ? 404 : message.startsWith("idempotency_conflict") ? 409 : message.startsWith("browser_bridge_not_connected") || message.startsWith("planner_api_key_missing") ? 409 : message.includes("invalid") || message.includes("required") || message.includes("limit") ? 400 : 422;
  sendJson(response, status, { error: message, code: message.split(/[：:]/, 1)[0] });
}
