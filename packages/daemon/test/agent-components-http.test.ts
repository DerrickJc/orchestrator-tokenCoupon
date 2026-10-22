import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { EPOCH_HEADER, PROTOCOL_HEADER } from "@token-coupon/client";
import { ApplicationService } from "../src/application-service.js";
import { createLocalServer } from "../src/http-server.js";

it("keeps Agent installation behind local authentication, current epoch, a fixed target and confirmation without requiring a workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-component-http-"));
  const service = new ApplicationService({ dataDirectory: root }); await service.initialize();
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const server = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory: root });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${port}`, path = "/api/v1/agent-components/codex/install";
  const install = vi.spyOn(service.agentComponents, "install");
  try {
    const landing = await fetch(origin); const cookie = landing.headers.getSetCookie()[0]!.split(";")[0]!; await landing.body?.cancel();
    expect((await fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: '{"confirmed":true}' })).status).toBe(403);
    expect(install).not.toHaveBeenCalled();
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", [PROTOCOL_HEADER]: "1", [EPOCH_HEADER]: service.epoch };
    expect((await fetch(origin + path, { method: "POST", headers: { ...headers, [EPOCH_HEADER]: "outdated" }, body: '{"confirmed":true}' })).status).toBe(409);
    expect(install).not.toHaveBeenCalled();
    const denied = await fetch(origin + path, { method: "POST", headers, body: "{}" });
    expect(denied.status).toBe(400); expect(await denied.json()).toMatchObject({ error: expect.stringContaining("agent_install_confirmation_required") });
    install.mockClear();
    const invalid = await fetch(origin + "/api/v1/agent-components/arbitrary-package/install", { method: "POST", headers, body: '{"confirmed":true}' });
    expect(invalid.status).toBe(400); expect(install).not.toHaveBeenCalled();
    const status = { id: "codex" as const, label: "Codex", package: "@openai/codex", version: "0.163.0", docs: "https://developers.openai.com/codex/cli/", available: false, canInstall: false, installDirectory: join(root, "agents"), operation: { operationId: "00000000-0000-4000-8000-000000000000", phase: "installing" as const, message: "下载中", startedAt: new Date().toISOString() } };
    install.mockResolvedValue(status); vi.spyOn(service.agentComponents, "list").mockResolvedValue([status]);
    const result = await fetch(origin + path, { method: "POST", headers, body: '{"confirmed":true}' });
    expect(result.status).toBe(202); expect(install).toHaveBeenCalledWith("codex", true);
    expect(await result.json()).toMatchObject({ id: "codex", operation: { phase: "installing" } });
    expect((await fetch(origin + "/api/v1/agent-components", { headers: { Cookie: cookie } })).status).toBe(200);
    vi.spyOn(service.agentComponents, "active").mockReturnValue([{ jobId: status.operation.operationId, kind: "agent.component.install" }]);
    expect(service.daemonStopAssessment()).toMatchObject({ canStop: false, activeJobs: [{ kind: "agent.component.install" }] });
    expect(service.listWorkspaces()).toEqual([]);
  } finally { vi.restoreAllMocks(); await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
