import { createServer, request as httpRequest, type RequestListener } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { ConnectionObservation } from "../src/connection-diagnostics.js";
import { traceGatewayRequest } from "../src/gateway-tracing.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("records an interrupted response without pretending it completed with HTTP 200", async () => {
  const entries: ConnectionObservation[] = [];
  const origin = await listen((request, response) => {
    traceGatewayRequest(request, response, "https://demo.trycloudflare.com/mcp", async entry => { entries.push(entry); });
    request.resume(); response.writeHead(200); response.flushHeaders();
  });
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(`${origin}/mcp`, response => { response.destroy(); resolve(); });
    request.once("error", reject); request.end();
  });
  await expect.poll(() => entries.find(entry => entry.requestState === "aborted")).toMatchObject({ code: "gateway_connection_aborted", outcome: "error" });
  expect(entries.find(entry => entry.requestState === "aborted")?.httpStatus).toBeUndefined();
  expect(entries.some(entry => entry.requestState === "completed")).toBe(false);
});

it("keeps the HTTP response working when diagnostic storage rejects or throws", async () => {
  let calls = 0;
  const origin = await listen((request, response) => {
    traceGatewayRequest(request, response, "https://demo.trycloudflare.com/mcp", () => { if (++calls === 1) throw new Error("storage unavailable"); return Promise.reject(new Error("disk full")); });
    response.end("still working");
  });
  const response = await fetch(`${origin}/mcp`);
  expect(response.status).toBe(200); expect(await response.text()).toBe("still working");
});
