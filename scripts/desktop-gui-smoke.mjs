// Real Electron GUI acceptance in an isolated profile. No Runner or paid model calls.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createClient } from "../packages/client/dist/index.js";
import { discoverOwnedDaemon } from "../packages/client/dist/node.js";

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const executablePath = option("--executable");
assert(executablePath && isAbsolute(executablePath), "--executable requires the absolute packaged Electron executable");
const outputDirectory = option("--output") ?? fileURLToPath(new URL(`../.token-coupon/reports/desktop-gui-${Date.now()}/`, import.meta.url));
assert(isAbsolute(outputDirectory), "--output must be absolute");
// This controller only talks to loopback. Do not route local DevTools handshakes through user proxies.
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost,::1";
await mkdir(outputDirectory, { recursive: true });
const manifest = JSON.parse(await readFile(join(dirname(executablePath), "resources/token-coupon-runtime/runtime-manifest.json"), "utf8"));
const root = await mkdtemp(join(process.platform === "win32" ? homedir() : tmpdir(), ".token-coupon-desktop-gui-"));
const profile = join(root, "daemon"), desktopHome = join(root, "桌面 profile");
await mkdir(profile, { mode: 0o700 });
const noSandbox = process.argv.includes("--no-sandbox");
assert(!noSandbox || process.platform === "linux", "--no-sandbox is only a Linux CI test escape hatch");
const environment = { ...process.env, TOKEN_COUPON_DESKTOP_HOME: desktopHome };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
const pageErrors = [];
let lastOrigin;

async function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function launch() {
  console.log("GUI smoke：启动隔离桌面窗口…");
  application = await electron.launch({ executablePath, chromiumSandbox: !noSandbox,
    args: ["--data-dir", profile, ...(noSandbox ? ["--no-sandbox"] : [])], env: environment, timeout: 60_000 });
  const page = await application.firstWindow({ timeout: 60_000 });
  console.log("GUI smoke：已取得窗口，等待页面与 preload…");
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.tokenCouponDesktop && document.title.includes("Token Coupon"));
  const attachment = await page.evaluate(() => window.tokenCouponDesktop.getAttachment());
  console.log("GUI smoke：本机 IPC 与后台身份已核实…");
  lastOrigin = attachment.origin;
  assert.equal(attachment.applicationVersion, manifest.applicationVersion);
  assert.equal(attachment.buildId, manifest.buildId);
  assert.equal(await bounded(application.evaluate(({ app }) => app.isPackaged), "inspect packaged startup"), true);
  assert.equal(await bounded(application.evaluate(({ app }) => app.getPath("userData")), "inspect desktop profile"), resolve(desktopHome));
  return { page, attachment };
}

async function closeWindow() {
  console.log("GUI smoke：退出桌面 UI，保留后台…");
  if (application) {
    const current = application; application = undefined;
    const child = current.process();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolveExit => child.once("exit", resolveExit));
    // Electron can exit before Playwright's browser-context close promise settles.
    // Confirm the OS process exit rather than waiting indefinitely for that transport receipt.
    void current.close().catch(() => {});
    try { await bounded(exited, "close test desktop", 10_000); }
    catch (error) { child.kill("SIGKILL"); throw error; }
  }
}

async function stopDaemon() {
  const ownerFile = join(profile, "daemon-owner.json");
  try { await access(ownerFile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const owner = await discoverOwnedDaemon(profile, { timeoutMs: 1500 });
  console.log("GUI smoke：安全停止本次测试的后台…");
  if (lastOrigin) assert.equal(owner.origin, lastOrigin, "only the verified daemon started for this test may be stopped");
  const landing = await fetch(owner.origin, { signal: AbortSignal.timeout(5000) }), cookie = landing.headers.getSetCookie()[0]?.split(";")[0];
  await landing.body?.cancel();
  assert(cookie, "test daemon must establish local authorization");
  const client = createClient({ fetch: (path, options) => fetch(owner.origin + path, { ...options, signal: AbortSignal.timeout(5000),
    headers: { ...Object.fromEntries(new Headers(options?.headers)), Cookie: cookie, Origin: owner.origin } }) });
  await client.api("/api/v1/health");
  await client.api("/api/v1/daemon/stop", { method: "POST", body: JSON.stringify({ confirmed: true, expectedEpoch: owner.epoch }) });
  for (let index = 0; index < 100; index++) {
    try { await access(ownerFile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error("test daemon did not stop after accepting the shutdown command");
}

try {
  let { page, attachment } = await launch();
  const firstEpoch = attachment.epoch;
  const isolation = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
  assert.deepEqual(isolation, { require: "undefined", process: "undefined" });
  const preferences = await bounded(application.browserWindow(page).then(window => window.evaluate(instance => instance.webContents.getLastWebPreferences())), "inspect renderer isolation");
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => window.tokenCouponDesktop.getNotificationsEnabled()), false);
  assert.equal(await page.evaluate(() => window.tokenCouponDesktop.setNotificationsEnabled(true)), true);
  assert.equal(await page.evaluate(() => window.open("https://example.invalid/") === null), true);
  const iframe = await page.evaluateHandle(() => { const frame = document.createElement("iframe"); frame.srcdoc = "<p>Untrusted child frame</p>"; document.body.append(frame); return frame; });
  const frame = await iframe.asElement().contentFrame();
  assert(frame); assert.equal(await frame.evaluate(() => typeof window.tokenCouponDesktop), "undefined");
  await iframe.evaluate(element => element.remove());
  await page.screenshot({ path: join(outputDirectory, "desktop.png"), fullPage: false });
  await closeWindow();
  assert.equal((await discoverOwnedDaemon(profile)).epoch, firstEpoch, "closing desktop must preserve its detached daemon");

  ({ page, attachment } = await launch());
  assert.equal(attachment.epoch, firstEpoch, "reopening desktop should reuse the authenticated running daemon");
  assert.equal(await page.evaluate(() => window.tokenCouponDesktop.getNotificationsEnabled()), true);
  await stopDaemon(); await closeWindow();

  ({ page, attachment } = await launch());
  assert.notEqual(attachment.epoch, firstEpoch, "after safe shutdown a new daemon must have a new epoch");
  assert.equal(await page.evaluate(() => window.tokenCouponDesktop.getNotificationsEnabled()), true);
  assert.deepEqual(pageErrors, [], "the real renderer should load without JavaScript errors");
  const report = { platform: process.platform, electronVersion: await application.evaluate(() => process.versions.electron),
    buildId: manifest.buildId, packagedStartup: "passed", restrictedPreload: "passed", childFrameIsolation: "passed", popupDenied: "passed",
    notificationPreferencePersistence: "passed", detachedDaemonReuse: "passed", safeStopAndRestart: "passed",
    chromiumSandbox: noSandbox ? "disabled-for-linux-test" : "enabled", nativeWindowsAcceptance: false };
  await writeFile(join(outputDirectory, "desktop-gui-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputDirectory, ...report }));
} finally {
  try { await stopDaemon(); }
  finally { await closeWindow(); }
  await rm(root, { recursive: true, force: true });
}
