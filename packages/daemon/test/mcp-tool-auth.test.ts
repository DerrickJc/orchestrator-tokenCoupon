import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "../src/application-service.js";
import { createMcpServer, type RemoteMcpPrincipal, type RemoteMcpScope } from "../src/mcp-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
// The SDK Client.listTools() strips nonstandard top-level fields. Preserve the
// extension in this response schema so tests verify the actual transmitted data.
const toolListSchema = ListToolsResultSchema.extend({ tools: z.array(ToolSchema.extend({
  securitySchemes: z.array(z.object({ type: z.literal("oauth2"), scopes: z.array(z.string()) })).optional(),
})) });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tc-tool-auth-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService({ dataDirectory: join(root, "state") });
  await service.initialize();
  const path = join(root, "project"); await mkdir(path);
  const workspace = await service.addWorkspace(path, "授权项目");
  const scopes: RemoteMcpScope[] = ["repository:read", "planning:read", "planning:write", "session:read", "session:control"];
  const principal: RemoteMcpPrincipal = { grantId: randomUUID(), clientId: randomUUID(), workspaceId: workspace.workspaceId, scopes, expiresAt: Date.now() + 60_000 };
  const connect = async (identity?: RemoteMcpPrincipal) => {
    const server = createMcpServer(service, identity), client = new Client({ name: "auth-metadata-test", version: "1" });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote); await client.connect(local);
    cleanups.push(async () => { await client.close(); await server.close(); });
    return client;
  };
  return { service, workspace, principal, connect };
}

describe("remote MCP OAuth tool descriptors", () => {
  it("sends matching canonical and compatibility declarations for every exposed remote tool", async () => {
    const h = await fixture(), client = await h.connect(h.principal);
    const { tools } = await client.request({ method: "tools/list" }, toolListSchema);
    expect(tools).toHaveLength(16);
    expect(tools.map(tool => tool.name)).not.toContain("session_control");
    expect(tools.map(tool => tool.name)).not.toContain("delivery_prepare");
    for (const tool of tools) {
      expect(tool.securitySchemes).toEqual(tool._meta?.securitySchemes);
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: expect.any(Array) }]);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    }
    expect(tools.find(tool => tool.name === "workspace_query")).toMatchObject({
      inputSchema: { properties: {}, additionalProperties: false },
      securitySchemes: [{ type: "oauth2", scopes: [] }], annotations: { readOnlyHint: true },
    });
    for (const [name, scope] of [["planning_query", "planning:read"], ["planning_prepare", "planning:write"], ["external_submit", "planning:write"], ["repository_query", "repository:read"], ["session_query", "session:read"]]) {
      expect(tools.find(tool => tool.name === name)?.securitySchemes).toEqual([{ type: "oauth2", scopes: [scope] }]);
    }
    const reply = await client.callTool({ name: "workspace_query", arguments: {} });
    expect(reply.isError).not.toBe(true);
    expect(JSON.parse((reply.content as Array<{ text: string }>)[0]!.text).workspaces).toEqual([{ workspaceId: h.workspace.workspaceId, label: h.workspace.label }]);
    // The metadata/list adapter must not replace SDK input validation.
    expect((await client.callTool({ name: "workspace_query", arguments: { unexpected: true } })).isError).toBe(true);
  });

  it("retains scope filtering, project isolation and runtime expiration/revocation checks", async () => {
    const h = await fixture();
    const limited = await h.connect({ ...h.principal, scopes: ["planning:read"] });
    const tools = (await limited.request({ method: "tools/list" }, toolListSchema)).tools;
    expect(tools.some(tool => ["planning_prepare", "repository_query", "session_query"].includes(tool.name))).toBe(false);
    const denied = await limited.callTool({ name: "planning_query", arguments: { workspaceId: "ffffffffffffffff" } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("mcp_workspace_forbidden");
    expect(await h.service.listPlannings(h.workspace.workspaceId)).toEqual([]);
    const scopeFree = await h.connect({ ...h.principal, scopes: [] });
    expect((await scopeFree.listTools()).tools.map(tool => tool.name)).toEqual(["workspace_query"]);
    expect((await scopeFree.callTool({ name: "workspace_query", arguments: {} })).isError).not.toBe(true);
    const expired = await h.connect({ ...h.principal, expiresAt: Date.now() - 1 });
    expect((await expired.callTool({ name: "workspace_query", arguments: {} })).isError).toBe(true);
    const revoked = await h.connect({ ...h.principal, assertActive: async () => { throw new Error("oauth_grant_revoked：授权已撤销"); } });
    const reply = await revoked.callTool({ name: "workspace_query", arguments: {} });
    expect(reply.isError).toBe(true); expect(JSON.stringify(reply)).toContain("oauth_grant_revoked");
  });

  it("does not advertise anonymous access or remote OAuth for the independently authenticated local transport", async () => {
    const h = await fixture(), client = await h.connect();
    const tools = (await client.request({ method: "tools/list" }, toolListSchema)).tools;
    expect(tools.some(tool => tool.name === "session_control")).toBe(true);
    for (const tool of tools) {
      expect(tool.securitySchemes).toBeUndefined();
      expect(tool._meta?.securitySchemes).toBeUndefined();
    }
  });
});
