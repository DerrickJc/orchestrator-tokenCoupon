import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnNative } from "../packages/core/dist/native-command.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await pause(25); }
  throw new Error(message);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = path => access(path).then(() => true, () => false);
const ended = child => new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });

if (process.argv[2] === "--owner") {
  const root = process.argv[3], fixture = join(root, "fixture.mjs");
  const child = spawnNative(process.execPath, [fixture, "root", root], { cwd: root, stdio: "ignore" });
  await writeFile(join(root, "helper"), String(child.pid));
  setInterval(() => {}, 1000);
} else if (process.platform !== "win32") {
  console.log(JSON.stringify({ platform: process.platform, windowsJob: "not-applicable" }));
} else {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-process-tree-"));
  const fixture = join(root, "fixture.mjs");
  const children = new Set();
  const plain = (args, options = {}) => { const child = spawn(process.execPath, args, { stdio: "ignore", ...options }); children.add(child); return child; };
  const owned = (args, options = {}) => { const child = spawnNative(process.execPath, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], ...options }); children.add(child); return child; };
  const pids = async () => Promise.all(["root", "child", "grandchild"].map(async name => Number(await readFile(join(root, name), "utf8"))));
  const waitTree = () => until(() => exists(join(root, "grandchild")), "tree_did_not_start");
  async function clearRecords() { for (const name of ["root", "child", "grandchild", "heartbeat", "helper"]) await rm(join(root, name), { force: true }); }
  try {
    await writeFile(fixture, `import {spawn} from 'node:child_process';import{writeFile}from'node:fs/promises';import{join}from'node:path';import{fileURLToPath}from'node:url';
const[role,root,mode]=process.argv.slice(2);await writeFile(join(root,role),String(process.pid));
if(role==='echo'){const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);process.stdout.write(Buffer.concat(chunks));process.stderr.write(process.env.TOKEN_COUPON_CHILD_CONFIG?'config-leaked':'private-config-removed');}
else{if(role!=='grandchild')spawn(process.execPath,[fileURLToPath(import.meta.url),role==='root'?'child':'grandchild',root],{stdio:'ignore'});
if(role==='root'&&mode==='exit'){setTimeout(()=>process.exit(7),1500);}else setInterval(()=>{if(role==='grandchild')void writeFile(join(root,'heartbeat'),String(Date.now()));},25);}`);
    const unrelated = plain(["-e", "setInterval(()=>{},1000)"]);
    const payload = Buffer.concat([Buffer.from("中文\n\r\n"), Buffer.from(Array.from({ length: 256 }, (_, index) => index))]);
    const echo = owned([fixture, "echo", root]); let output = Buffer.alloc(0), diagnostic = "";
    echo.stdout.on("data", chunk => { output = Buffer.concat([output, chunk]); }); echo.stderr.on("data", chunk => { diagnostic += chunk; });
    const echoEnded = ended(echo); echo.stdin.end(payload);
    assert.equal(await echoEnded, 0, diagnostic); assert.deepEqual(output, payload); assert.equal(diagnostic, "private-config-removed");

    const cancelled = owned([fixture, "root", root]); const cancelEnded = ended(cancelled);
    cancelled.stdout.resume(); cancelled.stderr.resume();
    await waitTree(); const cancelledPids = [cancelled.pid, ...await pids()];
    cancelled.kill("SIGTERM"); await cancelEnded;
    await until(() => cancelledPids.every(pid => !alive(pid)), "cancel_left_owned_processes");
    assert(alive(unrelated.pid)); await clearRecords();

    const normal = owned([fixture, "root", root, "exit"]); const normalEnded = ended(normal);
    normal.stdout.resume(); normal.stderr.resume();
    await waitTree(); const normalPids = [normal.pid, ...await pids()];
    assert.equal(await normalEnded, 7);
    await until(() => normalPids.every(pid => !alive(pid)), "normal_exit_left_descendants");
    assert(alive(unrelated.pid)); await clearRecords();

    const owner = plain([fileURLToPath(import.meta.url), "--owner", root]); const ownerEnded = ended(owner);
    await waitTree(); const abandonedPids = [Number(await readFile(join(root, "helper"), "utf8")), ...await pids()];
    owner.kill("SIGKILL"); await ownerEnded;
    await until(() => abandonedPids.every(pid => !alive(pid)), "parent_crash_left_owned_processes");
    assert(alive(unrelated.pid));
    console.log(JSON.stringify({ platform: process.platform, node: process.version, stdio: "byte-exact", cancelTree: "passed", normalExit: "passed", parentCrash: "passed", unrelatedProcess: "preserved" }));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await pause(250); await rm(root, { recursive: true, force: true });
  }
}
