import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RemoteMcpScope } from "./mcp-server.js";

// workspace_query requires a valid grant, but no additional scope: it only
// discovers that grant's bound projects. No remote tool permits anonymous use.
const scopesByTool: Record<string, RemoteMcpScope[]> = {
  workspace_query: [],
  handoff_query: ["planning:read"],
  handoff_claim: ["planning:write"],
  handoff_release: ["planning:write"],
  planning_prepare: ["planning:write"],
  external_context: ["planning:read"],
  repository_query: ["repository:read"],
  conversation_read: ["planning:read"],
  external_submit: ["planning:write"],
  planning_query: ["planning:read"],
  operation_query: ["planning:read"],
  session_query: ["session:read"],
  attempt_evidence_read: ["session:read"],
  delivery_query: ["session:read"],
  session_diagnose: ["session:read"],
  external_cancel: ["planning:write"],
};

export function knownRemoteTool(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(scopesByTool, value);
}

/** Add OAuth discovery metadata without changing handlers or local authentication. */
export function remoteToolRegistration(server: McpServer) {
  const tools = new Map<string, RegisteredTool>();
  const register: typeof server.registerTool = (name, config, callback) => {
    const scopes = scopesByTool[name];
    if (!scopes) throw new Error(`mcp_tool_auth_missing：工具 ${name} 未声明远程权限`);
    const schemes = [{ type: "oauth2", scopes: [...scopes] }];
    const tool = server.registerTool(name, { ...config, _meta: { ...config._meta, securitySchemes: schemes } }, callback);
    tools.set(name, tool);
    return tool;
  };
  return { register, install: () => {
    // SDK 1.x only serializes _meta, not top-level extension fields. Use its
    // public handler API and schema conversion to emit both on the actual wire.
    // Calls, input validation, scope filtering and authorization stay with SDK/core.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...tools].filter(([, tool]) => tool.enabled).map(([name, tool]) => {
        const input = normalizeObjectSchema(tool.inputSchema);
        const output = normalizeObjectSchema(tool.outputSchema);
        return { name, title: tool.title, description: tool.description,
          inputSchema: input ? toJsonSchemaCompat(input, { strictUnions: true, pipeStrategy: "input" }) : { type: "object", properties: {} },
          ...(output ? { outputSchema: toJsonSchemaCompat(output, { strictUnions: true, pipeStrategy: "output" }) } : {}),
          annotations: tool.annotations, execution: tool.execution,
          securitySchemes: tool._meta!.securitySchemes, _meta: tool._meta,
        };
      }),
    }));
  } };
}
