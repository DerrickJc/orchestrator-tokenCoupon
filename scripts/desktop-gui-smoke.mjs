// Real Electron GUI acceptance in an isolated profile. No Runner or paid model calls.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createClient } from "../packages/client/dist/index.js";
import { discoverOwnedDaemon, readDaemonOwnerCredential } from "../packages/client/dist/node.js";
import { directoryFootprint } from "./desktop-measurements.mjs";
import { prepareDesktopAcceptance } from "./prepare-desktop-acceptance.mjs";

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
const root = await mkdtemp(join(tmpdir(), ".token-coupon-desktop-gui-"));
// Exercise the actual preview-launcher setup with a Temp/build-side workspace,
// while credentials live in a separately protected user profile.
const acceptanceProfile = process.platform === "win32"
  ? await prepareDesktopAcceptance(executablePath, join(root, "Launch GUI Acceptance.cmd"), { instanceId: `gui-${randomUUID()}` }) : undefined;
const profile = acceptanceProfile?.daemon ?? join(root, "daemon"), desktopHome = acceptanceProfile?.desktop ?? join(root, "桌面 profile");
await mkdir(profile, { recursive: true, mode: 0o700 });
const noSandbox = process.argv.includes("--no-sandbox");
assert(!noSandbox || process.platform === "linux", "--no-sandbox is only a Linux CI test escape hatch");
const environment = { ...process.env, TOKEN_COUPON_DESKTOP_HOME: desktopHome };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
const pageErrors = [];
let lastOrigin;
let acceptanceFailure;
const startupSamples = [];

async function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function launch() {
  const started = performance.now();
  console.log("GUI smoke：启动隔离桌面窗口…");
  application = await electron.launch({ executablePath, chromiumSandbox: !noSandbox,
    args: ["--data-dir", profile, ...(noSandbox ? ["--no-sandbox"] : [])], env: environment, timeout: 60_000 });
  const page = await application.firstWindow({ timeout: 60_000 });
  const firstWindowMs = Math.round(performance.now() - started);
  console.log("GUI smoke：已取得窗口，等待页面与 preload…");
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.tokenCouponDesktop && /orchestrator-tokenCoupon|Token Coupon/.test(document.title));
  const attachment = await page.evaluate(() => window.tokenCouponDesktop.getAttachment());
  console.log("GUI smoke：本机 IPC 与后台身份已核实…");
  lastOrigin = attachment.origin;
  assert.equal(attachment.applicationVersion, manifest.applicationVersion);
  assert.equal(attachment.buildId, manifest.buildId);
  assert.equal(await bounded(application.evaluate(({ app }) => app.isPackaged), "inspect packaged startup"), true);
  assert.equal(await bounded(application.evaluate(({ app }) => app.getPath("userData")), "inspect desktop profile"), resolve(desktopHome));
  await page.waitForFunction(() => document.querySelector("#global-pending-open")?.disabled === false);
  startupSamples.push({ scenario: startupSamples.length === 0 ? "isolated-profile-first-start" : startupSamples.length === 1 ? "existing-daemon-reopen" : "stopped-daemon-restart",
    firstWindowMs, webControlsReadyMs: Math.round(performance.now() - started) });
  return { page, attachment };
}

async function measurements() {
  const footprint = { application: await directoryFootprint(dirname(executablePath)),
    runtime: await directoryFootprint(join(dirname(executablePath), "resources/token-coupon-runtime")),
    asarBytes: (await stat(join(dirname(executablePath), "resources/app.asar"))).size };
  await bounded(application.evaluate(({ app }) => app.getAppMetrics()), "prime Electron CPU sample");
  await new Promise(resolveSample => setTimeout(resolveSample, 2000));
  const electronProcesses = await bounded(application.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
    pid: metric.pid, type: metric.type, creationTime: metric.creationTime, workingSetKB: metric.memory.workingSetSize,
    cpuPercentSincePreviousSample: metric.cpu.percentCPUUsage,
  }))), "sample Electron resources");
  let daemonResidentMemory = { available: false, reason: "本平台尚未实现独立后台 OS 内存采样" };
  if (process.platform === "linux") {
    const credential = await readDaemonOwnerCredential(profile);
    const verified = await discoverOwnedDaemon(profile);
    assert.equal(verified.origin, lastOrigin);
    const status = await readFile(`/proc/${credential.owner.pid}/status`, "utf8");
    const residentKB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
    if (Number.isFinite(residentKB)) daemonResidentMemory = { available: true, residentKB };
  }
  return { format: 1, scope: "isolated-preview-mock-no-real-runner-or-tunnel", startupSamples, footprint,
    electronProcesses, sumElectronWorkingSetKB: electronProcesses.reduce((sum, metric) => sum + metric.workingSetKB, 0),
    cpuSampleIntervalMs: 2000, daemonResidentMemory,
    caveats: ["启动读数包含测试控制器和后台附着开销，不是清空 OS 缓存的冷启动基准。", "文件逻辑字节不是安装器压缩体积或文件系统实际分配。", "各进程工作集之和可能重复计算共享页；未作为独占物理内存。", "未采集模型、项目构建与隧道进程；缺失平台项明确为未知。"] };
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

async function verifyClipboard(page) {
  const text = `Token Coupon clipboard verification ${Date.now()}`;
  await bounded(application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const entries = await clipboard.read();
    // Electron 44 read() entries are read-only platform views. Snapshot every
    // payload before changing the clipboard, then construct writable entries.
    const snapshot = [];
    for (const entry of entries) {
      const payloads = {};
      for (const type of entry.types) payloads[type] = await entry.getType(type);
      snapshot.push(new ClipboardItem(payloads));
    }
    globalThis.__tokenCouponClipboardBeforeTest = snapshot;
  }), "save clipboard formats");
  try {
    await page.evaluate(value => {
      document.querySelector("#copy-fallback-text").value = value;
      document.querySelector("#copy-fallback-dialog").showModal();
    }, text);
    await page.click("#copy-fallback-copy");
    await page.waitForFunction(() => !document.querySelector("#copy-fallback-dialog").open);
    assert.equal(await bounded(application.evaluate(async ({ clipboard }, value) => (await clipboard.readText()) === value, text), "verify native clipboard"), true);
  } finally {
    await bounded(application.evaluate(async ({ clipboard }, value) => {
      if ((await clipboard.readText()) === value) {
        if (globalThis.__tokenCouponClipboardBeforeTest.length) await clipboard.write(globalThis.__tokenCouponClipboardBeforeTest);
        else clipboard.clear();
      }
      delete globalThis.__tokenCouponClipboardBeforeTest;
    }, text), "restore clipboard formats");
  }
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
  console.log("GUI smoke：检查全局待处理入口和失效请求定位…");
  const todo = await completed(await client.api(`/api/v1/workspaces/${workspace.workspaceId}/plannings`, { method: "POST",
    body: JSON.stringify({ requestKey: randomUUID(), request: "待审查的离线演示计划", provider: "mock", executionDefaults: { runnerId: "mock", mode: "managed" } }) }));
  await page.locator("#global-pending-open").click();
  await page.getByText("没有当前有效的 Runner 请求。", { exact: true }).waitFor();
  await page.locator("#global-pending-close").click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "global-pending-open");
  await page.locator("#global-pending-open").click();
  await page.locator("#global-pending-dialog .global-pending-item").filter({ hasText: "草案待审查" }).click();
  await page.waitForFunction(id => location.hash.endsWith(`/plans/${id}/review`), todo.planningId);
  await page.goto(`${origin}/#/workspaces/${workspace.workspaceId}/plans/${planned.planningId}/execution`);
  await page.waitForSelector("#task-list .task-row");
  // Deliberately stale read fixture: the UI must re-read the Plan rather than approve anything.
  const pendingRoute = "**/api/v1/pending?*";
  const currentHealth = await client.api("/api/v1/health");
  await page.route(pendingRoute, route => route.fulfill({ json: { epoch: currentHealth.epoch, total: 1, nextOffset: null, items: [{
    requestId: "stale-read-fixture", workspaceId: workspace.workspaceId, workspaceLabel: "失效请求定位测试", planningId: planned.planningId,
    taskId: "implement-request", runnerId: "mock", kind: "question", createdAt: new Date().toISOString(),
  }] } }));
  await page.locator("#global-pending-open").click();
  const pendingItem = page.locator(".global-pending-item").filter({ hasText: "失效请求定位测试" });
  await pendingItem.waitFor(); await pendingItem.click();
  await page.getByText("此请求已处理或失效，已打开所属计划的最新状态。", { exact: true }).waitFor();
  assert.equal(await page.locator("#global-pending-dialog").evaluate(element => element.open), false);
  await page.unroute(pendingRoute);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.waitForFunction(expected => matchMedia("(prefers-color-scheme: dark)").matches === (expected === "dark"), theme);
    // Electron may acknowledge the emulation before all documents' computed styles update.
    await page.waitForFunction(expected => getComputedStyle(document.documentElement).backgroundColor ===
      (expected === "dark" ? "rgb(21, 27, 22)" : "rgb(245, 246, 242)"), theme);
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
  return { workspaceId: workspace.workspaceId, planningId: todo.planningId };
}

async function verifyAgentComponents(page) {
  console.log("GUI smoke：检查可选组件状态与安装确认，不在界面测试中下载安装…");
  const route = "**/api/v1/agent-components", writes = [];
  const record = request => { if (request.method() === "POST" && request.url().includes("/agent-components/")) writes.push(request.url()); };
  page.on("request", record);
  const item = { id: "codex", label: "Codex · 安装确认测试", package: "@openai/codex", version: "0.163.0", docs: "https://developers.openai.com/codex/cli/", available: false, canInstall: true, installDirectory: join(root, "isolated-agent-fixture") };
  await page.route(route, request => request.fulfill({ json: [item] }));
  try {
    await page.locator("#agent-components-refresh").click();
    const row = page.locator("#agent-components-list .agent-component-row").filter({ hasText: item.label }); await row.waitFor();
    await row.getByRole("button", { name: "按需安装", exact: true }).click();
    await page.locator("#agent-component-dialog").waitFor({ state: "visible" });
    assert(await page.locator("#agent-component-install-confirm").isDisabled());
    assert((await page.locator("#agent-component-install-details").textContent()).includes("@openai/codex"));
    await page.locator("#agent-component-consent").check(); assert(await page.locator("#agent-component-install-confirm").isEnabled());
    await page.locator("#agent-component-install-close").click();
    assert.deepEqual(writes, [], "viewing or cancelling confirmation must not install an Agent");
  } finally { await page.unroute(route); page.off("request", record); }
  await page.locator("#agent-components-refresh").click();
}

async function verifySecondInstance(attachment) {
  console.log("GUI smoke：检查相同/不同后台目录的第二次启动…");
  await application.evaluate(({ dialog }) => {
    globalThis.testOriginalMessageBox = dialog.showMessageBox;
    globalThis.testProfileDialogs = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.testProfileDialogs.push(args.at(-1));
      return { response: 0, checkboxChecked: false };
    };
  });
  async function second(directory) {
    const child = spawn(executablePath, ["--data-dir", directory, ...(noSandbox ? ["--no-sandbox"] : [])], { env: environment, stdio: "ignore" });
    try {
      const code = await bounded(new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); }), "second desktop instance", 20_000);
      assert.equal(code, 0);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }
  try {
    await second(profile);
    assert.equal(await application.evaluate(() => globalThis.testProfileDialogs.length), 0);
    const otherProfile = join(root, "另一个后台目录");
    await second(otherProfile);
    const deadline = Date.now() + 20_000;
    while (!(await application.evaluate(() => globalThis.testProfileDialogs.length)) && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    const [message] = await application.evaluate(() => globalThis.testProfileDialogs);
    assert.equal(message.title, "后台目录未切换");
    assert(message.detail.includes(profile) && message.detail.includes(otherProfile));
    await assert.rejects(access(join(otherProfile, "daemon-owner.json")), { code: "ENOENT" });
    assert.equal((await discoverOwnedDaemon(profile)).epoch, attachment.epoch);
  } finally {
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.testOriginalMessageBox; delete globalThis.testOriginalMessageBox; delete globalThis.testProfileDialogs; });
  }
}

async function verifyLiveReconnect(page, attachment, plan) {
  console.log("GUI smoke：保留窗口，模拟后台崩溃并恢复未提交输入…");
  const route = `#/workspaces/${plan.workspaceId}/plans/${plan.planningId}/draft`;
  await page.goto(`${attachment.origin}/${route}`);
  await page.locator("#toggle-plan-edit").click();
  const title = page.locator("#plan-text-editor input").first();
  const unsentTitle = "重连保留的未提交标题";
  await title.fill(unsentTitle);
  await page.evaluate(() => {
    for (const [id, value] of [["request-text", "尚未发送的新需求"], ["reply-text", "尚未发送的澄清"]]) {
      const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const path = `/api/v1/workspaces/${plan.workspaceId}/plannings/${plan.planningId}`;
  const before = await (await localClient(attachment.origin)).api(path);
  const verified = await discoverOwnedDaemon(profile), credential = await readDaemonOwnerCredential(profile);
  assert.equal(verified.epoch, attachment.epoch);
  const writes = [];
  const record = request => { if (request.url().includes("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); };
  page.on("request", record);
  process.kill(credential.owner.pid, "SIGKILL");
  try {
    await page.locator("#desktop-connection-banner").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("#desktop-reconnect").click();
    const deadline = Date.now() + 60_000;
    let recovered = false;
    while (Date.now() < deadline) {
      try {
        const current = await discoverOwnedDaemon(profile, { timeoutMs: 1000 });
        if (current.epoch !== attachment.epoch && new URL(page.url()).origin === current.origin) { lastOrigin = current.origin; recovered = true; break; }
      } catch { /* A killed owner remains stale until the managed restart claims the profile. */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert(recovered, "live authenticated daemon and page recovery timed out");
    await page.waitForFunction(expected => document.querySelector("#plan-text-editor input")?.value === expected, unsentTitle, { timeout: 60_000 });
    assert.equal(await page.locator("#request-text").inputValue(), "尚未发送的新需求");
    assert.equal(await page.locator("#reply-text").inputValue(), "尚未发送的澄清");
    const found = await page.evaluate(() => window.tokenCouponDesktop.getAttachment());
    lastOrigin = found.origin;
    assert.notEqual(found.epoch, attachment.epoch);
    assert.equal(found.profileId, attachment.profileId);
    assert.equal(new URL(page.url()).origin, found.origin);
    assert.equal(new URL(page.url()).hash, route);
    await page.waitForFunction(() => document.querySelector("#desktop-connection-message").textContent.includes("已恢复"));
    assert.equal(await page.evaluate(() => window.tokenCouponDesktop.getRecoveryState()), undefined, "acknowledged drafts must leave no recovery buffer in main");
    const after = await (await localClient(found.origin)).api(path);
    assert.deepEqual(after.draft, before.draft, "unsaved changes must not be committed by reconnect");
    assert.equal(after.execution, before.execution);
    assert.deepEqual(writes, [], "reconnect must not replay any business POST");
    await page.screenshot({ path: join(outputDirectory, "desktop-reconnected-drafts.png"), fullPage: false });
    // Discard the test edit explicitly so the following normal quit does not hit the unsaved-edit guard.
    await page.locator("#toggle-plan-edit").click();
    await page.locator("#unsaved-plan-discard").click();
    return found;
  } catch (error) {
    await page.screenshot({ path: join(outputDirectory, "desktop-reconnect-failed.png"), fullPage: false }).catch(() => {});
    console.error("Reconnect diagnostic:", await page.evaluate(async () => ({ url: location.href, connection: await window.tokenCouponDesktop.getConnectionState(), attachment: await window.tokenCouponDesktop.getAttachment(), banner: document.querySelector("#desktop-connection-banner")?.textContent, text: document.body.innerText.slice(-3000) })).catch(() => "renderer unavailable"));
    console.error("Test daemon log:", await readFile(join(desktopHome, "logs", "daemon.log"), "utf8").then(value => value.slice(-5000)).catch(() => "log unavailable"));
    throw error;
  } finally { page.off("request", record); }
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
  await verifyAgentComponents(page);
  await verifyClipboard(page);
  const todo = await verifyAppearance(page, attachment.origin);
  await verifySecondInstance(attachment);
  attachment = await verifyLiveReconnect(page, attachment, todo);
  const firstEpoch = attachment.epoch;
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
  const resourceMeasurements = await measurements();
  await writeFile(join(outputDirectory, "desktop-measurements.json"), `${JSON.stringify(resourceMeasurements, null, 2)}\n`);
  const report = { platform: process.platform, privateAcceptanceProfile: acceptanceProfile ? "verified-outside-temp" : "posix-profile", electronVersion: await application.evaluate(() => process.versions.electron),
    buildId: manifest.buildId, packagedStartup: "passed", restrictedPreload: "passed", childFrameIsolation: "passed", popupDenied: "passed",
    notificationPreferencePersistence: "passed", nativeClipboardCopy: "passed", detachedDaemonReuse: "passed", safeStopAndRestart: "passed",
    liveDaemonReconnect: "passed", draftRecoveryNoReplay: "passed", secondInstanceProfileGuard: "passed",
    optionalAgentConsentNoImplicitInstall: "passed",
    systemAppearanceContrast: "passed", keyboardSkipNavigation: "passed", reducedMotion: "passed", mockTaskView: "passed", globalPendingEmptyAndStaleRead: "passed", planningTodoNavigation: "passed",
    chromiumSandbox: noSandbox ? "disabled-for-linux-test" : "enabled", nativeWindowsAcceptance: false };
  await writeFile(join(outputDirectory, "desktop-gui-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputDirectory, ...report }));
} catch (error) {
  acceptanceFailure = error;
  throw error;
} finally {
  try { await stopDaemon().catch(error => { if (acceptanceFailure) console.error("Cleanup after failed acceptance:", error.message); else throw error; }); }
  finally { await closeWindow(); }
  await rm(root, { recursive: true, force: true });
  if (acceptanceProfile) await rm(acceptanceProfile.root, { recursive: true, force: true });
}
