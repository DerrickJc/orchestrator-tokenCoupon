import { expect, it } from "vitest";
import { createClient, type DaemonHealthDto, type WorkspaceDto } from "../src/index.js";

const health: DaemonHealthDto = {
  status: "ok", epoch: "epoch-1234567890123456", instanceId: "epoch-1234567890123456", applicationVersion: "0.1.0", buildId: "development",
  protocol: { major: 1, minor: 0 }, profile: { id: "a".repeat(24), kind: "wsl", platform: "linux" }, capabilities: { protocolHandshake: 1 },
  phase: "7-incremental", host: "127.0.0.1", workspaceEnvironment: { currentDirectory: "/workspace", platform: "linux", isWsl: true, home: "/home/user" },
  nativePicker: {}, mcp: { url: "http://127.0.0.1:4177/mcp", transport: "Streamable HTTP", localReady: true, chatgptVerified: false, tokenFile: "/profile/token" },
};

it("provides typed domain reads through the same handshake-aware HTTP transport", async () => {
  const workspace: WorkspaceDto = { workspaceId: "workspace-id", path: "/work/project", label: "Project", addedAt: "2026-10-20T00:00:00.000Z" };
  const paths: string[] = [];
  const fetcher = (async (input) => {
    const path = String(input); paths.push(path);
    if (path === "/api/v1/health") return Response.json(health);
    if (path === "/api/v1/workspaces") return Response.json([workspace]);
    return Response.json([]);
  }) as typeof fetch;
  const client = createClient({ fetch: fetcher });

  expect(await client.domain.health()).toEqual(health);
  expect(client.connection().compatibility).toBe("compatible");
  expect(await client.domain.workspaces()).toEqual([workspace]);
  expect(await client.domain.plannings("workspace /one")).toEqual([]);
  expect(paths).toEqual([
    "/api/v1/health",
    "/api/v1/workspaces",
    "/api/v1/workspaces/workspace%20%2Fone/plannings",
  ]);
});

it("encodes planning identifiers before building observation URLs", async () => {
  const paths: string[] = [];
  const fetcher = (async (input) => { paths.push(String(input)); return Response.json({ events: [], retainedWindow: true }); }) as typeof fetch;
  const client = createClient({ fetch: fetcher });
  await client.domain.planningEvents("workspace", "plan/one");
  expect(paths).toEqual(["/api/v1/workspaces/workspace/plannings/plan%2Fone/events"]);
});

it("requires the daemon handshake for typed mutations and never retries an accepted-unknown write", async () => {
  const calls: Array<{ path: string; method: string; epoch: string | null; body: string }> = [];
  const fetcher = (async (input, init) => {
    const path = String(input), method = init?.method ?? "GET";
    if (method === "GET") return Response.json(health);
    calls.push({ path, method, epoch: new Headers(init?.headers).get("X-Token-Coupon-Epoch"), body: String(init?.body) });
    throw new Error("connection lost after request dispatch");
  }) as typeof fetch;
  const client = createClient({ fetch: fetcher });
  const command = { requestKey: "a9c3f612-6f9f-4fb1-8e6e-86eb3cbf960e", request: "make a small plan", provider: "mock", executionDefaults: { runnerId: "mock", mode: "managed" as const } };

  await expect(client.commands.startPlanning("workspace", command)).rejects.toThrow("daemon_handshake_required");
  expect(calls).toHaveLength(0);
  await client.domain.health();
  await expect(client.commands.startPlanning("workspace /one", command)).rejects.toThrow("connection lost");

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ path: "/api/v1/workspaces/workspace%20%2Fone/plannings", method: "POST", epoch: health.epoch, body: JSON.stringify(command) });
});
