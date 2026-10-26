import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import { ApplicationService } from "../../daemon/src/application-service.js";
import { createLocalServer } from "../../daemon/src/http-server.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

it("bootstraps a fresh development session, serves React modules, and reports a stopped daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-coupon-vite-"));
  const previousOrigin = process.env.TOKEN_COUPON_WEB_DAEMON_ORIGIN;
  let daemon: Awaited<ReturnType<typeof createLocalServer>> | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    const port = await freePort(), devPort = await freePort();
    process.env.TOKEN_COUPON_WEB_DAEMON_ORIGIN = `http://127.0.0.1:${port}`;
    const service = new ApplicationService({ dataDirectory: directory }); await service.initialize();
    daemon = await createLocalServer(service, { port, host: "127.0.0.1", dataDirectory: directory });
    await new Promise<void>(resolve => daemon!.listen(port, "127.0.0.1", resolve));
    vite = await createViteServer({ configFile: join(process.cwd(), "packages/web/vite.config.js"), logLevel: "silent", server: { port: devPort, strictPort: true } });
    await vite.listen();
    const origin = `http://127.0.0.1:${devPort}`;
    const landing = await fetch(origin), html = await landing.text();
    expect(landing.status).toBe(200);
    const cookie = landing.headers.getSetCookie()[0]?.split(";")[0];
    expect(cookie).toMatch(/^tc_local=.+/);
    expect(landing.headers.get("set-cookie")).toContain("HttpOnly");
    expect(html).not.toContain(cookie!.slice("tc_local=".length));
    const script = [...html.matchAll(/<script[^>]+src="([^"]+\.tsx)"/g)][0]?.[1];
    expect(script).toBeTruthy();
    const module = await fetch(new URL(script!, origin));
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("javascript");
    expect(await module.text()).not.toContain("<!DOCTYPE html>");
    expect((await fetch(`${origin}/api/v1/health`)).status).toBe(403);
    expect((await fetch(`${origin}/api/v1/health`, { headers: { Cookie: cookie! } })).status).toBe(200);
    const write = await fetch(`${origin}/api/v1/workspaces`, { method: "POST", headers: { Cookie: cookie!, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ path: "relative-path" }) });
    expect(write.status).toBe(400);
    await new Promise<void>(resolve => daemon!.close(() => resolve())); daemon = undefined;
    const offline = await fetch(origin);
    expect(offline.status).toBe(503);
    expect(await offline.text()).toContain("web_dev_daemon_unavailable");
  } finally {
    await vite?.close();
    if (daemon) await new Promise<void>(resolve => daemon!.close(() => resolve()));
    if (previousOrigin === undefined) delete process.env.TOKEN_COUPON_WEB_DAEMON_ORIGIN;
    else process.env.TOKEN_COUPON_WEB_DAEMON_ORIGIN = previousOrigin;
    await rm(directory, { recursive: true, force: true });
  }
});
