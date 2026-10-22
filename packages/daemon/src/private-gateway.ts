import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const hex = /^[a-f0-9]{64}$/;
const pipe = /^\\\\\.\\pipe\\tc-gateway-[a-f0-9]{64}$/;
const proof = (key: string, role: string, client: string, server: string) => createHmac("sha256", key).update(`${role}:${client}:${server}`).digest("hex");
const matches = (expected: string, supplied: string) => hex.test(supplied) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));

export interface PrivateGatewayEndpoint { socketPath: string; token?: string; directory?: string; }
export async function createPrivateGateway(platform: NodeJS.Platform = process.platform): Promise<PrivateGatewayEndpoint> {
  if (platform === "win32") return { socketPath: `\\\\.\\pipe\\tc-gateway-${randomBytes(32).toString("hex")}`, token: randomBytes(32).toString("hex") };
  const directory = await mkdtemp(join(tmpdir(), "tc-gateway-"));
  await chmod(directory, 0o700);
  return { socketPath: join(directory, "gateway.sock"), directory };
}
export async function removePrivateGateway(endpoint?: PrivateGatewayEndpoint): Promise<void> {
  if (endpoint?.directory) await rm(endpoint.directory, { recursive: true, force: true });
}
export async function validatePrivateGateway(socketPath: unknown, token: unknown, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    if (typeof socketPath !== "string" || !pipe.test(socketPath) || typeof token !== "string" || !hex.test(token)) throw new Error("gateway_endpoint_invalid");
    return;
  }
  if (token !== undefined || typeof socketPath !== "string" || !isAbsolute(socketPath) || basename(socketPath) !== "gateway.sock" || dirname(dirname(socketPath)) !== resolve(tmpdir()) || !basename(dirname(socketPath)).startsWith("tc-gateway-")) throw new Error("gateway_endpoint_invalid");
  const parent = await lstat(dirname(socketPath)), entry = await lstat(socketPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || !entry.isSocket() || entry.isSymbolicLink() || process.getuid && parent.uid !== process.getuid()) throw new Error("gateway_endpoint_invalid");
}

function frame(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => { socket.removeListener("data", data); socket.removeListener("error", failed); socket.removeListener("close", closed); };
    const failed = () => { cleanup(); reject(new Error("gateway_auth_failed")); };
    const closed = () => failed();
    const data = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf(10);
      if (end > 256 || end < 0 && pending.length > 256) { cleanup(); socket.destroy(); reject(new Error("gateway_auth_invalid")); return; }
      if (end < 0) return;
      socket.pause(); cleanup();
      if (pending.length > end + 1) socket.unshift(pending.subarray(end + 1));
      resolve(pending.subarray(0, end).toString("ascii"));
    };
    socket.on("data", data); socket.once("error", failed); socket.once("close", closed); socket.resume();
  });
}

/** Authenticate before giving any bytes to the HTTP parser; no static secret crosses IPC. */
export function protectPrivateGateway(server: Server, key: string): () => void {
  if (!hex.test(key)) throw new Error("gateway_key_invalid");
  const listeners = server.listeners("connection"), pending = new Set<Socket>();
  server.removeAllListeners("connection");
  server.on("connection", (socket: Socket) => {
    pending.add(socket); socket.once("close", () => pending.delete(socket));
    const timeout = () => socket.destroy(); socket.setTimeout(5000, timeout);
    void (async () => {
      const greeting = await frame(socket), client = greeting.startsWith("TCG1 ") ? greeting.slice(5) : "";
      if (!hex.test(client)) throw new Error("gateway_auth_invalid");
      const nonce = randomBytes(32).toString("hex");
      socket.write(`${nonce} ${proof(key, "server", client, nonce)}\n`);
      if (!matches(proof(key, "client", client, nonce), await frame(socket))) throw new Error("gateway_auth_failed");
      socket.setTimeout(0); socket.removeListener("timeout", timeout); pending.delete(socket);
      socket.write("OK\n");
      for (const listener of listeners) listener.call(server, socket);
      socket.resume();
    })().catch(() => { pending.delete(socket); socket.destroy(); });
  });
  return () => { for (const socket of pending) socket.destroy(); pending.clear(); };
}

export async function connectPrivateGateway(socketPath: string, key: string): Promise<Socket> {
  if (!hex.test(key)) throw new Error("gateway_key_invalid");
  const socket = connect(socketPath), timeout = () => socket.destroy();
  socket.setTimeout(5000, timeout);
  try {
    await new Promise<void>((resolve, reject) => {
      const error = () => { socket.removeListener("connect", ready); socket.removeListener("close", error); reject(new Error("gateway_auth_failed")); };
      const ready = () => { socket.removeListener("error", error); socket.removeListener("close", error); resolve(); };
      socket.once("connect", ready); socket.once("error", error); socket.once("close", error);
    });
    const client = randomBytes(32).toString("hex"); socket.write(`TCG1 ${client}\n`);
    const [nonce, supplied, extra] = (await frame(socket)).split(" ");
    if (!nonce || !hex.test(nonce) || !supplied || extra !== undefined || !matches(proof(key, "server", client, nonce), supplied)) throw new Error("gateway_auth_failed");
    socket.write(`${proof(key, "client", client, nonce)}\n`);
    if (await frame(socket) !== "OK") throw new Error("gateway_auth_failed");
    socket.setTimeout(0); socket.removeListener("timeout", timeout);
    return socket;
  } catch { socket.destroy(); throw new Error("gateway_auth_failed"); }
}

export function privateGatewayAgent(socketPath: string, key: string): Agent {
  const agent = new Agent({ keepAlive: false, maxSockets: 64 });
  agent.createConnection = ((_options, callback) => {
    void connectPrivateGateway(socketPath, key).then(socket => { callback!(null, socket); socket.resume(); }, () => callback!(new Error("gateway_auth_failed"), undefined as never));
    return undefined as never;
  }) as typeof agent.createConnection;
  return agent;
}

/** Windows modes do not implement ACLs. Restrict only this dedicated component directory. */
export async function prepareTunnelDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("tunnel_directory_invalid");
  if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
  const encoded = Buffer.from(resolve(directory), "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $ids=@($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));
    $item=Get-Item -LiteralPath $p -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' };
    $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
    foreach ($id in $ids) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) };
    Set-Acl -LiteralPath $p -AclObject $acl;
    foreach ($f in Get-ChildItem -LiteralPath $p -Force) {
      if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' };
      if (-not $f.PSIsContainer) { $a=[Security.AccessControl.FileSecurity]::new(); $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false);
        foreach ($id in $ids) { $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','Allow')) }; Set-Acl -LiteralPath $f.FullName -AclObject $a }
    }`;
  try {
    await execute(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
  } catch { throw new Error("tunnel_directory_permissions：无法设置当前用户的连接组件目录权限，请使用用户目录后重试"); }
}
