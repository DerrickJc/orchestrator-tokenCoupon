import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNetworkClient } from "../src/network-fetch.js";
import { installCloudflared } from "../src/cloudflared-component.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server, host = "127.0.0.1") {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no port"); return address.port;
}

it("uses HTTP_PROXY without a Node flag and keeps loopback requests local", async () => {
  const target = createServer((request, response) => response.end(`download ${request.url}`)); const targetPort = await listen(target);
  const sockets = new Set<Socket>(); let connections = 0;
  const proxy = createServer();
  proxy.on("connect", (request, socket, head) => {
    connections++; expect(request.url).toBe("download.invalid:80");
    sockets.add(socket);
    const upstream = connect(targetPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    sockets.add(upstream); upstream.on("error", () => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); });
  const client = createNetworkClient({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` }); cleanups.push(() => client.close());
  expect(await (await client.fetch("http://download.invalid/asset", { signal: AbortSignal.timeout(3000) })).text()).toBe("download /asset");
  expect(await (await client.fetch(`http://127.0.0.1:${targetPort}/local`)).text()).toBe("download /local");
  expect(connections).toBe(1);
}, 10_000);

it("honors NO_PROXY for a destination otherwise handled by the proxy", async () => {
  const server = createServer((_request, response) => response.end("direct")); const port = await listen(server, "127.0.0.2");
  const client = createNetworkClient({ HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.2" }); cleanups.push(() => client.close());
  expect(await (await client.fetch(`http://127.0.0.2:${port}/`, { signal: AbortSignal.timeout(3000) })).text()).toBe("direct");
});

it("distinguishes HTTP, network and filesystem failures without disclosing proxy credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-download-diagnostic-")); cleanups.push(() => rm(root, { force: true, recursive: true }));
  const asset = { name: "cloudflared-linux-amd64", sha256: "0".repeat(64), bytes: 1 };
  const signal = new AbortController().signal;
  await expect(installCloudflared(join(root, "http"), asset, signal, () => undefined, async () => new Response("forbidden", { status: 403 }))).rejects.toThrow("HTTP 403");
  let message = "";
  try { await installCloudflared(join(root, "network"), asset, signal, () => undefined, async () => { throw new Error("http://user:secret@proxy.test", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }); }); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain("ECONNREFUSED"); expect(message).not.toContain("secret"); expect(message).not.toContain("proxy.test");
  const file = join(root, "file"); await writeFile(file, "ordinary file");
  await expect(installCloudflared(join(file, "cache"), asset, signal, () => undefined)).rejects.toThrow("component_install_failed");
  expect(await readFile(file, "utf8")).toBe("ordinary file");
});
