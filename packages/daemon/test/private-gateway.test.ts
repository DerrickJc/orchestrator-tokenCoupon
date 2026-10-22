import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { createServer as netServer, connect } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { connectPrivateGateway, createPrivateGateway, prepareTunnelDirectory, privateGatewayAgent, protectPrivateGateway, removePrivateGateway, validatePrivateGateway } from "../src/private-gateway.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const endpoint = await createPrivateGateway(), key = randomBytes(32).toString("hex");
  let count = 0;
  const server = createServer((req, res) => { count++; res.end(req.headers.authorization === "Bearer business-secret" ? "authenticated business" : "ordinary request"); });
  const dispose = protectPrivateGateway(server, key);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ path: endpoint.socketPath, readableAll: false, writableAll: false }, resolve); });
  cleanups.push(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removePrivateGateway(endpoint); });
  return { endpoint, key, server, count: () => count };
}
function get(socketPath: string, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const agent = privateGatewayAgent(socketPath, key);
    const req = request({ socketPath, path: "/mcp", agent, headers: { Authorization: "Bearer business-secret" } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.once("end", () => { agent.destroy(); resolve(body); }); res.once("error", reject);
    });
    req.once("error", error => { agent.destroy(); reject(error); }); req.end();
  });
}
it("authenticates both ends before forwarding ordinary HTTP, including repeated requests", async () => {
  const h = await fixture();
  expect(await get(h.endpoint.socketPath, h.key)).toBe("authenticated business");
  expect(await get(h.endpoint.socketPath, h.key)).toBe("authenticated business");
  expect(h.count()).toBe(2);
});
it("rejects missing/wrong credentials and oversized greetings before reaching the HTTP handler", async () => {
  const h = await fixture();
  await expect(connectPrivateGateway(h.endpoint.socketPath, "0".repeat(64))).rejects.toThrow("gateway_auth_failed");
  for (const greeting of ["GET /mcp HTTP/1.1\r\nAuthorization: Bearer business-secret\r\n\r\n", "x".repeat(300)]) {
    const socket = connect(h.endpoint.socketPath);
    await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.once("connect", () => socket.write(greeting)); socket.once("close", () => resolve()); });
  }
  expect(h.count()).toBe(0);
});
it("does not disclose HTTP credentials or a body to a forged backend", async () => {
  const endpoint = await createPrivateGateway(); let observed = "";
  const sockets = new Set<import("node:net").Socket>();
  const fake = netServer(socket => { sockets.add(socket); socket.on("data", chunk => { observed += chunk; socket.write(`${"0".repeat(64)} ${"0".repeat(64)}\n`); }); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => fake.listen(endpoint.socketPath, resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => fake.close(() => resolve())); await removePrivateGateway(endpoint); });
  await expect(get(endpoint.socketPath, randomBytes(32).toString("hex"))).rejects.toThrow("gateway_auth_failed");
  expect(observed).toMatch(/^TCG1 [a-f0-9]{64}\n$/);
  expect(observed).not.toContain("business-secret"); expect(observed).not.toContain("/mcp");
});
it("rejects reflected server proofs instead of accepting them as client authentication", async () => {
  const h = await fixture(), socket = connect(h.endpoint.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject); socket.once("close", () => resolve());
    socket.once("connect", () => socket.write(`TCG1 ${"a".repeat(64)}\n`));
    socket.once("data", data => socket.write(data.toString().trim().split(" ")[1] + "\n"));
  });
  expect(h.count()).toBe(0);
});
it("accepts only application pipe names on Windows, never arbitrary pipes, files or TCP URLs", async () => {
  const endpoint = await createPrivateGateway("win32");
  await expect(validatePrivateGateway(endpoint.socketPath, endpoint.token, "win32")).resolves.toBeUndefined();
  for (const path of ["C:\\users\\public\\gateway.sock", "\\\\.\\pipe\\other", "http://127.0.0.1:4177", endpoint.socketPath + "\\..\\other"]) {
    await expect(validatePrivateGateway(path, endpoint.token, "win32")).rejects.toThrow("gateway_endpoint_invalid");
  }
  await expect(validatePrivateGateway(endpoint.socketPath, undefined, "win32")).rejects.toThrow("gateway_endpoint_invalid");
});
it("cleans unauthenticated connections when the private gateway stops", async () => {
  const h = await fixture(), socket = connect(h.endpoint.socketPath);
  await new Promise<void>(resolve => socket.once("connect", resolve));
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  // The fixture closes pending connections through its returned disposer.
  const cleanup = cleanups.pop()!; await cleanup(); await closed;
});
it("protects the dedicated tunnel directory without altering unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-private-中文 空格-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "tunnel"), unrelated = join(root, "keep.txt");
  await writeFile(unrelated, "keep"); await prepareTunnelDirectory(target);
  await writeFile(join(target, "supervisor.json"), "{}"); await prepareTunnelDirectory(target);
  expect(await readFile(unrelated, "utf8")).toBe("keep");
}, 30000);
