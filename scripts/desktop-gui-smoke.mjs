// Real Electron GUI acceptance in an isolated profile. No Runner or paid model calls.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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

async function localClient(origin) {
  const landing = await fetch(origin, { signal: AbortSignal.timeout(5000) }), cookie = landing.headers.getSetCookie()[0]?.split(";")[0];
  await landing.body?.cancel();
  assert(cookie, "test daemon must establish local authorization");
  const client = createClient({ fetch: (path, options) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(5000),
    headers: { ...Object.fromEntries(new Headers(options?.headers)), Cookie: cookie, Origin: origin } }) });
  await client.api("/api/v1/health");
  return client;
}

async function verifyAppearance(page, origin) {
  console.log("GUI smoke：检查键盘导航、真实任务页深浅色和减少动画偏好…");
  await page.focus("#skip-main"); await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "main-content");
  await page.locator("#system-settings-save").click();
  await page.waitForFunction(() => document.querySelector("#system-settings-status").textContent.includes("已保存"));
  const workspacePath = join(root, "中文 mock 任务"); await mkdir(workspacePath);
  const client = await localClient(origin);
  async function completed(job) {
    const deadline = Date.now() + 60_000;
    while (job.status === "running" && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50)); job = await client.api(`/api/v1/jobs/${job.jobId}`);
    }
    assert.equal(job.status, "succeeded", job.error); return job.result;
  }
  const workspace = await client.api("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ path: workspacePath, label: "外观与键盘回归" }) });
  const planned = await completed(await client.api(`/api/v1/workspaces/${workspace.workspaceId}/plannings`, { method: "POST",
    body: JSON.stringify({ requestKey: randomUUID(), request: "离线问候函数与测试", provider: "mock", executionDefaults: { runnerId: "mock", mode: "managed" } }) }));
  const planPath = `/api/v1/workspaces/${workspace.workspaceId}/plannings/${planned.planningId}`;
  await completed(await client.api(`${planPath}/review`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID(), reviewer: { mode: "mock" } }) }));
  const draft = await client.api(planPath);
  await completed(await client.api(`${planPath}/approve`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID(), draftRevision: draft.draft.draftRevision }) }));
  await completed(await client.api(`${planPath}/run`, { method: "POST", body: JSON.stringify({ requestKey: randomUUID(), isolation: "shared", maxParallel: 1 }) }));
  // A hash-only goto keeps the old in-memory workspace list. Reload after API fixture creation.
  await page.goto(`${origin}/?gui-smoke=appearance#/workspaces/${workspace.workspaceId}/plans/${planned.planningId}/execution`);
  try { await page.waitForSelector("#task-list .task-row"); }
  catch (error) {
    await page.screenshot({ path: join(outputDirectory, "appearance-load-failed.png") });
    console.error("Task view diagnostic:", await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-5000) })));
    throw error;
  }
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.waitForFunction(expected => matchMedia("(prefers-color-scheme: dark)").matches === (expected === "dark"), theme);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const contrast = await page.evaluate(() => {
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const rootStyle = getComputedStyle(document.documentElement), task = getComputedStyle(document.querySelector("#task-list .task-row"));
      const select = getComputedStyle(document.querySelector("#system-settings-mode"));
      const button = getComputedStyle(document.querySelector("#system-settings-save"));
      const dagText = document.querySelector("#task-dependencies .dag-node text"), dagRect = document.querySelector("#task-dependencies .dag-node > rect");
      const spinner = document.createElement("span"); spinner.className = "spinner"; document.body.append(spinner);
      const duration = parseFloat(getComputedStyle(spinner).animationDuration); spinner.remove();
      return { background: rootStyle.backgroundColor, taskColors: [task.color, task.backgroundColor], text: ratio(rootStyle.color, rootStyle.backgroundColor), task: ratio(task.color, task.backgroundColor),
        select: ratio(select.color, select.backgroundColor), button: ratio(button.color, button.backgroundColor), animationDuration: duration,
        ...(dagText && dagRect ? { dag: ratio(getComputedStyle(dagText).fill, getComputedStyle(dagRect).fill) } : {}) };
    });
    console.log(`GUI smoke：${theme} theme contrast`, contrast);
    await page.screenshot({ path: join(outputDirectory, `desktop-${theme}.png`), fullPage: false });
    await page.locator("#execution-task-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(outputDirectory, `desktop-tasks-${theme}.png`), fullPage: false });
    for (const part of ["text", "task", "select", "button"]) assert(contrast[part] >= 4.5, `${theme} ${part} text contrast ${contrast[part]}`);
    if (contrast.dag !== undefined) assert(contrast.dag >= 4.5, `${theme} DAG contrast ${contrast.dag}`);
    assert(contrast.animationDuration < .001, "reduced-motion must disable continuous spinner animation");
    if (theme === "dark") assert.notEqual(contrast.background, "rgb(245, 246, 242)");
  }
}

async function stopDaemon() {
  const ownerFile = join(profile, "daemon-owner.json");
  try { await access(ownerFile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const owner = await discoverOwnedDaemon(profile, { timeoutMs: 1500 });
  console.log("GUI smoke：安全停止本次测试的后台…");
  if (lastOrigin) assert.equal(owner.origin, lastOrigin, "only the verified daemon started for this test may be stopped");
  const client = await localClient(owner.origin);
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
  await verifyAppearance(page, attachment.origin);
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
    systemAppearanceContrast: "passed", keyboardSkipNavigation: "passed", reducedMotion: "passed", mockTaskView: "passed",
    chromiumSandbox: noSandbox ? "disabled-for-linux-test" : "enabled", nativeWindowsAcceptance: false };
  await writeFile(join(outputDirectory, "desktop-gui-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputDirectory, ...report }));
} finally {
  try { await stopDaemon(); }
  finally { await closeWindow(); }
  await rm(root, { recursive: true, force: true });
}
