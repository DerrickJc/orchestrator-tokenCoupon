const $ = (selector) => document.querySelector(selector);
$("#skip-main")?.addEventListener("click", () => $("#main-content")?.focus());
const tokenCouponClient = globalThis.tokenCouponClient;
if (typeof tokenCouponClient?.api !== "function" || typeof tokenCouponClient?.openEventStream !== "function") throw new Error("web_client_not_loaded：请先加载本机 HTTP/SSE 客户端模块");
const { api, openEventStream } = tokenCouponClient;
function bindTextareaEnterSubmit(textarea, submit) {
  if (!textarea || textarea.dataset.enterSubmitBound) return;
  textarea.dataset.enterSubmitBound = "true";
  let composing = false;
  let recentCompositionEnd = 0;
  textarea.addEventListener("compositionstart", () => { composing = true; });
  textarea.addEventListener("compositionend", () => { composing = false; recentCompositionEnd = performance.now(); });
  textarea.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (composing || event.isComposing || event.keyCode === 229 || event.which === 229) return;
    event.preventDefault();
    if (event.repeat || (recentCompositionEnd && performance.now() - recentCompositionEnd < 120) || textarea.disabled || textarea.readOnly) return;
    if (textarea.form?.querySelector('button[type="submit"]:disabled')) return;
    submit();
  });
}
const state = { workspaces: [], workspace: null, plannings: [], planning: null, providers: [], runners: [], environment: null, activeJob: null, eventSource: null, lastEventId: 0, reconnectAttempts: 0, reconnectTimer: null, savedPlanText: "", editedPlanHash: "", toastTimer: null, budgetOperationId: null, remotePoll: null, remoteMutation: false, remoteFetching: false, remoteRefreshPending: false, remoteStatus: null, remoteApprovalsSignature: "", seenAuthorizationRequests: new Set(), authorizationCountdown: null, desktopNotificationsEnabled: false, modelChoiceSelections: { planner: "", runner: "", reviewer: "" } };
const statuses = { collecting: "收集中", draft_ready: "草案待处理", approved: "已批准", execution_created: "执行已创建", succeeded: "已完成", failed: "失败", cancelled: "已取消", running: "运行中", paused: "已暂停", blocked: "等待处理", interrupted: "已中断", ready: "准备就绪", planned: "待执行", timed_out: "超时" };
statuses.needs_input = "等待用户决策";
const diagnosticStatuses = { running: "分析中", completed: "分析完成", failed: "分析失败", interrupted: "分析中断" };
function configureGlobalPending() {
  globalThis.tokenCouponGlobalPending?.configure({ epoch: state.daemonEpoch || "", supported: !!state.pendingQueueSupported, planningSupported: !!state.planningTodosSupported,
    authorizations: state.pendingRemoteApprovals?.filter(item => new Date(item.expiresAt).getTime() > Date.now()).map(item => ({ requestId: item.requestId, label: item.clientName || "未命名网页客户端" })) || [],
    authorizationFresh: state.authorizationsFresh === true });
}
async function openGlobalPendingPlan(item, tab) {
  const navigation = state.navigationSequence;
  try {
    const workspaces = await api("/api/v1/workspaces");
    if (navigation !== state.navigationSequence) return;
    state.workspaces = workspaces; renderWorkspaces();
    if (state.workspace?.workspaceId === item.workspaceId && !state.plannings.some(plan => plan.planningId === item.planningId)) {
      const latest = await api(`/api/v1/workspaces/${encodeURIComponent(item.workspaceId)}/plannings/${encodeURIComponent(item.planningId)}`);
      if (navigation !== state.navigationSequence) return false;
      state.plannings.push(latest);
    }
    const samePlan = state.planning?.planningId === item.planningId;
    await navigate(`/workspaces/${encodeURIComponent(item.workspaceId)}/plans/${encodeURIComponent(item.planningId)}/${tab}`);
    if (samePlan && state.route?.planningId === item.planningId) await loadPlanning(item.planningId);
  } catch (error) { showToast(error.message, true); return false; }
  return state.planning?.planningId === item.planningId && state.route?.tab === tab;
}
window.addEventListener("token-coupon:planning-todo-open", event => { void openGlobalPendingPlan(event.detail, event.detail.tab); });
window.addEventListener("token-coupon:pending-open", async event => {
  const item = event.detail;
  if (!await openGlobalPendingPlan(item, "execution")) return;
  const target = [...$("#interaction-list").querySelectorAll("[data-request-id]")].find(card => card.dataset.requestId === item.requestId);
  if (!target) { showToast("此请求已处理或失效，已打开所属计划的最新状态。"); void globalThis.tokenCouponGlobalPending?.refresh(); return; }
  target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center" });
});
window.addEventListener("token-coupon:authorization-open", event => { void openAuthorizationRequest(event.detail); });
const isWebMcp = value => ["chatgpt-mcp", "web-mcp", "claude-mcp"].includes(value);
const labels = { codex: "Codex", "claude-code": "Claude Code", dsh: "DeepSeek Harness (dsh)", mock: "离线模拟" };
Object.assign(state, { editingPlan: false, editBase: null, savingPlan: false, replying: false, unsavedDecision: null });
Object.assign(state, { confirmActionResolve: null });
Object.assign(state, { directorySelections: new Set(), referenceFiles: [] });
statuses.unavailable = "状态待核验"; statuses.pausing = "正在暂停"; statuses.created = "正在启动";

function pendingWebTokenExchange(remote) {
  return !!remote?.validGrants && remote.pendingTokenExchanges === remote.validGrants;
}
function grantMcpName(grant) {
  const alias = (grant.alias || "").trim(), client = (grant.clientName || "").trim();
  // OAuth clients often send the application name, not the user's connector name.
  const generic = /^(chatgpt|claude|claude\.ai|未命名网页客户端|网页客户端)(?:[\s_-]*(?:mcp|web|client|connector))?$/i.test(client);
  return alias || (generic ? "" : client);
}
// A selection here identifies a local OAuth grant. It cannot select an app in a webpage.
function promptClients() {
  return (state.remoteStatus?.clients || []).filter(client => client.status === "active" && client.usage !== "diagnostic");
}
function selectedPromptClient() {
  return promptClients().find(client => client.grantId === state.promptGrantId);
}
function verifiedPromptClients(workspaceId = state.workspace?.workspaceId) {
  return promptClients().filter(client => client.toolVerified && (!workspaceId || client.workspaceIds?.includes(workspaceId)));
}
function webpageSelectionHeader(workspaceId, target) {
  const client = selectedPromptClient();
  if (client && workspaceId && !client.workspaceIds?.includes(workspaceId)) throw new Error("所选网页连接未授权本项目，请在连接中心选择匹配的连接，或先编辑该连接的工作区授权。");
  if (client && target && target !== "any" && client.source !== target) throw new Error("所选网页连接来源与本次交接不一致，请在连接中心选择对应的 ChatGPT／Claude 连接；已准备的操作会保留。任何名称备注都不会替代网页中的实际选择。");
  const address = client?.mcpUrl || state.remoteStatus?.mcpUrl;
  const alias = client?.alias;
  return [(client?.source || target) === "claude" ? "发送前：在 Claude 当前聊天启用并选择下面的 MCP 连接，再发送。" : "发送前：ChatGPT 请在网页输入 @，从列表实际选择本连接再发送；Claude 请在当前聊天启用对应 MCP。仅粘贴名称不会切换工具。",
    alias ? `网页连接名称（用户填写，请与网页设置核对）：${JSON.stringify(alias)}` : "网页连接名称尚未填写，请核对当前聊天实际选中的连接；不要沿用旧聊天的工具。",
    ...(address ? [`MCP 地址：${address}`] : []),
    ...(client ? [`客户端短标识：${client.clientFingerprint || shortId(client.clientId)}；本机备注不代表网页认证身份。`] : []),
    "若工具回执的地址或连接与上述信息不符，请停止并说明，不自动重建连接或新建 Planning。"].join("\n");
}
function renderConnectionIdentity() {
  const select = $("#connection-prompt-client"); if (!select) return;
  const clients = promptClients();
  // A disappeared selection must not silently switch to another client's grant.
  if (state.promptGrantId && !clients.some(client => client.grantId === state.promptGrantId)) state.promptGrantId = "";
  if (state.promptGrantId === undefined && clients.length === 1) state.promptGrantId = clients[0].grantId;
  const signature = JSON.stringify([clients.map(client => [client.grantId, client.alias, client.clientName, client.workspaceIds, client.source]), state.workspaces.map(item => [item.workspaceId, item.label])]);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(new Option("请选择网页连接；名称未知可先核对地址", ""));
    for (const client of clients) {
      const projects = (client.workspaceIds || []).map(id => state.workspaces.find(item => item.workspaceId === id)?.label || id).join("、");
      select.append(new Option(`${client.alias || "名称待填写"} · ${{ chatgpt: "ChatGPT", claude: "Claude" }[client.source] || "网页"} · ${client.clientFingerprint || shortId(client.clientId)} · ${projects}`, client.grantId));
    }
    select.dataset.signature = signature;
  }
  select.value = state.promptGrantId || "";
  const client = selectedPromptClient(), summary = $("#connection-identity-status");
  const recentFailure = client?.lastCall?.outcome === "error" ? `最近调用失败：${client.lastCall.code || "待诊断"}，请展开调用详情核对追踪 ID。` : "";
  summary.textContent = state.remoteUnavailable || state.authorizationsFresh === false ? "连接信息暂不可用，显示的上次记录不能证明当前可用。" : !client ? "请选择要核对的网页连接；同一地址下的各客户端授权与验证独立。名称可在授权记录中填写。" : `${client.alias ? `用户填写名称：${client.alias}` : "网页名称未知，可在授权记录中填写"} · ${state.remoteStatus?.transport === "ready" ? "公网入口可用" : "公网入口尚未就绪"} · ${client.oauthState === "awaiting_token" ? "本机已批准，等待网页完成 OAuth" : "OAuth 已完成"} · ${client.toolVerified ? `本客户端调用成功：${new Date(client.lastSuccess?.at).toLocaleString()}` : "尚未收到此连接在当前授权范围内的成功工具调用，请核对网页所选连接及地址"}。${recentFailure}`;
}
function renderGrantOAuthState(card, grant) {
  const hint = card.querySelector(".grant-oauth-state"); if (!hint) return;
  hint.textContent = grant.oauthState === "awaiting_token" ? "网页待完成连接" : "网页授权有效";
  hint.className = `grant-oauth-state badge ${grant.oauthState === "awaiting_token" ? "badge-warning" : "badge-success"}`;
}
function renderAuthorizationOverview() {
  const grants = state.grants || [], remote = state.remoteStatus || {}, ready = grants.filter(grant => grant.oauthState !== "awaiting_token");
  const root = $("#remote-authorization-status");
  $("#remote-grant-count").textContent = `${ready.length} 个已授权 · ${grants.length - ready.length} 个待完成`;
  const related = (remote.recentCalls || []).filter(item => ["oauth", "authentication"].includes(item.stage) && grants.some(grant => item.grantId === grant.grantId || item.clientId && item.clientId === grant.clientId)).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const failed = related?.outcome === "error";
  const unknown = state.remoteUnavailable || state.authorizationsFresh === false;
  const sources = [...new Set(ready.map(grant => ({ chatgpt: "ChatGPT", claude: "Claude", other: "其他网页" })[grant.source] || grant.clientName || "网页"))].join("、");
  root.textContent = unknown ? "连接状态暂不可用，请刷新状态后确认。" : failed ? `${ready.length ? "已有网页授权可用；" : ""}最近一次网页授权失败（${related.code || "令牌交换未完成"}）。请在原网页重新连接，详情见连接诊断。` : ready.length ? verifiedPromptClients(null).length ? `网页已连通 · ${verifiedPromptClients(null).length} 个客户端已有成功调用，其余需分别验证；授权来源：${sources}。` : `${sources} 授权成功 · 等待首次工具调用验证。` : grants.length ? "本机权限已保存，等待网页完成连接。请回到发起授权的网页；若连接报错，展开连接诊断查看原因。" : "尚无网页授权，请在 ChatGPT／Claude 发起连接。";
  root.className = `notice ${unknown || failed || !ready.length ? "notice-warn" : "notice-success"}`;
  let names = $("#remote-mcp-names");
  if (!names) { names = document.createElement("p"); names.id = "remote-mcp-names"; names.className = "hint"; root.after(names); }
  const known = [...grants].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  names.textContent = known.length ? `MCP 名称：${known.slice(0, 3).map(grant => grantMcpName(grant) || "待设置名称").join("、")}${known.length > 3 ? ` 等 ${known.length} 条授权` : ""}。可在授权卡片上设置与网页一致的名称。` : "MCP 名称：尚无授权连接。";
}
function key() { return crypto.randomUUID(); }
function showToast(message, isError = false, source = "general") {
  const el = $("#toast"); $("#toast-message").textContent = message; clearTimeout(state.toastTimer);
  if (isError && source === "general" && /^(请选择|请先|请填写|先写下|自定义修订说明不能为空|当前已有操作|草案正在保存)/.test(String(message))) {
    showActionFeedback("请补全本次操作", `${message} 此操作尚未提交，不影响已在执行的任务。`, "validation"); return;
  }
  if (isError) {
    let text = String(message);
    if (/not a git repository/i.test(text)) text = "此文件夹还不是 Git 仓库。请在执行页初始化 Git，或改用共享工作区串行执行。";
    if (/Needed a single revision/i.test(text)) text = "Git 已初始化，但尚无首次提交。请创建首次提交后再使用 worktree 隔离。";
    $("#page-error").dataset.errorSource = source;
    $("#page-error").dataset.context = source === "remote-connection" ? "global" : `${state.workspace?.workspaceId || ""}:${state.planning?.planningId || ""}`;
    $("#page-error strong").textContent = source === "remote-connection" ? "公网连接暂不可用" : source === "execution" ? "任务操作未完成" : "本次操作未完成";
    $("#page-error-message").textContent = text; show($("#page-error")); show(el, false); return;
  }
  el.classList.remove("error"); show(el); state.toastTimer = setTimeout(() => show(el, false), 9000);
}
function askConfirm(title, description, confirmLabel = "确认", destructive = false) {
  const dialog = $("#confirm-action-dialog");
  if (dialog.open || state.confirmActionResolve) return Promise.resolve(false);
  $("#confirm-action-title").textContent = title; $("#confirm-action-description").textContent = description;
  const confirm = $("#confirm-action-yes"); confirm.textContent = confirmLabel; confirm.className = `button ${destructive ? "button-danger" : "button-primary"}`;
  dialog.showModal();
  return new Promise(resolve => { state.confirmActionResolve = resolve; });
}
function settleConfirmAction(value) { const resolve = state.confirmActionResolve; state.confirmActionResolve = null; if ($("#confirm-action-dialog").open) $("#confirm-action-dialog").close(); resolve?.(value); }
function showCopyFallback(title, value) {
  $("#copy-fallback-description").textContent = "无法直接访问系统剪贴板。请复制下方文本。";
  $("#copy-fallback-description").className = "hint";
  $("#copy-fallback-title").textContent = title; $("#copy-fallback-text").value = value; $("#copy-fallback-dialog").showModal();
  $("#copy-fallback-text").focus(); $("#copy-fallback-text").select();
}
function showActionFeedback(title, text, kind = "info") {
  const root = $("#action-feedback"); root.dataset.kind = kind; $("#action-feedback-title").textContent = title; $("#action-feedback-text").textContent = text; show(root);
}
function clearInputFeedback() { if ($("#action-feedback").dataset.kind === "validation") show($("#action-feedback"), false); }
function setConnectionTab(tab) {
  state.connectionTab = tab;
  show($("#connection-transport-panel"), tab === "transport"); show($("#authorization-panel"), tab === "authorization");
  $("#authorization-current-url").textContent = state.remoteStatus?.mcpUrl || "请先在“连接”中建立可用入口";
  $("#authorization-copy-url").disabled = !state.remoteStatus?.mcpUrl;
  const active = state.remoteStatus?.enabled && state.remoteStatus?.gateway === "running" && !!state.remoteStatus?.publicOrigin;
  show($("#connection-next"), tab === "authorization" || !active || state.connectionMode === "new");
  for (const button of document.querySelectorAll("[data-connection-tab]")) { const selected = button.dataset.connectionTab === tab; button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected)); }
}
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function shortId(value) { return value ? `${value.slice(0, 8)}…` : ""; }
function show(el, visible = true) { el.classList.toggle("hidden", !visible); }
async function copyText(text) {
  if (window.tokenCouponDesktop?.copyText) {
    try { await window.tokenCouponDesktop.copyText(text); return; } catch { /* Try browser copying if the desktop bridge is temporarily unavailable. */ }
  }
  try { await navigator.clipboard.writeText(text); return; } catch { /* Older browsers may still allow a user-triggered copy command. */ }
  const previous = document.activeElement, field = document.createElement("textarea");
  field.value = text; field.setAttribute("aria-hidden", "true"); field.style.cssText = "position:fixed;left:-10000px;top:0"; document.body.append(field);
  try {
    field.focus(); field.select();
    if (!document.execCommand?.("copy")) throw new Error("clipboard_unavailable");
  } finally { field.remove(); previous?.focus?.({ preventScroll: true }); }
}
function commandPaletteEntries() {
  const entries = [
    { label: "连接中心", hint: "连接与网页授权", run: () => navigate("/connect") },
    { label: "工作区与计划", hint: "选择或新建工作区", run: () => navigate("/workspaces") },
    { label: "系统设置", hint: "规划、审查、修订与诊断默认方式", run: () => navigate("/settings") },
    { label: "刷新状态", hint: "重新读取当前工作区和计划", run: () => manualRefresh() },
  ];
  if (state.workspace) entries.push({ label: `新建计划 · ${state.workspace.label}`, hint: "打开规划设置，不会立即提交", run: () => startNewTask() });
  if (state.workspace && state.planning) {
    const title = state.planning.draft?.plan?.title || state.planning.title || "当前计划";
    entries.push(
      { label: `${title} · 概览`, hint: "查看计划状态和下一步", run: () => planTab("overview") },
      { label: `${title} · 草案`, hint: "查看或编辑当前计划", run: () => planTab("draft") },
      { label: `${title} · 审查与修订`, hint: "审查、修订或核对报告", run: () => planTab("review") },
      { label: `${title} · 执行与结果`, hint: "查看任务、DAG 和执行状态", run: () => planTab("execution") },
    );
    if (state.planning.interactions?.length) entries.push({ label: `处理待审批与回答 · ${state.planning.interactions.length} 项`, hint: title, run: async () => { await planTab("execution"); if (state.route?.tab === "execution") requestAnimationFrame(() => $("#pending-approval-box").scrollIntoView({ block: "start", behavior: "smooth" })); } });
    const runtimeTasks = state.planning.session?.tasks || [];
    for (const item of state.planning.draft?.plan?.tasks || []) {
      const task = item.task, runtime = runtimeTasks.find(candidate => candidate.taskId === task.id);
      const execution = runtime?.currentAttempt?.execution || runtime?.execution || task.execution || {};
      const status = statuses[runtime?.status] || runtime?.status || "待执行";
      entries.push({
        label: `任务 ${task.id} · ${task.title || task.id}`,
        hint: `${status} · ${execution.runnerId || "Runner 未设置"} / ${runtime?.currentAttempt?.reportedModel || execution.modelId || "默认模型"}`,
        run: async () => { await planTab("execution"); if (state.route?.tab === "execution") showDagTaskDetails(task.id); },
      });
    }
  }
  return entries;
}
function renderCommandPalette() {
  const ensureFallback = ensureCommandPaletteFallback();
  if (!ensureFallback) return;
  const query = $("#command-palette-query").value.trim().toLocaleLowerCase();
  const entries = commandPaletteEntries().filter(entry => `${entry.label} ${entry.hint}`.toLocaleLowerCase().includes(query));
  state.commandPaletteEntries = entries; state.commandPaletteIndex = Math.min(state.commandPaletteIndex || 0, Math.max(0, entries.length - 1));
  const root = $("#command-palette-results"); root.replaceChildren();
  if (!entries.length) { const empty = document.createElement("p"); empty.className = "command-palette-empty"; empty.textContent = "没有匹配的页面或操作。"; root.append(empty); return; }
  entries.forEach((entry, index) => {
    const button = document.createElement("button"); button.type = "button"; button.id = `command-palette-option-${index}`; button.className = "command-palette-option"; button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === state.commandPaletteIndex));
    const label = document.createElement("span"), hint = document.createElement("small"); label.textContent = entry.label; hint.textContent = entry.hint; button.append(label, hint);
    button.addEventListener("click", () => { $("#command-palette").close(); void runCommandPaletteEntry(entry); }); root.append(button);
  });
}
function moveCommandPaletteSelection(delta) {
  const entries = state.commandPaletteEntries || [];
  if (!entries.length) return;
  state.commandPaletteIndex = (state.commandPaletteIndex + delta + entries.length) % entries.length;
  renderCommandPalette();
  $(`#command-palette-option-${state.commandPaletteIndex}`)?.scrollIntoView?.({ block: "nearest" });
}
async function runCommandPaletteEntry(entry) {
  try { await entry.run(); } catch (error) { showToast(error.message, true); }
}
function ensureCommandPaletteFallback() {
  const root = $("#command-palette-root");
  if (!root || globalThis.tokenCouponCommandPalette) return !!root && !globalThis.tokenCouponCommandPalette;
  if (!root.childElementCount) root.append($("#command-palette-fallback").content.cloneNode(true));
  if (root.dataset.fallbackBound) return true;
  root.dataset.fallbackBound = "true";
  const dialog = $("#command-palette");
  $("#command-palette-close").addEventListener("click", () => dialog.close());
  $("#command-palette-query").addEventListener("input", () => { state.commandPaletteIndex = 0; renderCommandPalette(); });
  $("#command-palette-query").addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveCommandPaletteSelection(event.key === "ArrowDown" ? 1 : -1); return; }
    if (event.key === "Enter") {
      const entry = state.commandPaletteEntries?.[state.commandPaletteIndex];
      if (entry) { event.preventDefault(); dialog.close(); void runCommandPaletteEntry(entry); }
    }
  });
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  return true;
}
function openCommandPalette() {
  const dialog = $("#command-palette");
  if ([...document.querySelectorAll("dialog[open]")].some(open => open !== dialog)) return;
  if (globalThis.tokenCouponCommandPalette) {
    globalThis.tokenCouponCommandPalette.open(commandPaletteEntries(), entry => { void runCommandPaletteEntry(entry); });
    return;
  }
  ensureCommandPaletteFallback();
  state.commandPaletteIndex = 0; $("#command-palette-query").value = ""; renderCommandPalette(); dialog.showModal(); $("#command-palette-query").focus();
}
$("#command-palette-open").addEventListener("click", openCommandPalette);
window.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "k") return;
  if ([...document.querySelectorAll("dialog[open]")].length) return;
  event.preventDefault(); openCommandPalette();
});
window.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
  if (!state.editingPlan || state.savingPlan || [...document.querySelectorAll("dialog[open]")].length) return;
  event.preventDefault();
  if (planHasChanges()) void savePlanEditor();
});

const remoteScopeLabels = {
  "repository:read": "读取项目文件（只读调研）",
  "planning:read": "查看草案、审查与规划状态",
  "planning:write": "提交规划/审查结果（不能批准草案）",
  "session:read": "查看 Session、任务状态与交付证据",
  "session:control": "运行、暂停、恢复或重试已批准计划",
};
async function refreshRemoteConnection(rethrow = false) {
  if (state.remoteFetching) {
    if (!rethrow) { state.remoteRefreshPending = true; return; }
    const until = Date.now() + 15000;
    while (state.remoteFetching && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    if (state.remoteFetching) throw new Error("连接刷新超时，请重试");
  }
  state.remoteFetching = true;
  try {
    const status = await api("/api/v1/remote-connection", { signal: AbortSignal.timeout(12000) });
    state.remoteStatus = status;
    const quickUnavailable = status.quickTunnel?.available === false;
    const quickReason = status.quickTunnel?.reason || "当前后台暂不支持快捷连接。可使用本机 Agent 或已有固定 HTTPS 网关。";
    const blockedQuick = quickUnavailable && status.mode !== "fixed_https";
    $("#remote-platform-support").textContent = quickReason;
    show($("#remote-platform-support"), quickUnavailable);
    const badge = $("#remote-status");
    const phases = { stopped: "未连接", checking: "检查组件", downloading: "下载组件", verifying: "校验组件", starting: "启动网关", discovering: "建立隧道", probing: "测试公网连接", reconnecting: "正在重试", ready: "公网入口可用", disconnected: "连接已中断", error: "连接失败" };
    badge.textContent = status.transport === "ready" ? status.validGrants ? pendingWebTokenExchange(status) ? "公网可用 · 网页待完成连接" : "公网可用 · 网页授权有效" : "公网可用 · 网页待授权" : phases[status.transport] || "未连接";
    badge.className = `badge ${status.transport === "ready" ? "badge-success" : ["error", "disconnected"].includes(status.transport) ? "badge-error" : "badge-neutral"}`;
    if (status.publicOrigin !== state.displayedRemoteOrigin) {
      if (status.publicOrigin && document.activeElement !== $("#remote-origin")) $("#remote-origin").value = status.publicOrigin;
      state.displayedRemoteOrigin = status.publicOrigin;
    }
    if (status.gatewayAddress !== state.displayedGatewayAddress) {
      if (status.gatewayAddress && document.activeElement !== $("#remote-port")) $("#remote-port").value = new URL(status.gatewayAddress).port;
      state.displayedGatewayAddress = status.gatewayAddress;
    }
    const project = $("#quick-workspace"), selected = project.value || "";
    const workspaceSignature = JSON.stringify(state.workspaces.map(({ workspaceId, label }) => [workspaceId, label]));
    if (workspaceSignature !== state.remoteWorkspaceSignature) {
      project.replaceChildren(new Option("仅建立连接，稍后选择项目", ""));
      for (const workspace of state.workspaces) project.add(new Option(workspace.label, workspace.workspaceId));
      state.remoteWorkspaceSignature = workspaceSignature;
    }
    if (state.workspaces.some((workspace) => workspace.workspaceId === selected)) project.value = selected;
    if (status.scopes && !state.remoteScopesInitialized) {
      $("#quick-repository").checked = status.scopes.includes("repository:read");
      $("#quick-session-read").checked = status.scopes.includes("session:read");
      $("#quick-session-control").checked = false;
      state.remoteScopesInitialized = true;
    }
    $("#remote-address").textContent = `${status.mode === "quick_tunnel" ? "快捷隧道" : "固定 HTTPS"} · 本机网关 ${status.gatewayAddress || "http://127.0.0.1:4178"} · ${status.pendingApprovals} 个待授权 · ${status.validGrants} 个有效授权`;
    const check = status.probeCheck;
    $("#remote-progress").textContent = state.pendingRemoteApprovals?.length ? `已收到 ${state.pendingRemoteApprovals.length} 个网页 OAuth 请求，请在下方核对客户端、项目和权限后决定。` : check && ["checking", "retrying"].includes(check.state) ? `${check.background ? "后台检查，当前入口保持可用" : "正在验证当前入口"} · 第 ${check.attempt}/${check.maxAttempts} 次${check.state === "retrying" ? `；将自动重试，无需重复点击。${check.lastError || ""}` : ""}` : status.addressChanged && !status.validGrants ? "地址已变化，原网页授权不适用；请复制新地址，到 ChatGPT／Claude 更新连接并重新授权。" : status.transport === "ready" ? status.validGrants ? pendingWebTokenExchange(status) ? "公网自检通过；本机已批准，网页尚未成功换取访问令牌。请完成原网页的 OAuth 连接，失败详情见连接记录。" : "公网自检通过；网页授权有效。实际工具调用结果见客户端卡片。" : "公网自检通过；尚无有效网页授权，复用入口不会自动连接 GPT。" : status.busy ? `${phases[status.transport]}，可点击停止取消。` : "建立公网入口后，还需在对应网页完成项目授权。";
    if (status.startupReadiness && status.transport !== "ready") {
      const remaining = Math.max(0, Math.ceil((status.startupReadiness.deadlineAt - Date.now()) / 1000));
      badge.textContent = "新地址就绪检查中";
      $("#remote-progress").textContent = `已取得新地址，正在校验 DNS、Cloudflare 路由和 MCP · 第 ${status.startupReadiness.round} 轮 · 最多再等待 ${remaining} 秒。通过校验前入口不可用；可停止取消，无需重复新建连接。${check?.lastError ? ` 最近诊断：${check.lastError}` : ""}`;
    } else if (status.transport === "error" && status.nextProbeAt) {
      $("#remote-progress").textContent = `当前校验未通过，约 ${Math.max(0, Math.ceil((status.nextProbeAt - Date.now()) / 1000))} 秒后自动复检；保留当前地址，也可手动重测。`;
    }
    show($("#remote-url-wrap"), Boolean(status.mcpUrl)); show($("#remote-setup"), Boolean(status.mcpUrl));
    $("#remote-mcp-url").value = status.mcpUrl || "";
    if (blockedQuick) { badge.textContent = "快捷连接暂不支持"; badge.className = "badge badge-neutral"; $("#remote-progress").textContent = "本机 Agent 规划、审查和执行可继续使用。"; }
    $("#remote-quick").disabled = state.remoteMutation || status.busy || quickUnavailable;
    $("#remote-quick").title = quickUnavailable ? quickReason : "";
    $("#remote-quick").textContent = quickUnavailable ? "快捷连接暂不支持" : status.enabled && status.mode === "quick_tunnel" && status.gateway === "running" ? "继续使用当前连接" : "新建快捷连接";
    $("#remote-save").disabled = state.remoteMutation || status.busy;
    $("#remote-stop").disabled = state.remoteMutation || !status.enabled;
    show($("#remote-cancel"), !!status.busy); $("#remote-cancel").disabled = state.remoteMutation || !status.enabled;
    $("#remote-test").disabled = state.remoteMutation || status.busy || !status.enabled || status.gateway !== "running" || blockedQuick;
    const checking = check && ["checking", "retrying"].includes(check.state);
    const connectionError = checking || blockedQuick && status.lastError?.startsWith("remote_quick_tunnel_unsupported：") ? "" : status.lastError || "";
    $("#remote-error").textContent = connectionError; show($("#remote-error"), Boolean(connectionError));
    if (connectionError && connectionError !== state.lastRemoteError) showToast(connectionError, true, "remote-connection");
    if (!connectionError && (checking || status.transport === "ready") && $("#page-error").dataset.errorSource === "remote-connection") show($("#page-error"), false);
    state.lastRemoteError = connectionError;
    await refreshRemoteApprovals();
    state.remoteUnavailable = false;
    renderConnectionEntry(); renderWorkspaceAccess(); renderConnectionClients();
    if (state.initialized) await maybeNavigateToAuthorization();
    await finishConnectionFlow();
  } catch (error) {
    state.remoteUnavailable = true; state.connectionFlow = null; renderConnectionSummary(); renderConnectionClients();
    $("#remote-status").textContent = "服务不可用"; $("#remote-status").className = "badge badge-error";
    $("#remote-error").textContent = error.message; show($("#remote-error"));
    if (rethrow) throw error;
  } finally {
    state.remoteFetching = false;
    if (state.remoteRefreshPending) { state.remoteRefreshPending = false; queueMicrotask(() => void refreshRemoteConnection()); }
  }
}
function inferWebSource(value) {
  try {
    const hostname = new URL(value.redirectHost || "").hostname.toLowerCase();
    if (["claude.ai", "claude.com"].includes(hostname)) return "claude";
    if (["chatgpt.com", "chat.openai.com"].includes(hostname)) return "chatgpt";
  } catch { /* An absent or invalid callback needs manual labeling. */ }
  return "";
}
async function refreshRemoteApprovals() {
  let requests; let grants;
  const grantVersion = state.grantVersion || 0;
  try { [requests, grants] = await Promise.all([api("/api/v1/remote-connection/approvals", { signal: AbortSignal.timeout(12000) }), api("/api/v1/remote-connection/grants", { signal: AbortSignal.timeout(12000) })]); }
  catch { state.authorizationsFresh = false; configureGlobalPending(); return; }
  state.authorizationsFresh = true;
  requests = [...requests].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  grants = [...grants].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (grantVersion !== (state.grantVersion || 0)) grants = state.grants || [];
  state.grants = grants;
  state.pendingRemoteApprovals = requests;
  configureGlobalPending();
  const root = $("#remote-approvals");
  const signature = JSON.stringify([requests, state.workspaces.map(({ workspaceId, label }) => ({ workspaceId, label }))]);
  // Preserve each request's selections when another browser submits a request.
  if (signature !== state.remoteApprovalsSignature) {
  const selections = new Map([...root.querySelectorAll(".remote-approval-card[data-request-id]")].map(card => [card.dataset.requestId, {
    alias: card.querySelector(".remote-mcp-name")?.value || "", source: card.querySelector(".remote-source-select")?.value || "", workspaceId: card.querySelector(".remote-workspace-select")?.value || "",
    workspaceIds: selectedProjects(card.querySelector(".remote-projects") || document.createElement("fieldset")), scopes: [...card.querySelectorAll(".remote-scope input:checked")].map(input => input.value),
  }]));
  // Keep the shared form (and typed input) alive when another OAuth request arrives.
  if (root.contains($("#workspace-form"))) $("#workspace-form-host").append($("#workspace-form"));
  state.remoteApprovalsSignature = signature; root.replaceChildren();
  if (!requests.length) root.innerHTML = '<div class="empty-state">没有待处理的网页授权。可在 GPT／Claude 网页重新发起连接后刷新此处。</div>';
  for (const request of requests) {
    const card = document.createElement("article"); card.className = "remote-approval-card"; card.dataset.requestId = request.requestId;
    const heading = document.createElement("div"); heading.className = "remote-approval-heading";
    const title = document.createElement("b"); title.textContent = request.clientName || "未命名网页客户端";
    const id = document.createElement("span"); id.className = "muted small"; id.textContent = `客户端 ID ${shortId(request.clientId)}`;
    heading.append(title, id); card.append(heading);
    const redirect = document.createElement("p"); redirect.className = "muted small"; redirect.dataset.expiresAt = String(request.expiresAt); redirect.textContent = `请求 ${shortId(request.requestId)} · 回调来源：${request.redirectHost} · 创建：${new Date(request.createdAt).toLocaleString()} · ${authorizationExpiryText(request.expiresAt)}`; card.append(redirect);
    const workspaceLabel = document.createElement("label"); workspaceLabel.className = "remote-workspace-label"; workspaceLabel.append(document.createTextNode("授权项目"));
    const workspaceSelect = document.createElement("select"); workspaceSelect.className = "remote-workspace-select";
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = state.workspaces.length ? "选择一个已登记项目" : "请先添加项目"; workspaceSelect.append(empty);
    for (const workspace of state.workspaces) { const option = document.createElement("option"); option.value = workspace.workspaceId; option.textContent = workspace.label; workspaceSelect.append(option); }
    const saved = selections.get(request.requestId);
    if (saved?.workspaceId && [...workspaceSelect.options].some(option => option.value === saved.workspaceId)) workspaceSelect.value = saved.workspaceId;
    const sourceSelect = document.createElement("select"); sourceSelect.className = "remote-source-select"; sourceSelect.append(new Option("请选择网页来源", ""), new Option("ChatGPT", "chatgpt"), new Option("Claude", "claude"), new Option("其他", "other")); sourceSelect.value = saved?.source ?? inferWebSource(request);
    const sourceLabel = document.createElement("label"); sourceLabel.textContent = "网页来源（可修改）"; sourceLabel.append(sourceSelect); const sourceHint = document.createElement("small"); sourceHint.className = "hint"; sourceHint.textContent = inferWebSource(request) ? "已按回调域名识别，可手工修改；来源标签不代替权限校验。" : "未识别出已知网页，请手工选择。"; sourceLabel.append(sourceHint); card.append(sourceLabel);
    const nameLabel = document.createElement("label"); nameLabel.textContent = "MCP 名称（本机备注，可选）";
    const mcpName = document.createElement("input"); mcpName.className = "remote-mcp-name"; mcpName.maxLength = 80; mcpName.placeholder = "例如 demo27，方便与网页连接对应"; mcpName.value = saved?.alias || ""; nameLabel.append(mcpName); card.append(nameLabel);
    const projects = projectCheckboxes(saved?.workspaceIds || []); projects.classList.add("remote-projects");
    projects.querySelector("legend").textContent = "勾选额外授权的工作区";
    const moreProjects = document.createElement("details"); moreProjects.className = "foldout"; moreProjects.innerHTML = "<summary>同时授权其他工作区（可选，可多选）</summary>"; moreProjects.append(projects);
    workspaceLabel.append(workspaceSelect);
    const permissions = document.createElement("fieldset"); permissions.className = "remote-scope-list permissions";
    const legend = document.createElement("legend"); legend.textContent = "1 · 权限（默认均未授权）"; permissions.append(legend);
    const permissionOptions = document.createElement("div"); permissionOptions.className = "remote-scope-options";
    for (const scope of request.requestedScopes.filter(scope => scope !== "session:control")) {
      const label = document.createElement("label"); label.className = "remote-scope";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = scope;
      checkbox.checked = !!saved?.scopes.includes(scope);
      const text = document.createElement("span"); text.textContent = remoteScopeLabels[scope] || scope;
      label.append(checkbox, text); permissionOptions.append(label);
    }
    const allPermissions = document.createElement("input"); allPermissions.type = "checkbox"; allPermissions.className = "remote-scopes-all";
    const allLabel = document.createElement("label"), allText = document.createElement("span"); allLabel.className = "remote-scope-all-row"; allText.textContent = "全选"; allLabel.append(allPermissions, allText);
    const updateSelectAll = () => { const inputs = [...permissions.querySelectorAll('.remote-scope input')], selected = inputs.filter(input => input.checked).length; allPermissions.disabled = !inputs.length; allPermissions.checked = !!inputs.length && selected === inputs.length; allPermissions.indeterminate = selected > 0 && selected < inputs.length; };
    allPermissions.addEventListener("change", () => { for (const input of permissions.querySelectorAll('.remote-scope input')) input.checked = allPermissions.checked; });
    permissions.addEventListener("change", updateSelectAll); permissions.append(allLabel, permissionOptions); updateSelectAll();
    card.append(permissions);
    workspaceLabel.firstChild.textContent = "已登记工作区";
    empty.textContent = "请选择已有工作区";
    const workspaceChoice = document.createElement("section"); workspaceChoice.className = "authorization-workspace-choice";
    const mode = document.createElement("div"); mode.className = "workspace-mode-switch"; mode.setAttribute("role", "group"); mode.setAttribute("aria-label", "授权工作区选择方式");
    const existing = document.createElement("button"), create = document.createElement("button");
    for (const button of [existing, create]) { button.type = "button"; button.className = "button button-quiet"; }
    existing.classList.add("authorization-existing-workspace"); existing.textContent = "选择已有";
    create.classList.add("authorization-new-workspace"); create.textContent = "新建工作区";
    existing.addEventListener("click", () => { if (state.workspaceFormContext?.requestId === request.requestId) closeWorkspaceForm(); workspaceSelect.focus({ preventScroll: true }); });
    create.addEventListener("click", () => void openWorkspaceForm(request.requestId));
    const workspaceHeading = document.createElement("h4"); workspaceHeading.textContent = "2 · 工作区";
    mode.append(existing, create); workspaceChoice.append(workspaceHeading, mode, workspaceLabel); card.append(workspaceChoice, moreProjects);
    const formHost = document.createElement("div"); formHost.className = "authorization-workspace-form";
    workspaceSelect.addEventListener("change", () => {
      if (state.creatingWorkspace && state.workspaceFormContext?.requestId === request.requestId) closeWorkspaceForm();
    });
    workspaceChoice.append(formHost);
    const pathChoice = document.createElement("button"); pathChoice.type = "button"; pathChoice.className = "text-button authorization-path-browser"; pathChoice.textContent = "按路径浏览／搜索"; pathChoice.addEventListener("click", () => void openWorkspaceForm(request.requestId, false)); workspaceChoice.append(pathChoice);
    const actions = document.createElement("div"); actions.className = "remote-approval-actions";
    const deny = document.createElement("button"); deny.type = "button"; deny.className = "button button-quiet"; deny.textContent = "拒绝";
    deny.addEventListener("click", () => void decideRemoteApproval(request.requestId, { decision: "deny" }, deny));
    const allow = document.createElement("button"); allow.type = "button"; allow.className = "button button-primary"; allow.textContent = "授权所选权限";
    const validation = document.createElement("p"); validation.className = "field-guidance"; validation.setAttribute("role", "status");
    validation.id = `authorization-guidance-${request.requestId}`; allow.setAttribute("aria-describedby", validation.id);
    const updateAllow = () => {
      for (const input of projects.querySelectorAll("input")) {
        const primary = input.value === workspaceSelect.value; input.disabled = primary; if (primary) input.checked = false; show(input.parentElement, !primary);
      }
      const additional = selectedProjects(projects).length;
      moreProjects.querySelector("summary").textContent = additional ? `同时授权其他工作区（已选 ${additional} 项）` : "同时授权其他工作区（可选，可多选）";
      const workspaceMissing = !state.workspaces.some(workspace => workspace.workspaceId === workspaceSelect.value);
      const creatingHere = state.creatingWorkspace && state.workspaceFormContext?.requestId === request.requestId;
      const missing = [!sourceSelect.value ? "请选择网页来源" : "", creatingHere ? "请先登记新工作区，或切换到选择已有" : workspaceMissing ? "请选择已有工作区，或登记新工作区" : "", !permissions.querySelector(".remote-scope input:checked") ? "请至少勾选一项权限" : ""].filter(Boolean);
      allow.disabled = !!missing.length; allow.title = missing.join("；"); validation.textContent = missing.length ? `尚不能授权：${missing.join("；")}。` : "已就绪，可授权所选工作区与权限。";
      sourceSelect.setAttribute("aria-invalid", String(!sourceSelect.value)); workspaceSelect.setAttribute("aria-invalid", String(workspaceMissing)); validation.classList.toggle("authorization-ready", !missing.length);
    };
    card.addEventListener("change", () => { updateAllow(); clearInputFeedback(); }); card.refreshAuthorizationState = updateAllow; updateAllow(); card.append(validation);
    allow.addEventListener("click", () => {
      const scopes = [...permissions.querySelectorAll(".remote-scope input:checked")].map((input) => input.value);
      if (!state.workspaces.some(workspace => workspace.workspaceId === workspaceSelect.value) || !scopes.length || !sourceSelect.value) { updateAllow(); return; }
      void decideRemoteApproval(request.requestId, { decision: "allow", workspaceId: workspaceSelect.value, workspaceIds: [...new Set([workspaceSelect.value, ...selectedProjects(projects)])], source: sourceSelect.value, ...(mcpName.value.trim() ? { alias: mcpName.value.trim() } : {}), scopes }, allow);
    });
    actions.append(deny, allow); card.append(actions); root.append(card);
  }
  }
  renderWorkspaceFormMode();
  renderAuthorizationHistory();
  renderRemoteGrants(grants);
}
async function saveRemoteGrant(grant, payload) {
  state.grantVersion = (state.grantVersion || 0) + 1;
  try {
    await api(`/api/v1/remote-connection/grants/${encodeURIComponent(grant.grantId)}`, { method: "POST", body: JSON.stringify(payload) });
    state.grants = (state.grants || []).map(item => item.grantId === grant.grantId ? { ...item, ...payload, workspaceId: payload.workspaceIds[0] } : item);
  } finally { state.grantVersion++; }
}
async function saveRemoteGrantName(grant, alias) {
  state.grantVersion = (state.grantVersion || 0) + 1;
  try {
    await api(`/api/v1/remote-connection/grants/${encodeURIComponent(grant.grantId)}/name`, { method: "POST", body: JSON.stringify({ alias }) });
    state.grants = (state.grants || []).map(item => item.grantId === grant.grantId ? { ...item, alias } : item);
  } finally { state.grantVersion++; }
}
function renderRemoteGrants(grants) {
  grants = [...grants].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  renderAuthorizationOverview();
  const grantRoot = $("#remote-grants");
  const grantSignature = JSON.stringify([grants, state.workspaces.map(item => [item.workspaceId, item.label, item.path]), state.authorizationWorkspace?.workspaceId]);
  if (state.grantSignature === grantSignature) return;
  state.grantSignature = grantSignature;
  if (!grants.length) { grantRoot.innerHTML = '<div class="empty-state">没有有效网页授权。</div>'; return; }
  grantRoot.querySelector(".empty-state")?.remove();
  for (const card of grantRoot.querySelectorAll("[data-grant-id]")) if (!grants.some(grant => grant.grantId === card.dataset.grantId)) card.remove();
  for (const grant of grants) {
    const workspaceIds = grant.workspaceIds || [grant.workspaceId];
    const signature = JSON.stringify([grant.alias, grant.source, grant.usage, grant.clientName, workspaceIds, grant.scopes, grant.expiresAt, state.workspaces, state.authorizationWorkspace?.workspaceId]);
    const previous = [...grantRoot.children].find(card => card.dataset.grantId === grant.grantId);
    if (previous) renderGrantOAuthState(previous, grant);
    if (previous?.dataset.signature === signature) continue;
    if (previous && (previous.dataset.mode !== "saved" || previous.dataset.naming === "true")) {
      previous.dataset.stale = "true";
      previous.querySelector(".grant-editor-feedback").textContent = "授权或工作区信息已变化，请取消编辑后重新核对。当前修改尚未保存。";
      previous.querySelector(".grant-save").disabled = true;
      previous.querySelector(".grant-name-save").disabled = true;
      if (previous.dataset.naming === "true") previous.querySelector(".grant-name-feedback").textContent = "授权信息已变化，请取消后重新设置名称。";
      continue;
    }
    const card = document.createElement("article"); card.className = "remote-approval-card remote-grant-card"; card.dataset.grantId = grant.grantId; card.dataset.signature = signature;
    const heading = document.createElement("div"); heading.className = "remote-approval-heading";
    const name = grantMcpName(grant);
    const title = document.createElement("b"); title.className = "grant-mcp-title"; title.textContent = `MCP：${name || "待设置名称"}${name ? grant.alias ? "（用户填写）" : "（客户端声明）" : ""} · ${workspaceIds.length} 个项目`;
    const rename = document.createElement("button"); rename.type = "button"; rename.className = "text-button grant-rename"; rename.textContent = name ? "修改名称" : "设置 MCP 名称";
    const status = document.createElement("span"); status.className = "grant-state badge badge-success"; status.setAttribute("role", "status"); heading.append(title, rename, status); card.append(heading);
    const nameForm = document.createElement("form"); nameForm.className = "grant-name-form hidden";
    const nameLabel = document.createElement("label"); nameLabel.textContent = "网页连接名称／本机别名（用户填写）";
    const nameInput = document.createElement("input"); nameInput.className = "grant-name-input"; nameInput.maxLength = 80; nameInput.value = grant.alias || ""; nameInput.placeholder = "填写网页端的连接名称，例如 demo1"; nameLabel.append(nameInput);
    const nameNote = document.createElement("p"); nameNote.className = "hint"; nameNote.textContent = "此名称在本机保存，用于对应网页中的连接；不会修改网页名称或访问权限。";
    const nameFeedback = document.createElement("p"); nameFeedback.className = "grant-name-feedback hint"; nameFeedback.setAttribute("role", "status");
    const nameSave = document.createElement("button"); nameSave.type = "submit"; nameSave.className = "button button-primary grant-name-save"; nameSave.textContent = "保存名称";
    const nameCancel = document.createElement("button"); nameCancel.type = "button"; nameCancel.className = "button button-quiet"; nameCancel.textContent = "取消";
    const nameActions = document.createElement("div"); nameActions.className = "button-row"; nameActions.append(nameSave, nameCancel); nameForm.append(nameLabel, nameNote, nameFeedback, nameActions); card.append(nameForm);
    const summary = document.createElement("div"); summary.className = "grant-saved-summary";
    const identityText = document.createElement("p"); identityText.className = "hint"; identityText.textContent = `${!name ? "网页未提供 MCP 名称，请设置与网页一致的名称。 " : ""}来源：${({ chatgpt: "ChatGPT", claude: "Claude", other: "其他" })[grant.source] || "尚未标注"} · 授权创建：${new Date(grant.createdAt).toLocaleString()} · 到期：${new Date(grant.expiresAt).toLocaleString()} · 客户端 ${shortId(grant.clientId)}`;
    const savedProjects = document.createElement("div"); savedProjects.className = "grant-workspace-summary";
    for (const id of workspaceIds) {
      const workspace = state.workspaces.find(item => item.workspaceId === id), item = document.createElement("div"), name = document.createElement("strong"), path = document.createElement("small");
      name.textContent = workspace?.label || id; path.textContent = workspace?.path || "工作区未登记"; item.append(name, path); savedProjects.append(item);
    }
    const oauthHint = document.createElement("span"); oauthHint.className = "grant-oauth-state badge";
    summary.append(identityText, savedProjects, oauthHint); card.append(summary); renderGrantOAuthState(card, grant);
    const detail = document.createElement("details"); detail.className = "foldout";
    const permissionTitle = document.createElement("summary"); permissionTitle.textContent = "已授予权限";
    const permissionText = document.createElement("p"); permissionText.textContent = grant.scopes.map(scope => remoteScopeLabels[scope] || scope).join("；") + "。调整权限请从原网页重新发起 OAuth。"; detail.append(permissionTitle, permissionText); card.append(detail);
    const editor = document.createElement("div"); editor.className = "grant-editor hidden";
    const source = document.createElement("select"); source.append(new Option("请选择来源", ""), new Option("ChatGPT", "chatgpt"), new Option("Claude", "claude"), new Option("其他", "other")); source.value = grant.source || "";
    const alias = document.createElement("input"); alias.maxLength = 80; alias.placeholder = "例如 demo27；留空使用客户端名称"; alias.value = grant.alias || "";
    const sourceLabel = document.createElement("label"); sourceLabel.textContent = "网页来源"; sourceLabel.append(source);
    const aliasLabel = document.createElement("label"); aliasLabel.textContent = "MCP 名称（本机备注）"; aliasLabel.append(alias);
    const identity = document.createElement("details"); identity.className = "foldout"; identity.innerHTML = "<summary>连接名称与网页来源</summary>"; identity.append(sourceLabel, aliasLabel);
    const usage = document.createElement("select"); usage.className = "grant-usage-select"; usage.append(new Option("网页连接", "web"), new Option("独立 SDK／诊断（不计作网页验证）", "diagnostic")); usage.value = grant.usage || "web";
    const usageLabel = document.createElement("label"); usageLabel.textContent = "验证用途（由本机指定）"; usageLabel.append(usage); identity.append(usageLabel);
    const projects = projectCheckboxes(workspaceIds); editor.append(projects, identity); card.append(editor);
    const feedback = document.createElement("p"); feedback.className = "grant-editor-feedback hint"; feedback.setAttribute("role", "status"); card.append(feedback);
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "button button-quiet grant-edit"; edit.textContent = "编辑授权";
    const save = document.createElement("button"); save.type = "button"; save.className = "button button-primary grant-save"; save.textContent = "保存工作区授权";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button button-quiet grant-edit-cancel"; cancel.textContent = "取消编辑";
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "button button-quiet"; revoke.textContent = "撤销此连接";
    const danger = document.createElement("details"); danger.className = "foldout"; danger.innerHTML = "<summary>撤销授权</summary>"; danger.append(revoke);
    const actions = document.createElement("div"); actions.className = "remote-approval-actions"; actions.append(edit, save, cancel);
    let add; let confirming = false;
    const updateEditor = () => {
      const editing = card.dataset.mode !== "saved", saving = card.dataset.mode === "saving";
      show(summary, !editing); show(editor, editing); show(edit, !editing); show(save, editing); show(cancel, editing); show(danger, !editing); if (add) show(add, !editing);
      rename.disabled = editing;
      status.textContent = saving ? "保存中…" : editing ? "编辑中 · 未保存" : "已保存"; status.className = `grant-state badge ${editing ? "badge-warning" : "badge-success"}`;
      const selected = selectedProjects(projects), dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...workspaceIds].sort()) || source.value !== (grant.source || "") || (alias.value.trim() !== (grant.alias || "")) || usage.value !== (grant.usage || "web");
      save.disabled = saving || confirming || !!card.dataset.stale || !dirty || !selected.length || !source.value; cancel.disabled = saving || confirming;
      projects.disabled = saving || confirming; source.disabled = saving || confirming; alias.disabled = saving || confirming; usage.disabled = saving || confirming;
      card.setAttribute("aria-busy", String(saving));
      if (!card.dataset.stale) feedback.textContent = !editing ? "" : !selected.length ? "请至少选择一个可访问的工作区。" : !source.value ? "请选择网页来源。" : dirty ? "修改尚未保存，保存后才会更新网页访问范围。" : "可修改工作区或连接信息；取消编辑将保留原授权。";
    };
    edit.addEventListener("click", () => { card.dataset.mode = "editing"; updateEditor(); });
    rename.addEventListener("click", () => { card.dataset.naming = "true"; show(nameForm); rename.disabled = true; edit.disabled = true; nameInput.focus({ preventScroll: true }); });
    nameCancel.addEventListener("click", () => {
      if (card.dataset.stale) { card.remove(); state.grantSignature = ""; renderRemoteGrants(state.grants || []); return; }
      card.dataset.naming = "false"; show(nameForm, false); nameInput.value = grant.alias || ""; nameFeedback.textContent = ""; rename.disabled = false; edit.disabled = false;
    });
    nameForm.addEventListener("submit", async event => {
      event.preventDefault(); if (nameSave.disabled || card.dataset.stale) return;
      nameSave.disabled = true; nameCancel.disabled = true; nameFeedback.textContent = "正在保存名称…";
      try {
        await saveRemoteGrantName(grant, nameInput.value.trim());
        card.remove(); state.grantSignature = ""; renderRemoteGrants(state.grants || []); showToast("MCP 名称已保存。"); void refreshRemoteConnection();
      } catch (error) { nameFeedback.textContent = `名称保存未完成：${error.message}`; }
      finally { nameSave.disabled = !!card.dataset.stale; nameCancel.disabled = false; }
    });
    projects.addEventListener("change", updateEditor); source.addEventListener("change", updateEditor); alias.addEventListener("input", updateEditor); usage.addEventListener("change", updateEditor);
    cancel.addEventListener("click", () => {
      for (const checkbox of projects.querySelectorAll("input")) checkbox.checked = workspaceIds.includes(checkbox.value);
      source.value = grant.source || ""; alias.value = grant.alias || ""; usage.value = grant.usage || "web"; identity.open = false; card.dataset.mode = "saved";
      if (card.dataset.stale) { card.remove(); state.grantSignature = ""; renderRemoteGrants(state.grants || []); } else updateEditor();
    });
    save.addEventListener("click", async () => {
      if (save.disabled || confirming) return;
      const payload = { workspaceIds: selectedProjects(projects), source: source.value, alias: alias.value.trim(), usage: usage.value };
      confirming = true; updateEditor();
      try {
        if (!await askConfirm("确认网页项目权限", "此连接将只能访问当前勾选的项目；取消勾选的项目会立即停止授权。", "保存权限")) return;
        if (card.dataset.stale) return;
        card.dataset.mode = "saving"; updateEditor();
        await saveRemoteGrant(grant, payload);
        card.remove(); state.grantSignature = ""; renderRemoteGrants(state.grants || []);
        showToast("工作区授权已保存；公网地址保持不变。"); void refreshRemoteConnection();
      } catch (error) { card.dataset.mode = "editing"; feedback.textContent = `保存未完成：${error.message}。修改已保留，可重试或取消。`; }
      finally { confirming = false; if (card.isConnected) { const error = feedback.textContent; updateEditor(); if (error.startsWith("保存未完成")) feedback.textContent = error; } }
    });
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try { await api(`/api/v1/remote-connection/grants/${encodeURIComponent(grant.grantId)}/revoke`, { method: "POST", body: "{}" }); showToast("该网页客户端授权已撤销。"); await refreshRemoteConnection(); }
      catch (error) { showToast(error.message, true); revoke.disabled = false; }
    });
    const target = state.authorizationWorkspace;
    if (target && !workspaceIds.includes(target.workspaceId)) {
      add = document.createElement("button"); add.type = "button"; add.className = "button button-primary"; add.textContent = `授权并打开“${target.label}”`;
      add.addEventListener("click", async () => {
        if (!grant.source) { card.dataset.mode = "editing"; identity.open = true; updateEditor(); return; }
        if (!await askConfirm("授权另一个工作区", `允许此网页连接按已有权限访问“${target.label}”？原有工作区授权保留，MCP 地址不变。`, "授权并打开")) return;
        add.disabled = true;
        try {
          await saveRemoteGrant(grant, { workspaceIds: [...new Set([...workspaceIds, target.workspaceId])], source: grant.source });
          state.authorizationWorkspace = null; state.connectionReturn = null; card.remove(); state.grantSignature = ""; renderRemoteGrants(state.grants || []);
          showToast("工作区已授权，可在同一网页 MCP 连接中继续。地址和其他授权保持不变。");
          await selectWorkspace(target.workspaceId); void refreshRemoteConnection();
        } catch (error) { showToast(error.message, true); add.disabled = false; }
      }); actions.prepend(add);
    }
    card.dataset.mode = "saved"; updateEditor(); card.append(actions, danger);
    if (previous) previous.replaceWith(card); else grantRoot.append(card);
  }
  for (const [index, grant] of grants.entries()) {
    const card = [...grantRoot.children].find(item => item.dataset.grantId === grant.grantId);
    if (card && grantRoot.children[index] !== card) grantRoot.insertBefore(card, grantRoot.children[index] || null);
  }

}

function renderAuthorizationHistory() {
  const requests = (state.remoteStatus?.authorizationRequests || []).filter(item => item.status !== "pending").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 12);
  const root = $("#remote-approval-history-list"); root.replaceChildren();
  const labels = { approved: "已批准", rejected: "已拒绝", expired: "已过期" };
  if (!requests.length) root.innerHTML = '<p class="empty-state">暂无已结束的授权请求记录。</p>';
  for (const request of requests) {
    const row = document.createElement("article"); row.className = "remote-approval-card authorization-history-row";
    const name = document.createElement("strong"); name.textContent = request.clientName || "网页客户端";
    const stateLabel = document.createElement("span"); stateLabel.className = `badge ${request.status === "approved" ? "badge-success" : "badge-warning"}`; stateLabel.textContent = labels[request.status] || "状态未知";
    const details = document.createElement("p"); details.className = "muted small"; details.textContent = `请求 ${shortId(request.requestId)} · ${new Date(request.createdAt).toLocaleString()} · 客户端 ${shortId(request.clientId)}`;
    row.append(name, stateLabel, details); root.append(row);
  }
  show($("#remote-approval-history"), requests.length > 0);
}
function authorizationExpiryText(expiresAt) {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return seconds ? `约 ${Math.ceil(seconds / 60)} 分钟后过期` : "已过期，请回网页重新发起";
}
async function maybeNavigateToAuthorization() {
  if (!state.authorizationsFresh || !state.pendingRemoteApprovals?.length) return;
  if (state.nativePicking) return;
  const current = state.pendingRemoteApprovals.filter(item => new Date(item.expiresAt).getTime() > Date.now()).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  if (!current || state.seenAuthorizationRequests.has(current.requestId)) return;
  try { state.seenAuthorizationRequests = new Set(JSON.parse(sessionStorage.getItem("tc-seen-oauth-requests") || "[]")); } catch { state.seenAuthorizationRequests = new Set(); }
  if (state.seenAuthorizationRequests.has(current.requestId)) return;
  if (state.route?.page !== "connect") {
    if (state.editingPlan && planHasChanges() || protectedLocalInputIsDirty()) return;
    if (!state.connectionReturn && state.routeHash) state.connectionReturn = { path: state.routeHash };
    const before = state.navigationSequence;
    await navigate("/connect");
    if (state.navigationSequence === before) return;
  }
  state.seenAuthorizationRequests.add(current.requestId);
  try { sessionStorage.setItem("tc-seen-oauth-requests", JSON.stringify([...state.seenAuthorizationRequests].slice(-30))); } catch { /* Session storage is optional. */ }
  state.managingConnection = true;
  setConnectionTab("authorization");
  renderConnectionClients();
  const card = [...$("#remote-approvals").querySelectorAll("[data-request-id]")].find(item => item.dataset.requestId === current.requestId);
  card?.classList.add("authorization-arrived");
  const heading = card?.querySelector(".remote-approval-heading"); if (heading) heading.tabIndex = -1;
  setTimeout(() => { card?.scrollIntoView({ behavior: "smooth", block: "center" }); heading?.focus?.(); }, 50);
  $("#authorization-arrival-description").textContent = `${current.clientName || "网页客户端"} 的授权请求将在 ${new Date(current.expiresAt).toLocaleTimeString()} 过期。请在本机核对后手动选择项目和权限。`;
  show($("#authorization-arrival"));
  showToast("收到网页授权请求，已打开本机授权页面；请核对后再决定。您也可以在左侧导航继续其他操作。");
}
async function openAuthorizationRequest(requestId) {
  if (state.route?.page !== "connect") {
    if (!state.connectionReturn && state.routeHash) state.connectionReturn = { path: state.routeHash };
    await navigate("/connect");
    if (state.route?.page !== "connect") return;
  }
  state.managingConnection = true;
  renderConnectionClients();
  focusAuthorizationRequest(requestId);
  const request = state.pendingRemoteApprovals?.find(item => item.requestId === requestId);
  if (request) {
    $("#authorization-arrival-description").textContent = `${request.clientName || "网页客户端"} 的授权请求将在 ${new Date(request.expiresAt).toLocaleTimeString()} 过期。请在本机核对后手动选择项目和权限。`;
    show($("#authorization-arrival"));
  }
}
function focusAuthorizationRequest(requestId) {
  setConnectionTab("authorization");
  const card = [...$("#remote-approvals").querySelectorAll("[data-request-id]")].find(item => item.dataset.requestId === requestId);
  card?.classList.add("authorization-arrived");
  const heading = card?.querySelector(".remote-approval-heading"); if (heading) heading.tabIndex = -1;
  setTimeout(() => { card?.scrollIntoView({ behavior: "smooth", block: "center" }); heading?.focus?.(); }, 50);
}
function projectCheckboxes(selected) {
  const root = document.createElement("fieldset"); root.className = "remote-scope-list workspace-checkbox-grid";
  const legend = document.createElement("legend"); legend.textContent = "2 · 可访问的工作区"; root.append(legend);
  for (const workspace of state.workspaces) {
    const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span"), name = document.createElement("strong"), path = document.createElement("small");
    label.className = "workspace-check-cell"; checkbox.type = "checkbox"; checkbox.value = workspace.workspaceId; checkbox.checked = selected.includes(workspace.workspaceId);
    name.textContent = workspace.label; path.textContent = workspace.path; text.append(name, path);
    label.append(checkbox, text); root.append(label);
  }
  return root;
}
function selectedProjects(root) { return [...root.querySelectorAll("input:checked")].map(input => input.value); }
async function decideRemoteApproval(requestId, decision, button) {
  button.disabled = true;
  if (decision.decision === "deny") state.connectionFlow = null;
  try {
    if (decision.decision === "allow" && state.route?.page === "connect" && !state.managingConnection) state.connectionFlow = { kind: "authorization", requestId, clientId: state.pendingRemoteApprovals?.find(item => item.requestId === requestId)?.clientId, source: decision.source, workspaceId: decision.workspaceId, startedAt: Date.now(), ...(state.connectionReturn?.path ? { returnPath: state.connectionReturn.path } : {}) };
    await api(`/api/v1/remote-connection/approvals/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify(decision) });
    showToast(decision.decision === "allow" ? "网页 MCP 权限已授予。" : "网页 MCP 请求已拒绝。");
    await refreshRemoteConnection();
  } catch (error) { state.connectionFlow = null; showToast(error.message, true); button.disabled = false; }
}

function parseRoute(path) {
  let parts; try { parts = path.split("/").filter(Boolean).map(decodeURIComponent); } catch { return { page: "connect" }; }
  if (parts[0] === "connect" || !parts.length) return { page: "connect" };
  if (parts[0] === "settings") return { page: "settings" };
  if (parts[0] !== "workspaces") return { page: "connect" };
  if (!parts[1]) return { page: "workspaces" };
  if (parts[2] === "settings") return { page: "workspace-settings", workspaceId: parts[1] };
  if (parts[2] === "new") return { page: "new", workspaceId: parts[1] };
  if (parts[2] === "plans" && parts[3]) return { page: "plan", workspaceId: parts[1], planningId: parts[3], tab: ["overview", "draft", "review", "execution", "models", "attempts"].includes(parts[4]) ? parts[4] : "overview" };
  return { page: "workspaces", workspaceId: parts[1] };
}
function routePath(route) {
  if (route.page === "settings") return "/settings";
  if (!route.workspaceId) return route.page === "connect" ? "/connect" : "/workspaces";
  const base = `/workspaces/${encodeURIComponent(route.workspaceId)}`;
  return route.page === "workspace-settings" ? `${base}/settings` : route.page === "new" ? `${base}/new` : route.page === "plan" ? `${base}/plans/${encodeURIComponent(route.planningId)}${route.tab !== "overview" ? `/${route.tab}` : ""}` : base;
}
function protectedLocalInputIsDirty() { return !!state.reviewChoiceContext?.dirty || !!state.runConfigDirty; }
async function confirmLocalInputNavigation(route) {
  const leavesCurrentPlan = state.route?.page === "plan" && (route.page !== "plan" || route.planningId !== state.route.planningId);
  if (!leavesCurrentPlan || !protectedLocalInputIsDirty()) return true;
  const dialog = $("#unsaved-local-state-dialog");
  $("#unsaved-local-state-description").textContent = [state.reviewChoiceContext?.dirty ? "审查意见选择已保存在当前浏览器会话。" : "", state.runConfigDirty ? "运行参数保存在当前 Plan 的本机浏览器设置中，尚未启动。" : "", "请选择如何继续。"].filter(Boolean).join(" ");
  const choice = await new Promise(resolve => { state.localStateDecision = resolve; dialog.showModal(); });
  if (choice === "cancel") return false;
  if (choice === "discard") {
    if (state.reviewChoiceContext?.key) sessionStorage.removeItem(`tc-review-${state.reviewChoiceContext.key}`);
    if (state.runConfigKey) localStorage.removeItem(state.runConfigKey);
    state.reviewChoiceContext = null; state.runConfigDirty = false; state.runConfiguration = null;
  }
  return true;
}
function decideLocalInputNavigation(choice) {
  const resolve = state.localStateDecision; state.localStateDecision = null;
  $("#unsaved-local-state-dialog").close(); resolve?.(choice);
}
function navigate(path) { return applyRoute(path); }
async function applyRoute(path, replace = false) {
  const route = parseRoute(path), previous = state.route;
  const leavesPlan = state.route?.page === "plan" && (route.page !== "plan" || route.planningId !== state.route.planningId);
  if (routePath(route) !== state.routeHash && leavesPlan && protectedLocalInputIsDirty() && !await confirmLocalInputNavigation(route)) {
    history.replaceState(null, "", `#${state.routeHash || "/connect"}`); return;
  }
  if (state.editingPlan && routePath(route) !== state.routeHash && !await confirmPlanChanges()) {
    history.replaceState(null, "", `#${state.routeHash || "/connect"}`); return;
  }
  const sequence = state.navigationSequence = (state.navigationSequence || 0) + 1;
  try {
    if (state.systemSettingsSupported && ["new", "plan", "settings"].includes(route.page)) {
      const settings = await api("/api/v1/settings");
      if (sequence !== state.navigationSequence) return;
      if (!state.systemSettings || settings.revision >= state.systemSettings.revision) state.systemSettings = settings;
    }
    if (route.workspaceId && !state.workspaces.some(item => item.workspaceId === route.workspaceId)) throw new Error("该工作区未登记，请重新选择。");
    state.route = route;
    if (previous?.workspaceId !== route.workspaceId || previous?.planningId !== route.planningId) {
      finishGitFileSelection();
      for (const id of ["dag-dialog", "dag-task-dialog", "task-results-dialog", "session-continue-dialog", "git-preview-dialog"]) if ($("#" + id).open) $("#" + id).close();
      state.dagView = null; state.taskResultView = null; state.continueContext = null; state.gitPreview = null;
    }
    if (route.page !== "connect") state.connectionFlow = null;
    if (!route.workspaceId && route.page !== "settings") {
      state.workspace = null; state.planning = null; state.plannings = []; state.referenceFile = null; state.referenceFiles = [];
      $("#new-task").disabled = true; renderWorkspaces();
    }
    if (route.workspaceId && route.workspaceId !== state.workspace?.workspaceId) await loadWorkspace(route.workspaceId, sequence);
    if (sequence !== state.navigationSequence) return;
    if (route.page === "plan") {
      if (!state.plannings.some(item => item.planningId === route.planningId)) throw new Error("该 Plan 不存在或已移除，请从工作区重新选择。");
      if (route.planningId !== state.planning?.planningId) await loadPlanning(route.planningId);
    } else if (route.page === "new") { state.planning = null; sessionStorage.removeItem(`tc-planning-${route.workspaceId}`); }
    if (sequence !== state.navigationSequence) return;
    state.routeHash = routePath(route);
    if (location.hash !== `#${state.routeHash}`) history[replace ? "replaceState" : "pushState"](null, "", `#${state.routeHash}`);
    if (route.page === "plan" && ["models", "attempts"].includes(route.tab) && routePath(route) !== routePath(previous || {})) {
      state.planToolsExpanded ??= new Map(); state.planToolsExpanded.set(`${route.workspaceId}:${route.planningId}`, true);
    }
    renderRoute(); renderPlanningList();
    if (route.page === "settings") { renderSystemSettings(); void refreshAgentComponents(); }
    if (route.page === "new" && (previous?.page !== "new" || previous.workspaceId !== route.workspaceId || state.resetPlanningPolicy)) { applyPlanningPolicy(); state.resetPlanningPolicy = false; }
    if (route.page === "plan" && state.planning) { renderReviewerControls(state.planning); renderRequirements(); renderReview(); renderPlanOverview(); renderPlanWorkflowBanner(); }
    if (route.page === "plan" && previous?.page === "plan" && previous.planningId === route.planningId && previous.tab !== route.tab) $(`#${route.tab}-tab`)?.scrollIntoView({ block: "start" });
    if (route.page === "new" && previous?.page !== "new") {
      if (isWebMcp($("#planner-provider").value)) $("#copy-web-planning").focus();
      else if (globalThis.tokenCouponPlannerRequestComposer) globalThis.tokenCouponPlannerRequestComposer.focus();
      else $("#request-text").focus();
    }
  } catch (error) {
    if (sequence !== state.navigationSequence) return;
    showToast(error.message, true); state.route = { page: "workspaces" }; state.routeHash = "/workspaces";
    history.replaceState(null, "", "#/workspaces"); renderRoute();
  }
}
function renderRoute() {
  const route = state.route || { page: "connect" };
  for (const page of document.querySelectorAll("[data-page]")) show(page, page.dataset.page === route.page);
  for (const button of document.querySelectorAll("[data-route]")) { const active = button.dataset.route === (route.page === "settings" ? "/settings" : route.page === "connect" ? "/connect" : route.page === "workspace-settings" ? "" : "/workspaces"); button.classList.toggle("active", active); button.setAttribute("aria-current", active ? "page" : "false"); }
  $("#workspace-settings-nav").disabled = !state.workspace;
  $("#workspace-settings-nav").classList.toggle("active", route.page === "workspace-settings");
  show($("#planning-panel"), route.page === "plan" && !!state.planning);
  show($("#workspace-detail"), route.page === "workspaces" && !!state.workspace);
  show($("#workspace-selection"), route.page === "workspaces" && !state.workspace);
  if (state.workspaceFormContext?.kind === "authorization" ? route.page !== "connect" : route.page !== "workspaces" || state.workspace) { state.creatingWorkspace = false; cancelDirectoryPicker(); }
  renderWorkspaceFormMode();
  show($("#new-task"), !["connect", "settings", "workspace-settings"].includes(route.page));
  show($(".journey"), !["settings", "workspace-settings"].includes(route.page));
  $("#project-title").textContent = route.page === "settings" ? "系统设置" : route.page === "workspace-settings" ? "工作区设置" : route.page === "connect" ? "连接中心" : state.workspace?.label || "工作区与计划";
  $("#project-path").textContent = route.page === "settings" ? "默认处理方式与模型偏好" : route.page === "connect" ? "新建或复用网页模型连接" : state.workspace?.path || "选择一个后台可访问的项目目录";
  $("#workspace-detail-title").textContent = `${state.workspace?.label || "项目"} · 计划`;
  $("#journey-plan").classList.toggle("active", route.page === "plan" || route.page === "new");
  const composer = $("#new-planning"), host = route.page === "plan" ? $("#plan-settings-host") : $("#composer-host");
  if (composer.parentElement !== host) host.append(composer);
  show(composer, route.page === "new" || route.page === "plan");
  for (const panel of document.querySelectorAll("[data-plan-panel]")) show(panel, panel.dataset.planPanel === route.tab);
  if (globalThis.tokenCouponPlanTabs) globalThis.tokenCouponPlanTabs.render(route.tab || "overview", tab => void planTab(tab));
  else for (const button of document.querySelectorAll("[data-plan-tab]")) { const selected = button.dataset.planTab === route.tab || button.dataset.planTab === "execution" && ["models", "attempts"].includes(route.tab); button.classList.toggle("active", selected); button.setAttribute("aria-current", selected ? "page" : "false"); }
  document.title = route.page === "plan" ? `${state.planning?.draft?.plan?.title || "Plan"} · orchestrator-tokenCoupon` : `${$("#project-title").textContent} · orchestrator-tokenCoupon`;
  closeNavigation();
  renderExecutionFloatingStatus();
  renderPlanningProgress();
  clearInputFeedback();
  if ($("#page-error").dataset.context && !["global", `${state.workspace?.workspaceId || ""}:${state.planning?.planningId || ""}`].includes($("#page-error").dataset.context)) show($("#page-error"), false);
  if (route.page !== "plan") show($("#selection-feedback"), false);
  if (!state.planning) show($("#pending-action-banner"), false);
  renderWorkspaceAccess(); renderReference(); renderConnectionSummary(); renderOperationNotices();
  if (state.planning) renderRunConfiguration();
}
function renderConnectionEntry() {
  const status = state.remoteStatus; if (!status) return;
  const blockedQuick = status.quickTunnel?.available === false && status.mode !== "fixed_https";
  const reusable = !blockedQuick && status.enabled && status.gateway === "running" && !!status.publicOrigin;
  state.connectionMode ||= reusable ? "reuse" : "new";
  setConnectionTab(state.managingConnection ? "authorization" : state.connectionTab || "transport");
  for (const button of document.querySelectorAll("[data-connection-mode]")) button.classList.toggle("active", button.dataset.connectionMode === state.connectionMode);
  show($("#connection-reuse"), reusable && state.connectionMode === "reuse");
  show($("#connection-empty-reuse"), !reusable && state.connectionMode === "reuse");
  $("#connection-reuse-status").textContent = state.remoteUnavailable ? "状态暂不可用" : status.transport === "ready" ? status.validGrants ? pendingWebTokenExchange(status) ? "入口可用 · 网页待完成连接" : "入口可用 · 授权有效" : "入口可用 · 网页待授权" : status.busy ? "正在检查" : "需要重测";
  $("#connection-reuse-status").className = `badge ${status.transport === "ready" && status.validGrants ? "badge-success" : "badge-warning"}`;
  $("#connection-reuse-description").textContent = `${status.validGrants || 0} 个有效网页授权。复用只继续使用当前入口，不会更新 GPT／Claude 保存的地址或恢复失效授权。`;
  if (status.connectionProcess?.persistent) $("#connection-reuse-description").textContent += status.connectionProcess.recovered ? " 已恢复原常驻隧道，MCP 地址保持不变；原授权仍按有效期和权限生效。" : " 快捷隧道独立常驻，业务后端重启会保留地址和有效授权。";
  $("#reuse-address-label").textContent = status.transport === "ready" && !state.remoteUnavailable ? "当前 MCP 地址" : "当前入口地址（等待验证）";
  $("#reuse-mcp-address").textContent = status.publicOrigin ? `${status.publicOrigin}/mcp` : "尚未取得地址";
  show($("#quick-address-policy"), status.mode === "quick_tunnel");
  $("#remote-reuse").textContent = status.transport === "ready" ? "继续：选择工作区" : "重测当前连接";
  $("#remote-reuse").disabled = state.remoteMutation || status.busy || state.remoteUnavailable || blockedQuick;
  $("#reuse-test").disabled = state.remoteMutation || status.busy || state.remoteUnavailable || !status.enabled || status.gateway !== "running" || blockedQuick;
  $("#reuse-copy-url").disabled = !status.mcpUrl || state.remoteUnavailable;
  $("#connection-next").disabled = status.transport !== "ready";
  show($("#remote-connection"), state.connectionMode === "new");
  $("#authorization-count").textContent = status.pendingApprovals ? `(${status.pendingApprovals} 待处理)` : "";
  const approvals = $("#remote-approvals"); show(approvals, !!state.pendingRemoteApprovals?.length);
  renderConnectionSummary();
}
function renderConnectionSummary() {
  renderAuthorizationOverview();
  const root = $("#workspace-connection-summary"), remote = state.remoteStatus;
  show(root, !["connect", "settings"].includes(state.route?.page));
  const grants = (state.grants || []).filter(grant => new Date(grant.expiresAt).getTime() > Date.now() && (!state.workspace || (grant.workspaceIds || [grant.workspaceId]).includes(state.workspace.workspaceId)));
  const sources = [...new Set(grants.map(grant => {
    const projects = (grant.workspaceIds || [grant.workspaceId]).map(id => state.workspaces.find(item => item.workspaceId === id)?.label || id).join("、");
    return state.workspace ? `${grant.source || "来源待确认"} 已获准访问本项目` : `${grant.source || "来源待确认"} 已授权（${projects}）`;
  }))];
  const inactive = (remote?.authorizationStates || []).filter(item => item.status !== "active" && (!state.workspace || item.workspaceIds.includes(state.workspace.workspaceId)) && !grants.some(grant => grant.source === item.source));
  const lost = [...new Set(inactive.map(item => `${item.source} ${item.status === "expired" ? "授权已过期" : "授权已撤销"}`))].join("；");
  const pending = !state.remoteUnavailable && state.authorizationsFresh !== false ? state.pendingRemoteApprovals?.filter(item => new Date(item.expiresAt).getTime() > Date.now()) || [] : [];
  const authorization = pending.length ? `收到 ${pending.length} 个网页授权请求，等待本机确认` : state.authorizationsFresh === false ? "网页授权状态暂不可用（上次记录仅供参考）" : [sources.join("；"), lost].filter(Boolean).join("；") || "网页待授权";
  const toolState = remote?.transport === "ready" && state.authorizationsFresh !== false ? verifiedPromptClients().length ? " · 网页工具：已观测成功调用" : pendingWebTokenExchange(remote) ? " · 网页连接：等待完成令牌交换" : grants.length ? " · 网页工具：待实际调用验证" : "" : "";
  root.textContent = `${state.remoteUnavailable ? "连接状态暂不可用（上次状态仅供参考）" : remote?.transport === "ready" ? "公网入口可用" : remote?.busy ? "公网入口验证中" : "公网入口未就绪"} · ${authorization}${toolState} · ${state.workspace ? `工作区：${state.workspace.label}` : "未选择工作区，请手工选择"}`;
  root.classList.toggle("notice-warn", !!state.remoteUnavailable);
  const active = (state.grants || []).filter(grant => new Date(grant.expiresAt).getTime() > Date.now());
  const authorizationUnknown = !state.remoteUnavailable && remote?.transport === "ready" && state.authorizationsFresh === false;
  const needsAuthorization = !state.remoteUnavailable && !authorizationUnknown && remote?.transport === "ready" && !active.length;
  const needsVerification = !state.remoteUnavailable && !authorizationUnknown && remote?.transport === "ready" && active.length && !verifiedPromptClients().length;
  show($("#connection-action-needed"), state.route?.page !== "connect" && (state.route?.page !== "settings" || !!pending.length) && !!(pending.length || authorizationUnknown || needsAuthorization || needsVerification));
  const waitingForToken = active.length > 0 && active.every(grant => grant.oauthState === "awaiting_token");
  const verificationOnly = !!needsVerification && !pending.length && !waitingForToken;
  $("#connection-action-title").textContent = pending.length ? "已收到网页授权请求，等待本机确认" : authorizationUnknown ? "网页授权状态暂不可用，请刷新重试" : needsAuthorization ? remote.addressChanged ? "公网地址已变化，需要更新网页连接并重新授权" : "公网入口可用，网页尚未完成授权" : waitingForToken ? "本机已批准，网页尚未完成连接" : "已授权，可以发起一次验证提示";
  show($("#connection-action-description"), !verificationOnly);
  show($("#connection-repair"), !verificationOnly); show($("#connection-copy-current"), !verificationOnly);
  show($("#connection-verify-web"), verificationOnly); $("#connection-verify-web").textContent = "复制网页提示";
  $("#connection-action-description").textContent = pending.length ? `最新请求来自 ${pending[0].clientName || "网页客户端"}，请检查项目和权限后再授权。网页授权与公网入口状态分开显示。` : authorizationUnknown ? "公网入口可用，但本次授权列表读取失败；缓存信息仅供参考，尚不能确认网页是否已授权。请先刷新状态，无需重建隧道。" : needsAuthorization ? `${remote.previousMcpUrl ? `原地址：${remote.previousMcpUrl}。` : ""}当前地址：${remote.mcpUrl || remote.publicOrigin + "/mcp"}。${state.reusedOrigin === remote.publicOrigin ? "你已复用该公网入口；" : ""}请在对应网页使用当前地址并完成 OAuth，本机复用不会自动修改网页配置。` : waitingForToken ? "本机批准已保存，但网页尚未成功换取访问令牌。请在原网页连接中完成或重新连接；若仍失败，查看下方 OAuth 换取令牌记录。" : "公网自检与 OAuth 授权已具备；请在已连接的网页发送一次验证提示。内部 connection_probe 不计作网页工具验证。";
  show($("#authorization-arrival"), pending.length > 0);
  if (pending.length) $("#authorization-arrival-description").textContent = `${pending[0].clientName || "网页客户端"} · 请求 ${shortId(pending[0].requestId)} · 请在本机确认项目与权限。`;
  $("#connection-repair").textContent = pending.length ? "打开授权审批" : needsAuthorization ? "查看连接与授权步骤" : "查看客户端与最近调用";
  $("#connection-copy-current").disabled = !remote?.mcpUrl;
}
function renderConnectionClients() {
  renderConnectionIdentity();
  const remote = state.remoteStatus || {}, root = $("#connection-current-clients"), history = $("#connection-history-clients");
  const clients = [...(remote.clients || (state.grants || []).map(grant => ({ ...grant, name: grant.alias || grant.clientName || grant.source, status: "active", mcpUrl: remote.mcpUrl })))].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const expanded = new Set([...root.querySelectorAll("details[open][data-connection-fold]"), ...history.querySelectorAll("details[open][data-connection-fold]")].map(item => item.dataset.connectionFold));
  root.replaceChildren(); history.replaceChildren();
  const active = clients.filter(client => client.status === "active"), old = clients.filter(client => client.status !== "active");
  $("#connection-client-count").textContent = state.remoteUnavailable || state.authorizationsFresh === false ? "授权状态暂不可用" : `${active.length} 个有效 · ${old.length} 个历史`;
  const historyDetails = $("#connection-history"); if (historyDetails) historyDetails.querySelector("summary").textContent = `历史连接与失效授权 · ${old.length} 条`;
  const approvalHistory = $("#remote-approval-history"); if (approvalHistory) approvalHistory.querySelector("summary").textContent = `最近的授权请求 · ${(remote.authorizationRequests || []).filter(item => item.status !== "pending").length} 条`;
  if (!active.length) root.innerHTML = '<p class="empty-state">当前没有有效的网页授权。请核对地址和授权状态；本机保存权限、停止隧道与网页移除连接是不同操作。</p>';
  const renderClient = (client, target) => {
    const card = document.createElement("article"); card.className = "connection-client";
    const names = (client.workspaceIds || [client.workspaceId]).map(id => state.workspaces.find(workspace => workspace.workspaceId === id)?.label || "已移除项目").join("、");
    const labels = { active: "授权有效", expired: "授权已过期", revoked: "授权已撤销", address_changed: "地址不匹配" };
    const call = client.lastCall;
    const identity = client.alias ? `${client.alias}（用户填写）` : `${client.clientName || client.name || "网页名称未知"}（客户端声明）`;
    const failure = call?.outcome === "error" ? `最近调用未完成：${call.code === "mcp_tool_input_rejected" ? "参数或工具名称校验失败" : call.code?.includes("forbidden") ? "本次访问超出授权范围" : "工具执行失败"}（${call.code || "原因待诊断"}）；详情含追踪 ID。` : "";
    const verification = client.usage === "diagnostic" ? "独立 SDK／诊断调用，不计作网页验证" : client.toolVerified ? `本客户端调用已验证 · ${new Date(client.lastSuccess?.at).toLocaleString()}` : "尚未收到此连接的成功工具调用；请先核对网页选中的连接名称及地址";
    card.innerHTML = `<div class="section-title"><strong>${esc(identity)}</strong><span class="badge ${client.status === "active" ? "badge-success" : "badge-warning"}">${esc(client.status === "active" && client.oauthState === "awaiting_token" ? "本机已批准 · 网页待连接" : labels[client.status])}</span></div><p>${esc(client.source || "来源待确认")} · 项目：${esc(names)}</p><p class="small connection-endpoint">${esc(client.mcpUrl || "地址尚未记录")}</p><p class="connection-verification">${esc(verification)}</p>${failure ? `<p class="notice notice-warn">${esc(failure)}</p>` : ""}<details class="foldout" data-connection-fold="${esc(client.grantId || client.clientId || "unknown")}"><summary>客户端、时间与最近调用</summary><p class="small">授权创建：${client.createdAt ? esc(new Date(client.createdAt).toLocaleString()) : "时间未知"} · 到期：${client.expiresAt ? esc(new Date(client.expiresAt).toLocaleString()) : "未知"} · 回执短标识 ${esc(client.clientFingerprint || "旧后台未提供")} · 客户端 ${esc(client.clientId || "未知")} · 授权 ${esc(shortId(client.grantId))}</p><p>${call ? `${call.outcome === "success" ? "最近工具调用成功" : "最近工具调用失败"}：${esc(call.tool)} · ${esc(new Date(call.at).toLocaleString())}${call.code ? ` · ${esc(call.code)}` : ""} · 追踪 ID：${esc(call.traceId)}` : "当前授权范围暂无工具调用记录"}</p></details>`;
    target.append(card);
  };
  active.slice(0, 5).forEach(client => renderClient(client, root));
  if (active.length > 5) {
    const older = document.createElement("details"); older.className = "foldout older-connection-records"; older.dataset.connectionFold = "older-active";
    const summary = document.createElement("summary"); summary.textContent = `较早的有效授权 · ${active.length - 5} 条`;
    const content = document.createElement("div"); content.className = "connection-client-grid"; active.slice(5).forEach(client => renderClient(client, content)); older.append(summary, content); root.append(older);
  }
  old.slice(0, 5).forEach(client => renderClient(client, history));
  if (old.length > 5) {
    const older = document.createElement("details"); older.className = "foldout older-connection-records"; older.dataset.connectionFold = "older-history";
    const summary = document.createElement("summary"); summary.textContent = `更早的失效授权 · ${old.length - 5} 条`;
    const content = document.createElement("div"); content.className = "connection-client-grid"; old.slice(5).forEach(client => renderClient(client, content)); older.append(summary, content); history.append(older);
  }
  for (const fold of [...root.querySelectorAll("details[data-connection-fold]"), ...history.querySelectorAll("details[data-connection-fold]")]) fold.open = expanded.has(fold.dataset.connectionFold);
  show($("#connection-history"), !!old.length);
  const check = remote.probeCheck;
  $("#connection-check-details").textContent = `${remote.lastProbeAt ? `最近公网自检：${new Date(remote.lastProbeAt).toLocaleString()}` : "尚无成功的公网自检"}${check ? ` · 检查 ${check.attempt}/${check.maxAttempts} · ${check.state}${check.lastError ? ` · ${check.lastError}` : ""}` : ""}${remote.diagnosticsUnavailable ? " · 调用诊断存储暂不可用，不能保证记录完整" : ""}`;
  let tracing = $("#connection-tracing-status");
  if (!tracing) { tracing = document.createElement("p"); tracing.id = "connection-tracing-status"; tracing.className = "hint"; $("#connection-check-details").after(tracing); }
  tracing.textContent = remote.gatewayTracing?.enabled ? `入口追踪已启用 · ${remote.gatewayTracing.lastRequestAt ? `最近请求：${new Date(remote.gatewayTracing.lastRequestAt).toLocaleString()}` : "尚未收到外部请求"} · ${remote.gatewayTracing.lastToolAt ? `最近工具调用：${new Date(remote.gatewayTracing.lastToolAt).toLocaleString()}` : "尚未收到工具调用"}` : "当前后台尚未提供完整入口追踪，请更新后台后查看。";
  const calls = $("#connection-recent-calls"); calls.replaceChildren();
  if (!remote.recentCalls?.length) calls.innerHTML = '<p class="empty-state">尚未收到当前入口的请求。若网页报错，请核对所选连接名称及地址；未观察到请求不能证明用户没有发送或授权被拒绝，无需先重建隧道。</p>';
  for (const entry of remote.recentCalls || []) {
    const line = document.createElement("p"); line.className = "small connection-call";
    const stage = entry.stage === "ingress" ? `${entry.httpMethod || "请求"} ${entry.route === "other" ? "其他路径" : entry.route || ""} · ${{ received: "入口已收到", completed: "响应已完成", aborted: "连接中断", stream_closed: "事件流已关闭" }[entry.requestState] || "入口记录"}` : entry.stage === "oauth" ? `OAuth ${entry.method === "refresh_token" ? "刷新令牌" : "换取令牌"}${entry.outcome === "success" ? "成功" : "失败"}` : entry.stage === "authentication" ? "认证失败，工具未执行" : entry.stage === "tool" ? `${entry.tool} ${entry.outcome === "success" ? "成功" : "失败"}` : `${entry.method || "请求"} 已到达网关`;
    line.textContent = `${new Date(entry.at).toLocaleString()} · ${stage} · ${entry.code || `HTTP ${entry.httpStatus || "—"}`}${entry.httpStatus && entry.code ? ` · HTTP ${entry.httpStatus}` : ""}${entry.authorization ? ` · 认证头：${{ missing: "未携带", bearer: "已携带 Bearer", other: "其他格式" }[entry.authorization]}` : ""}${entry.accept ? ` · Accept：${entry.accept} · Content-Type：${entry.contentType} · 协议：${entry.protocolVersion}` : ""}${entry.requestFields ? ` · 已携带字段：${entry.requestFields.join("、") || "无"}` : ""}${entry.cloudflareRay ? ` · Cloudflare Ray：${entry.cloudflareRay}` : ""} · 追踪 ID：${entry.traceId}`; calls.append(line);
  }
  show($("#connection-return-plan"), !!state.connectionReturn);
}
async function finishConnectionFlow() {
  const flow = state.connectionFlow, status = state.remoteStatus;
  if (!flow || state.route?.page !== "connect" || state.managingConnection) return;
  // A read started before a connection mutation may complete with the old
  // stopped state. Keep the new onboarding flow until its post-mutation read.
  if (state.remoteMutation) return;
  if (status.addressChanged && flow.kind !== "authorization") { state.connectionFlow = null; return; }
  if (["error", "disconnected", "stopped"].includes(status.transport)) { state.connectionFlow = null; return; }
  if (status.transport !== "ready" || status.gateway !== "running" || !status.enabled || !status.publicOrigin || state.remoteMutation) return;
  if (flow.kind === "authorization" && !(state.grants || []).some(grant => grant.clientId === flow.clientId && new Date(grant.createdAt).getTime() >= flow.startedAt && grant.source === flow.source && (grant.workspaceIds || [grant.workspaceId]).includes(flow.workspaceId) && new Date(grant.expiresAt).getTime() > Date.now())) return;
  // Never navigate on background readiness alone, while editing, or over another authorization.
  if (!state.authorizationsFresh || state.pendingRemoteApprovals?.length || status.pendingApprovals > 0 || state.editingPlan || state.connectionConfigDirty) return;
  if (flow.kind === "authorization" && flow.returnPath) {
    state.connectionFlow = null; show($("#connection-return-plan"));
    $("#connection-return-plan").textContent = "返回刚才的工作区／计划";
    showToast(`${flow.source} 已授权。可返回刚才的页面继续；没有自动批准或运行计划。`);
    return;
  }
  if (flow.kind === "authorization" && flow.returnPath) {
    state.connectionFlow = null; show($("#connection-return-plan"));
    $("#connection-return-plan").textContent = "返回刚才的工作区／计划";
    showToast(`${flow.source} 已授权。可返回刚才的页面继续；没有自动批准或运行计划。`); return;
  }
  state.connectionFlow = null;
  showToast(flow.kind === "authorization" ? `${flow.source} 已授权，请选择工作区。` : "公网入口已就绪，请手工选择工作区；网页授权需另行确认。");
  await navigate("/workspaces");
}
function renderWorkspaceAccess() {
  renderWorkspaceSettings();
  const hint = $("#workspace-access-hint"); if (!state.workspace) { hint.textContent = ""; return; }
  const status = state.remoteStatus;
  const grants = (state.grants || []).filter(grant => (grant.workspaceIds || [grant.workspaceId]).includes(state.workspace.workspaceId));
  hint.textContent = grants.length ? `已有 ${grants.length} 个网页客户端获准访问本项目。切换工作区不改变 MCP 地址，可直接在原网页继续。` : status?.transport === "ready" ? "已有 MCP 连接。选择一个有效网页授权，直接增加此工作区即可；无需新建连接。" : "本机/API 模式可直接使用；网页规划需先建立连接并授权工作区。";
  const button = $("#workspace-enable-access");
  show(button, true);
  button.textContent = grants.length ? `工作区授权 · 已授权 ${grants.length} 个客户端` : "工作区授权 · 查看／配置";
  button.disabled = !!state.remoteMutation;
  const planButton = $("#plan-workspace-access");
  planButton.textContent = button.textContent; planButton.disabled = button.disabled;
}
function planTab(tab) {
  if (state.workspace && state.planning) return navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/plans/${encodeURIComponent(state.planning.planningId)}/${tab}`);
}
function renderPlanOverview() {
  const plan = state.planning; if (!plan) return;
  const session = plan.session, review = plan.review;
  const waiting = (plan.interactions || []).length || state.waitingInteractions || 0;
  const stage = plan.workflow?.label || (session ? waiting ? "等待人工处理" : statuses[session.status] || session.status : plan.status === "approved" ? "待执行" : review?.current ? "待核对与批准" : plan.draft ? "待审查" : "等待网页规划");
  let nextAction = session ? waiting ? "Runner 正在等待你的批准或回答，进入执行页处理。" : "进入执行与结果页查看任务状态、恢复操作和交付证据。" : plan.status === "approved" ? "草案已批准。查看本次并发与隔离配置后，到执行页运行。" : review?.current ? "核对审查结论和必要的豁免记录，然后在审查页批准。" : plan.draft ? "查看草案；在网页继续审查，提交有效报告后再批准。" : "到已连接的网页继续需求澄清与规划。可复制下方提示，在新会话恢复同一 Plan。";
  if (plan.workflow) nextAction = plan.workflow.detail;
  if (!session && !plan.workflow?.role && !review?.current && !selectedOperationIsWeb("review")) nextAction = plan.draft ? "在审查与修订页点击所选 Agent／API 的审查按钮，核对结果后再批准。" : "在本机回答澄清或补充需求，继续规划。";
  state.planNextAction = nextAction;
  const approved = plan.workflow ? plan.workflow.stage === "approved" : plan.status === "approved";
  const target = session || approved ? "execution" : review?.current || plan.workflow?.role === "review" || plan.workflow?.stage?.startsWith("review_") ? "review" : plan.draft ? "draft" : "overview";
  const primaryActionLabel = target === "execution" ? "查看执行与结果" : target === "review" ? "核对并批准" : target === "draft" ? "查看草案" : "复制网页继续提示";
  const resumeDisabled = !isWebMcp(plan.config.provider) && !(plan.handoffs || []).length;
  const overview = globalThis.tokenCouponPlanOverview;
  if (overview) overview.render({ stage, stageTone: statusClass(session?.status || plan.status), nextAction, taskCount: plan.draft?.plan?.tasks?.length || 0, completedTaskCount: session?.tasks?.filter(task => task.status === "succeeded").length || 0, reviewStatus: review?.current ? "有效" : review ? "已过期" : "待提交", primaryActionLabel, resumeDisabled }, () => target === "overview" ? void copyResumePrompt() : planTab(target), () => void copyResumePrompt());
  else {
    $("#plan-stage").textContent = stage; $("#plan-stage").className = `badge ${statusClass(session?.status || plan.status)}`;
    $("#plan-next-action").textContent = nextAction;
    $("#plan-summary").innerHTML = `<div><strong>${plan.draft?.plan?.tasks?.length || 0}</strong><span>计划任务</span></div><div><strong>${session?.tasks?.filter(task => task.status === "succeeded").length || 0}</strong><span>执行完成</span></div><div><strong>${review?.current ? "有效" : review ? "已过期" : "待提交"}</strong><span>审查报告</span></div>`;
    $("#plan-primary-action").textContent = primaryActionLabel;
    $("#plan-primary-action").onclick = () => target === "overview" ? $("#copy-plan-resume").click() : planTab(target);
    $("#copy-plan-resume").disabled = resumeDisabled;
  }
}
function renderReference() {
  const root = $("#reference-summary"); if (!root) return;
  show(root, !!state.referenceFile);
  root.textContent = state.referenceFile ? `规划参考：${(state.referenceFiles?.length ? state.referenceFiles : [state.referenceFile]).join("、")}。复制提示会携带相对路径，由网页重新读取；不会上传未选择的文件。` : "";
}
async function copyResumePrompt() {
  if (!state.planning || !await confirmPlanChanges()) return;
  let header; try { header = webpageSelectionHeader(state.workspace?.workspaceId); } catch (error) { showToast(error.message, true); return; }
  const prompt = [header, "通过 Token Coupon MCP 继续已有计划，不新建 Planning，也不在网页执行代码。",
    `项目：${JSON.stringify(state.workspace.label)}；workspaceId：${state.workspace.workspaceId}；planningId：${state.planning.planningId}。`,
    "先调用 planning_query，使用上面的 workspaceId / planningId 一次核实授权并读取最新需求、草案、审查与 handoffs，无需重复 workspace_query 或 handoff_query。",
    "从返回的 handoffs 选择当前待处理操作，直接 handoff_claim 领取并获取协议；没有待处理操作时才 planning_prepare，继续规划或审查，再 external_submit。",
    "以本地最新版本为准；历史原文仅按需 conversation_read，不能用当前网页聊天覆盖已保存的需求。工具不可用时报告阻断。",
    "草案生成或修订后接着审查一次；需要用户取舍的问题集中提问，避免无限修订。批准、执行与恢复 Session 由我在 本地控制台 操作。",
    `本次继续目标：${state.planning.workflow?.detail || "继续当前计划并复审"}。当前草案 draft-${state.planning.draft?.draftRevision || "尚未生成"}；以 planning_query 返回的最新版本为准。`,
    "先完成已有规划／修订操作，再审查新版本；已有有效审查则停止重复审查，给出明确 A/B/C 下一步（含自定义）。"].join("\n");
  try { await copyText(prompt); showToast("继续提示已复制。在任一获准网页发送，恢复同一 Plan；没有启动执行。"); }
  catch { showCopyFallback("复制已有计划的继续提示", prompt); }
}

function functionPolicy(name) {
  const settings = state.systemSettings;
  return settings?.initialized ? settings.mode === "unified" ? settings.unified : settings.functions[name] || (name === "revision" ? settings.functions.planning : null) : null;
}
function policySelection(name) {
  const policy = functionPolicy(name); if (!policy) return null;
  return policy.priority === "web" ? { mode: `web-${policy.webSource}` } : { mode: policy.agent.runnerId === "claude-code" ? "claude-agent" : "codex-agent", model: policy.agent.modelId || "runner-default" };
}
function selectedOperationIsWeb(name) {
  const selection = name === "review" ? { mode: $("#reviewer-mode")?.value || "planning" } : policySelection(name);
  return selection && selection.mode !== "planning" ? selection.mode.startsWith("web-") : isWebMcp(state.planning?.config.provider);
}
function applyPlanningPolicy() {
  const policy = functionPolicy("planning"); if (!policy) return;
  const provider = policy.priority === "web" ? policy.webSource === "claude" ? "claude-mcp" : [...$("#planner-provider").options].some(option => option.value === "web-mcp") ? "web-mcp" : "chatgpt-mcp" : policy.agent.runnerId === "claude-code" ? "claude-agent" : "codex-agent";
  const select = $("#planner-provider");
  if (![...select.options].some(option => option.value === provider)) { showToast("默认规划方式未在当前后台提供，请检查系统设置与后台版本。", true); return; }
  select.value = provider; select.dispatchEvent(new Event("change"));
  if (policy.priority === "agent") $("#planner-model").value = policy.agent.modelId || "runner-default";
}
function renderWorkspaceSettings() {
  const workspace = state.workspace;
  $("#workspace-settings-title").textContent = `${workspace?.label || "项目"} · 工作区设置`;
  $("#workspace-settings-path").textContent = workspace?.path || "请先打开工作区。";
  const grants = (state.grants || []).filter(grant => (grant.workspaceIds || [grant.workspaceId]).includes(workspace?.workspaceId)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $("#workspace-settings-access").textContent = grants.length ? `已保存 ${grants.length} 项网页授权。修改访问范围时进入授权管理，MCP 地址保持不变。` : "暂无网页授权。本机 Agent 可直接使用；网页访问需单独授权。";
  const root = $("#workspace-settings-grants"); root.replaceChildren();
  for (const grant of grants) {
    const row = document.createElement("p"); row.className = "settings-grant";
    row.textContent = `${grantMcpName(grant) || "MCP 未命名"} · ${grant.source || "来源待确认"} · ${grant.oauthState === "awaiting_token" ? "网页待完成连接" : "已授权"}`;
    root.append(row);
  }
}
function renderSystemSettings() {
  const root = $("#system-settings-policies"), status = $("#system-settings-status");
  const saved = state.systemSettings;
  if (!state.systemSettingsSupported || !saved || !state.operationRoutingSupported) {
    status.textContent = "当前后台尚未加载完整的功能路由设置。请重启后台并刷新后再配置。";
    $("#system-settings-save").disabled = true; $("#system-settings-mode").disabled = true; disposeAgentSelectionControls(root); disposeSystemPolicyRouting(root); root.replaceChildren(); return;
  }
  const draft = state.settingsDraft = structuredClone(saved);
  $("#system-settings-save").disabled = false; $("#system-settings-mode").disabled = false;
  $("#system-settings-mode").value = draft.mode;
  $("#system-settings-title").textContent = saved.initialized ? "系统设置" : "首次使用：选择默认处理方式";
  status.textContent = saved.initialized ? `设置已保存 · 版本 ${saved.revision}` : "设置尚未保存。可统一选择 Agent 优先或网页优先，也可分别设置。";
  show($("#system-settings-continue"), !!state.initialSetup && saved.initialized);
  renderSystemPolicyFields();
}
function renderSystemPolicyFields() {
  const draft = state.settingsDraft, root = $("#system-settings-policies"); disposeAgentSelectionControls(root); disposeSystemPolicyRouting(root); root.replaceChildren();
  if (!draft) return;
  draft.functions.revision ??= structuredClone(draft.functions.planning);
  const names = draft.mode === "unified" ? [["unified", "所有功能"]] : [["planning", "规划"], ["review", "审查"], ["revision", "修订"], ["diagnosis", "错误分析"]];
  for (const [name, title] of names) {
    const policy = name === "unified" ? draft.unified : draft.functions[name];
    const card = document.createElement("fieldset"); card.className = "policy-card"; card.dataset.function = name;
    const legend = document.createElement("legend"); legend.textContent = title;
    const routing = document.createElement("div"); routing.className = "policy-routing-mount"; routing.dataset.systemPolicyRoutingMount = "true";
    const current = () => state.settingsDraft === draft && card.isConnected;
    const controls = createAgentSelectionControls(policy.agent, value => { policy.agent = value; markSystemSettingsDirty(); }, current, (state.runners || []).filter(runner => ["codex", "claude-code"].includes(runner.id)));
    const update = () => {
      globalThis.tokenCouponSystemPolicyRouting?.render(routing, policy, {
        onPriorityChange: value => { policy.priority = value; update(); if (value === "agent") void controls.load(); markSystemSettingsDirty(); },
        onWebSourceChange: value => { policy.webSource = value; markSystemSettingsDirty(); },
      });
      if (!globalThis.tokenCouponSystemPolicyRouting) {
        const priority = routing.querySelector<HTMLSelectElement>('[data-field="priority"]'), web = routing.querySelector<HTMLLabelElement>('[data-field="web-source"]');
        if (priority) priority.value = policy.priority;
        if (web) show(web, policy.priority === "web");
        show(controls.root, policy.priority === "agent");
      } else show(controls.root, policy.priority === "agent");
    };
    if (!globalThis.tokenCouponSystemPolicyRouting) {
      const priorityLabel = document.createElement("label"); priorityLabel.textContent = "默认方式";
      const priority = document.createElement("select"); priority.dataset.field = "priority";
      priority.add(new Option("网页优先", "web")); priority.add(new Option("指定 Agent 优先", "agent")); priority.value = policy.priority; priorityLabel.append(priority);
      const web = document.createElement("label"); web.dataset.field = "web-source"; web.textContent = "默认网页";
      const source = document.createElement("select"); source.add(new Option("ChatGPT", "chatgpt")); source.add(new Option("Claude", "claude")); source.value = policy.webSource; web.append(source);
      priority.addEventListener("change", () => { policy.priority = priority.value; update(); if (policy.priority === "agent") void controls.load(); markSystemSettingsDirty(); });
      source.addEventListener("change", () => { policy.webSource = source.value; markSystemSettingsDirty(); });
      routing.append(priorityLabel, web);
    }
    card.append(legend, routing, controls.root); root.append(card); update(); if (policy.priority === "agent") void controls.load();
  }
}
function disposeSystemPolicyRouting(container) {
  const bridge = globalThis.tokenCouponSystemPolicyRouting;
  if (!bridge) return;
  for (const mount of [container, ...container.querySelectorAll("[data-system-policy-routing-mount]")]) bridge.unmount(mount);
}
function markSystemSettingsDirty() { $("#system-settings-status").textContent = "设置已修改，保存后对后续操作生效。"; show($("#system-settings-continue"), false); }
$("#workspace-settings-nav").addEventListener("click", () => state.workspace && void navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/settings`));
$("#workspace-settings-back").addEventListener("click", () => state.workspace && void navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}`));
$("#system-settings-mode").addEventListener("change", () => { if (!state.settingsDraft) return; state.settingsDraft.mode = $("#system-settings-mode").value; renderSystemPolicyFields(); markSystemSettingsDirty(); });
$("#system-settings-reload").addEventListener("click", async () => {
  if (!state.systemSettingsSupported) return;
  try { state.systemSettings = await api("/api/v1/settings"); renderSystemSettings(); }
  catch (error) { $("#system-settings-status").textContent = `读取失败：${error.message}`; }
});
$("#system-settings-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!state.settingsDraft || state.settingsSaving) return;
  state.settingsSaving = true;
  for (const input of $("#system-settings-form").querySelectorAll("input, select, button")) input.disabled = true;
  $("#system-settings-status").textContent = "正在保存…";
  try {
    state.systemSettings = await api("/api/v1/settings", { method: "POST", body: JSON.stringify(state.settingsDraft) });
    renderSystemSettings();
  } catch (error) { $("#system-settings-status").textContent = `保存未完成：${error.message}。已保留本次输入；如版本冲突，请重新加载。`; }
  finally { state.settingsSaving = false; for (const input of $("#system-settings-form").querySelectorAll("input, select, button")) input.disabled = false; }
});
$("#system-settings-continue").addEventListener("click", () => { state.initialSetup = false; void navigate(functionPolicy("planning")?.priority === "web" ? "/connect" : "/workspaces"); });

function recoveryStorageKey(key, kind) {
  return kind === "local" ? key.startsWith("tc-run:") || key === "tc-runner-id" || key.startsWith("tc-model-") : key.startsWith("tc-review-") || key.startsWith("tc-planning-");
}
async function refreshAgentComponents() {
  if (!state.agentComponentsSupported) return;
  show($("#agent-components"));
  clearTimeout(state.componentRefreshTimer);
  const generation = state.componentRefreshGeneration = (state.componentRefreshGeneration || 0) + 1;
  try {
    const components = await api("/api/v1/agent-components");
    if (generation !== state.componentRefreshGeneration) return;
    const becameAvailable = components.some(item => item.available && state.agentComponents?.some(previous => previous.id === item.id && !previous.available));
    state.agentComponents = components;
    const root = $("#agent-components-list"), expanded = new Set([...root.querySelectorAll("details[open]")].map(node => node.dataset.component));
    root.replaceChildren();
    for (const item of components) {
      const row = document.createElement("section"); row.className = "agent-component-row"; row.dataset.componentId = item.id;
      const header = document.createElement("div"); header.className = "section-title";
      const title = document.createElement("strong"); title.textContent = item.label;
      const badge = document.createElement("span"); badge.className = `badge ${item.available ? "badge-success" : "badge-neutral"}`;
      const busy = item.operation?.phase === "installing";
      badge.textContent = busy ? "安装中" : item.available ? item.source === "managed" ? "组件已就绪" : "复用本机工具" : "尚未就绪";
      header.append(title, badge); row.append(header);
      const message = document.createElement("p"); message.className = "hint"; message.setAttribute("role", "status");
      message.textContent = busy ? item.operation.message : item.available ? "将复用此工具。可复制启动命令，在终端完成登录；检测到程序不代表已登录或模型可用。" : item.operation?.message || item.reason || "使用时再安装。"; row.append(message);
      const details = document.createElement("details"); details.dataset.component = item.id; details.open = expanded.has(item.id);
      const summary = document.createElement("summary"); summary.textContent = "路径与安装信息"; details.append(summary);
      for (const text of [item.executable ? `当前程序：${item.executable}` : "当前程序：未检测到", `按需安装：${item.package}@${item.version}`, `组件目录：${item.installDirectory}`, `官方说明：${item.docs}`]) { const line = document.createElement("p"); line.className = "hint"; line.textContent = text; details.append(line); }
      row.append(details);
      const actions = document.createElement("div"); actions.className = "button-row";
      if (item.available && item.executable) {
        const launch = document.createElement("button"); launch.type = "button"; launch.className = "button button-quiet"; launch.textContent = "复制启动命令";
        launch.addEventListener("click", async () => { const windows = state.environment?.platform === "win32", quoted = "'" + item.executable.replaceAll("'", windows ? "''" : "'\\''") + "'", text = (windows ? "& " : "") + quoted; try { await copyText(text); showToast("启动命令已复制。在终端运行并按工具提示登录。"); } catch { showCopyFallback("启动 Agent", text); } }); actions.append(launch);
      }
      if (!item.available && !busy) {
        const install = document.createElement("button"); install.type = "button"; install.className = "button button-primary"; install.textContent = "按需安装"; install.disabled = !item.canInstall;
        install.addEventListener("click", () => openAgentInstall(item)); actions.append(install);
      }
      if (busy) {
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button button-quiet"; cancel.textContent = "取消安装";
        cancel.addEventListener("click", async () => { cancel.disabled = true; try { await api(`/api/v1/agent-components/${item.id}/cancel`, { method: "POST", body: JSON.stringify({ operationId: item.operation.operationId }) }); await refreshAgentComponents(); } catch (error) { $("#agent-components-status").textContent = `取消未完成：${error.message}`; cancel.disabled = false; } }); actions.append(cancel);
      }
      const instructions = document.createElement("button"); instructions.type = "button"; instructions.className = "button button-quiet"; instructions.textContent = "复制手动安装说明";
      instructions.addEventListener("click", async () => { const text = `${item.label} 官方安装与登录说明：${item.docs}\n安装完成后回到系统设置点击“重新检测”，会优先复用本机工具。`; try { await copyText(text); showToast("手动安装说明已复制。"); } catch { showCopyFallback("手动安装说明", text); } }); if (!item.available) actions.append(instructions);
      row.append(actions); root.append(row);
    }
    $("#agent-components-status").textContent = "检测完成。规划、审查和执行使用相同的工具发现规则；不会自动安装或升级工具。";
    if (becameAvailable) void refreshAgentRunners();
    if (components.some(item => item.operation?.phase === "installing") && state.route?.page === "settings") state.componentRefreshTimer = setTimeout(() => void refreshAgentComponents(), 2000);
  } catch (error) { if (generation === state.componentRefreshGeneration) $("#agent-components-status").textContent = `组件状态读取未完成：${error.message}。可点击重新检测。`; }
}
function openAgentInstall(item) {
  state.componentInstallTarget = item.id;
  const root = $("#agent-component-install-details"); root.replaceChildren();
  for (const [label, text] of [["工具", item.label], ["官方包", item.package], ["固定版本", item.version], ["安装目录", item.installDirectory]]) { const term = document.createElement("dt"), value = document.createElement("dd"); term.textContent = label; value.textContent = text; root.append(term, value); }
  $("#agent-component-consent").checked = false; $("#agent-component-install-confirm").disabled = true; $("#agent-component-install-error").textContent = ""; $("#agent-component-dialog").showModal();
}
$("#agent-components-refresh").addEventListener("click", () => { void refreshAgentComponents(); void refreshAgentRunners(); });
$("#agent-component-consent").addEventListener("change", () => { $("#agent-component-install-confirm").disabled = !$("#agent-component-consent").checked; });
$("#agent-component-install-close").addEventListener("click", () => $("#agent-component-dialog").close());
$("#agent-component-install-confirm").addEventListener("click", async () => {
  if (!state.componentInstallTarget || !$("#agent-component-consent").checked) return;
  const button = $("#agent-component-install-confirm"); button.disabled = true;
  try {
    await api(`/api/v1/agent-components/${state.componentInstallTarget}/install`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    $("#agent-component-dialog").close(); await refreshAgentComponents();
  } catch (error) { $("#agent-component-install-error").textContent = `安装未提交：${error.message}`; button.disabled = false; }
});
async function refreshAgentRunners() {
  try { state.runners = await api("/api/v1/runners"); state.providers = await api("/api/v1/providers"); renderRunners(); renderProviders(); } catch { /* Availability remains unknown; leave current selections intact. */ }
}
function captureDesktopRecovery() {
  const storage = {};
  for (const [kind, source] of [["local", localStorage], ["session", sessionStorage]]) {
    storage[kind] = [];
    for (let index = 0; index < source.length; index++) {
      const key = source.key(index);
      if (key && recoveryStorageKey(key, kind)) storage[kind].push([key, source.getItem(key)]);
    }
  }
  const diagnosis = state.attemptDiagnosticContext;
  const inputs = new Map((state.desktopRecoveryPending?.value.inputs || []).map(input => [`${input.kind}:${input.workspaceId || ""}:${input.planningId || ""}:${input.identity || ""}`, input]));
  const remember = input => inputs.set(`${input.kind}:${input.workspaceId || ""}:${input.planningId || ""}:${input.identity || ""}`, input);
  if (state.workspace && state.planning) remember({ kind: "reply", workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, text: $("#reply-text").value });
  if (state.editingPlan && state.editBase) remember({ kind: "plan", workspaceId: state.editBase.workspaceId, planningId: state.editBase.planningId, base: state.editBase, text: $("#plan-editor").value });
  for (const [identity, text] of state.desktopRecoveredDiagnoses || []) remember({ kind: "diagnosis", identity, text });
  if (diagnosis) remember({ kind: "diagnosis", identity: diagnosis.identity, text: $("#attempt-diagnosis-reply")?.value ?? diagnosis.unsentText ?? "" });
  return JSON.stringify({ version: 1, route: location.hash || "#/connect", requestText: $("#request-text").value, storage,
    inputs: [...inputs.values()],
  });
}
function desktopConnectionChanged(value) {
  if (!window.tokenCouponDesktop?.reconnect) return;
  const busy = value.phase === "reconnecting";
  state.desktopReconnecting = busy;
  $("#desktop-reconnect").disabled = busy; $("#reconnect").disabled = busy;
  $("#reconnect").textContent = busy ? "正在重连…" : "重新连接后台";
  const lost = value.phase === "disconnected";
  show($("#desktop-connection-banner"), lost || busy || !!state.desktopRecoveryNotice);
  show($("#desktop-reconnect"), lost || busy);
  show($("#desktop-restore-inputs"), !!state.desktopRecoveryPending);
  $("#desktop-connection-title").textContent = busy ? "正在重新连接后台" : lost ? "本机后台已失联" : "后台已重新连接";
  $("#desktop-connection-message").textContent = value.error || (busy ? "正在核验后台身份并恢复页面。未提交内容暂存在内存中，不会自动保存、批准或重试任务。" : state.desktopRecoveryNotice || "");
  if (lost || busy) { $("#connection-dot").classList.remove("online"); $("#connection-label").textContent = busy ? "后台重新连接中" : "后台失联 · 可重新连接"; }
}
async function loadDesktopRecovery() {
  if (!window.tokenCouponDesktop?.getRecoveryState) return;
  const saved = await window.tokenCouponDesktop.getRecoveryState();
  if (!saved) return;
  if (state.desktopRecoveryPending?.id === saved.id) return;
  const value = JSON.parse(saved.snapshot);
  if (value?.version !== 1) return;
  state.desktopRecoveryPending = { id: saved.id, value };
  for (const [kind, target] of [["local", localStorage], ["session", sessionStorage]]) {
    for (const entry of value.storage?.[kind] || []) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && recoveryStorageKey(entry[0], kind)) target.setItem(entry[0], entry[1]);
    }
  }
}
async function restoreDesktopRecovery() {
  const saved = state.desktopRecoveryPending;
  if (!saved) return;
  const value = saved.value;
  if (!saved.globalRestored && typeof value.requestText === "string") { $("#request-text").value = value.requestText; globalThis.tokenCouponPlannerRequestComposer?.setValue(value.requestText); }
  saved.globalRestored = true;
  const samePlan = context => context?.workspaceId === state.workspace?.workspaceId && context?.planningId === state.planning?.planningId;
  const pending = [];
  for (const input of value.inputs || []) {
    if (typeof input?.text !== "string") continue;
    if (input.kind === "reply" && input.text) {
      if (samePlan(input)) { $("#reply-text").value = input.text; globalThis.tokenCouponReplyComposer?.setValue(input.text); }
      else pending.push(input);
    } else if (input.kind === "plan" && input.base) {
      if (samePlan(input) && samePlan(input.base) && state.planning?.draft && !state.planning.execution) {
        state.editBase = input.base; state.savedPlanText = state.editBase.text;
        $("#plan-editor").value = input.text; state.editingPlan = true;
        renderTextEditor(); renderPlanEditControls(); previewPlanDiff();
      } else pending.push(input);
    } else if (input.kind === "diagnosis" && typeof input.identity === "string") {
      state.desktopRecoveredDiagnoses ??= new Map(); state.desktopRecoveredDiagnoses.set(input.identity, input.text);
    }
  }
  state.desktopRecoveryNotice = pending.length ? "后台已连接。部分未提交内容属于其他计划或原计划已进入执行；内容仍保留，请打开原计划后点击恢复未提交内容。" : "未提交的需求、澄清和草案已恢复。请核对最新状态；没有自动保存、批准、回答或重试任务。";
  if (!pending.length) { await window.tokenCouponDesktop?.acknowledgeRecovery?.(saved.id); state.desktopRecoveryPending = null; }
  else state.desktopRecoveryPending.value = { ...value, inputs: pending };
  desktopConnectionChanged({ phase: "connected" });
}
async function reconnectDesktop() {
  if (!window.tokenCouponDesktop?.reconnect) { state.reconnectAttempts = 0; await init(); return; }
  if (state.desktopReconnecting) return;
  try {
    const snapshot = captureDesktopRecovery();
    desktopConnectionChanged({ phase: "reconnecting" });
    clearTimeout(state.reconnectTimer); state.eventSource?.close(); state.eventGeneration = (state.eventGeneration || 0) + 1;
    await window.tokenCouponDesktop.reconnect(snapshot);
  } catch (error) { desktopConnectionChanged({ phase: "disconnected", error: `重连未完成：${error.message}。内容保留，可再次重试。` }); }
}
window.addEventListener("token-coupon:desktop-reconnect", () => { void reconnectDesktop(); });
window.addEventListener("token-coupon:desktop-connection", event => desktopConnectionChanged(event.detail));

async function init() {
  try {
    await loadDesktopRecovery();
    if (window.tokenCouponDesktop) {
      try {
        state.desktopNotificationsEnabled = await window.tokenCouponDesktop.getNotificationsEnabled();
        $("#enable-notifications").textContent = state.desktopNotificationsEnabled ? "关闭桌面提醒" : "开启桌面提醒";
        $("#notification-status").textContent = state.desktopNotificationsEnabled ? "已开启：新审批到达且页面在后台时发送系统通知。" : "审批到达时显示页签提醒，可选择开启系统通知。";
      } catch { state.desktopNotificationsEnabled = false; }
    }
    const health = await api("/api/v1/health");
    applyDaemonHandshake(health);
    state.daemonEpoch = health.epoch;
    state.environment = health.workspaceEnvironment;
    if (state.systemSettingsSupported) state.systemSettings = await api("/api/v1/settings");
    if (health.mcp?.localReady) { $("#mcp-local-address").textContent = `本机 MCP 地址：${health.mcp.url}`; show($("#mcp-connection")); }
    const environment = state.environment;
    $("#workspace-path-help").textContent = environment?.isWsl
      ? `后台运行于 WSL${environment.distro ? `（${environment.distro}）` : ""}。支持 /home/…、~/…、D:\\…；Windows 路径会转换后检查。`
      : `后台运行于 ${environment?.platform || "本机"}，请填写后台可访问的绝对目录或 ~/目录。`;
    $("#use-current-directory").disabled = !environment?.currentDirectory;
    $("#connection-dot").classList.add("online"); $("#connection-label").textContent = "Daemon 已连接";
    [state.workspaces, state.providers, state.runners] = await Promise.all([api("/api/v1/workspaces"), api("/api/v1/providers"), api("/api/v1/runners")]);
    renderProviders(); renderRunners(); renderWorkspaces(); void preloadModelCatalogs();
    await refreshRemoteConnection();
    const firstUse = state.systemSettings && !state.systemSettings.initialized && !state.workspaces.length && !location.hash;
    state.initialSetup = !!firstUse;
    await applyRoute(firstUse ? "/settings" : location.hash.slice(1) || "/connect", true);
    if (!state.desktopRecoveryPending) await maybeNavigateToAuthorization();
    state.initialized = true;
    await restoreDesktopRecovery();
    if (window.tokenCouponDesktop?.getConnectionState) desktopConnectionChanged(await window.tokenCouponDesktop.getConnectionState());
    connectEvents();
    configureGlobalPending(); void globalThis.tokenCouponGlobalPending?.refresh();
  } catch (error) { disconnected(error); }
}
function applyDaemonHandshake(health) {
    state.agentComponentsSupported = health.capabilities?.agentComponents === 1;
    show($("#agent-components"), state.agentComponentsSupported);
    state.environment = health.workspaceEnvironment;
    state.executionSelectionSupported = health.capabilities?.executionSelection === 1;
    state.systemSettingsSupported = health.capabilities?.systemSettings === 1;
    state.operationRoutingSupported = health.capabilities?.operationRouting === 1;
    state.plannerProgressSupported = health.capabilities?.plannerProgress === 1;
    state.pendingQueueSupported = health.capabilities?.pendingQueue === 1;
    state.planningTodosSupported = health.capabilities?.planningTodos === 1;
    if (health.protocol && health.protocol.major !== 1) showToast("界面与后台协议不兼容，写操作已暂停。请更新后重新打开；当前仍可查看记录。", true);
}
function disconnected(error) { globalThis.tokenCouponGlobalPending?.unavailable(); $("#connection-dot").classList.remove("online"); $("#connection-label").textContent = "连接中断"; desktopConnectionChanged({ phase: "disconnected", error: error.message }); showToast(error.message || "无法连接本机服务", true); }
function renderProviders() {
  const select = $("#planner-provider"), standalone = [], local = [], api = [];
  for (const provider of state.providers) {
    if (["chatgpt-web", "chatgpt-mcp"].includes(provider.id) && state.providers.some(item => item.id === "web-mcp")) continue;
    const item = { id: provider.id, label: provider.available ? provider.label : `${provider.label} · 未连接`, disabled: !provider.available };
    if (isWebMcp(provider.id)) standalone.push(item);
    else if (provider.id.endsWith("-agent")) local.push(item);
    else api.push(item);
  }
  const allProviders = [...standalone, ...local, ...api];
  const preferred = allProviders.find(option => option.id === "web-mcp" && !option.disabled)?.id
    || allProviders.find(option => option.id === "chatgpt-mcp" && !option.disabled)?.id
    || allProviders.find(option => !option.disabled)?.id || "";
  if (!allProviders.some(option => option.id === state.plannerProviderId && !option.disabled)) state.plannerProviderId = preferred;
  const renderSelector = () => {
    const model = { standalone, localAgents: local, apiProviders: api, selectedProviderId: state.plannerProviderId || "" };
    if (globalThis.tokenCouponPlannerProviderSelector) {
      globalThis.tokenCouponPlannerProviderSelector.render(model, providerId => {
        state.plannerProviderId = providerId; update();
      });
      return;
    }
    select.replaceChildren();
    for (const option of standalone) { const entry = new Option(option.label, option.id, false, option.id === state.plannerProviderId); entry.disabled = option.disabled; select.add(entry); }
    for (const [items, label] of [[local, "本机 Agent（只读规划／审查）"], [api, "模型 API / 离线演示"]]) {
      if (!items.length) continue;
      const group = document.createElement("optgroup"); group.label = label;
      for (const option of items) { const entry = new Option(option.label, option.id, false, option.id === state.plannerProviderId); entry.disabled = option.disabled; group.append(entry); }
      select.append(group);
    }
    select.value = state.plannerProviderId || "";
    select.onchange = () => { state.plannerProviderId = select.value; update(); };
  };
  let modelOwner;
  const update = () => {
    const provider = globalThis.tokenCouponPlannerProviderSelector ? state.plannerProviderId : select.value, mcp = isWebMcp(provider);
    if (modelOwner !== provider) {
      if (modelOwner !== undefined) state.modelChoiceSelections.planner = "";
      modelOwner = provider;
    }
    state.plannerProviderId = provider;
    if (globalThis.tokenCouponPlannerProviderSelector) renderSelector();
    show($("#planner-model-wrap"), !mcp && provider !== "mock");
    show($("#web-planning-guide"), mcp); show($("#local-request-wrap"), !mcp); show($("#start-planning"), !mcp);
    $("#planning-entry-label").textContent = mcp ? "WEB PLANNING" : "NEW PLANNING";
    $("#planning-entry-step").textContent = mcp ? "执行配置" : "01 · 需求";
    $("#planning-entry-title").textContent = mcp ? "网页规划准备与执行配置" : "描述你想完成的工作";
    $("#new-task").textContent = "新建 Plan";
    $("#new-task-sidebar").textContent = "＋ 新建 Plan";
    $("#planner-model").placeholder = mcp ? "网页所选模型名称（仅记录）" : provider.endsWith("-agent") ? "选择本机模型或沿用 Runner 默认" : "输入自定义模型 ID";
    const current = mcp ? "" : provider === "mock" ? "mock" : state.providers.find(item => item.id === provider)?.model || "";
    renderModelPicker("planner", { models: current && current !== "mock" ? [{ id: current, label: `${current}（已配置）` }] : [], customAllowed: true }, current, mcp ? "在所选网页选择" : "使用已配置模型");
    setModelCatalogStatus("planner", mcp ? "此处仅记录名称；实际模型在对应网页中切换。" : provider.endsWith("-agent") ? "调用可能使用本机 Agent 登录账号的额度；规划在只读模式下运行，业务任务仍需单独审查、批准和执行。" : "可选择接口公布的模型，也可输入自定义 ID。");
    $("#planner-help").textContent = mcp ? "需求、文件调研、规划和审查在网页完成；这里配置执行、编辑草案、审批和观测。" : provider.endsWith("-agent") ? "开始后调用本机 Agent 一次；返回结果仍经过规划校验，草案需单独审查和批准。" : "按当前 API 或离线模拟配置生成草案。";
    $("#start-planning").textContent = mcp ? "登记需求，等待网页" : "开始规划";
    show($("#provider-notice"), false); void loadPlannerModels();
  };
  renderSelector();
  if (!globalThis.tokenCouponModelChoiceSelectors) $("#planner-model-choice").onchange = () => applyModelChoice("planner");
  update();
}
function renderRunners() {
  const select = $("#runner-id");
  const ordered = ["codex", "claude-code", "dsh", "mock"].flatMap(id => state.runners.filter(item => item.id === id));
  const options = ordered.map(runner => ({ id: runner.id, label: (labels[runner.id] || runner.id) + (runner.available ? "" : " · 未就绪"), disabled: !runner.available }));
  const stored = localStorage.getItem("tc-runner-id");
  const selectedRunnerId = stored && options.some(option => option.id === stored && !option.disabled) ? stored : ordered.find(runner => runner.id !== "mock" && runner.available)?.id || "mock";
  const renderSelector = runnerId => globalThis.tokenCouponRunnerSelector?.render({ options, selectedRunnerId: runnerId }, value => update(value));
  let modelOwner;
  const update = (requestedRunnerId = "") => {
    const runnerId = requestedRunnerId || (globalThis.tokenCouponRunnerSelector ? $("#runner-id").value : select.value);
    if (modelOwner !== runnerId) {
      if (modelOwner !== undefined) state.modelChoiceSelections.runner = "";
      modelOwner = runnerId;
    }
    state.runnerId = runnerId;
    localStorage.setItem("tc-runner-id", runnerId);
    if (globalThis.tokenCouponRunnerSelector) renderSelector(runnerId);
    renderModelPicker("runner", { models: [], customAllowed: runnerId !== "mock" }, localStorage.getItem("tc-model-" + runnerId) || "", "沿用 Runner 默认模型");
    void loadRunnerModels();
  };
  if (globalThis.tokenCouponRunnerSelector) renderSelector(selectedRunnerId);
  else {
    select.replaceChildren();
    for (const option of options) { const entry = new Option(option.label, option.id); entry.disabled = option.disabled; select.add(entry); }
    select.value = selectedRunnerId;
    select.onchange = () => update(select.value);
  }
  $("#runner-model").onchange = () => localStorage.setItem("tc-model-" + $("#runner-id").value, $("#runner-model").value.trim());
  if (!globalThis.tokenCouponModelChoiceSelectors) $("#runner-model-choice").onchange = () => { applyModelChoice("runner"); localStorage.setItem("tc-model-" + $("#runner-id").value, $("#runner-model").value.trim()); };
  update(selectedRunnerId);
}
function renderModelPicker(prefix, catalog, current, defaultLabel) {
  const select = $(`#${prefix}-model-choice`), input = $(`#${prefix}-model`);
  const choices = [
    { id: "", label: defaultLabel },
    ...(catalog.models || []).map(model => ({ id: model.id, label: `${model.label || model.id}${model.label && model.label !== model.id ? ` · ${model.id}` : ""}${model.isDefault ? "（工具推荐）" : ""}` })),
    ...(catalog.customAllowed ? [{ id: "__custom__", label: prefix === "planner" && isWebMcp($("#planner-provider").value) ? "记录网页模型名称…" : "自定义模型 ID…" }] : []),
  ];
  const currentIsChoice = current && choices.some(choice => choice.id === current);
  const remembersCustomChoice = ["planner", "runner", "reviewer"].includes(prefix) && state.modelChoiceSelections[prefix] === "__custom__";
  const selectedModelId = currentIsChoice ? current : current && catalog.customAllowed ? "__custom__" :
    (catalog.customAllowed && remembersCustomChoice ? "__custom__" : "");
  if (["planner", "runner", "reviewer"].includes(prefix) && globalThis.tokenCouponModelChoiceSelectors) {
    select.onchange = null;
    globalThis.tokenCouponModelChoiceSelectors.render(prefix, { choices, selectedModelId, loading: !!state.modelCatalogLoading?.[prefix] }, modelId => {
      state.modelChoiceSelections[prefix] = modelId;
      applyModelChoice(prefix);
      if (prefix === "runner") localStorage.setItem("tc-model-" + $("#runner-id").value, $("#runner-model").value.trim());
    });
  } else {
    select.replaceChildren(...choices.map(choice => new Option(choice.label, choice.id)));
    select.value = selectedModelId;
  }
  input.value = catalog.customAllowed || catalog.models?.some(model => model.id === current) ? current : "";
  show(input, selectedModelId === "__custom__"); input.dataset.customAllowed = String(!!catalog.customAllowed); input.disabled = !catalog.customAllowed || !!state.modelCatalogLoading?.[prefix];
  select.disabled = !!state.modelCatalogLoading?.[prefix];
}
function applyModelChoice(prefix) {
  const select = $(`#${prefix}-model-choice`), input = $(`#${prefix}-model`), custom = select.value === "__custom__";
  if (["planner", "runner", "reviewer"].includes(prefix)) state.modelChoiceSelections[prefix] = select.value;
  input.value = custom ? "" : select.value;
  show(input, custom); if (custom) input.focus();
}
const modelCatalogCache = new Map();
function cachedModelCatalog(identity, url, refresh = false) {
  const key = `${state.daemonEpoch}:${identity}`, previous = modelCatalogCache.get(key);
  if (!refresh && previous && previous.expiresAt > Date.now()) return previous.promise;
  const entry = { expiresAt: Infinity, promise: null };
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("读取模型目录超时，请刷新后重试。")); }, 25000); });
  entry.promise = Promise.race([api(url, { signal: controller.signal }), timeout]).then(catalog => {
    entry.expiresAt = Date.now() + (catalog.error ? 5000 : 120000);
    return catalog;
  }).catch(error => { if (modelCatalogCache.get(key) === entry) modelCatalogCache.delete(key); throw error; }).finally(() => clearTimeout(timer));
  modelCatalogCache.set(key, entry);
  return entry.promise;
}
function runnerModelCatalog(runnerId, workspaceId = "", refresh = false) {
  const params = new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(refresh ? { refresh: "1" } : {}) });
  return cachedModelCatalog(`runner:${runnerId}:${workspaceId}`, `/api/v1/runners/${encodeURIComponent(runnerId)}/models?${params}`, refresh);
}
function plannerModelCatalog(refresh = false) {
  return cachedModelCatalog("provider:deepseek-api", `/api/v1/providers/deepseek-api/models${refresh ? "?refresh=1" : ""}`, refresh);
}
function preloadModelCatalogs(workspaceId = "") {
  for (const runner of state.runners.filter(item => item.available && item.id !== "mock")) void runnerModelCatalog(runner.id, workspaceId).catch(() => {});
  if (state.providers.some(item => item.id === "deepseek-api" && item.available)) void plannerModelCatalog().catch(() => {});
}
function setModelPickerLoading(kind, loading) {
  state.modelCatalogLoading ??= {}; state.modelCatalogLoading[kind] = loading;
  const select = $(`#${kind}-model-choice`), input = $(`#${kind}-model`);
  if (select) { select.disabled = loading; select.setAttribute("aria-busy", String(loading)); }
  if (input) input.disabled = loading || input.dataset.customAllowed === "false";
}
function setModelCatalogStatus(kind, message, loading = false) {
  setModelPickerLoading(kind, loading);
  const bridge = globalThis.tokenCouponModelCatalogStatus;
  if (bridge) bridge.render(kind, { message, loading });
  else {
    const hint = $(`#${kind}-model-hint`);
    if (hint) hint.textContent = message;
    const refresh = $("#refresh-models");
    if (refresh && kind === "runner") { refresh.disabled = loading; refresh.textContent = loading ? "正在读取模型…" : "刷新模型列表"; }
  }
}
async function loadRunnerModels(refresh = false) {
  const runnerId = $("#runner-id").value; if (!runnerId) return;
  const workspaceId = state.workspace?.workspaceId || "";
  const sequence = state.runnerModelRequest = (state.runnerModelRequest || 0) + 1;
  setModelCatalogStatus("runner", "正在读取本机工具的模型目录…", true);
  const params = new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(refresh ? { refresh: "1" } : {}) });
  try {
    const catalog = await runnerModelCatalog(runnerId, workspaceId, refresh);
    if (sequence !== state.runnerModelRequest || runnerId !== $("#runner-id").value || workspaceId !== (state.workspace?.workspaceId || "")) return;
    renderModelPicker("runner", catalog, $("#runner-model").value.trim(), "沿用 Runner 默认模型");
    setModelCatalogStatus("runner", catalog.error || (runnerId === "mock" ? "离线模拟无需选择模型。" : `${catalog.models.length} 个候选模型，来自本机工具目录；实际调用仍取决于账户和接口。`));
  } catch (error) { if (sequence === state.runnerModelRequest) setModelCatalogStatus("runner", `${error.message}；仍可使用默认模型或自定义 ID。`); }
}
async function loadPlannerModels(refresh = false) {
  const sequence = state.plannerModelRequest = (state.plannerModelRequest || 0) + 1;
  const provider = $("#planner-provider").value;
  if (provider === "codex-agent" || provider === "claude-agent") {
    const runnerId = provider === "codex-agent" ? "codex" : "claude-code";
    const workspaceId = state.workspace?.workspaceId || "";
    const params = new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(refresh ? { refresh: "1" } : {}) });
    try {
      setModelCatalogStatus("planner", "正在读取本机工具的规划模型目录…", true);
      const catalog = await runnerModelCatalog(runnerId, workspaceId, refresh);
      if (sequence !== state.plannerModelRequest || provider !== $("#planner-provider").value) return;
      const selected = $("#planner-model").value.trim();
      renderModelPicker("planner", { ...catalog, models: [{ id: "runner-default", label: "沿用 Runner 默认模型", isDefault: true }, ...(catalog.models || [])], customAllowed: true }, selected || "runner-default", "沿用 Runner 默认模型");
      setModelCatalogStatus("planner", catalog.error || `${catalog.models.length} 个本机候选模型；选择只配置本次调用，不会启动模型。`);
    } catch (error) { if (sequence === state.plannerModelRequest) setModelCatalogStatus("planner", `${error.message}；可自定义模型 ID 或沿用 Runner 默认模型。`); }
    return;
  }
  if (provider !== "deepseek-api") { setModelCatalogStatus("planner", $("#planner-model-hint")?.textContent || "", false); return; }
  try {
    setModelCatalogStatus("planner", "正在读取规划模型目录…", true);
    const catalog = await plannerModelCatalog(refresh);
    if (sequence !== state.plannerModelRequest || $("#planner-provider").value !== "deepseek-api") return;
    renderModelPicker("planner", catalog, $("#planner-model").value.trim(), "使用已配置模型");
    setModelCatalogStatus("planner", catalog.error || "候选项来自当前 Planner 接口，可选或自定义模型 ID。");
  } catch (error) { if (sequence === state.plannerModelRequest) setModelCatalogStatus("planner", error.message); }
}
function renderWorkspaces() {
  const list = $("#workspace-list");
  const cards = $("#workspace-cards");
  const reactSwitcher = globalThis.tokenCouponWorkspaceSwitcher;
  if (!reactSwitcher) { list.replaceChildren(); cards.replaceChildren(); }
  if (!state.workspaces.length) {
    if (reactSwitcher) reactSwitcher.render([], undefined, selectWorkspace);
    else { list.innerHTML = '<div class="muted small" style="padding:8px">尚未添加项目</div>'; cards.innerHTML = '<div class="empty-state">添加一个项目目录，或先完成上一步连接。</div>'; }
    return;
  }
  for (const workspace of state.workspaces) {
    if (!reactSwitcher) {
      const button = document.createElement("button"); button.className = `workspace-item ${state.workspace?.workspaceId === workspace.workspaceId ? "active" : ""}`; button.innerHTML = `<span class="workspace-glyph">⌂</span><span>${esc(workspace.label)}</span>`;
      button.addEventListener("click", () => selectWorkspace(workspace.workspaceId)); list.append(button);
      const card = document.createElement("button"); card.className = `project-card ${state.workspace?.workspaceId === workspace.workspaceId ? "selected" : ""}`;
      card.innerHTML = `<span class="eyebrow">WORKSPACE</span><strong>${esc(workspace.label)}</strong><span class="muted small">${esc(workspace.path)}</span><span class="card-link">打开工作区 →</span>`;
      card.addEventListener("click", () => selectWorkspace(workspace.workspaceId));
      cards.append(card);
    }
  }
  reactSwitcher?.render(state.workspaces, state.workspace?.workspaceId, selectWorkspace);
}

function planningListStatus(planning) {
  const sessionStatus = planning.session?.status;
  const terminal = ["succeeded", "failed", "cancelled", "interrupted", "unavailable"];
  if (sessionStatus && terminal.includes(sessionStatus)) return { label: statuses[sessionStatus], tone: statusClass(sessionStatus) };
  const pending = planning.interactions || [];
  if (pending.length) return { label: pending.some(item => item.request?.kind === "approval") ? "待审批" : "待回答", tone: "badge-warning" };
  if (sessionStatus) return { label: statuses[sessionStatus] || "状态待核验", tone: statusClass(sessionStatus) };
  if (planning.turns?.at(-1)?.status === "running") return { label: "规划中", tone: "badge-warning" };
  if (planning.review?.status === "running") return { label: "审查中", tone: "badge-warning" };
  const stage = planning.workflow?.stage;
  const stages = {
    awaiting_approval: "待批准", approved: "待执行", awaiting_review: "待审查", review_stale: "待复审",
    review_prepared: "待网页审查", review_owned: "网页审查中", review_submitting: "审查校验中",
    plan_prepared: "待网页规划", plan_owned: "网页规划中", plan_submitting: "规划校验中", plan_needs_continue: "待继续规划",
  };
  if (stages[stage]) return { label: stages[stage], tone: stage === "approved" ? "badge-success" : "badge-warning" };
  const label = planning.status === "approved" ? "待执行" : planning.review?.current && planning.review.status === "succeeded" ? "待批准" : planning.draft ? "待审查" : "待规划";
  return { label, tone: "badge-neutral" };
}
function planningCreationTime(planning) {
  const value = planning.createdAt;
  const date = typeof value === "string" && value.trim() ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '<span class="planning-created">创建时间未记录</span>';
  const text = date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return `<time class="planning-created" datetime="${esc(date.toISOString())}" title="${esc(date.toLocaleString())}">创建 ${esc(text)}</time>`;
}
function renderPlanningList() {
  const root = $("#planning-list"), cards = $("#workspace-plan-cards");
  show($("#planning-nav-heading"), !!state.workspace);
  const reactPlanning = globalThis.tokenCouponPlanningSwitcher;
  if (reactPlanning) {
    state.planToolsExpanded ??= new Map();
    const items = state.plannings.map(planning => {
      const status = planningListStatus(planning);
      const identity = `${state.workspace.workspaceId}:${planning.planningId}`;
      return {
        planningId: planning.planningId,
        title: planning.draft?.plan?.title || planning.messages?.[0]?.content?.slice(0, 28) || "新规划",
        status: status.label,
        statusTone: status.tone,
        createdAt: planning.createdAt,
        taskCount: planning.draft?.plan?.tasks?.length || 0,
        selected: state.planning?.planningId === planning.planningId,
        workflowLabel: planning.workflow?.label,
        toolsExpanded: state.planToolsExpanded.get(identity) ?? (state.planning?.planningId === planning.planningId && ["models", "attempts"].includes(state.route?.tab)),
      };
    });
    reactPlanning.render(
      items,
      state.route?.tab,
      planningId => { void selectPlanning(planningId); },
      (planningId, tab) => { if (state.workspace) void navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/plans/${encodeURIComponent(planningId)}/${tab}`); },
      (planningId, expanded) => { if (state.workspace) state.planToolsExpanded.set(`${state.workspace.workspaceId}:${planningId}`, expanded); },
    );
    return;
  }
  root.replaceChildren(); cards.replaceChildren();
  for (const planning of state.plannings) {
    const button = document.createElement("button"); button.className = `workspace-item ${state.planning?.planningId === planning.planningId ? "active" : ""}`;
    const title = planning.draft?.plan?.title || planning.messages?.[0]?.content?.slice(0, 28) || "新规划";
    const status = planningListStatus(planning), created = planningCreationTime(planning);
    button.title = `${title} · ${planning.workflow?.label || status.label}`;
    button.innerHTML = `<span class="workspace-glyph" aria-hidden="true">↗</span><span class="planning-list-copy"><span class="planning-list-title">${esc(title)}</span><span class="planning-list-state badge ${status.tone}">${esc(status.label)}</span>${created}</span>`;
    button.setAttribute("aria-current", state.planning?.planningId === planning.planningId ? "page" : "false"); button.addEventListener("click", () => void selectPlanning(planning.planningId)); root.append(button);
    const tools = document.createElement("details"); tools.className = "plan-tools"; tools.dataset.planningId = planning.planningId;
    const identity = `${state.workspace.workspaceId}:${planning.planningId}`;
    state.planToolsExpanded ??= new Map(); tools.open = state.planToolsExpanded.get(identity) ?? (state.planning?.planningId === planning.planningId && ["models", "attempts"].includes(state.route?.tab));
    const summary = document.createElement("summary"); summary.textContent = "任务工具"; tools.append(summary);
    for (const [tab, label] of [["models", "切换模型"], ["attempts", "任务详情"]]) {
      const child = document.createElement("button"); child.className = "workspace-item plan-tool-link"; child.dataset.planTool = tab; child.textContent = label;
      child.setAttribute("aria-current", state.planning?.planningId === planning.planningId && state.route?.tab === tab ? "page" : "false");
      child.addEventListener("click", () => void navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/plans/${encodeURIComponent(planning.planningId)}/${tab}`)); tools.append(child);
    }
    tools.addEventListener("toggle", () => { if (tools.isConnected) state.planToolsExpanded.set(identity, tools.open); }); root.append(tools);
    const card = document.createElement("button"); card.className = `project-card ${state.planning?.planningId === planning.planningId ? "selected" : ""}`; card.setAttribute("aria-pressed", String(state.planning?.planningId === planning.planningId));
    card.innerHTML = `<span class="badge ${status.tone}">${esc(status.label)}</span><strong>${esc(title)}</strong><span class="muted small">${planning.draft?.plan?.tasks?.length || 0} 个任务</span>${created}<span class="card-link">打开计划 →</span>`;
    card.addEventListener("click", () => void selectPlanning(planning.planningId)); cards.append(card);
  }
  if (!state.plannings.length) cards.innerHTML = '<div class="empty-state">还没有 Plan。新建规划，或在网页通过 MCP 提交，之后会出现在这里。</div>';
}
function selectWorkspace(workspaceId) { return navigate(`/workspaces/${encodeURIComponent(workspaceId)}`); }
async function loadWorkspace(workspaceId, sequence = state.navigationSequence) {
  state.workspace = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId); state.planning = null; renderWorkspaces();
  state.referenceFile = null; state.referenceFiles = []; renderReference();
  $("#new-task").disabled = !state.workspace; $("#start-planning").disabled = !state.workspace; $("#copy-web-planning").disabled = !state.workspace; void loadRunnerModels(); void preloadModelCatalogs(state.workspace?.workspaceId || "");
  const plannings = await api(`/api/v1/workspaces/${workspaceId}/plannings`);
  if (state.workspace?.workspaceId !== workspaceId || sequence !== state.navigationSequence) return;
  state.plannings = plannings;
  renderPlanningList();
  void restorePlanningProgress(workspaceId, sequence);
}
function connectEvents() {
  clearTimeout(state.reconnectTimer);
  state.eventSource?.close();
  const generation = state.eventGeneration = (state.eventGeneration || 0) + 1;
  const connected = () => { if (generation === state.eventGeneration) $("#connection-label").textContent = "已连接，正在核对状态"; };
  const failed = () => {
    if (generation !== state.eventGeneration) return;
    globalThis.tokenCouponGlobalPending?.unavailable();
    state.eventSource?.close(); state.eventSource = null; $("#connection-dot").classList.remove("online");
    if (state.reconnectAttempts >= 5) { $("#connection-label").textContent = "需要重新连接"; desktopConnectionChanged({ phase: "disconnected" }); return; }
    $("#connection-label").textContent = "正在重连";
    const delay = Math.min(16000, 1000 * (2 ** state.reconnectAttempts)) + Math.floor(Math.random() * 250);
    state.reconnectAttempts += 1; state.reconnectTimer = setTimeout(connectEvents, delay);
  };
  state.eventSource = openEventStream(`/api/v1/events?after=${state.lastEventId}${state.daemonEpoch ? `&epoch=${encodeURIComponent(state.daemonEpoch)}` : ""}`, {
    onHello: event => { void reconcileDaemon(event, generation).catch(error => { if (generation === state.eventGeneration) { disconnected(error); failed(); } }); },
    onOpen: connected,
    onError: failed,
    onMessage: event => { if (generation === state.eventGeneration) consumeEvent(event); },
    eventTypes: ["job.started", "job.succeeded", "job.failed", "job.cancel_requested", "job.cancelled", "planning.progress", "planning.updated", "review.completed", "planning.approved", "execution.completed", "draft.saved", "draft.revised", "interaction.requested", "interaction.resolved", "runner.output", "task.activity", "workspace.registered", "external.prepared", "external.completed", "external.handoff", "remote_authorization.updated", "remote_authorization.pending", "remote_authorization.decided", "remote_authorization.revoked", "session.model.updated", "session.control_requested", "task.model-switch.waiting", "remote_connection.updated", "remote_connection.started", "remote_connection.stopped"],
  });
}
async function reconcileDaemon(event, generation) {
  const hello = JSON.parse(event.data);
  if (generation !== state.eventGeneration) return;
  state.eventReconciling = true;
  if (hello.epoch !== state.daemonEpoch || hello.resetReason) state.lastEventId = Number.isSafeInteger(hello.latestSequence) ? hello.latestSequence : 0;
  try {
    const health = await api("/api/v1/health");
    if (generation !== state.eventGeneration) return;
    if (hello.epoch !== health.epoch) throw new Error("daemon_epoch_changed：核对期间后台再次重启，请重新连接。");
    const changed = state.daemonEpoch !== health.epoch;
    applyDaemonHandshake(health);
    state.daemonEpoch = health.epoch;
    configureGlobalPending();
    if (changed || hello.resetReason) {
      state.loggedPlanEvents?.clear(); state.taskActivity = {};
    }
    // Only authoritative reads: do not re-submit any interrupted command or clear local inputs.
    const [workspaces, providers, runners] = await Promise.all([api("/api/v1/workspaces"), api("/api/v1/providers"), api("/api/v1/runners")]);
    if (generation !== state.eventGeneration) return;
    state.workspaces = workspaces; state.providers = providers; state.runners = runners;
    // Keep the current provider/model form controls and drafts untouched during a reconnect.
    renderWorkspaces();
    if (state.systemSettingsSupported) state.systemSettings = await api("/api/v1/settings");
    if (state.initialized) { await refreshAll(true); await readSelectedAttempt(); await refreshRemoteConnection(); }
    if (generation !== state.eventGeneration) return;
    state.reconnectAttempts = 0; $("#connection-dot").classList.add("online"); $("#connection-label").textContent = "Daemon 已连接 · 状态已核对";
    void globalThis.tokenCouponGlobalPending?.refresh();
    if (changed) showToast("后台已重新连接，已读取最新状态。未提交输入已保留，执行操作不会自动重放。");
  } finally { if (generation === state.eventGeneration) state.eventReconciling = false; }
}
function consumeEvent(event) {
  let data; try { data = JSON.parse(event.data); } catch { return; }
  const sequence = Number(event.lastEventId || data.sequence); if (Number.isFinite(sequence)) state.lastEventId = Math.max(state.lastEventId, sequence);
  if (state.eventReconciling || state.daemonEpoch && data.epoch !== state.daemonEpoch) return;
  if (data.type === "planning.progress") { consumePlanningProgress(data); return; }
  if (data.workspaceId === state.workspace?.workspaceId && data.planningId === state.planning?.planningId) logPlanEvent(data);
  if (data.type === "task.model-switch.waiting" && data.workspaceId === state.workspace?.workspaceId && data.planningId === state.planning?.planningId) { $("#job-label").textContent = data.payload?.message || "目标任务正在收尾，等待安全重试"; show($("#job-bar")); }
  if (data.type?.startsWith("remote_")) void refreshRemoteConnection();
  if (["interaction.requested", "interaction.resolved", "job.succeeded", "job.failed", "job.cancelled"].includes(data.type) && !state.pendingQueueRefreshTimer) {
    state.pendingQueueRefreshTimer = setTimeout(() => { state.pendingQueueRefreshTimer = null; void globalThis.tokenCouponGlobalPending?.refresh(); }, 200);
  }
  if (data.workspaceId === state.workspace?.workspaceId && (data.planningId === state.planning?.planningId || !data.planningId)) {
    if (data.type === "runner.output" || data.type === "task.activity") {
      if (!state.outputRefreshTimer) state.outputRefreshTimer = setTimeout(() => { state.outputRefreshTimer = null; void readSelectedAttempt(); }, 350);
      if (!state.sessionRefreshTimer) state.sessionRefreshTimer = setTimeout(() => { state.sessionRefreshTimer = null; void refreshAll(); }, 2500);
    } else void refreshAll();
  }
}
function logPlanEvent(data) {
  const identity = `${data.epoch}:${data.sequence}`;
  state.loggedPlanEvents ??= new Set();
  if (state.loggedPlanEvents.has(identity)) return;
  state.loggedPlanEvents.add(identity);
  if (state.loggedPlanEvents.size > 1000) state.loggedPlanEvents.delete(state.loggedPlanEvents.values().next().value);
  if (data.type === "runner.output") {
    const box = $("#event-log"), last = box.lastElementChild, group = `${data.taskId}:${data.payload?.attemptId || "legacy"}`;
    const text = data.payload?.text || ""; if (!text) return;
    if (last?.dataset.outputGroup === group) {
      const content = last.lastElementChild; content.textContent = (content.textContent + text).slice(0, 4096);
    } else { addLog(`${data.taskId || "Runner"}: ${text}`, "runner.output（片段摘要）", data.createdAt); box.lastElementChild.dataset.outputGroup = group; }
  }
  else if (data.type === "interaction.requested") addLog(`${data.payload?.owner?.runnerId || "Runner"} 等待人工输入：${data.payload?.request?.title || "交互请求"}`, data.type, data.createdAt);
  else addLog(`${data.type}${data.payload?.jobId ? ` · ${shortId(data.payload.jobId)}` : ""}`, data.type, data.createdAt);
}
async function loadPlanLogs() {
  if (!state.workspace || !state.planning) return;
  const workspaceId = state.workspace.workspaceId, planningId = state.planning.planningId;
  try {
    const result = await api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}/events`);
    if (workspaceId !== state.workspace?.workspaceId || planningId !== state.planning?.planningId) return;
    for (const event of result.events) logPlanEvent(event);
  } catch (error) { showToast(error.message, true); }
}
function addLog(text, type, createdAt) {
  const box = $("#event-log"); const empty = box.querySelector(".empty-state"); empty?.remove();
  const line = document.createElement("div"); line.className = "event-entry";
  const time = document.createElement("span"); time.className = "event-time"; time.textContent = (createdAt ? new Date(createdAt) : new Date()).toLocaleTimeString();
  const name = document.createElement("span"); name.className = "event-type"; name.textContent = type;
  const content = document.createElement("span"); content.className = "event-content"; content.textContent = text.slice(0, 4096);
  const level = /error|failed|denied|timeout|interrupted|cancelled/i.test(`${type} ${text}`) ? "error" : /succeeded|completed|approved/i.test(`${type} ${text}`) ? "success" : "normal";
  line.dataset.level = level; line.append(time, name, content); box.append(line);
  while (box.children.length > 150) box.firstElementChild.remove();
}

async function selectPlanning(planningId) {
  if (!state.workspace) return;
  const workspaceId = state.workspace.workspaceId, name = state.plannings.find(plan => plan.planningId === planningId)?.title || shortId(planningId);
  const token = state.selectionToken = key();
  $("#selection-feedback").textContent = `正在打开规划：${name}…`; $("#selection-feedback").setAttribute("aria-busy", "true"); show($("#selection-feedback"));
  await navigate(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planningId)}`);
  if (state.selectionToken !== token) return;
  $("#selection-feedback").setAttribute("aria-busy", "false");
  $("#selection-feedback").textContent = state.planning?.planningId === planningId ? `已打开：${state.planning.draft?.plan.title || name} · ${state.planning.workflow?.label || statuses[state.planning.session?.status] || statuses[state.planning.status]}` : "未切换规划；请查看提示或保留当前编辑。";
}
async function loadPlanning(planningId) {
  const item = state.plannings.find((plan) => plan.planningId === planningId); if (!item) return;
  const changed = planningId !== state.planning?.planningId;
  if (changed) { state.taskActivity = {}; state.attemptView = null; }
  const workspaceId = state.workspace.workspaceId, sequence = state.navigationSequence;
  const planning = await api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}`, { signal: AbortSignal.timeout(12000) });
  if (workspaceId !== state.workspace?.workspaceId || sequence !== state.navigationSequence || state.route?.planningId !== planningId) return;
  state.planning = planning;
  if (state.plannerProgressSupported && planning.localOperation) {
    const operation = planning.localOperation;
    if (!state.activeJob || state.activeJob.jobId === operation.jobId) acceptPlanningJob(operation);
  }
  sessionStorage.setItem(`tc-planning-${state.workspace.workspaceId}`, planningId);
  renderPlanningList();
  if (changed) { for (const details of document.querySelectorAll("#overview-tab details")) details.open = false; $("#plan-logs-details").open = false; $("#event-log").replaceChildren(); state.loggedPlanEvents = new Set(); }
  if (changed) renderPlanning(); else preserveExecutionReading(renderPlanning);
}
// Refresh changes the data, not the user's reading position or keyboard focus.
function preserveExecutionReading(render) {
  if (state.route?.page !== "plan" || !["execution", "models", "attempts"].includes(state.route.tab)) return render();
  const active = document.activeElement, scrollX = window.scrollX, scrollY = window.scrollY;
  const taskId = active?.closest(".task-row")?.dataset.taskId;
  const taskButton = taskId ? [...active.closest(".task-row").querySelectorAll("button")].indexOf(active) : -1;
  const selection = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const selectors = ".task-row,.attempt-message,#attempt-tools details,#attempt-state,#session-health,#runtime-model-panel,#attempt-reader";
  const candidates = [...document.querySelectorAll(selectors)].filter(el => {
    const rect = el.getBoundingClientRect(); let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    // A long reply can extend far beyond a scroll box; clipped text is not a page anchor.
    for (let parent = el.parentElement; parent && parent !== document.body && bottom > top; parent = parent.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) { const clip = parent.getBoundingClientRect(); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    }
    return rect.height > 0 && bottom > top;
  });
  const anchor = candidates.sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top))[0];
  const top = anchor?.getBoundingClientRect().top;
  render();
  if (active && !active.isConnected && document.activeElement === document.body) {
    const replacement = active.id ? document.getElementById(active.id) : taskId ? [...document.querySelectorAll(".task-row")].find(row => row.dataset.taskId === taskId)?.querySelectorAll("button")[taskButton] : null;
    replacement?.focus({ preventScroll: true });
    if (selection && replacement?.setSelectionRange) replacement.setSelectionRange(...selection);
  }
  const targetY = anchor?.isConnected ? window.scrollY + anchor.getBoundingClientRect().top - top : scrollY;
  if (window.scrollY !== targetY || window.scrollX !== scrollX) window.scrollTo({ left: scrollX, top: targetY, behavior: "instant" });
}
function verificationCandidates(plan, projected) {
  if (Array.isArray(projected)) return projected.filter(item => item.valid).map(item => ({ taskId: item.taskId, title: item.title || item.taskId }));
  const entries = plan?.tasks || [], byId = new Map(entries.map(entry => [entry.task.id, entry]));
  return entries.filter(({ task }) => {
    if (entries.some(entry => entry.dependsOn.includes(task.id))) return false;
    const ancestors = new Set();
    const visit = id => { for (const dependency of byId.get(id)?.dependsOn || []) if (!ancestors.has(dependency)) { ancestors.add(dependency); visit(dependency); } };
    visit(task.id);
    return entries.every(entry => entry.task.id === task.id || ancestors.has(entry.task.id));
  }).map(entry => ({ taskId: entry.task.id, title: entry.task.title }));
}
function runConfigurationStorageKey(plan) {
  return `tc-run:${state.workspace.workspaceId}:${plan.planningId}:${plan.draft?.draftRevision}:${plan.draft?.planHash}`;
}
function defaultRunConfiguration(plan) {
  const candidates = verificationCandidates(plan.draft?.plan, plan.verificationTasks);
  return { mode: "default", isolation: "git-worktree", maxParallel: 1, verificationTaskId: candidates.length === 1 ? candidates[0].taskId : "", needsReconfirm: false, edited: false };
}
async function refreshGitReadiness(force = false) {
  const workspaceId = state.workspace?.workspaceId; if (!workspaceId) return false;
  if (!force && state.gitReadiness?.workspaceId === workspaceId && Date.now() - state.gitReadiness.checkedAt < 15000) return state.gitReadiness.state === "ready";
  if (state.gitChecking === workspaceId) return false;
  state.gitChecking = workspaceId;
  try {
    const result = await api(`/api/v1/workspaces/${workspaceId}/git`);
    if (state.workspace?.workspaceId !== workspaceId) return false;
    state.gitReadiness = { ...result, workspaceId, checkedAt: Date.now() };
  } catch (error) {
    state.gitReadiness = { workspaceId, state: "error", checkedAt: Date.now(), message: `无法读取 Git 准备状态：${error.message}` };
  } finally { if (state.gitChecking === workspaceId) state.gitChecking = null; }
  if (state.workspace?.workspaceId === workspaceId) renderRunConfiguration();
  return state.gitReadiness.workspaceId === workspaceId && state.gitReadiness.state === "ready";
}
function renderGitReadiness(needed) {
  show($("#git-readiness"), needed);
  if (!needed) { if ($("#git-files-dialog").open) finishGitFileSelection(); return true; }
  const data = state.gitReadiness?.workspaceId === state.workspace?.workspaceId ? state.gitReadiness : null;
  if (state.gitResultWorkspace !== state.workspace?.workspaceId) $("#git-commit-result").textContent = "";
  $("#git-workspace-path").textContent = `工作区：${state.workspace?.path || ""}`;
  $("#git-readiness-message").textContent = data?.message || "正在检查 Git 仓库、首次提交和运行记录…";
  $("#git-readiness").classList.toggle("git-ready", data?.state === "ready");
  $("#git-readiness-commands").textContent = (data?.commands || []).join("\n");
  $("#git-readiness-paths").textContent = (data?.paths || []).join("\n");
  show($("#git-manual-help"), !!(data?.commands?.length || data?.paths?.length));
  const identity = data?.identity, identityPanel = $("#git-identity");
  show(identityPanel, !!data && !["not_repository", "wrong_root", "error"].includes(data.state));
  if (state.gitIdentityWorkspace !== state.workspace?.workspaceId) {
    state.gitIdentityWorkspace = state.workspace?.workspaceId; state.gitIdentitySignature = null;
    $("#git-name").value = ""; $("#git-email").value = ""; $("#git-identity-error").textContent = "";
  }
  const identitySignature = JSON.stringify(identity);
  if (state.gitIdentitySignature !== identitySignature) {
    state.gitIdentitySignature = identitySignature;
    identityPanel.open = identity?.configured === false;
    $("#git-name").value = identity?.name || ""; $("#git-email").value = identity?.email || "";
  }
  $("#git-identity-summary").textContent = identity?.configured ? "Git 身份已就绪 · 修改本仓库身份" : "设置本仓库 Git 身份";
  $("#git-identity-status").textContent = identity?.configured ? `已读取有效 Git 配置${identity.name ? `：${identity.name} <${identity.email}>` : ""}，无需重复填写。` : identity?.configured === false ? "创建提交前需要填写姓名和邮箱。保存只影响此仓库，不修改全局配置。" : "填写后仅保存到此仓库；已有 Git 配置也可直接复用。";
  const actions = $("#git-readiness-actions"); actions.replaceChildren();
  $("#git-steps").textContent = `检查仓库 → 检查基线 → 处理变更 → 就绪 · 当前：${({ not_repository: "等待初始化", no_commit: "等待首次提交", metadata_tracked: "修复运行记录跟踪", dirty: "等待确认提交", ready: "全部完成" })[data?.state] || "检查中／需处理"}`;
  const selection = $("#git-file-selection"), files = $("#git-file-list");
  const signature = JSON.stringify([state.workspace?.workspaceId, data?.changes]);
  show(selection, !!data && !["wrong_root", "error"].includes(data.state));
  const nativeExplorer = !!window.tokenCouponDesktop?.openWorkspaceFolder;
  $("#git-open-system").disabled = !nativeExplorer;
  if (state.gitExplorerWorkspace !== state.workspace?.workspaceId) { state.gitExplorerWorkspace = state.workspace?.workspaceId; $("#git-system-status").textContent = ""; }
  $("#git-open-system").title = nativeExplorer ? "打开后台电脑上的工作区文件夹" : "文件资源管理器入口仅在桌面应用中可用；浏览器中仍可浏览和选择变更文件";
  if (state.gitFilesSignature !== signature) {
    state.gitFilesSignature = signature; files.replaceChildren();
    state.gitFileChanges = (data?.changes || []).filter(item => !item.runtime);
    const available = new Set(state.gitFileChanges.map(item => item.path));
    if (state.gitSelectionWorkspace !== state.workspace?.workspaceId) {
      if ($("#git-files-dialog").open) finishGitFileSelection();
      state.gitSelectionWorkspace = state.workspace?.workspaceId; state.gitSelectedPaths = new Set(); $("#git-files-filter").value = "";
    }
    state.gitSelectedPaths = new Set([...(state.gitSelectedPaths || [])].filter(path => available.has(path)));
    renderGitFileTree(state.gitFileChanges, files);
  }
  if (data?.state === "dirty" && data.changes?.some(item => item.runtime && item.code === "D ")) {
    const button = document.createElement("button"); button.type = "button"; button.className = "button button-primary"; button.textContent = "查看运行记录变更并提交";
    button.disabled = !!state.activeJob; button.addEventListener("click", () => previewGitFromUI("runtime")); actions.append(button);
  }
  if (data?.state === "dirty" && data.changes?.some(item => item.runtime && item.code === "??")) {
    const protect = document.createElement("button"); protect.type = "button"; protect.className = "button button-quiet"; protect.textContent = "恢复运行记录忽略规则";
    protect.addEventListener("click", () => prepareGitFromUI("protect-runtime")); actions.append(protect);
  }
  const options = { not_repository: ["initialize", "初始化 Git 仓库"], no_commit: ["initial-commit", "创建空的首次提交"], metadata_tracked: ["untrack-runtime", "取消跟踪运行记录（保留文件）"] };
  if (options[data?.state]) {
    const [action, text] = options[data.state], button = document.createElement("button"); button.type = "button"; button.className = "button button-primary"; button.textContent = text; button.dataset.gitAction = action;
    button.disabled = !!state.activeJob || (action === "initial-commit" && identity?.configured === false);
    button.addEventListener("click", () => prepareGitFromUI(action)); actions.append(button);
    if (action === "initial-commit" && identity?.configured === false) { const note = document.createElement("span"); note.className = "field-error"; note.textContent = "先在下方保存 Git 姓名和邮箱，再创建首次提交。"; actions.append(note); }
  }
  if (data?.state === "wrong_root" && data.repositoryRoot) {
    const button = document.createElement("button"); button.type = "button"; button.className = "button button-primary"; button.textContent = "选择仓库根目录";
    button.addEventListener("click", () => void openWorkspaceForm()); actions.append(button);
  }
  if (data && data.state !== "ready") {
    const help = document.createElement("button"); help.type = "button"; help.className = "button button-quiet"; help.textContent = "我手工处理，查看说明"; help.addEventListener("click", () => { $("#git-manual-help").open = true; }); actions.append(help);
  }
  if (state.route?.tab === "execution" && state.gitChecking !== state.workspace?.workspaceId && (!data || Date.now() - data.checkedAt >= 15000)) void refreshGitReadiness();
  return data?.state === "ready";
}
function renderGitFileTree(changes, root) {
  root.replaceChildren();
  const query = $("#git-files-filter").value.trim().normalize("NFKC").toLocaleLowerCase();
  changes = changes.filter(item => !query || item.path.normalize("NFKC").toLocaleLowerCase().includes(query));
  if (state.gitSelectionWorkspace !== state.workspace?.workspaceId) { state.gitSelectionWorkspace = state.workspace?.workspaceId; state.gitSelectedPaths = new Set(); }
  const tree = { dirs: new Map(), files: [] }, allPaths = changes.map(item => item.path);
  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean); let node = tree;
    for (const part of parts.slice(0, -1)) { if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], name: part }); node = node.dirs.get(part); }
    node.files.push(change);
  }
  const selectAll = document.createElement("label"); selectAll.className = "git-tree-select-all";
  const all = document.createElement("input"); all.type = "checkbox"; all.dataset.allFiles = "true"; all.checked = allPaths.length > 0 && allPaths.every(path => state.gitSelectedPaths.has(path));
  all.addEventListener("change", () => { for (const path of allPaths) all.checked ? state.gitSelectedPaths.add(path) : state.gitSelectedPaths.delete(path); for (const input of root.querySelectorAll("input[data-file-path]")) input.checked = all.checked; updateGitFolderChecks(root); });
  selectAll.append(all, document.createTextNode(`${query ? "全选搜索结果" : "全选本次变更"}（${allPaths.length} 个文件）`)); root.append(selectAll);
  const makeFile = change => {
    const label = document.createElement("label"); label.className = "git-tree-file";
    const input = document.createElement("input"); input.type = "checkbox"; input.dataset.filePath = change.path; input.checked = state.gitSelectedPaths.has(change.path);
    input.addEventListener("change", () => { if (input.checked) state.gitSelectedPaths.add(change.path); else state.gitSelectedPaths.delete(change.path); updateGitFolderChecks(root); });
    const status = change.staged ? "已暂存" : change.code === "??" ? "未跟踪" : "未暂存";
    const name = document.createElement("span"); name.className = "git-tree-file-name"; name.textContent = change.path.split("/").at(-1); name.title = change.path;
    const statusLabel = document.createElement("span"); statusLabel.className = "git-tree-file-status"; statusLabel.textContent = `${status}${change.staged && change.unstaged ? " · 另有修改，需手工处理" : ""}`;
    label.title = change.path; label.append(input, name, statusLabel); return label;
  };
  const renderNode = (node, parent, prefix = "") => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name, details = document.createElement("details"), summary = document.createElement("summary"), label = document.createElement("label");
      details.className = "git-tree-folder"; details.open = !!query; label.className = "git-tree-folder-label";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.folderPath = path;
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => { const matches = allPaths.filter(file => file.startsWith(`${path}/`)); for (const file of matches) checkbox.checked ? state.gitSelectedPaths.add(file) : state.gitSelectedPaths.delete(file); details.querySelectorAll("input[data-file-path]").forEach(input => input.checked = checkbox.checked); updateGitFolderChecks(root); });
      label.append(checkbox, document.createTextNode(`${name}/`));
      const count = document.createElement("span"); count.className = "git-tree-folder-count"; count.textContent = `${allPaths.filter(file => file.startsWith(`${path}/`)).length} 项`;
      summary.append(label, count); details.append(summary);
      const children = document.createElement("div"); children.className = "git-tree-children";
      renderNode(child, children, path); details.append(children); parent.append(details);
    }
    for (const file of node.files) parent.append(makeFile(file));
  };
  renderNode(tree, root);
  if (!changes.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = query ? "没有匹配的变更文件。已选文件仍会保留。" : "当前没有可提交的项目文件变更；可使用文件资源管理器查看目录。"; root.append(empty); }
  updateGitFolderChecks(root);
}
function gitChangeLabel(code) {
  if (code === "??") return "新文件 · 尚未跟踪";
  if (code === "!!") return "已忽略";
  if (code?.includes("U") || ["AA", "DD"].includes(code)) return "合并冲突";
  const labels = [["R", "重命名"], ["C", "复制"], ["D", "删除"], ["A", "新增"], ["M", "修改"], ["T", "文件类型变更"]];
  return labels.filter(([flag]) => code?.includes(flag)).map(([, label]) => label).join("、") || "文件变更";
}
function updateGitFolderChecks(root) {
  const count = state.gitSelectedPaths?.size || 0, total = state.gitFileChanges?.length || 0;
  $("#git-file-selection-summary").textContent = `${total} 个项目文件有变更 · 已选 ${count} 个`;
  $("#git-files-count").textContent = `已选 ${count} / ${total} 个文件`;
  $("#git-preview-selected").disabled = count === 0 || !!state.activeJob;
  const files = [...root.querySelectorAll("input[data-file-path]")], selected = files.filter(input => input.checked).length, all = root.querySelector("input[data-all-files]");
  if (all) { all.checked = files.length > 0 && selected === files.length; all.indeterminate = selected > 0 && selected < files.length; }
  for (const folder of root.querySelectorAll(".git-tree-folder")) {
    const inputs = [...folder.querySelectorAll("input[data-file-path]")], count = inputs.filter(input => input.checked).length, checkbox = folder.querySelector("input[data-folder-path]");
    if (checkbox) { checkbox.checked = inputs.length > 0 && count === inputs.length; checkbox.indeterminate = count > 0 && count < inputs.length; }
  }
}
async function prepareGitFromUI(action) {
  const descriptions = { initialize: "只初始化 Git 仓库，不提交项目文件。", "initial-commit": "只创建空基线，不保存已有项目文件；暂存区非空时会拒绝。已有项目文件仍需单独提交，才能启动 worktree。", "untrack-runtime": "仅从 Git 索引移除 .token-coupon 的跟踪记录，本机对话、计划和运行文件都会保留。下一步在本页预览并确认提交。", "protect-runtime": "只恢复本机运行记录的忽略规则，不提交、不删除文件。" };
  if (!await askConfirm("确认 Git 准备操作", `${state.workspace?.path}\n${descriptions[action]}`, "确认执行")) return;
  const job = await startJob("准备 Git", requestKey => api(`/api/v1/workspaces/${state.workspace.workspaceId}/git`, { method: "POST", body: JSON.stringify({ requestKey, action, confirmed: true }) }), true);
  await refreshGitReadiness(true);
  if (job?.status === "succeeded") show($("#page-error"), false);
}
async function previewGitFromUI(mode) {
  if (!state.workspace || state.activeJob) return;
  const workspaceId = state.workspace.workspaceId;
  try {
    const paths = [...(state.gitSelectedPaths || [])];
    const preview = await api(`/api/v1/workspaces/${workspaceId}/git/preview`, { method: "POST", body: JSON.stringify({ mode, paths }) });
    if (workspaceId !== state.workspace?.workspaceId) return;
    state.gitPreview = { ...preview, workspaceId };
    $("#git-preview-summary").textContent = `${state.workspace.path} · ${preview.paths.length} 个文件 · ${preview.head === "unborn" ? "首次提交" : `基线 ${preview.head.slice(0, 8)}`}`;
    const box = $("#git-preview-content"); box.replaceChildren();
    for (const item of preview.previews) {
      const details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre"); details.className = "foldout";
      const status = document.createElement("span"), path = document.createElement("span");
      status.className = "git-preview-status"; status.textContent = gitChangeLabel(item.code);
      path.textContent = `${item.path}${item.truncated ? " · 预览已截断，请手工核对完整文件" : ""}`;
      summary.append(status, path); pre.textContent = item.text; details.append(summary, pre); box.append(details);
    }
    $("#git-commit-message").value = preview.suggestedMessage;
    const missingIdentity = state.gitReadiness?.workspaceId === workspaceId && state.gitReadiness.identity?.configured === false;
    $("#git-preview-error").textContent = missingIdentity ? "可以预览文件；提交前请关闭预览，在 Git 身份区域填写姓名和邮箱并保存。" : "";
    $("#git-confirm-commit").disabled = missingIdentity;
    $("#git-preview-dialog").showModal();
  } catch (error) { showToast(error.message, true); }
}
async function confirmGitCommit() {
  const preview = state.gitPreview;
  if (!preview || preview.workspaceId !== state.workspace?.workspaceId) return;
  const button = $("#git-confirm-commit"); button.disabled = true;
  try {
    const job = await startJob("提交 Git 变更", requestKey => api(`/api/v1/workspaces/${preview.workspaceId}/git/commit`, { method: "POST", body: JSON.stringify({ requestKey, confirmed: true, mode: preview.mode, paths: preview.paths, fingerprint: preview.fingerprint, message: $("#git-commit-message").value }) }), true);
    if (job?.status === "succeeded") {
      $("#git-preview-dialog").close(); state.gitPreview = null;
      state.gitResultWorkspace = preview.workspaceId;
      $("#git-commit-result").textContent = `已创建本地提交 ${job.result.commit.slice(0, 8)}；未推送、未启动任务。`;
      show($("#page-error"), false);
    } else $("#git-preview-error").textContent = job?.error || $("#page-error-message").textContent || "提交未确认成功，请检查状态后重试。";
    await refreshGitReadiness(true);
  } finally { button.disabled = false; }
}
function runExecutionSelection(config, plan) {
  const choice = task => ({ runnerId: task.execution.runnerId, ...(task.execution.modelId ? { modelId: task.execution.modelId } : {}) });
  if (config.agentMode === "unified") return { defaults: config.agentDefaults || choice(plan.tasks[0].task), ...((config.agentOverrides || []).length ? { tasks: config.agentOverrides.filter(item => plan.tasks.some(entry => entry.task.id === item.taskId)) } : {}) };
  if (config.agentMode === "per-task") return { tasks: plan.tasks.map(({ task }) => ({ taskId: task.id, ...((config.agentTasks || []).find(item => item.taskId === task.id) || choice(task)) })) };
  return undefined;
}
function launchExecutionForTask(task, selection) {
  const choice = selection?.tasks?.find(item => item.taskId === task.id) || selection?.defaults;
  return choice || task.execution;
}
function renderRunAgents(config, plan) {
  let section = $("#run-agent-configuration");
  if (!section) {
    section = document.createElement("fieldset"); section.id = "run-agent-configuration"; section.className = "run-agent-configuration";
    section.innerHTML = '<legend>本次执行 Runner／模型</legend><label class="compact-label">配置方式<div id="run-agent-mode-root"><select id="run-agent-mode"><option value="plan">沿用已批准草案</option><option value="unified">统一配置所有任务</option><option value="per-task">逐任务单独配置</option></select></div></label><div id="run-agent-defaults"></div><details id="run-agent-overrides"><summary>单独配置个别任务（可选）</summary><div id="run-agent-task-list"></div></details><p class="hint">只影响本次 Session 的 Runner／模型；任务正文、依赖及工具审批沿用已批准草案。模型留空使用所选 Runner 的本机默认。</p>';
    $("#run-configuration-summary").after(section);
    if (!globalThis.tokenCouponRunAgentMode) $("#run-agent-mode").addEventListener("change", () => updateRunAgentMode($("#run-agent-mode").value));
  }
  section.disabled = !!state.activeJob || !!state.runInFlight;
  const mode = config.agentMode || "plan";
  const modeOptions = [
    { id: "plan", label: "沿用已批准草案", disabled: false },
    { id: "unified", label: "统一配置所有任务", disabled: !state.executionSelectionSupported },
    { id: "per-task", label: "逐任务单独配置", disabled: !state.executionSelectionSupported },
  ];
  if (globalThis.tokenCouponRunAgentMode) {
    globalThis.tokenCouponRunAgentMode.render({ options: modeOptions, selectedMode: mode }, updateRunAgentMode);
  } else {
    for (const option of $("#run-agent-mode").options) if (option.value !== "plan") option.disabled = !state.executionSelectionSupported;
    $("#run-agent-mode").value = mode;
  }
  let supportNote = $("#run-agent-support-note");
  if (!supportNote) { supportNote = document.createElement("p"); supportNote.id = "run-agent-support-note"; supportNote.className = "hint"; supportNote.setAttribute("role", "status"); section.append(supportNote); }
  show(supportNote, !state.executionSelectionSupported); supportNote.textContent = "当前后台尚未加载运行模型选择功能，请正常重启后台并刷新此页面。仍可沿用已批准草案运行。";
  const signature = JSON.stringify([state.runConfigKey, mode]);
  if (section.dataset.signature === signature) {
    if (mode === "unified") $("#run-agent-overrides > summary").textContent = config.agentOverrides?.length ? `单独配置个别任务（已设置 ${config.agentOverrides.length} 项）` : "单独配置个别任务（可选）";
    for (const hint of section.querySelectorAll(".run-agent-inherited")) hint.textContent = `沿用统一配置：${labels[config.agentDefaults?.runnerId] || config.agentDefaults?.runnerId || ""} / ${config.agentDefaults?.modelId || "Runner 默认模型"}`;
    return;
  }
  section.dataset.signature = signature;
  const defaults = $("#run-agent-defaults"), list = $("#run-agent-task-list"), overrides = $("#run-agent-overrides"); disposeAgentSelectionControls(defaults); disposeAgentSelectionControls(list); defaults.replaceChildren(); list.replaceChildren();
  show(defaults, mode === "unified"); show(overrides, mode !== "plan"); overrides.open = mode === "per-task";
  overrides.querySelector("summary").textContent = mode === "per-task" ? `逐任务配置（${plan.tasks.length} 项）` : config.agentOverrides?.length ? `单独配置个别任务（已设置 ${config.agentOverrides.length} 项）` : "单独配置个别任务（可选）";
  if (mode === "plan") return;
  const key = state.runConfigKey, current = () => state.runConfigKey === key && state.runConfiguration === config;
  const remember = () => { if (!current()) return; config.edited = true; state.runRequestKey = null; renderRunConfiguration(); };
  const original = task => ({ runnerId: task.execution.runnerId, ...(task.execution.modelId ? { modelId: task.execution.modelId } : {}) });
  if (mode === "unified") {
    config.agentDefaults ||= original(plan.tasks[0].task);
    const controls = createAgentSelectionControls(config.agentDefaults, value => { if (current()) { config.agentDefaults = value; remember(); } }, current);
    defaults.append(controls.root); void controls.load();
  }
  for (const [index, { task }] of plan.tasks.entries()) {
    const row = document.createElement("details"); row.className = "run-agent-task"; row.dataset.taskId = task.id;
    const heading = document.createElement("summary"); heading.textContent = `任务 ${index + 1}：${task.title}`; row.append(heading);
    const hint = document.createElement("p"); hint.className = "hint"; row.append(hint);
    const property = mode === "unified" ? "agentOverrides" : "agentTasks";
    const stored = (config[property] || []).find(item => item.taskId === task.id);
    const custom = document.createElement("input"); custom.type = "checkbox"; custom.checked = mode === "per-task" || !!stored; custom.dataset.taskOverride = task.id;
    const toggle = document.createElement("label"); toggle.className = "run-agent-override-toggle"; toggle.append(custom, document.createTextNode("为此任务单独配置")); if (mode === "unified") row.append(toggle);
    const host = document.createElement("div"); row.append(host); let controls;
    const update = value => { if (!current()) return; config[property] = [...(config[property] || []).filter(item => item.taskId !== task.id), { taskId: task.id, ...value }]; hint.textContent = `${labels[value.runnerId] || value.runnerId} / ${value.modelId || "Runner 默认模型"}`; remember(); };
    const showControls = () => {
      show(host, custom.checked);
      if (custom.checked && !controls) {
        const initial = stored || (mode === "unified" ? config.agentDefaults : original(task));
        controls = createAgentSelectionControls(initial, update, current); host.append(controls.root); void controls.load();
      }
      hint.classList.toggle("run-agent-inherited", !custom.checked);
      const value = custom.checked ? controls?.value() || stored || original(task) : config.agentDefaults;
      hint.textContent = `${custom.checked ? "" : "沿用统一配置："}${labels[value?.runnerId] || value?.runnerId || ""} / ${value?.modelId || "Runner 默认模型"}`;
    };
    custom.addEventListener("change", () => { showControls(); if (custom.checked) update(controls.value()); else { config[property] = (config[property] || []).filter(item => item.taskId !== task.id); remember(); } });
    row.addEventListener("toggle", () => { if (row.open) showControls(); });
    const initial = stored || (mode === "unified" ? config.agentDefaults : original(task)); hint.textContent = `${mode === "unified" && !stored ? "沿用统一配置：" : ""}${labels[initial.runnerId] || initial.runnerId} / ${initial.modelId || "Runner 默认模型"}`;
    if (mode === "unified" && !stored) hint.classList.add("run-agent-inherited");
    list.append(row);
  }
}
function updateRunAgentMode(mode) {
  if (!state.runConfiguration || !["plan", "unified", "per-task"].includes(mode)) return;
  state.runConfiguration.agentMode = mode;
  state.runConfiguration.edited = true;
  state.runRequestKey = null;
  renderRunConfiguration();
}
function renderRunConfiguration() {
  const plan = state.planning;
  const root = $("#run-configuration");
  if (!plan) { show(root, false); return; }
  const approved = plan.status === "approved" && plan.approval?.planHash === plan.draft?.planHash && !!plan.review?.current && plan.workflow?.role !== "plan";
  const sessionExists = !!plan.execution || !!plan.session;
  show(root, approved && !sessionExists);
  $("#run-button").disabled = !approved || sessionExists || !!state.activeJob;
  if (sessionExists) {
    $("#run-configuration-status").textContent = "Session 参数已固定";
    $("#run-configuration-status").className = "badge badge-neutral";
  }
  if (!approved || sessionExists || !plan.draft) return;
  const key = runConfigurationStorageKey(plan);
  const identity = { planningId: plan.planningId, draftRevision: plan.draft.draftRevision, planHash: plan.draft.planHash };
  if (state.runConfigKey !== key) {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(key) || "null"); } catch { stored = null; }
    const previous = state.runConfigIdentity?.planningId === plan.planningId ? state.runConfiguration : null;
    state.runConfiguration = stored || (previous ? { ...previous, mode: "", needsReconfirm: true } : defaultRunConfiguration(plan));
    state.runConfiguration.needsReconfirm = !!state.runConfiguration.needsReconfirm;
    state.runConfigKey = key; state.runConfigIdentity = identity;
    if (previous && !stored) { try { localStorage.setItem(key, JSON.stringify(state.runConfiguration)); } catch { /* Local preferences are optional. */ } }
  }
  const config = state.runConfiguration;
  renderRunAgents(config, plan.draft.plan);
  const candidates = verificationCandidates(plan.draft.plan, plan.verificationTasks);
  if (globalThis.tokenCouponRunModeSelector) {
    const radios = [...document.querySelectorAll('input[name="run-mode-choice"]')];
    const options = radios.map(radio => ({ id: radio.value, title: radio.closest("label")?.querySelector("strong")?.textContent || radio.value, description: radio.closest("label")?.querySelector("small")?.textContent || "" }));
    globalThis.tokenCouponRunModeSelector.render({ options, selectedMode: config.mode || "" }, mode => persistRunConfiguration(mode, true));
  } else {
    const radio = document.querySelector(`input[name="run-mode-choice"][value="${config.mode}"]`);
    for (const item of document.querySelectorAll('input[name="run-mode-choice"]')) item.checked = item === radio;
  }
  show($("#run-custom-fields"), config.mode === "custom");
  const previousVerification = config.verificationTaskId;
  const verificationOptions = candidates.length
    ? candidates.map(candidate => ({ id: candidate.taskId, label: `${candidate.title} · ${candidate.taskId}` }))
    : [{ id: "", label: "没有满足依赖要求的最终验证任务" }];
  const selectedVerification = candidates.some(item => item.taskId === previousVerification) ? previousVerification : candidates.length === 1 ? candidates[0].taskId : "";
  const parallelOptions = [...$("#run-parallel").options].map(option => ({ id: option.value, label: option.textContent || option.value }));
  const isolationOptions = [...$("#run-isolation").options].map(option => ({ id: option.value, label: option.textContent || option.value }));
  config.verificationTaskId = selectedVerification;
  if (globalThis.tokenCouponRunParameters) {
    globalThis.tokenCouponRunParameters.render({
      parallelOptions, selectedParallel: String(config.maxParallel || 1), isolationOptions, selectedIsolation: config.isolation || "git-worktree",
      verificationOptions, selectedVerification, showVerification: config.isolation !== "shared",
    }, (field, value) => persistRunConfiguration(undefined, true, { field, value }));
  } else {
    const verification = $("#run-verification");
    verification.replaceChildren(...verificationOptions.map(option => new Option(option.label, option.id)));
    verification.value = selectedVerification;
    $("#run-parallel").value = String(config.maxParallel || 1);
    $("#run-isolation").value = config.isolation || "git-worktree";
  }
  const shared = config.isolation === "shared";
  if (!globalThis.tokenCouponRunParameters) show($("#run-verification-wrap"), !shared);
  const selection = runExecutionSelection(config, plan.draft.plan);
  const taskModes = [...new Set(plan.draft.plan.tasks.map(({ task }) => { const execution = launchExecutionForTask(task, selection); return `${labels[execution.runnerId] || execution.runnerId}${execution.modelId ? ` / ${execution.modelId}` : " / Runner 默认模型"}`; }))];
  $("#run-configuration-summary").textContent = `${config.needsReconfirm ? "草案版本已变化，旧参数仅供参考；请重新选择默认或自定义后再启动。 " : ""}批准草案：draft-${plan.approval.draftRevision}。本次 Runner／模型：${taskModes.join("；") || "未设置"}。启动配置独立保存在 Session，任务内容和依赖沿用已批准草案。`;
  $("#run-configuration-status").textContent = config.needsReconfirm ? "参数待重新确认" : config.mode ? "已批准，待配置启动" : "批准后待配置";
  $("#run-configuration-status").className = `badge ${config.needsReconfirm ? "badge-warning" : "badge-success"}`;
  let error = "";
  if (selection && !state.executionSelectionSupported) error = "当前后台不支持所选 Runner／模型配置，请重启后台并刷新页面后再运行。";
  else if (config.needsReconfirm || !config.mode) error = "请明确选择默认参数或自定义参数，然后点击“确认参数并运行”。";
  else if (config.mode === "default" && !candidates.length) error = "计划没有满足最终验证规则的任务；可选择自定义共享工作区，或修订草案的任务依赖。";
  else if (config.isolation === "shared" && Number(config.maxParallel) !== 1) error = "共享工作区只支持并发 1，请修正参数。";
  else if (config.isolation === "git-worktree" && !candidates.some(item => item.taskId === config.verificationTaskId)) error = "请选择依赖图合法的最终验证任务。";
  const gitReady = renderGitReadiness(config.isolation === "git-worktree");
  $("#run-configuration-error").textContent = error || (!gitReady ? `暂不能运行：${state.gitReadiness?.workspaceId === state.workspace?.workspaceId ? state.gitReadiness.message : "正在检查 Git 准备状态。"}` : state.activeJob || state.runInFlight ? "正在处理当前操作，请等待完成。" : "");
  $("#run-configuration-error").classList.toggle("is-git-blocked", !gitReady);
  $("#run-button").disabled = !!error || !gitReady || !!state.activeJob || !!state.runInFlight;
  try { localStorage.setItem(key, JSON.stringify(config)); } catch { /* Run preferences remain in memory. */ }
  state.runConfigDirty = !!config.edited && !config.needsReconfirm;
}
function startNewTask() {
  if (!state.workspace) return;
  state.resetPlanningPolicy = true;
  return navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/new`);
}
function refreshSnapshot() {
  return JSON.stringify([state.workspaces.map(w => [w.workspaceId, w.label]), state.plannings.map(p => [p.planningId, p.revision, p.status]), state.planning?.revision,
    state.planning?.session?.status, state.remoteStatus?.transport, state.remoteStatus?.validGrants, state.remoteStatus?.clients]);
}
async function manualRefresh() {
  if (state.manualRefresh) return state.manualRefresh;
  const button = $("#refresh"), feedback = $("#refresh-feedback"), navigation = state.navigationSequence, before = refreshSnapshot();
  const scope = state.planning?.draft?.plan?.title || state.workspace?.label || "当前页面";
  button.disabled = true; button.textContent = "正在刷新…"; feedback.textContent = "正在更新当前页面状态…"; show($("#refresh-feedback-wrap"));
  const tasks = [
    ["工作区与计划", async () => {
      if (state.workspace) await refreshAll(true);
      else { const rows = await api("/api/v1/workspaces", { signal: AbortSignal.timeout(12000) }); if (navigation === state.navigationSequence) { state.workspaces = rows; renderWorkspaces(); } }
    }],
    ["连接与授权", async () => { await refreshRemoteConnection(true); if (state.authorizationsFresh === false) throw new Error("网页授权状态未更新"); }],
    ...(globalThis.tokenCouponGlobalPending?.refreshChecked ? [["待处理状态", () => globalThis.tokenCouponGlobalPending.refreshChecked()]] : []),
  ];
  state.manualRefresh = (async () => {
    const results = await Promise.allSettled(tasks.map(([, run]) => run()));
    const failures = results.flatMap((result, i) => result.status === "rejected" ? [`${tasks[i][0]}：${result.reason?.message || "读取失败"}`] : []);
    const current = navigation === state.navigationSequence;
    const prefix = current ? "" : `${scope} · `;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    feedback.textContent = failures.length ? `${prefix}${failures.length === tasks.length ? "刷新失败" : "部分刷新失败"}：${failures.join("；")}。未更新部分保留上次状态，请重试。` : `${prefix}刷新成功${before === refreshSnapshot() ? " · 状态无变化" : ""} · ${time}`;
    feedback.dataset.kind = failures.length ? "warning" : "success";
    if (!failures.length) { state.lastManualRefreshAt = time; $("#refresh-last-success").textContent = `最近成功 ${time}${current ? "" : ` · ${scope}`}`; }
    show($("#refresh-feedback-wrap"));
  })().finally(() => { state.manualRefresh = null; button.disabled = false; button.textContent = "刷新状态"; });
  return state.manualRefresh;
}
async function refreshAll(rethrow = false) {
  if (!state.workspace) return;
  try {
    const workspaceId = state.workspace.workspaceId, navigation = state.navigationSequence;
    const plannings = await api(`/api/v1/workspaces/${workspaceId}/plannings`, { signal: AbortSignal.timeout(12000) });
    if (state.workspace?.workspaceId !== workspaceId || navigation !== state.navigationSequence) return;
    state.plannings = plannings;
    renderPlanningList();
    const id = state.planning?.planningId;
    if (id && state.plannings.some((plan) => plan.planningId === id) && state.route?.page === "plan") await loadPlanning(id);
    renderWorkspaceAccess();
  } catch (error) { showToast(error.message, true); if (rethrow === true) throw error; }
}
function renderPlanning() {
  const plan = state.planning; if (!plan) return;
  $("#planning-title").textContent = plan.draft?.plan?.title || (plan.messages?.[0]?.content || "规划详情").slice(0, 70);
  $("#planning-meta").textContent = `Planning ${shortId(plan.planningId)} · revision ${plan.revision} · ${plan.config.provider} / ${plan.config.model}`;
  let sourceLink = $("#planning-source-link");
  if (!sourceLink) { sourceLink = document.createElement("a"); sourceLink.id = "planning-source-link"; sourceLink.className = "planning-source-link hint"; $("#planning-meta").parentElement.after(sourceLink); }
  show(sourceLink, !!plan.sourcePlanning);
  if (plan.sourcePlanning) { sourceLink.textContent = `修订自 ${shortId(plan.sourcePlanning.planningId)} · 原草案 draft-${plan.sourcePlanning.draftRevision} · 查看原记录`; sourceLink.href = `#/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/plans/${encodeURIComponent(plan.sourcePlanning.planningId)}`; }
  $("#planning-status").textContent = plan.workflow?.label || statuses[plan.session?.status] || statuses[plan.status] || plan.session?.status || plan.status;
  $("#planning-status").className = `badge ${statusClass(plan.session?.status || plan.status)}`;
  const conversationMessages = (plan.messages || []).slice(-30).map((message, index) => ({
    messageId: String(message.messageId || `message-${index}`), roleClass: message.role === "user" ? "user" : "assistant",
    label: message.role === "user" ? "你" : "Planner", content: message.content,
  }));
  const pendingInputs = [...new Map((plan.externalOperations || []).filter((operation) => operation.role === "plan" && ["prepared", "stale", "interrupted", "failed"].includes(operation.state) && operation.message && !(plan.messages || []).some((message) => message.messageId === operation.sourceMessageId)).reverse().map(operation => [operation.sourceMessageId || operation.operationId, operation])).values()];
  const pendingMessages = pendingInputs.map(operation => ({
    messageId: String(operation.sourceMessageId || operation.operationId), roleClass: "user",
    label: `你 · ${externalOperationState(operation) === "prepared" ? "已登记，等待网页" : "已登记，需要继续处理"}`, content: operation.message,
  }));
  const messageItems = [...conversationMessages, ...pendingMessages];
  const conversationModel = { count: (plan.messages?.length || 0) + pendingInputs.length, messages: messageItems };
  if (globalThis.tokenCouponConversationView) globalThis.tokenCouponConversationView.render(conversationModel);
  else {
    $("#turn-count").textContent = `${conversationModel.count} 条`;
    const conversation = $("#conversation"); conversation.replaceChildren();
    for (const message of messageItems) {
      const item = document.createElement("article"); item.className = `message ${message.roleClass}`;
      const label = document.createElement("div"), content = document.createElement("div"); label.className = "message-label"; label.textContent = message.label; content.textContent = message.content; item.append(label, content); conversation.append(item);
    }
    if (!conversation.children.length) conversation.innerHTML = '<div class="empty-state">本轮还没有对话内容。</div>';
  }
  renderRequirements(); renderDraft(); renderReview(); renderSession(); renderInteractions(); renderRunConfiguration();
  renderExternalOperations(); renderHandoffs();
  renderReviewerControls(plan);
  const canEdit = !!plan.draft && !plan.execution;
  $("#configure-task-agents").disabled = !canEdit;
  $("#toggle-plan-edit").disabled = !canEdit || state.savingPlan; $("#review-button").disabled = !plan.draft || !!plan.execution || !!state.activeJob;
  $("#approve-button").disabled = !plan.draft || !plan.review?.current || plan.workflow?.role === "plan" || plan.status === "approved" || plan.status === "execution_created" || !!plan.execution;
  renderPlanOverview();
  renderPlanWorkflowBanner();
  show($("#waiver-label"), !!plan.review?.current && plan.review.findings?.some(item => item.severity === "error") && !plan.approval);
}
function renderPlanWorkflowBanner() {
  const plan = state.planning; if (!plan) return;
  const banner = $("#plan-workflow-banner"); banner.replaceChildren();
  const heading = document.createElement("strong"); heading.textContent = plan.workflow?.label || $("#planning-status").textContent;
  const detail = document.createElement("p"); detail.textContent = plan.workflow?.role ? plan.workflow.detail : state.planNextAction || $("#plan-next-action").textContent;
  banner.append(heading, detail);
  const lastTurn = plan.turns?.at(-1);
  if (["codex-agent", "claude-agent"].includes(plan.config.provider) && !plan.execution && !plan.localOperation?.progress && ["failed", "timed_out", "cancelled", "interrupted"].includes(lastTurn?.status) && !(plan.externalOperations || []).some(item => ["prepared", "submitting"].includes(item.state))) {
    const note = document.createElement("p"); note.textContent = `上次规划轮次${statuses[lastTurn.status] || lastTurn.status}（${lastTurn.reasonCode || "原因见轮次日志"}）。可保留 Planning 和原始输入重试，无需新建规划。`;
    const retry = document.createElement("button"); retry.id = "retry-planning-turn"; retry.type = "button"; retry.className = "button button-primary"; retry.textContent = "重试原规划";
    retry.disabled = state.submittingJob || state.activeJob?.status === "running";
    const workspaceId = state.workspace.workspaceId, planningId = plan.planningId;
    retry.onclick = () => { if (state.workspace?.workspaceId === workspaceId && state.planning?.planningId === planningId) void startJob("重试规划", requestKey => api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}/planner-retry`, { method: "POST", body: JSON.stringify({ requestKey }) })); };
    banner.append(note, retry);
  }
  if (plan.approval && plan.approval.planHash === plan.draft?.planHash) {
    const approval = document.createElement("p"); approval.textContent = `已批准 draft-${plan.approval.draftRevision} · ${new Date(plan.approval.approvedAt).toLocaleString()} · 审查 ${shortId(plan.approval.reviewId)}`; banner.append(approval);
    if (!plan.execution && plan.review?.current && plan.workflow?.role !== "plan") { const run = document.createElement("button"); run.className = "button button-primary"; run.textContent = "查看配置并运行计划"; run.onclick = () => planTab("execution"); banner.append(run); }
  }
  if (plan.workflow?.approvalNotice) { const notice = document.createElement("p"); notice.textContent = plan.workflow.approvalNotice; banner.append(notice); }
  if (state.route?.tab === "draft" && (plan.workflow?.role === "plan" || selectedOperationIsWeb("review")) && !plan.execution && (!plan.approval || !plan.review?.current || plan.workflow?.role === "plan") && (!plan.review?.current || plan.workflow?.role === "plan")) {
    const resume = document.createElement("button"); resume.className = "button button-primary"; resume.textContent = "复制继续当前计划并复审提示"; resume.onclick = copyResumePrompt; banner.append(resume);
  }
  banner.classList.toggle("notice-success", !!plan.approval && !!plan.review?.current && !plan.execution && plan.workflow?.role !== "plan");
  show($("#waiver-label"), !!plan.review?.current && plan.review.findings?.some(item => item.severity === "error") && !plan.approval);
}

function renderReviewerControls(plan) {
  let select = $("#reviewer-mode");
  const button = $("#review-button");
  const setReviewerMode = mode => {
    localStorage.setItem("tc-reviewer-mode", mode);
    $("#reviewer-model").value = "";
    state.modelChoiceSelections.reviewer = "";
    state.reviewerModelMode = "";
  };
  if (!select) {
    const controls = document.createElement("div"); controls.className = "review-run-controls";
    const methodLabel = document.createElement("label"); methodLabel.className = "compact-label"; methodLabel.textContent = "审查方式";
    select = document.createElement("select"); select.id = "reviewer-mode";
    for (const [value, label] of [["planning", "沿用规划方式"], ["codex-agent", "Codex 本机 Agent"], ["claude-agent", "Claude Code 本机 Agent"], ["deepseek-api", "DeepSeek API"], ["web-chatgpt", "ChatGPT 网页 MCP"], ["web-claude", "Claude 网页 MCP"]]) select.add(new Option(label, value));
    methodLabel.append(select); controls.append(methodLabel);
    const modelLabel = document.createElement("label"); modelLabel.id = "reviewer-model-wrap"; modelLabel.className = "compact-label"; modelLabel.textContent = "审查模型";
    const modelChoiceRoot = document.createElement("div"); modelChoiceRoot.id = "reviewer-model-choice-root";
    const modelChoice = document.createElement("select"); modelChoice.id = "reviewer-model-choice";
    const modelInput = document.createElement("input"); modelInput.id = "reviewer-model"; modelInput.maxLength = 120; modelInput.placeholder = "沿用 Runner 默认模型";
    modelChoiceRoot.append(modelChoice); modelLabel.append(modelChoiceRoot, modelInput); controls.append(modelLabel);
    button.parentElement.insertBefore(controls, button);
    const hint = document.createElement("p"); hint.id = "reviewer-mode-hint"; hint.className = "hint"; button.parentElement.parentElement.insertBefore(hint, button.parentElement.nextSibling);
  }
  if (!$("#reviewer-model-choice")) {
    let choiceRoot = $("#reviewer-model-choice-root");
    if (!choiceRoot) { choiceRoot = document.createElement("div"); choiceRoot.id = "reviewer-model-choice-root"; $("#reviewer-model").before(choiceRoot); }
    const choice = document.createElement("select"); choice.id = "reviewer-model-choice"; choiceRoot.append(choice);
  }
  if (!select.dataset.bound) {
    select.dataset.bound = "true";
    if (!globalThis.tokenCouponReviewerModeSelector) select.onchange = () => { setReviewerMode(select.value); renderReviewerControls(state.planning); };
    if (!globalThis.tokenCouponModelChoiceSelectors) $("#reviewer-model-choice").addEventListener("change", () => applyModelChoice("reviewer"));
  }
  const reviewKey = `${plan.planningId}:${state.systemSettings?.revision || 0}`;
  if (state.reviewerPolicyKey !== reviewKey && functionPolicy("review")) {
    const policy = functionPolicy("review");
    select.value = policy.priority === "web" ? `web-${policy.webSource}` : policy.agent.runnerId === "claude-code" ? "claude-agent" : "codex-agent";
    $("#reviewer-model").value = policy.priority === "agent" ? policy.agent.modelId || "" : "";
    state.reviewerModelMode = ""; state.reviewerPolicyKey = reviewKey;
  }
  const stored = functionPolicy("review") ? null : localStorage.getItem("tc-reviewer-mode");
  if (stored && [...select.options].some(option => option.value === stored)) select.value = stored;
  if (globalThis.tokenCouponReviewerModeSelector) {
    select.onchange = null;
    globalThis.tokenCouponReviewerModeSelector.render({ options: [...select.options].map(option => ({ id: option.value, label: option.textContent || option.value })), selectedMode: select.value || "planning" }, mode => {
      setReviewerMode(mode);
      queueMicrotask(() => renderReviewerControls(state.planning));
    });
  } else {
    select.onchange = () => { setReviewerMode(select.value); renderReviewerControls(state.planning); };
  }
  const mode = select.value || "planning";
  const web = mode === "web-chatgpt" || mode === "web-claude" || mode === "planning" && isWebMcp(plan.config.provider);
  const model = ["codex-agent", "claude-agent", "deepseek-api", "web-chatgpt", "web-claude"].includes(mode);
  show($("#reviewer-model-wrap"), model);
  $("#review-button").textContent = web ? plan.workflow?.role === "review" ? "继续当前审查" : plan.review?.current ? "重新准备网页审查" : "准备网页审查" : mode === "codex-agent" ? "使用 Codex 审查" : mode === "claude-agent" ? "使用 Claude Code 审查" : "运行审查";
  const hints = {
    planning: isWebMcp(plan.config.provider) ? "沿用当前网页规划方式；点击后在网页领取审查操作。" : isLocalPlanner(plan.config.provider) ? "沿用本机 Agent，调用可能使用已登录账号额度；只读审查，不写文件、不审批、不执行任务。" : "沿用当前 API／离线规划方式；提交后立即调用所选模型。",
    "codex-agent": "调用可能使用本机 Codex 登录账号的额度；使用 read-only sandbox 审查，不修改计划或运行项目任务。",
    "claude-agent": "调用可能使用本机 Claude Code 登录账号的额度；使用 Plan 模式审查，不修改计划或运行项目任务。",
    "deepseek-api": "使用 DeepSeek Planner API 审查；会消耗 API 用量。",
    "web-chatgpt": "准备 ChatGPT 网页 MCP 审查；需在获准的 ChatGPT 会话领取并提交。",
    "web-claude": "准备 Claude 网页 MCP 审查；需在获准的 Claude 会话领取并提交。",
  };
  $("#reviewer-mode-hint").textContent = hints[mode] || "请选择审查方式。";
  if (mode !== state.reviewerModelMode) {
    state.modelChoiceSelections.reviewer = "";
    state.reviewerModelMode = mode;
    void runReviewModelCatalog(mode);
  }
  renderReviewContinuation();
  if (state.planning) { renderPlanOverview(); renderPlanWorkflowBanner(); }
}

async function runReviewModelCatalog(mode) {
  const sequence = state.reviewerModelRequest = (state.reviewerModelRequest || 0) + 1;
  let existing = $("#reviewer-model")?.value.trim() || "";
  const workspaceId = state.workspace?.workspaceId || "";
  const config = state.planning?.config;
  const effective = mode === "planning" ? config?.provider === "deepseek" ? "deepseek-api" : config?.provider : mode;
  if (state.reviewerModelOwner !== undefined && state.reviewerModelOwner !== effective) existing = "";
  state.reviewerModelOwner = effective;
  const local = effective === "codex-agent" || effective === "claude-agent";
  const loading = local || effective === "deepseek-api";
  setModelPickerLoading("reviewer", loading);
  let hint = $("#reviewer-model-loading-hint");
  if (!hint) { hint = document.createElement("small"); hint.id = "reviewer-model-loading-hint"; hint.className = "hint"; hint.setAttribute("role", "status"); $("#reviewer-model-wrap").append(hint); }
  hint.textContent = loading ? "正在加载模型…" : "";
  const current = () => sequence === state.reviewerModelRequest && $("#reviewer-mode")?.value === mode && workspaceId === (state.workspace?.workspaceId || "");
  try {
    if (local) {
      const catalog = await runnerModelCatalog(effective === "codex-agent" ? "codex" : "claude-code", workspaceId);
      if (!current()) return;
      renderModelPicker("reviewer", { ...catalog, models: [{ id: "runner-default", label: "沿用 Runner 默认模型", isDefault: true }, ...(catalog.models || [])], customAllowed: true }, existing || "runner-default", "沿用 Runner 默认模型");
    } else if (effective === "deepseek-api") {
      const catalog = await plannerModelCatalog();
      if (!current()) return;
      renderModelPicker("reviewer", catalog, existing || config?.model || "", "使用已配置模型");
    } else if (mode.startsWith("web-")) renderModelPicker("reviewer", { models: [], customAllowed: true }, existing, "网页中选择模型");
    else renderModelPicker("reviewer", { models: [], customAllowed: false }, "", "沿用规划模型");
    if (current()) hint.textContent = "";
  } catch {
    if (current()) {
      renderModelPicker("reviewer", { models: [], customAllowed: true }, existing || (local ? "runner-default" : ""), "沿用默认模型");
      hint.textContent = "目录暂不可读，可使用默认模型或自定义模型 ID。";
    }
  } finally { if (current()) setModelPickerLoading("reviewer", false); }
}

function isLocalPlanner(provider) { return provider === "codex-agent" || provider === "claude-agent"; }
function renderHandoffs() {
  const root = $("#handoff-panel"); if (!root) return;
  const web = isWebMcp(state.planning.config.provider) || (state.planning.handoffs || []).length > 0;
  root.replaceChildren(); show(root, web);
  if (!web) return;
  const heading = document.createElement("h3"); heading.textContent = "网页规划与审查交接"; root.append(heading);
  for (const slot of state.planning.handoffs || []) {
    const card = document.createElement("article"); card.className = "handoff-card";
    const title = document.createElement("strong"); title.textContent = `${slot.role === "plan" ? "规划" : "审查"} · ${slot.target === "chatgpt" ? "ChatGPT" : slot.target === "claude" ? "Claude" : slot.target}`;
    const line = document.createElement("p");
    const ownerLabel = slot.owner ? state.grants?.find(grant => grant.grantId === slot.owner.grantId)?.alias || slot.owner.source || "已授权网页" : slot.completedBy?.source || "";
    const activity = slot.owner?.lastActivity || slot.updatedAt;
    line.textContent = `${slot.state === "succeeded" ? "✓ 已提交" : slot.owner ? slot.owner.expired ? "领取已到期" : "已领取处理中" : "等待网页领取"} · ${ownerLabel ? `处理来源 ${ownerLabel} · ` : ""}${slot.pendingInputs} 条待处理输入`;
    const meta = document.createElement("p"); meta.className = "hint"; meta.textContent = `接手码 ${slot.code}${activity ? ` · 最近活动 ${new Date(activity).toLocaleTimeString()}` : ""}`;
    const copy = document.createElement("button"); copy.className = "button button-quiet"; copy.textContent = "复制接手提示";
    copy.addEventListener("click", () => void copyHandoffPrompt(slot.prompt, slot.target)); card.append(title, line, meta, copy); root.append(card);
  }
  for (const role of ["plan", "review"]) for (const target of ["chatgpt", "claude"]) {
    const button = document.createElement("button"); button.className = "button button-quiet"; button.textContent = `交给 ${target === "chatgpt" ? "ChatGPT" : "Claude"}${role === "plan" ? "继续规划" : "审查"}`;
    button.disabled = !!state.planning.execution || role === "review" && !state.planning.draft;
    button.addEventListener("click", async () => {
      if (!await confirmPlanChanges()) return;
      const connected = (state.grants || []).some(grant => grant.source === target && (grant.workspaceIds || [grant.workspaceId]).includes(state.workspace.workspaceId) && grant.scopes.includes("planning:write"));
      if (!connected) { showToast(`请先在连接区为 ${target} 授权当前项目，并保存对应来源。`, true); state.managingConnection = true; await navigate("/connect"); renderConnectionEntry(); return; }
      const job = await startJob("准备网页交接", requestKey => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/handoff`, { method: "POST", body: JSON.stringify({ requestKey, role, target }) }), true);
      if (job?.status === "succeeded") await copyHandoffPrompt(job.result.prompt, target);
    }); root.append(button);
  }
}
async function copyHandoffPrompt(prompt, target) {
  if (!prompt) return;
  try { prompt = webpageSelectionHeader(state.workspace?.workspaceId, target) + "\n\n" + prompt; } catch (error) { showToast(error.message, true); return; }
  try { await copyText(prompt); showToast("接手提示已复制。到目标网页发送一次即可。请保持本地服务运行。"); }
  catch { showCopyFallback("复制接手提示，到目标网页发送", prompt); }
}
function externalOperationState(operation) {
  return operation.state === "prepared" && operation.expectedRevision !== undefined && operation.expectedRevision !== state.planning.revision ? "stale" : operation.state;
}
function renderExternalOperations() {
  const root = $("#external-operation-list"); root.replaceChildren();
  const states = { prepared: "等待网页领取／提交", submitting: "正在校验提交", failed: "修正次数已用尽", stale: "依据已变化", interrupted: "提交中断，需对账" };
  for (const operation of (state.planning.externalOperations || []).filter((item) => states[externalOperationState(item)] && (!item.coordinated || item.isCurrent)).slice(0, 4)) {
    const card = document.createElement("div"); card.className = "notice notice-warn";
    const operationState = externalOperationState(operation);
    const title = document.createElement("b"); title.textContent = `${operation.role === "plan" ? "网页规划" : "网页审查"} · ${states[operationState]}`;
    const text = document.createElement("p"); text.textContent = operation.diagnostic || (operationState === "stale" ? "草案或需求已更新，本轮上下文已过期。请重新发送回复或重新准备审查。" : `在已连接的网页中领取并完成本轮 ${shortId(operation.operationId)}。本地页面不会主动调用网页模型。`);
    const budget = operation.readBudget;
    const budgetLine = document.createElement("p"); budgetLine.className = "read-budget-status";
    if (budget) budgetLine.textContent = `MCP 只读预算：已用 ${formatBytes(budget.usedBytes)} / ${formatBytes(budget.limitBytes)} · 剩余 ${formatBytes(budget.remainingBytes)}`;
    card.append(title, text, ...(budget ? [budgetLine] : []));
    if (budget && operationState === "prepared" && budget.limitBytes < budget.maximumBytes) {
      const extend = document.createElement("button"); extend.type = "button"; extend.className = "button button-quiet"; extend.textContent = "扩容本次调研预算";
      extend.addEventListener("click", () => { state.budgetOperationId = operation.operationId; $("#budget-extension-description").textContent = `将为本次操作增加 256 KiB，只对本轮只读调研生效。当前 ${formatBytes(budget.usedBytes)} / ${formatBytes(budget.limitBytes)}，最多可扩展到 ${formatBytes(budget.maximumBytes)}。`; $("#budget-extension-dialog").showModal(); }); card.append(extend);
    }
    if (operation.message) { const message = document.createElement("p"); message.textContent = `本轮输入：${operation.message}`; card.append(message); }
    if (operation.state === "interrupted") {
      const reconcile = document.createElement("button"); reconcile.className = "button button-quiet"; reconcile.textContent = "核对已落库结果";
      reconcile.addEventListener("click", async () => { try { await api(`/api/v1/workspaces/${state.workspace.workspaceId}/external/${operation.operationId}/reconcile`, { method: "POST", body: "{}" }); showToast("已按领域记录对账，未重放提交。"); await refreshAll(); } catch (error) { showToast(error.message, true); } }); card.append(reconcile);
    }
    if (operation.state === "prepared") {
      const cancel = document.createElement("button"); cancel.className = "button button-quiet"; cancel.textContent = "取消本轮等待";
      cancel.addEventListener("click", async () => { try { await api(`/api/v1/workspaces/${state.workspace.workspaceId}/external/${operation.operationId}/cancel`, { method: "POST", body: "{}" }); await refreshAll(); } catch (error) { showToast(error.message, true); } }); card.append(cancel);
    }
    root.append(card);
  }
}
function formatBytes(value) { return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) ? 1 : 0)} MiB` : `${Math.ceil(value / 1024)} KiB`; }
async function confirmBudgetExtension() {
  const operationId = state.budgetOperationId, workspaceId = state.workspace?.workspaceId;
  if (!operationId || !workspaceId) return;
  const button = $("#budget-extension-confirm"); button.disabled = true;
  try {
    await api(`/api/v1/workspaces/${workspaceId}/external/${operationId}/budget`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    $("#budget-extension-dialog").close(); state.budgetOperationId = null; showToast("本次调研预算已扩展 256 KiB。"); await refreshAll();
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}
function renderRequirements() {
  const pending = (state.planning.requirements?.items || []).filter((item) => item.status === "pending");
  const replyPlaceholder = pending.length ? `还有 ${pending.length} 项需求待澄清，请回答 Planner 的问题` : "回答澄清问题，或补充需求";
  $("#reply-text").placeholder = replyPlaceholder;
  globalThis.tokenCouponReplyComposer?.setPlaceholder(replyPlaceholder);
  const mcp = selectedOperationIsWeb("planning");
  let prepare = $("#prepare-web-planning");
  if (!prepare) {
    prepare = document.createElement("button"); prepare.id = "prepare-web-planning"; prepare.type = "button"; prepare.className = "button button-primary"; prepare.textContent = "准备网页继续当前规划";
    prepare.addEventListener("click", async () => {
      if (!state.operationRoutingSupported) { showToast("请重启后台并刷新页面，以切换网页规划方式。", true); return; }
      const workspaceId = state.workspace.workspaceId, planningId = state.planning.planningId;
      await startJob("准备网页继续规划", requestKey => api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}/web-continue`, { method: "POST", body: JSON.stringify({ requestKey }) }));
    });
    $("#supplement-input").before(prepare);
  }
  show(prepare, mcp && !isWebMcp(state.planning.config.provider) && !state.planning.execution);
  prepare.disabled = !!state.activeJob;
  show($("#supplement-input"), !mcp);
  $("#supplement-input summary").textContent = mcp ? "登记补充需求（需要在网页继续）" : "回答澄清／补充需求";
  if (!mcp) $("#supplement-input").open = true;
  const pendingOperation = (state.planning.externalOperations || []).find((operation) => operation.role === "plan" && externalOperationState(operation) === "prepared");
  $("#reply-status").textContent = state.replying ? "正在提交回复…" : pendingOperation ? "回复已登记，等待网页 读取并提交结果。请在已连接 MCP 的 ChatGPT 对话中继续规划。" : mcp ? "此处只登记补充需求；需在 ChatGPT 或 Claude 网页中继续，模型才会生成结果。" : "发送回复后，Planner 会继续规划并更新对话。";
  $("#send-reply").textContent = state.replying ? "正在提交…" : mcp ? "登记补充需求，等待网页" : "发送回复";
  $("#send-reply").disabled = state.replying || !!state.planning.execution;
}
function renderDraft() {
  const draft = state.planning.draft; const target = $("#plan-view"); const draftView = globalThis.tokenCouponPlanDraftView;
  const expanded = draftView ? new Set() : new Set([...target.querySelectorAll("details[open]")].map(item => item.dataset.taskId));
  if (!draftView) target.replaceChildren();
  if (!draft) {
    closePlanEditor();
    const emptyMessage = isWebMcp(state.planning.config.provider) ? "等待网页模型生成草案；请在 ChatGPT／Claude 中提出需求或回答澄清。" : "Planner 正在收集需求，或尚未生成草案。回答上方的问题后继续。";
    if (draftView) draftView.render({ contextKey: `${state.planning.planningId}:empty`, emptyMessage, tasks: [] });
    else target.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }
  if (!state.editingPlan && state.editedPlanHash !== draft.planHash) {
    $("#plan-editor").value = JSON.stringify(draft.plan, null, 2); state.savedPlanText = $("#plan-editor").value; state.editedPlanHash = draft.planHash;
  }
  const review = state.planning.review;
  $("#plan-draft-status").textContent = `当前版本 draft-${draft.draftRevision} · ${state.planning.workflow?.label || statuses[state.planning.status] || state.planning.status} · ${review ? `${review.current ? "审查有效" : "审查已过期"}（draft-${review.draftRevision}）` : "尚无审查"}${state.planning.approval?.planHash === draft.planHash ? " · 已批准" : ""}`;
  const verification = $("#verification-task"); const previous = verification.value; verification.replaceChildren();
  const candidates = verificationCandidates(draft.plan, state.planning.verificationTasks);
  if (!candidates.length) verification.add(new Option("没有满足依赖要求的最终验证任务", ""));
  for (const candidate of candidates) verification.add(new Option(`${candidate.title} · ${candidate.taskId}`, candidate.taskId));
  verification.value = candidates.some(item => item.taskId === previous) ? previous : candidates.length === 1 ? candidates[0].taskId : "";
  show($("#verification-wrap"), $("#isolation").value === "git-worktree");
  const taskViews = draft.plan.tasks.map(entry => {
    const task = entry.task;
    const sections = task.schemaVersion === 2
      ? [["需求目标", task.objective], ["设计与技术方案", task.approach], ["实施步骤", task.steps], ["交付物", task.deliverables], ["验收标准", task.acceptanceCriteria], ["约束", task.constraints], ["其他说明", task.notes]]
      : [["任务正文", task.prompt]];
    return {
      taskId: task.id,
      title: task.title,
      schemaLabel: task.schemaVersion === 2 ? "结构化任务" : "旧版正文",
      sections: sections.filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && !value.length)).map(([label, value]) => ({ label, value })),
      dependsOn: entry.dependsOn,
      runnerLabel: labels[task.execution.runnerId] || task.execution.runnerId,
      modelLabel: task.execution.modelId || "Runner 默认模型",
    };
  });
  if (draftView) draftView.render({ contextKey: `${state.planning.planningId}:${draft.planHash}`, tasks: taskViews });
  else for (const task of taskViews) {
    const card = document.createElement("details"); card.className = "plan-card"; card.dataset.taskId = task.taskId; card.open = expanded.has(task.taskId);
    const summary = document.createElement("summary"), title = document.createElement("span"), hint = document.createElement("span");
    title.textContent = task.title; hint.className = "muted small"; hint.textContent = `${task.taskId} · ${task.schemaLabel} · 查看详情`; summary.append(title, hint);
    const sections = document.createElement("div"); sections.className = "plan-field-preview";
    for (const item of task.sections) {
      const section = document.createElement("section"), heading = document.createElement("strong"), body = document.createElement("p"); heading.textContent = item.label;
      body.textContent = Array.isArray(item.value) ? item.value.map((line, index) => `${index + 1}. ${line}`).join("\n") : item.value; section.append(heading, body); sections.append(section);
    }
    const meta = document.createElement("div"); meta.className = "task-meta"; meta.textContent = `依赖：${task.dependsOn.join(", ") || "无"} · ${task.runnerLabel} / ${task.modelLabel}`;
    card.append(summary, sections, meta); target.append(card);
  }
  renderPlanEditControls();
}
function createAgentSelectionControls(initial, onChange = () => {}, isCurrent = () => true, runners = state.runners) {
  return globalThis.tokenCouponAgentSelectionControls
    ? createReactAgentSelectionControls(initial, onChange, isCurrent, runners)
    : createNativeAgentSelectionControls(initial, onChange, isCurrent, runners);
}
function disposeAgentSelectionControls(container) {
  const bridge = globalThis.tokenCouponAgentSelectionControls;
  if (!bridge) return;
  for (const mount of [container, ...container.querySelectorAll("[data-agent-selection-mount]")]) bridge.unmount(mount);
}
function createNativeAgentSelectionControls(initial, onChange = () => {}, isCurrent = () => true, runners = state.runners) {
  const root = document.createElement("div"), fields = document.createElement("div"), hint = document.createElement("p");
  root.className = "agent-selection-controls"; fields.className = "settings-grid task-agent-config-fields"; hint.className = "hint"; hint.setAttribute("role", "status");
  const runner = document.createElement("select"); runner.dataset.field = "runner";
  for (const item of runners || []) { const option = new Option(`${labels[item.id] || item.id}${item.available ? "" : " · 未就绪"}`, item.id); option.disabled = !item.available && item.id !== initial.runnerId; runner.add(option); }
  if (![...runner.options].some(option => option.value === initial.runnerId)) runner.add(new Option(`${labels[initial.runnerId] || initial.runnerId} · 当前配置`, initial.runnerId));
  runner.value = initial.runnerId;
  const model = document.createElement("input"); model.type = "text"; model.maxLength = 120; model.autocomplete = "off"; model.dataset.field = "model"; model.value = initial.modelId || ""; model.placeholder = "输入自定义模型 ID";
  const choice = document.createElement("select"); choice.dataset.field = "model-choice";
  const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "text-button"; refresh.textContent = "刷新模型";
  const runnerLabel = document.createElement("label"); runnerLabel.textContent = "Runner"; runnerLabel.append(runner);
  const modelLabel = document.createElement("label"); modelLabel.textContent = "模型"; modelLabel.append(choice, model, refresh); fields.append(runnerLabel, modelLabel); root.append(fields, hint);
  const values = new Map([[runner.value, model.value]]); let currentRunner = runner.value, generation = 0;
  const value = () => ({ runnerId: runner.value, ...(model.value.trim() ? { modelId: model.value.trim() } : {}) });
  const preview = () => { values.set(runner.value, model.value.trim()); hint.textContent = `配置预览：${labels[runner.value] || runner.value} / ${model.value.trim() || "Runner 默认模型"}`; };
  const fill = catalog => {
    choice.replaceChildren(new Option("沿用所选 Runner 的默认模型", ""));
    for (const item of catalog.models || []) choice.add(new Option(`${item.label || item.id}${item.label && item.label !== item.id ? ` · ${item.id}` : ""}`, item.id));
    if (catalog.customAllowed !== false || model.value) choice.add(new Option("自定义模型 ID…", "__custom__"));
    choice.value = [...choice.options].some(item => item.value === model.value) ? model.value : "__custom__"; show(model, choice.value === "__custom__");
  };
  const load = async (force = false) => {
    const sequence = ++generation, runnerId = runner.value, workspaceId = state.workspace?.workspaceId;
    choice.disabled = true; model.disabled = true; refresh.disabled = true; root.dataset.modelLoading = "true"; choice.setAttribute("aria-busy", "true");
    fill({ models: [], customAllowed: runnerId !== "mock" }); hint.textContent = "正在读取所选 Runner 的完整模型目录…";
    try {
      const catalog = await runnerModelCatalog(runnerId, workspaceId || "", force);
      if (sequence !== generation || !root.isConnected || runner.value !== runnerId || !isCurrent()) return;
      fill(catalog); preview(); hint.textContent += catalog.error ? ` · ${catalog.error}；仍可使用默认或自定义模型。` : ` · ${catalog.models?.length || 0} 个目录候选，实际可用性以调用结果为准。`;
    } catch (error) { if (sequence === generation && root.isConnected && isCurrent()) { preview(); hint.textContent += ` · 目录暂不可读：${error.message}；可使用默认或自定义模型。`; } }
    finally { if (sequence === generation) { choice.disabled = false; model.disabled = false; refresh.disabled = false; root.dataset.modelLoading = "false"; choice.setAttribute("aria-busy", "false"); } }
  };
  runner.addEventListener("change", () => { values.set(currentRunner, model.value.trim()); currentRunner = runner.value; model.value = values.get(currentRunner) || ""; preview(); onChange(value()); void load(); });
  choice.addEventListener("change", () => { if (choice.value !== "__custom__") model.value = choice.value; show(model, choice.value === "__custom__"); if (choice.value === "__custom__") model.focus(); preview(); onChange(value()); });
  model.addEventListener("input", () => { preview(); onChange(value()); }); refresh.addEventListener("click", () => void load(true));
  return { root, load, value };
}
function createReactAgentSelectionControls(initial, onChange = () => {}, isCurrent = () => true, runners = state.runners) {
  const root = document.createElement("div"); root.dataset.agentSelectionMount = "true";
  let runnerId = initial.runnerId, modelId = initial.modelId || "", modelChoice = modelId || "", choices = [], hint = "", loading = false;
  const values = new Map([[runnerId, modelId]]); let generation = 0, customAllowed = runnerId !== "mock";
  const currentRunner = () => (runners || []).map(item => ({ id: item.id, label: `${labels[item.id] || item.id}${item.available ? "" : " · 未就绪"}`, disabled: !item.available && item.id !== initial.runnerId }));
  const runnerOptions = () => {
    const options = currentRunner();
    if (!options.some(option => option.id === runnerId)) options.push({ id: runnerId, label: `${labels[runnerId] || runnerId} · 当前配置`, disabled: false });
    return options;
  };
  const value = () => ({ runnerId, ...(modelId.trim() ? { modelId: modelId.trim() } : {}) });
  const preview = () => `配置预览：${labels[runnerId] || runnerId} / ${modelId.trim() || "Runner 默认模型"}`;
  const selectedChoice = () => modelChoice === "__custom__" ? "__custom__" : choices.some(item => item.id === modelId) ? modelId : modelChoice;
  const render = () => { root.dataset.modelLoading = String(loading); globalThis.tokenCouponAgentSelectionControls?.render(root, {
    runners: runnerOptions(), selectedRunnerId: runnerId, modelChoices: choices,
    selectedModelChoice: selectedChoice(), modelId, showCustomModel: selectedChoice() === "__custom__", hint, loading,
  }, {
    onRunnerChange: nextRunner => {
      if (!isCurrent() || nextRunner === runnerId) return;
      values.set(runnerId, modelId.trim()); runnerId = nextRunner; modelId = values.get(nextRunner) || "";
      modelChoice = modelId || ""; customAllowed = runnerId !== "mock"; hint = preview(); render(); onChange(value()); void load();
    },
    onModelChoice: nextChoice => {
      if (!isCurrent()) return;
      modelChoice = nextChoice;
      if (nextChoice !== "__custom__") modelId = nextChoice;
      hint = preview(); render(); onChange(value());
    },
    onModelInput: nextModel => {
      if (!isCurrent()) return;
      modelId = nextModel; values.set(runnerId, modelId.trim()); hint = preview(); render(); onChange(value());
    },
    onRefresh: () => void load(true),
  }); };
  const fill = catalog => {
    customAllowed = catalog.customAllowed !== false;
    choices = [{ id: "", label: "沿用所选 Runner 的默认模型" }, ...(catalog.models || []).map(item => ({ id: item.id, label: `${item.label || item.id}${item.label && item.label !== item.id ? ` · ${item.id}` : ""}` }))];
    if (customAllowed || modelId) choices.push({ id: "__custom__", label: "自定义模型 ID…" });
    modelChoice = choices.some(item => item.id === modelId) ? modelId : "__custom__";
  };
  const load = async (force = false) => {
    const sequence = ++generation, requestedRunner = runnerId, workspaceId = state.workspace?.workspaceId || "";
    loading = true;
    fill({ models: [], customAllowed: requestedRunner !== "mock" }); hint = "正在读取所选 Runner 的完整模型目录…"; render();
    try {
      const catalog = await runnerModelCatalog(requestedRunner, workspaceId, force);
      if (sequence !== generation || !root.isConnected || runnerId !== requestedRunner || !isCurrent()) return;
      fill(catalog); hint = `${preview()}${catalog.error ? ` · ${catalog.error}；仍可使用默认或自定义模型。` : ` · ${catalog.models?.length || 0} 个目录候选，实际可用性以调用结果为准。`}`; render();
    } catch (error) {
      if (sequence === generation && root.isConnected && isCurrent()) { hint = `${preview()} · 目录暂不可读：${error.message}；可使用默认或自定义模型。`; render(); }
    }
    finally { if (sequence === generation) { loading = false; if (root.isConnected && isCurrent()) render(); } }
  };
  fill({ models: [], customAllowed }); hint = preview(); render();
  return { root, load, value };
}

function openTaskAgentConfig() {
  const planning = state.planning, draft = planning?.draft;
  if (!planning || !draft || planning.execution) return;
  state.taskAgentContext = { planningId: planning.planningId, workspaceId: state.workspace.workspaceId, planHash: draft.planHash, draftRevision: draft.draftRevision };
  const root = $("#task-agent-config-list"); disposeAgentSelectionControls(root); root.replaceChildren();
  const defaults = planning.executionDefaults || {};
  $("#task-agent-config-defaults").textContent = `全局默认：${labels[defaults.runnerId] || defaults.runnerId || "未设置"}${defaults.modelId ? ` / ${defaults.modelId}` : " / Runner 默认模型"} · 执行模式 managed`;
  $("#task-agent-config-error").textContent = "";
  for (const [index, entry] of draft.plan.tasks.entries()) {
    const task = entry.task, row = document.createElement("fieldset"); row.className = "task-agent-config-row"; row.dataset.taskId = task.id;
    const legend = document.createElement("legend"); legend.textContent = `${task.id} · ${task.title}`; row.append(legend);
    const controls = createAgentSelectionControls(task.execution, undefined, () => state.planning?.planningId === planning.planningId);
    row.append(controls.root); root.append(row); void controls.load();
  }
  $("#task-agent-config-dialog").showModal();
}
async function saveTaskAgentConfig() {
  const planning = state.planning, draft = planning?.draft, rows = [...$("#task-agent-config-list").querySelectorAll(".task-agent-config-row")];
  if (!planning || !draft || planning.execution) return;
  const context = state.taskAgentContext;
  if (!context || context.planningId !== planning.planningId || context.workspaceId !== state.workspace?.workspaceId || context.planHash !== draft.planHash || context.draftRevision !== draft.draftRevision) { $("#task-agent-config-error").textContent = "草案或工作区已变化，请关闭并重新打开配置后再保存。"; return; }
  const tasks = [];
  for (const row of rows) {
    const taskId = row.dataset.taskId, current = draft.plan.tasks.find(entry => entry.task.id === taskId)?.task;
    if (!current) continue;
    const runnerId = row.querySelector('[data-field="runner"]').value, modelId = row.querySelector('[data-field="model"]').value.trim();
    const execution = { ...current.execution, runnerId, ...(modelId ? { modelId } : {}) };
    if (!modelId) delete execution.modelId;
    if (JSON.stringify(execution) !== JSON.stringify(current.execution)) tasks.push({ taskId, fields: { execution } });
  }
  if (!tasks.length) { $("#task-agent-config-dialog").close(); showToast("任务 Runner／模型配置没有变化。"); return; }
  const workspaceId = state.workspace.workspaceId, planningId = planning.planningId, expectedDraftRevision = draft.draftRevision, expectedPlanHash = draft.planHash;
  const button = $("#task-agent-config-save"); button.disabled = true; $("#task-agent-config-error").textContent = "正在校验任务配置并保存新草案版本…";
  try {
    const result = await startJob("保存任务 Runner／模型配置", requestKey => api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}/draft`, { method: "POST", body: JSON.stringify({ requestKey, edits: { tasks }, expectedDraftRevision, expectedPlanHash }) }), true);
    if (result?.status === "succeeded") {
      $("#task-agent-config-dialog").close(); $("#task-agent-config-error").textContent = "";
      await refreshAll();
      showToast("配置已保存为新草案版本；请查看 diff、重新审查并批准后再运行。");
    } else $("#task-agent-config-error").textContent = result?.error || "保存未完成；请查看上方操作状态与校验反馈。";
  } catch (error) { $("#task-agent-config-error").textContent = error.message; }
  finally { button.disabled = false; }
}
function planHasChanges() {
  if (!state.editingPlan || !state.editBase) return false;
  const text = $("#plan-editor").value;
  try { return JSON.stringify(JSON.parse(text)) !== JSON.stringify(JSON.parse(state.editBase.text)); }
  catch { return text !== state.editBase.text; }
}
function renderPlanEditControls() {
  show($("#plan-editor-wrap"), state.editingPlan); show($("#save-plan"), state.editingPlan); show($("#plan-view"), !state.editingPlan);
  $("#toggle-plan-edit").textContent = state.editingPlan ? "结束编辑" : "编辑草案";
  $("#toggle-plan-edit").disabled = state.savingPlan || !state.planning?.draft || !!state.planning?.execution;
  $("#save-plan").disabled = state.savingPlan || !planHasChanges() || !!state.planning?.execution;
  $("#save-plan").textContent = state.savingPlan ? "正在校验并保存…" : "校验并保存";
  $("#plan-edit-status").textContent = state.savingPlan ? "正在校验并保存…" : state.editingPlan && state.editBase.hash !== state.planning?.draft?.planHash ? "当前草案已更新。未保存内容已保留；请放弃修改后重新编辑，避免覆盖新版本。" : planHasChanges() ? "已修改，尚未保存。" : "尚无修改。";
  if (state.editingPlan && globalThis.tokenCouponPlanDraftEditor) globalThis.tokenCouponPlanDraftEditor.setDisabled($("#plan-text-editor"), state.savingPlan);
}
function closePlanEditor() {
  state.editingPlan = false; state.editBase = null; state.editedPlanHash = "";
  globalThis.tokenCouponPlanDraftEditor?.unmount($("#plan-text-editor"));
  globalThis.tokenCouponPlanDiff?.unmount($("#plan-diff"));
  show($("#plan-diff"), false); renderPlanEditControls();
}
function openPlanEditor() {
  const draft = state.planning?.draft; if (!draft || state.planning.execution) return;
  state.editBase = { workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, hash: draft.planHash, revision: draft.draftRevision, text: JSON.stringify(draft.plan, null, 2) };
  state.savedPlanText = state.editBase.text; $("#plan-editor").value = state.savedPlanText;
  state.editingPlan = true; renderTextEditor(); show($("#plan-diff"), false); renderPlanEditControls(); $("#plan-text-editor input, #plan-text-editor textarea")?.focus();
}
function renderTextEditor() {
  let plan; try { plan = JSON.parse($("#plan-editor").value); } catch { return; }
  if (globalThis.tokenCouponPlanDraftEditor && state.editBase) {
    globalThis.tokenCouponPlanDraftEditor.render($("#plan-text-editor"), {
      identity: `${state.editBase.workspaceId}:${state.editBase.planningId}:${state.editBase.hash}`,
      plan, disabled: state.savingPlan,
    }, updated => {
      $("#plan-editor").value = JSON.stringify(updated, null, 2);
      previewPlanDiff(); renderPlanEditControls();
    });
    return;
  }
  const root = $("#plan-text-editor"); root.replaceChildren();
  const field = (label, value, update, multiline = false, array = false) => {
    const wrapper = document.createElement("label"); wrapper.className = "draft-text-field"; wrapper.append(document.createTextNode(label));
    const input = document.createElement(multiline ? "textarea" : "input"); input.value = array ? (value || []).join("\n") : value || ""; if (multiline) input.rows = array ? Math.min(8, Math.max(3, (value || []).length + 1)) : 5;
    input.addEventListener("input", () => {
      try { const current = JSON.parse($("#plan-editor").value); update(current, array ? input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : input.value); $("#plan-editor").value = JSON.stringify(current, null, 2); previewPlanDiff(); renderPlanEditControls(); }
      catch { showToast("当前草案无法解析，请放弃本次修改并重新打开草案。", true); }
    }); wrapper.append(input); root.append(wrapper);
  };
  field("计划标题", plan.title, (current, value) => { current.title = value; });
  for (const [index, entry] of plan.tasks.entries()) {
    const info = document.createElement("h4"); info.className = "draft-task-heading"; info.textContent = `任务 ${index + 1} · ${entry.task.id} · 依赖 ${entry.dependsOn.join(", ") || "无"} · ${labels[entry.task.execution.runnerId] || entry.task.execution.runnerId} / ${entry.task.execution.modelId || "默认模型"}`; root.append(info);
    field(`任务 ${index + 1} 标题`, entry.task.title, (current, value) => { current.tasks[index].task.title = value; });
    if (entry.task.schemaVersion === 2) {
      field(`任务 ${index + 1} · 需求目标`, entry.task.objective, (current, value) => { current.tasks[index].task.objective = value; }, true);
      field(`任务 ${index + 1} · 设计与技术方案`, entry.task.approach, (current, value) => { current.tasks[index].task.approach = value; }, true);
      field(`任务 ${index + 1} · 实施步骤（每行一项）`, entry.task.steps, (current, value) => { current.tasks[index].task.steps = value; }, true, true);
      field(`任务 ${index + 1} · 交付物（每行一项）`, entry.task.deliverables, (current, value) => { current.tasks[index].task.deliverables = value; }, true, true);
      field(`任务 ${index + 1} · 验收标准（每行一项）`, entry.task.acceptanceCriteria, (current, value) => { current.tasks[index].task.acceptanceCriteria = value; }, true, true);
      field(`任务 ${index + 1} · 约束（每行一项，可空）`, entry.task.constraints, (current, value) => { current.tasks[index].task.constraints = value; }, true, true);
      field(`任务 ${index + 1} · 其他说明`, entry.task.notes, (current, value) => { if (value.trim()) current.tasks[index].task.notes = value; else delete current.tasks[index].task.notes; }, true);
    } else field(`任务 ${index + 1} · 旧版正文`, entry.task.prompt, (current, value) => { current.tasks[index].task.prompt = value; }, true);
  }
}
async function savePlanEditor() {
  if (state.savingPlan) return false;
  if (!planHasChanges()) { closePlanEditor(); return true; }
  let edits; try { edits = buildPlanEditPatch(JSON.parse(state.editBase.text), JSON.parse($("#plan-editor").value)); } catch (error) { showToast(`草案字段无法保存：${error.message}`, true); return false; }
  const base = state.editBase; state.savingPlan = true; $("#plan-editor").disabled = true; renderPlanEditControls();
  for (const input of $("#plan-text-editor").querySelectorAll("input,textarea")) input.disabled = true;
  try {
    const job = await startJob("保存草案", (requestKey) => api(`/api/v1/workspaces/${base.workspaceId}/plannings/${base.planningId}/draft`, { method: "POST", body: JSON.stringify({ requestKey, edits, expectedDraftRevision: base.revision, expectedPlanHash: base.hash }) }), true);
    if (job?.status !== "succeeded") return false;
    closePlanEditor(); renderDraft(); return true;
  } finally { state.savingPlan = false; $("#plan-editor").disabled = false; for (const input of $("#plan-text-editor").querySelectorAll("input,textarea")) input.disabled = false; renderPlanEditControls(); }
}
function buildPlanEditPatch(base, edited) {
  const patch = {};
  if (base.title !== edited.title) patch.title = edited.title;
  const taskPatches = [];
  for (const [index, nextEntry] of edited.tasks.entries()) {
    const oldEntry = base.tasks[index]; if (!oldEntry || oldEntry.task.id !== nextEntry.task.id) throw new Error("任务顺序或身份已变化");
    const keys = nextEntry.task.schemaVersion === 1 ? ["title", "prompt"] : ["title", "objective", "approach", "steps", "deliverables", "acceptanceCriteria", "constraints", "notes"];
    const fields = {};
    for (const key of keys) if (JSON.stringify(oldEntry.task[key] ?? null) !== JSON.stringify(nextEntry.task[key] ?? null)) fields[key] = key === "notes" && nextEntry.task[key] === undefined ? null : nextEntry.task[key];
    if (Object.keys(fields).length) taskPatches.push({ taskId: nextEntry.task.id, fields });
  }
  if (taskPatches.length) patch.tasks = taskPatches;
  if (!Object.keys(patch).length) throw new Error("没有可保存的正文修改");
  return patch;
}
async function confirmPlanChanges() {
  if (state.savingPlan) { showToast("草案正在保存，请等待校验结果。", true); return false; }
  if (!state.editingPlan) return true;
  if (!planHasChanges()) { closePlanEditor(); return true; }
  if (state.unsavedDecision) return false;
  const dialog = $("#unsaved-plan-dialog");
  const choice = await new Promise((resolve) => { state.unsavedDecision = resolve; dialog.showModal(); });
  if (choice === "save") return savePlanEditor();
  if (choice === "discard") { closePlanEditor(); renderDraft(); return true; }
  return false;
}
function decidePlanChanges(choice) {
  const resolve = state.unsavedDecision; state.unsavedDecision = null;
  $("#unsaved-plan-dialog").close(); resolve?.(choice);
}
function previewPlanDiff() {
  const box = $("#plan-diff"); show(box);
  try {
    const edited = JSON.parse($("#plan-editor").value); const old = JSON.parse(state.savedPlanText);
    const oldMap = new Map(old.tasks.map((item) => [item.task.id, item])); const newMap = new Map(edited.tasks.map((item) => [item.task.id, item]));
    const added = [...newMap.keys()].filter((id) => !oldMap.has(id)); const removed = [...oldMap.keys()].filter((id) => !newMap.has(id));
    const names = { title: "标题", objective: "需求目标", approach: "设计与技术方案", steps: "实施步骤", deliverables: "交付物", acceptanceCriteria: "验收标准", constraints: "约束", notes: "其他说明", prompt: "旧版正文" };
    const changed = [];
    for (const [id, entry] of newMap) {
      const before = oldMap.get(id); if (!before) continue;
      for (const key of Object.keys(names)) if (JSON.stringify(entry.task[key] ?? null) !== JSON.stringify(before.task[key] ?? null)) changed.push({ taskId: id, label: names[key] });
    }
    const model = { titleChange: edited.title !== old.title ? { from: old.title, to: edited.title } : undefined, changed, addedTasks: added, removedTasks: removed };
    if (globalThis.tokenCouponPlanDiff) { globalThis.tokenCouponPlanDiff.render(box, model); return; }
    box.textContent = `草案差异 · ${edited.title !== old.title ? `计划标题：${old.title} → ${edited.title}\n` : ""}修改 ${changed.length} 项 / 新增 ${added.length} 项 / 删除 ${removed.length} 项\n${changed.length ? changed.map(item => `• 任务 ${item.taskId} · ${item.label}`).join("\n") : "正文无字段修改"}${added.length ? `\n新增任务：${added.join("、")}` : ""}${removed.length ? `\n删除任务：${removed.join("、")}` : ""}`;
  } catch (error) {
    if (globalThis.tokenCouponPlanDiff) globalThis.tokenCouponPlanDiff.render(box, { changed: [], addedTasks: [], removedTasks: [], error: error.message });
    else box.textContent = `JSON 校验失败：${error.message}`;
  }
}
function renderReview() {
  const plan = state.planning, review = plan.review, box = $("#review-view");
  renderReviewContinuation();
  const signature = JSON.stringify([state.workspace.workspaceId, plan.planningId, plan.draft?.planHash, review, plan.workflow, plan.approval, plan.execution, plan.reviewHistory, plan.approvalHistory, plan.reviewReadError, state.systemSettings?.revision, state.activeJob?.jobId]);
  // A poll with no review change must not close an open select or move a typing cursor.
  if (state.renderedReviewSignature === signature) return;
  state.renderedReviewSignature = signature;
  const key = `${state.workspace.workspaceId}:${plan.planningId}:${plan.draft?.planHash}:${review?.reviewId}`;
  if (state.reviewChoiceContext?.key !== key) {
    if (state.reviewChoiceContext?.planningId === plan.planningId && state.reviewChoiceContext.dirty) showToast("草案或审查版本已变化，旧处理选择不再适用，请重新确认。", true);
    let choices = {}; try { choices = JSON.parse(sessionStorage.getItem(`tc-review-${key}`) || "{}"); } catch { /* Invalid local input is not a review record. */ }
    state.reviewChoiceContext = { key, planningId: plan.planningId, choices, dirty: Object.keys(choices).length > 0 };
  }
  const summaryTitle = review ? `${review.current ? "有效审查" : "审查已过期"} · draft-${review.draftRevision}` : plan.workflow?.label || "当前草案尚无有效审查";
  const reviewConfig = review?.reviewerConfig || plan.config;
  const reviewSource = review ? `审查来源：${({ deepseek: "DeepSeek API", mock: "离线模拟", "codex-agent": "Codex 本机 Agent", "claude-agent": "Claude Code 本机 Agent", "chatgpt-mcp": "ChatGPT 网页 MCP", "web-mcp": "Claude／网页 MCP" })[reviewConfig.provider] || reviewConfig.provider} · ${review.reviewerReportedModel ? `实际报告 ${review.reviewerReportedModel}` : `配置 ${reviewConfig.model}${["codex-agent", "claude-agent"].includes(reviewConfig.provider) ? "（Runner 未报告实际模型）" : ""}`}` : "";
  const summaryText = review ? `${review.reviewId ? `Review ${shortId(review.reviewId)} · ` : ""}${review.summary || "无总结"}${reviewSource ? `\n${reviewSource}` : ""}` : !selectedOperationIsWeb("review") ? "点击上方审查按钮，调用所选本机 Agent／API 审查当前草案。有待处理网页审查时，先确认接管。" : plan.workflow?.detail || "先准备审查，再到网页领取并提交报告。";
  const findings = (review?.findings || []).map(finding => ({
    findingId: finding.findingId,
    severity: ["error", "warning"].includes(finding.severity) ? finding.severity : "info",
    description: finding.description,
    suggestion: finding.suggestion,
    basis: finding.basis,
  }));
  const history = [
    ...(plan.reviewHistory || []).map(previous => `draft-${previous.draftRevision} · ${previous.summary} · ${previous.findings.length} 个问题`),
    ...(plan.approvalHistory || []).map(previous => `历史批准 draft-${previous.draftRevision} · ${new Date(previous.recordedAt).toLocaleString()}`),
  ];
  if (globalThis.tokenCouponReviewView) {
    const choices = Object.fromEntries(findings.map(finding => [finding.findingId, state.reviewChoiceContext.choices[finding.findingId] || { choice: "accept", custom: "" }]));
    globalThis.tokenCouponReviewView.render({
      contextKey: key,
      summaryTitle,
      summaryText,
      isCurrent: !!review?.current,
      ...(plan.reviewReadError ? { reviewReadError: plan.reviewReadError } : {}),
      findings,
      canChoose: !!review?.current && !plan.execution && !plan.approval && plan.workflow?.role !== "plan",
      choices,
      resolutions: review?.resolutions || [],
      history,
    }, rememberReviewChoice);
  } else {
    box.replaceChildren();
    const summary = document.createElement("section"); summary.className = `review-overview ${review?.current ? "is-current" : ""}`;
    const summaryHeading = document.createElement("strong"); summaryHeading.textContent = summaryTitle;
    const summaryParagraph = document.createElement("p"); summaryParagraph.textContent = summaryText;
    summary.append(summaryHeading, summaryParagraph); box.append(summary);
    if (plan.reviewReadError) { const error = document.createElement("p"); error.className = "notice notice-warn"; error.textContent = `审查记录读取失败：${plan.reviewReadError}`; box.append(error); }
    for (const finding of review?.findings || []) {
      const item = document.createElement("article"); item.className = "finding";
      const severity = finding.severity === "error" ? "阻塞建议" : finding.severity === "warning" ? "风险提醒" : "可选建议";
      item.innerHTML = `<div class="finding-head"><span class="badge ${finding.severity === "error" ? "badge-error" : finding.severity === "warning" ? "badge-warning" : "badge-neutral"}">${severity}</span><h4>${esc(finding.findingId)} · ${esc(finding.description)}</h4></div><p class="finding-suggestion">建议：${esc(finding.suggestion)}</p><details class="finding-basis"><summary>查看依据</summary><p class="basis">${esc(finding.basis)}</p></details>`;
      if (review.current && !plan.execution && !plan.approval && plan.workflow?.role !== "plan") item.append(reviewChoice(finding));
      box.append(item);
    }
    if (review?.resolutions?.length) {
      const resolutions = document.createElement("details"); resolutions.className = "review-resolutions";
      const heading = document.createElement("summary"); heading.textContent = `上轮问题逐项回顾 · ${review.resolutions.filter(item => item.status === "resolved").length}/${review.resolutions.length} 已解决`;
      resolutions.append(heading);
      for (const resolution of review.resolutions) { const row = document.createElement("p"); row.className = resolution.status === "resolved" ? "resolution-resolved" : "resolution-open"; row.textContent = `${resolution.findingId} · ${resolution.status === "resolved" ? "已解决" : "仍未解决"}：${resolution.basis}`; resolutions.append(row); }
      box.append(resolutions);
    }
    if (history.length) {
      const details = document.createElement("details"); details.className = "foldout";
      const heading = document.createElement("summary"); heading.textContent = "历史审查与批准（只读，不适用于本版）"; details.append(heading);
      for (const entry of history) { const text = document.createElement("p"); text.textContent = entry; details.append(text); }
      box.append(details);
    }
  }
  renderReviewActions(review);
}
function rememberReviewChoice(findingId, value) {
  if (!state.reviewChoiceContext) return;
  state.reviewChoiceContext.choices[findingId] = value;
  state.reviewChoiceContext.dirty = true;
  try { sessionStorage.setItem(`tc-review-${state.reviewChoiceContext.key}`, JSON.stringify(state.reviewChoiceContext.choices)); } catch { /* Input remains in memory if storage is full. */ }
}
function renderReviewContinuation() {
  const plan = state.planning; if (!plan) return;
  const role = plan.workflow?.role === "plan" ? "revision" : "review";
  const web = (plan.workflow?.role === "plan" || selectedOperationIsWeb(role)) && !plan.execution && (!plan.review?.current || plan.workflow?.role === "plan");
  show($("#web-continue"), web);
  $("#web-continue-status").textContent = "在已授权网页发送一次继续提示，接着完成修订与复审；本地页面会同步结果。";
}
function reviewChoice(finding) {
  const row = document.createElement("div"); row.className = "finding-choice"; row.dataset.findingId = finding.findingId;
  const saved = state.reviewChoiceContext.choices[finding.findingId] || { choice: "accept", custom: "" };
  const label = document.createElement("label"); label.textContent = `${finding.findingId} 处理方式`;
  const select = document.createElement("select"); select.setAttribute("aria-label", `${finding.findingId} 处理方式`);
  select.append(new Option("采纳建议（推荐）", "accept"), new Option("自定义修订说明", "custom"), new Option("暂不处理，保留问题", "defer")); select.value = saved.choice; label.append(select);
  const input = document.createElement("textarea"); input.rows = 3; input.value = saved.custom; input.placeholder = "写明希望如何修改"; input.setAttribute("aria-label", `${finding.findingId} 自定义修订说明`); show(input, saved.choice === "custom");
  const error = document.createElement("span"); error.className = "field-error hidden"; error.setAttribute("role", "alert");
  const remember = () => { state.reviewChoiceContext.choices[finding.findingId] = { choice: select.value, custom: input.value }; state.reviewChoiceContext.dirty = true; try { sessionStorage.setItem(`tc-review-${state.reviewChoiceContext.key}`, JSON.stringify(state.reviewChoiceContext.choices)); } catch { /* Input remains in memory if storage is full. */ } show(input, select.value === "custom"); show(error, false); };
  select.addEventListener("change", remember); input.addEventListener("input", remember); row.append(label, input, error); return row;
}
function renderReviewActions(review) {
  const root = $("#review-actions"); root.replaceChildren();
  if (!review?.current || !review.findings?.length || state.planning.execution || state.planning.approval || state.planning.workflow?.role === "plan") { show(root, false); return; }
  show(root);
  const title = document.createElement("p"); title.className = "hint"; title.textContent = state.activeJob ? "当前操作正在收尾，完成后可提交修订。" : "选择对应建议后，一次提交全部修订；暂不处理不代表解决或豁免。"; root.append(title);
  const selection = policySelection("revision");
  const method = document.createElement("p"); method.className = "hint"; method.textContent = selection ? `本次修订：${selection.mode === "codex-agent" ? "Codex Agent" : selection.mode === "claude-agent" ? "Claude Code Agent" : selection.mode === "web-claude" ? "Claude 网页" : "ChatGPT 网页"}${selection.model ? ` / ${selection.model}` : ""}。可在系统设置中修改修订默认方式。` : "本次修订沿用规划方式。";
  const button = document.createElement("button"); button.className = "button button-primary"; button.textContent = selectedOperationIsWeb("revision") ? "提交修订建议，交给网页" : "调用 Agent 修订草案"; button.addEventListener("click", () => submitReviewRevision(review)); root.append(method, button);
  button.disabled = !!state.activeJob;
}
async function submitReviewRevision(review) {
  if (functionPolicy("revision") && !state.operationRoutingSupported) { showToast("后台尚未支持按设置切换修订方式，请重启后台并刷新页面。", true); return; }
  const actions = globalThis.tokenCouponReviewView
    ? review.findings.map(finding => { const saved = state.reviewChoiceContext.choices[finding.findingId] || { choice: "accept", custom: "" }; return { findingId: finding.findingId, choice: saved.choice, custom: saved.custom.trim() }; })
    : [...$("#review-view").querySelectorAll(".finding-choice")].map(row => ({ findingId: row.dataset.findingId, choice: row.querySelector("select").value, custom: row.querySelector("textarea").value.trim() }));
  const invalidChoices = actions.filter(item => item.choice === "custom" && !item.custom.trim()).map(item => item.findingId);
  if (invalidChoices.length) {
    if (globalThis.tokenCouponReviewView) globalThis.tokenCouponReviewView.setErrors(invalidChoices);
    else for (const row of $("#review-view").querySelectorAll(".finding-choice")) { const invalid = invalidChoices.includes(row.dataset.findingId); row.querySelector(".field-error").textContent = "请填写自定义修订说明"; show(row.querySelector(".field-error"), invalid); }
    showToast("自定义修订说明不能为空。", true); return;
  }
  if (!await confirmPlanChanges()) return;
  if (!state.planning.review?.current || state.planning.review.reviewId !== review.reviewId) { showToast("草案已更新，请重新审查后修订。", true); return; }
  const message = actions.map((item) => {
    const finding = review.findings.find((entry) => entry.findingId === item.findingId);
    if (item.choice === "accept") return `${item.findingId}：采纳建议——${finding.suggestion}`;
    if (item.choice === "custom") return `${item.findingId}：自定义修订——${item.custom}`;
    return `${item.findingId}：暂不处理，保留问题并在新草案中说明；不得将其标记为已解决或豁免。`;
  }).join("\n");
  const planner = policySelection("revision");
  await startJob("按审查意见修订草案", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/revise`, { method: "POST", body: JSON.stringify({ requestKey, message, reviewId: review.reviewId, expectedPlanHash: state.planning.draft.planHash, expectedDraftRevision: state.planning.draft.draftRevision, ...(planner ? { planner } : {}) }) }));
}
function executionConclusion(status, reasonCode) {
  return status === "succeeded" ? "完成结论：任务已成功完成" : status === "blocked" && reasonCode === "user_input_required" ? "等待决策：任务已按要求停止，等待补充信息或处理技术阻塞" : status === "interrupted" ? "中止结论：执行已中断，需核验后恢复" : status === "cancelled" ? "中止结论：任务已取消" : ["failed", "timed_out"].includes(status) ? `错误结论：${status === "timed_out" ? "执行超时" : "任务失败"}` : status === "unavailable" ? "执行状态待核验" : "";
}
function preferredDagFocus(nodes) {
  return (nodes.find(node => node.status === "running") || nodes.find(node => ["failed", "interrupted", "timed_out"].includes(node.status)) || nodes.find(node => node.status !== "succeeded") || nodes.at(-1))?.id;
}
function dagStatusIcon(status) {
  return status === "succeeded" ? "✓" : status === "running" ? "◉" : ["failed", "interrupted", "cancelled", "timed_out", "unavailable"].includes(status) ? "!" : "○";
}
function renderTaskDependencies(tasks) {
  const root = $("#task-dependencies"), definitions = new Map((state.planning.draft?.plan.tasks || []).map(entry => [entry.task.id, entry]));
  const nodes = tasks.map(task => ({ id: task.taskId, title: task.title || definitions.get(task.taskId)?.task.title || task.taskId, status: task.status, deps: [...new Set(task.dependsOn || definitions.get(task.taskId)?.dependsOn || [])] }));
  const identity = `${state.workspace.workspaceId}:${state.planning.planningId}`;
  state.dagNodes = nodes;
  const signature = JSON.stringify([identity, nodes]); if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  if (!nodes.length) {
    if (globalThis.tokenCouponTaskDependencyPreview) globalThis.tokenCouponTaskDependencyPreview.render(null);
    else root.replaceChildren();
    if ($("#dag-dialog").open) $("#dag-dialog").close();
    return;
  }
  const graph = buildTaskDag(nodes, preferredDagFocus(nodes), 2, "preview");
  if (globalThis.tokenCouponTaskDependencyPreview) globalThis.tokenCouponTaskDependencyPreview.render({ taskCount: nodes.length, focusLabel: byTitle(nodes, graph.focusId), shown: graph.shown, svg: graph.svg, onOpen: () => openTaskDag(identity) });
  else {
    root.replaceChildren();
    const heading = document.createElement("h4"); heading.textContent = `任务依赖 · ${nodes.length} 个任务`; root.append(heading);
    const preview = document.createElement("div"); preview.className = "dag-preview dag-mini-map"; preview.append(graph.svg); root.append(preview);
    const full = document.createElement("button"); full.type = "button"; full.className = "button button-quiet task-dag-full"; full.textContent = "放大查看任务 DAG"; full.addEventListener("click", () => openTaskDag(identity)); root.append(full);
    const caption = document.createElement("p"); caption.className = "hint"; caption.textContent = `以${byTitle(nodes, graph.focusId)}为中心 · 显示 ${graph.shown}/${nodes.length} 项 · 远端分支折叠`; root.append(caption);
  }
  if ($("#dag-dialog").open) {
    if (state.dagView?.identity === identity) updateTaskDag(); else $("#dag-dialog").close();
  }
}
function byTitle(nodes, id) { return nodes.find(node => node.id === id)?.title || id; }
function buildTaskDag(nodes, focusId, depth, prefix) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  focusId = byId.has(focusId) ? focusId : preferredDagFocus(nodes);
  const adjacent = new Map(nodes.map(node => [node.id, new Set()]));
  for (const node of nodes) for (const dep of node.deps) if (byId.has(dep)) { adjacent.get(dep).add(node.id); adjacent.get(node.id).add(dep); }
  const distance = new Map([[focusId, 0]]), queue = [focusId];
  for (let i = 0; i < queue.length; i++) { const id = queue[i]; if (distance.get(id) >= depth) continue; for (const other of adjacent.get(id) || []) if (!distance.has(other)) { distance.set(other, distance.get(id) + 1); queue.push(other); } }
  // A bounded neighborhood prevents a long chain or broad fan-out from taking over the page.
  const selected = new Set(queue.slice(0, 21)), visible = nodes.filter(node => selected.has(node.id));
  const levels = new Map(), remaining = new Map(visible.map(node => [node.id, node.deps.filter(id => selected.has(id)).length]));
  const ready = visible.filter(node => !remaining.get(node.id)).map(node => node.id);
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]; levels.set(id, levels.get(id) || 0);
    for (const next of adjacent.get(id) || []) if (selected.has(next) && byId.get(next).deps.includes(id)) { levels.set(next, Math.max(levels.get(next) || 0, levels.get(id) + 1)); remaining.set(next, remaining.get(next) - 1); if (!remaining.get(next)) ready.push(next); }
  }
  const invalid = ready.length !== visible.length || nodes.some(node => node.deps.some(id => !byId.has(id)));
  for (const node of visible) if (!levels.has(node.id)) levels.set(node.id, 0);
  const focusLevel = levels.get(focusId) || 0, maxLevel = Math.max(0, ...levels.values());
  const span = Math.max(focusLevel, maxLevel - focusLevel), width = (span * 2 + 1) * 268 + 28;
  const columns = new Map();
  for (const node of visible) { const level = levels.get(node.id); if (!columns.has(level)) columns.set(level, []); columns.get(level).push(node); }
  const maxRows = Math.max(1, ...[...columns.values()].map(items => items.length)), height = maxRows * 116 + 44, positions = new Map();
  for (const [level, items] of columns) {
    items.sort((a, b) => a.id === focusId ? -1 : b.id === focusId ? 1 : 0);
    items.forEach((node, index) => positions.set(node.id, { x: (level - focusLevel + span) * 268 + 14, y: (height - items.length * 116) / 2 + index * 116 }));
  }
  const ns = "http://www.w3.org/2000/svg", make = (tag, attrs = {}) => { const el = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value)); return el; };
  const svg = make("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": "任务依赖图，入边为前置任务，出边为后续任务", "data-focus-id": focusId });
  const defs = make("defs"); svg.append(defs);
  const palette = ["#8264aa", "#368c87", "#bd6c87", "#728b43", "#627cb2", "#ae7849"];
  for (const [index, node] of visible.entries()) for (const dep of node.deps) {
    if (!positions.has(dep)) continue;
    const incoming = node.id === focusId, outgoing = dep === focusId, relation = incoming ? "incoming" : outgoing ? "outgoing" : "branch";
    const color = incoming ? "#3977bc" : outgoing ? "#bd7333" : palette[nodes.findIndex(item => item.id === dep) % palette.length];
    const markerId = `${prefix}-arrow-${index}-${node.deps.indexOf(dep)}`;
    const marker = make("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" }); marker.append(make("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color })); defs.append(marker);
    const from = positions.get(dep), to = positions.get(node.id), start = from.x + 216, mid = (start + to.x) / 2;
    const edge = make("path", { d: `M ${start} ${from.y + 42} C ${mid} ${from.y + 42}, ${mid} ${to.y + 42}, ${to.x - 4} ${to.y + 42}`, class: "dag-edge", stroke: color, "marker-end": `url(#${markerId})`, "data-from": dep, "data-to": node.id, "data-relation": relation });
    const title = make("title"); title.textContent = `${byId.get(dep).title} → ${node.title}`; edge.append(title); svg.append(edge);
  }
  for (const node of visible) {
    const { x, y } = positions.get(node.id), group = make("g", { class: "dag-node", "data-status": node.status, "data-task-id": node.id, "data-focused": node.id === focusId });
    const title = make("title"); title.textContent = `${node.title} (${node.id}) · ${statuses[node.status] || node.status}`;
    const name = make("text", { x: x + 12, y: y + 23 }), status = make("text", { x: x + 12, y: y + 46, class: "dag-status" });
    name.textContent = node.title.length > 15 ? node.title.slice(0, 14) + "…" : node.title;
    status.textContent = `${dagStatusIcon(node.status)} ${statuses[node.status] || node.status}${node.id === focusId ? " · 当前聚焦" : ""}`;
    const detail = make("g", { role: "button", tabindex: 0, class: "dag-detail-button", "data-dag-detail": node.id, "aria-label": `查看明细：${node.title}` });
    const detailText = make("text", { x: x + 125, y: y + 70 }); detailText.textContent = "查看明细 ↗";
    detail.append(make("rect", { x: x + 116, y: y + 53, width: 90, height: 25, rx: 5 }), detailText);
    group.append(title, make("rect", { x, y, width: 216, height: 86, rx: 10 }), name, status, detail); svg.append(group);
  }
  const focus = positions.get(focusId);
  return { svg, focusId, shown: visible.length, width, height, focusX: focus.x + 108, focusY: focus.y + 43, invalid };
}
function openTaskDag(identity) {
  state.dagView = { identity, focusId: preferredDagFocus(state.dagNodes), depth: 2, zoom: 1, autoFocus: true };
  $("#dag-title").textContent = `${state.planning.draft?.plan.title || "任务"} · 任务依赖图`;
  updateTaskDag(); $("#dag-dialog").showModal(); if ($("#dag-viewport").clientWidth > 650 || !$("#dag-viewport").clientWidth) fitTaskDag(); else centerTaskDag();
}
function updateTaskDag(recenter = false) {
  const view = state.dagView; if (!view || !state.dagNodes?.length) return;
  const previousFocus = view.focusId;
  if (view.autoFocus) view.focusId = preferredDagFocus(state.dagNodes);
  const graph = buildTaskDag(state.dagNodes, view.focusId, view.depth, "expanded");
  const viewport = $("#dag-viewport"), x = viewport.scrollLeft, y = viewport.scrollTop;
  Object.assign(view, { focusId: graph.focusId, width: graph.width, height: graph.height, focusX: graph.focusX, focusY: graph.focusY });
  viewport.replaceChildren(graph.svg); setTaskDagZoom(view.zoom);
  const focusOptions = state.dagNodes.map(node => ({ id: node.id, label: `${dagStatusIcon(node.status)} ${node.title} · ${statuses[node.status] || node.status}` }));
  if (globalThis.tokenCouponDagFocusSelector) {
    globalThis.tokenCouponDagFocusSelector.render(focusOptions, graph.focusId, taskId => {
      if (!state.dagView) return;
      state.dagView.focusId = taskId; state.dagView.autoFocus = false; updateTaskDag(true);
    });
  } else {
    const select = $("#dag-focus"); const optionsSignature = JSON.stringify(state.dagNodes);
    if (select.dataset.signature !== optionsSignature) { select.dataset.signature = optionsSignature; select.replaceChildren(...focusOptions.map(option => new Option(option.label, option.id))); }
    select.value = graph.focusId;
  }
  $("#dag-scope").textContent = `聚焦：${byTitle(state.dagNodes, graph.focusId)} · 前后 ${view.depth} 层 · 显示 ${graph.shown}/${state.dagNodes.length} 项；远端任务已折叠。${graph.shown >= 21 ? "已达到单视图 21 项上限，请切换聚焦任务查看其他分支。" : ""}${graph.invalid ? "依赖记录不完整或存在环，请核对草案。" : ""}`;
  $("#dag-expand").disabled = graph.shown === state.dagNodes.length || graph.shown >= 21 || view.depth >= 8;
  $("#dag-collapse").disabled = view.depth <= 1;
  if (recenter || view.autoFocus && previousFocus !== graph.focusId) centerTaskDag(); else { viewport.scrollLeft = x; viewport.scrollTop = y; }
}
function centerTaskDag() {
  const view = state.dagView, box = $("#dag-viewport"); if (!view) return;
  box.scrollLeft = Math.max(0, view.focusX * view.zoom - box.clientWidth / 2); box.scrollTop = Math.max(0, view.focusY * view.zoom - box.clientHeight / 2);
}
function setTaskDagZoom(zoom) {
  const view = state.dagView, svg = $("#dag-viewport svg"); if (!view || !svg) return;
  view.zoom = Math.min(3, Math.max(0.15, zoom));
  svg.setAttribute("width", String(Math.round(view.width * view.zoom))); svg.setAttribute("height", String(Math.round(view.height * view.zoom)));
  $("#dag-zoom-value").textContent = `${Math.round(view.zoom * 100)}%`;
}
function fitTaskDag() {
  const box = $("#dag-viewport"), view = state.dagView; if (!view) return;
  setTaskDagZoom(Math.min(1, ((box.clientWidth || view.width) - 24) / view.width, ((box.clientHeight || view.height) - 24) / view.height)); centerTaskDag();
}
function showDagTaskDetails(taskId) {
  const task = state.planning.session?.tasks.find(item => item.taskId === taskId), definition = state.planning.draft?.plan.tasks.find(entry => entry.task.id === taskId);
  if (!task && !definition) return;
  $("#dag-task-title").textContent = task?.title || definition?.task.title || taskId;
  const content = $("#dag-task-content"); content.replaceChildren();
  const execution = task?.currentAttempt?.execution || task?.execution || definition?.task.execution || {};
  const summaryFields = [["状态", `${dagStatusIcon(task?.status)} ${statuses[task?.status] || task?.status || "未开始"}`], ["任务 ID", taskId], ["Runner / 模型", `${execution.runnerId || "未设置"} / ${task?.currentAttempt?.reportedModel || execution.modelId || "Runner 默认"}`], ["前置任务", (task?.dependsOn || definition?.dependsOn || []).map(id => byTitle(state.dagNodes || [], id)).join("、") || "无"]];
  const spec = definition?.task;
  const bodyFields = spec?.schemaVersion === 2 ? [["需求目标", spec.objective], ["设计与技术方案", spec.approach], ["实施步骤", spec.steps], ["交付物", spec.deliverables], ["验收标准", spec.acceptanceCriteria], ["约束", spec.constraints], ["其他说明", spec.notes]] : [["正文与验收", spec?.prompt || "暂无计划正文"]];
  const sections = [...summaryFields, ...bodyFields].filter(([, raw]) => raw !== undefined && raw !== null).map(([label, raw]) => ({ label, value: Array.isArray(raw) ? raw.map((line, i) => `${i + 1}. ${line}`).join("\n") : raw }));
  const attemptId = task?.activeAttemptId || task?.attempts?.at(-1)?.attemptId;
  if (globalThis.tokenCouponDagTaskDetails) {
    globalThis.tokenCouponDagTaskDetails.render($("#dag-task-content-root"), { sections, canOpenAttempt: !!attemptId }, () => {
      if (!attemptId) return;
      $("#dag-task-dialog").close(); if ($("#dag-dialog").open) $("#dag-dialog").close(); void openTaskDetails(attemptId);
    });
  } else {
    content.replaceChildren();
    for (const { label, value } of sections) {
      const section = document.createElement("section"), heading = document.createElement("h4"), body = document.createElement("pre"); heading.textContent = label; body.textContent = value; section.append(heading, body); content.append(section);
    }
    $("#dag-task-attempt").disabled = !attemptId;
    $("#dag-task-attempt").onclick = () => { if (!attemptId) return; $("#dag-task-dialog").close(); if ($("#dag-dialog").open) $("#dag-dialog").close(); void openTaskDetails(attemptId); };
  }
  $("#dag-task-dialog").showModal();
}
function taskBoardGroup(status) {
  return status === "succeeded" ? "completed" : status === "running" ? "running" : ["planned", "created", "blocked", "paused", "ready"].includes(status) ? "pending" : "errors";
}
function ensureTaskBoard(box) {
  const identity = `${state.workspace?.workspaceId}:${state.planning.planningId}:${state.planning.session?.sessionId || ""}`;
  if (box.dataset.identity === identity && box.querySelector(".task-board")) return;
  box.dataset.identity = identity; box.replaceChildren();
  const board = document.createElement("div"); board.className = "task-board";
  for (const [id, label] of [["completed", "已完成"], ["running", "运行中"], ["pending", "未开始 / 等待依赖"], ["errors", "错误 / 中断"]]) {
    const column = document.createElement("section"); column.className = "task-board-column"; column.dataset.group = id;
    const heading = document.createElement("h4"); heading.textContent = label; const count = document.createElement("span"); count.className = "task-board-count"; heading.append(count);
    const rows = document.createElement("div"); rows.className = "task-board-rows";
    const overflow = document.createElement("details"); overflow.className = "task-board-overflow hidden";
    const summary = document.createElement("summary"), extra = document.createElement("div"); extra.className = "task-board-extra"; overflow.append(summary, extra);
    column.append(heading, rows, overflow); board.append(column);
  }
  box.append(board);
}
function pendingTaskInteraction(task) {
  if (!["created", "running"].includes(task.status)) return;
  const attemptId = task.activeAttemptId || task.currentAttempt?.attemptId || task.attempts?.at(-1)?.attemptId;
  return state.planning?.interactions?.find(item => item.owner?.taskId === task.taskId && (!item.owner.attemptId || !attemptId || item.owner.attemptId === attemptId));
}
function taskExecutionLabel(task) {
  const pending = pendingTaskInteraction(task);
  return pending ? pending.request.kind === "question" ? "等待回答" : pending.request.kind === "approval" ? "等待工具审批" : "等待表单／网页确认" : statuses[task.status] || task.status;
}
function taskBoardViewModel(session, tasks) {
  const groups = [
    { id: "completed", label: "已完成", tasks: [] },
    { id: "running", label: "运行中", tasks: [] },
    { id: "pending", label: "未开始 / 等待依赖", tasks: [] },
    { id: "errors", label: "错误 / 中断", tasks: [] },
  ];
  const definitions = new Map((state.planning.draft?.plan.tasks || []).map(entry => [entry.task.id, entry]));
  for (const task of tasks) {
    const definition = definitions.get(task.taskId), status = task.status, pending = pendingTaskInteraction(task);
    const attempt = task.currentAttempt, execution = attempt?.execution || task.execution || definition?.task.execution || {};
    const dependencies = task.dependsOn || definition?.dependsOn || [];
    const unfinishedDependencies = dependencies.filter(id => !tasks.some(item => item.taskId === id && item.status === "succeeded"));
    const dependencyItems = (unfinishedDependencies.length ? unfinishedDependencies : dependencies).map(id => {
      const dependency = tasks.find(item => item.taskId === id);
      return { label: `${dependency?.title || id}（${statuses[dependency?.status] || "状态待核验"}）`, tone: statusClass(dependency?.status) };
    });
    const completedDependencies = unfinishedDependencies.length && unfinishedDependencies.length < dependencies.length ? dependencies.filter(id => !unfinishedDependencies.includes(id)).map(id => {
      const dependency = tasks.find(item => item.taskId === id);
      return { label: `${dependency?.title || id}（${statuses[dependency?.status] || "状态待核验"}）`, tone: statusClass(dependency?.status) };
    }) : [];
    const id = task.activeAttemptId || task.attempts?.at(-1)?.attemptId;
    const runner = attempt?.runnerId || execution.runnerId || "未知 Runner";
    const model = attempt?.reportedModel ? reportedModelLabel(attempt.reportedModel, attempt.reportedModelSource) : execution.modelId ? `${execution.modelId}（配置模型）` : "沿用 Runner 默认，实际模型未报告";
    const elapsed = attempt?.startedAt ? ` · 耗时 ${Math.max(0, Math.floor(((attempt.finishedAt ? Date.parse(attempt.finishedAt) : Date.now()) - Date.parse(attempt.startedAt)) / 1000))} 秒` : "";
    const recent = attempt?.activity || state.taskActivity?.[task.taskId];
    const activity = pending ? "请在上方“审批与回答”处理；提交后继续当前任务" : recent || (status === "planned" ? `等待依赖：${dependencies.join("、") || "等待调度"}` : task.reasonCode === "user_input_required" ? "已暂停自动调度，请查看最新 Attempt 的结论" : attempt?.lastActivityAt ? `最近活动：${new Date(attempt.lastActivityAt).toLocaleTimeString()}` : "等待输出");
    const taskStatusLabel = status === "blocked" && task.reasonCode === "user_input_required" ? "等待用户决策" : status === "blocked" && task.reasonCode === "dependency_not_succeeded" ? "等待前置任务" : taskExecutionLabel(task);
    const icon = status === "succeeded" ? "✓" : status === "failed" ? "!" : status === "running" ? "◌" : status === "blocked" ? "Ⅱ" : "·";
    const actions = [{ label: "查看明细", onClick: () => showDagTaskDetails(task.taskId) }];
    if (id) actions.push({ label: "查看回复与工具活动", onClick: () => void openTaskDetails(id) });
    if (status === "succeeded") actions.push({ label: "查看任务生成结果", onClick: () => void openTaskResults(task.taskId) });
    const retryable = ["failed", "timed_out", "cancelled", "interrupted"].includes(status) && dependencies.every(id => tasks.some(item => item.taskId === id && item.status === "succeeded")) && !session.health?.recoveryRequired && !["active", "unknown", "identity_conflict"].includes(session.health?.state);
    if (retryable) actions.push({ label: `重试 ${task.taskId}`, onClick: () => startSessionAction("session/retry", `重试 ${task.taskId}`, { taskId: task.taskId }) });
    groups.find(group => group.id === taskBoardGroup(status)).tasks.push({
      taskId: task.taskId,
      icon: pending ? "Ⅱ" : icon,
      iconTone: pending ? "blocked" : status,
      title: task.title || definition?.task.title || task.taskId,
      runnerModel: `${runner} / ${model}`,
      attemptSummary: `${task.attempts?.length || 0} 次 attempt`,
      elapsed,
      ...(task.reasonCode ? { reasonCode: task.reasonCode } : {}),
      activity,
      ...(task.result?.summary ? { resultSummary: task.result.summary, resultTruncated: task.result.truncated } : {}),
      dependencyLabel: unfinishedDependencies.length ? "等待前置任务完成：" : "前置任务已全部完成：",
      dependencies: dependencyItems,
      ...(completedDependencies.length ? { completedDependencyLabel: "已完成的前置任务：", completedDependencies } : {}),
      ...(session.models?.overrides?.[task.taskId] ? { nextModel: `下次启动模型：${session.models.overrides[task.taskId].modelId || "沿用 Session 启动配置"}；当前 Attempt 不原地变更` } : {}),
      ...(executionConclusion(status, task.reasonCode) ? { outcome: executionConclusion(status, task.reasonCode) } : {}),
      statusLabel: taskStatusLabel,
      statusTone: statusClass(pending ? "blocked" : status),
      actions,
    });
  }
  return { groups };
}
function renderLiveTaskReplies(tasks) {
  const root = $("#live-task-replies");
  const wasOpen = !!root.querySelector("details[open]");
  const ordered = tasks.filter(item => item.currentAttempt).map((task, index) => ({ task, index, time: Date.parse(task.currentAttempt.startedAt || task.currentAttempt.lastActivityAt || "") || 0 }))
    .sort((a, b) => b.time - a.time || b.index - a.index).map(item => item.task);
  const latest = ordered[0], current = ordered.filter(task => task.status === "running" || task === latest), history = ordered.filter(task => !current.includes(task));
  const latestButton = $("#execution-latest-details"); latestButton.disabled = !latest;
  latestButton.dataset.attemptId = latest?.currentAttempt.attemptId || "";
  $("#execution-response-context").textContent = latest ? `最近一次记录：${latest.title || latest.taskId} · ${shortId(latest.currentAttempt.attemptId)}${latest.currentAttempt.startedAt ? ` · ${new Date(latest.currentAttempt.startedAt).toLocaleString()}` : ""}。历史任务结果另行折叠。` : "尚无执行记录；启动后在此查看任务与模型返回。";
  const cards = [...current, ...history].map((task, index) => {
    const attempt = task.currentAttempt;
    const modelLabel = attempt.reportedModel ? reportedModelLabel(attempt.reportedModel, attempt.reportedModelSource) : attempt.execution?.modelId ? `${attempt.execution.modelId}（配置值）` : "Runner 默认模型，实际未验证";
    const historical = history.includes(task);
    const pending = pendingTaskInteraction(task);
    const time = attempt.lastActivityAt ? Date.parse(attempt.lastActivityAt) : NaN;
    const failed = ["failed", "interrupted", "cancelled", "timed_out"].includes(task.status);
    return {
      attemptId: attempt.attemptId,
      heading: `${historical ? "历史任务 · " : ""}${task.title || task.taskId} · ${taskExecutionLabel(task)} · ${modelLabel}`,
      reply: attempt.lastReply ? `模型返回：${attempt.lastReply}` : "模型尚未返回文字；以工具活动及执行状态为准。",
      activity: pending ? `${shortId(attempt.attemptId)} · 请在上方“审批与回答”处理：${pending.request.summary || pending.request.title}。提交后继续当前任务。` : `${shortId(attempt.attemptId)} · ${attempt.activity || (task.status === "running" ? "等待下一条可观测活动" : "本次任务执行已结束")}${Number.isFinite(time) ? ` · ${new Date(time).toLocaleString()}` : ""}${task.status === "running" ? "。长任务暂无输出不等于已停止。" : ""}`,
      ...(attempt.reason && failed ? { error: `中断／错误原因：${attempt.reason}` } : {}),
      showDiagnosis: failed || task.status === "blocked" && task.reasonCode === "user_input_required",
      onDiagnose: async () => { await openTaskDetails(attempt.attemptId); await openAttemptDiagnosis(); },
    };
  });
  const visible = cards.slice(0, Math.min(3, current.length)), overflowCards = cards.slice(visible.length);
  const model = { visible, overflow: overflowCards, overflowLabel: `其他任务与历史返回（${overflowCards.length} 项，不代表本次重试）` };
  if (globalThis.tokenCouponLiveTaskReplies) globalThis.tokenCouponLiveTaskReplies.render(model);
  else {
    root.replaceChildren();
    const renderCard = cardModel => {
      const card = document.createElement("article"), heading = document.createElement("strong"), body = document.createElement("p"), activity = document.createElement("p");
      card.className = "live-task-reply"; card.dataset.attemptId = cardModel.attemptId; heading.textContent = cardModel.heading; body.textContent = cardModel.reply; activity.className = "hint"; activity.textContent = cardModel.activity; card.append(heading);
      if (cardModel.error) { const error = document.createElement("p"); error.className = "reply-verdict reply-error"; error.textContent = cardModel.error; card.append(error); }
      card.append(body, activity);
      if (cardModel.showDiagnosis) { const diagnose = document.createElement("button"); diagnose.type = "button"; diagnose.className = "button button-quiet"; diagnose.textContent = "分析原因"; diagnose.addEventListener("click", cardModel.onDiagnose); card.append(diagnose); }
      return card;
    };
    for (const card of visible) root.append(renderCard(card));
    if (overflowCards.length) {
      const overflow = document.createElement("details"); overflow.className = "live-replies-overflow foldout"; overflow.open = wasOpen;
      const summary = document.createElement("summary"); summary.textContent = model.overflowLabel; overflow.append(summary);
      for (const card of overflowCards) overflow.append(renderCard(card));
      root.append(overflow);
    }
  }
  show(root, !!cards.length);
}
function renderRuntimeModelPanel(tasks) {
  const candidates = tasks.filter(task => task.status !== "succeeded" && (task.execution?.runnerId || state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId)?.task.execution.runnerId) !== "mock");
  show($("#runtime-model-panel"), !!state.planning.session && !!candidates.length);
  show($("#runtime-model-empty"), !state.planning.session || !candidates.length);
  show($("#open-runtime-model"), !!state.planning.session && !!candidates.length);
  if (!candidates.length) return;
  const select = $("#runtime-model-task"), signature = JSON.stringify([state.workspace.workspaceId, state.planning.planningId, candidates.map(task => task.taskId)]);
  if (signature !== state.runtimeTaskSignature) {
    state.runtimeTaskSignature = signature;
    const previous = state.runtimeModelTaskId || select.value;
    state.runtimeModelTaskId = candidates.some(task => task.taskId === previous) ? previous : candidates[0].taskId;
    state.runtimeModelCatalogKey = null;
    state.runtimeModelChoices = [{ id: "", label: "沿用 Session 启动模型" }, { id: "__custom__", label: "自定义模型…" }];
    state.runtimeModelChoice = ""; state.runtimeModelCustomValue = "";
    void loadRuntimeModelChoices();
  }
  state.runtimeModelCandidates = candidates;
  renderRuntimeModelControls();
  const target = candidates.find(task => task.taskId === state.runtimeModelTaskId), busy = !!state.runtimeModelSubmitting || state.activeJob?.kind === "session.model-switch" && state.activeJob.status === "running";
  $("#runtime-model-save").disabled = busy;
  $("#runtime-model-retry").disabled = busy || target?.status !== "running" || state.planning.session.health?.state !== "active";
  if (!state.runtimeModelSubmitting) $("#runtime-model-status").textContent = `配置版本 ${state.planning.session.models?.revision || 0} · ${target?.title || target?.taskId || ""}：${statuses[target?.status] || ""}。运行中停止重试会等待当前批次安全收尾；不停止其他任务。`;
}
function renderRuntimeModelControls() {
  const tasks = (state.runtimeModelCandidates || []).map(task => ({ id: task.taskId, label: task.title || task.taskId }));
  const models = state.runtimeModelChoices || [{ id: "", label: "沿用 Session 启动模型" }, { id: "__custom__", label: "自定义模型…" }];
  const bridge = globalThis.tokenCouponRuntimeModelControls;
  if (bridge) {
    bridge.render({ tasks, selectedTaskId: state.runtimeModelTaskId || "", models, selectedModelId: state.runtimeModelChoice || "", customModelId: state.runtimeModelCustomValue || "", loading: !!state.runtimeModelLoading }, {
      onTaskChange: selectRuntimeModelTask,
      onModelChange: value => { state.runtimeModelChoice = value; renderRuntimeModelControls(); },
      onCustomModelChange: value => { state.runtimeModelCustomValue = value; renderRuntimeModelControls(); },
    });
    return;
  }
  const task = $("#runtime-model-task"), previous = task.value;
  task.replaceChildren(...tasks.map(item => new Option(item.label, item.id)));
  task.value = tasks.some(item => item.id === (state.runtimeModelTaskId || previous)) ? state.runtimeModelTaskId || previous : tasks[0]?.id || "";
  const choice = $("#runtime-model-choice"); choice.replaceChildren(...models.map(item => new Option(item.label, item.id)));
  choice.disabled = !!state.runtimeModelLoading; choice.setAttribute("aria-busy", String(!!state.runtimeModelLoading));
  choice.value = state.runtimeModelChoice || "";
  $("#runtime-model-custom").value = state.runtimeModelCustomValue || "";
  show($("#runtime-model-custom").parentElement, choice.value === "__custom__");
}
function selectRuntimeModelTask(taskId) {
  if (!state.runtimeModelCandidates?.some(task => task.taskId === taskId)) return;
  state.runtimeModelTaskId = taskId;
  state.runtimeModelChoices = [{ id: "", label: "沿用 Session 启动模型" }, { id: "__custom__", label: "自定义模型…" }];
  state.runtimeModelChoice = ""; state.runtimeModelCustomValue = "";
  renderRuntimeModelControls();
  void loadRuntimeModelChoices();
  if (state.planning?.session) renderRuntimeModelPanel(state.planning.session.tasks);
}
async function loadRuntimeModelChoices() {
  const plan = state.planning, workspaceId = state.workspace?.workspaceId, taskId = state.runtimeModelTaskId || $("#runtime-model-task").value;
  if (!plan || !workspaceId || !taskId) return;
  const entry = plan.draft?.plan.tasks.find(item => item.task.id === taskId), runnerId = plan.session?.tasks.find(item => item.taskId === taskId)?.execution?.runnerId || entry?.task.execution.runnerId;
  if (!runnerId) return;
  const identity = `${workspaceId}:${plan.planningId}:${taskId}`, request = state.runtimeModelRequest = (state.runtimeModelRequest || 0) + 1;
  state.runtimeModelLoading = true;
  state.runtimeModelChoices = [{ id: "", label: "沿用 Session 启动模型" }, { id: "__custom__", label: "自定义模型…" }];
  state.runtimeModelChoice = ""; state.runtimeModelCustomValue = ""; renderRuntimeModelControls();
  try {
    const catalog = await runnerModelCatalog(runnerId, workspaceId);
    if (request !== state.runtimeModelRequest || `${state.workspace?.workspaceId}:${state.planning?.planningId}:${state.runtimeModelTaskId || $("#runtime-model-task").value}` !== identity) return;
    state.runtimeModelChoices = [{ id: "", label: "沿用 Session 启动模型" }, ...(catalog.models || []).map(model => ({ id: model.id, label: model.label || model.id })), { id: "__custom__", label: "自定义模型…" }];
    const saved = plan.session?.models?.overrides?.[taskId]?.modelId;
    if (saved) { if (!state.runtimeModelChoices.some(item => item.id === saved)) state.runtimeModelChoices.splice(state.runtimeModelChoices.length - 1, 0, { id: saved, label: saved }); state.runtimeModelChoice = saved; }
  } catch { $("#runtime-model-status").textContent = "候选模型暂不可读，可输入 Runner 支持的自定义模型 ID。"; }
  if (request === state.runtimeModelRequest) { state.runtimeModelLoading = false; renderRuntimeModelControls(); }
}
async function changeRuntimeModel(stopAndRetry) {
  const plan = state.planning, workspaceId = state.workspace?.workspaceId, taskId = $("#runtime-model-task").value;
  const task = plan?.session?.tasks.find(item => item.taskId === taskId); if (!plan || !workspaceId || !task || state.runtimeModelSubmitting) return;
  const value = $("#runtime-model-choice").value, modelId = value === "__custom__" ? $("#runtime-model-custom").value.trim() : value || null;
  if (value === "__custom__" && !modelId) { $("#runtime-model-status").textContent = "请填写自定义模型 ID；尚未提交。"; return; }
  if (!await askConfirm(stopAndRetry ? "停止当前任务并换模型重试" : "设置后续执行模型", `${task.title || taskId} → ${modelId || "Session 启动模型"}。旧 Attempt 和文件保留，不回滚修改；独立 worktree 的未完成改动保留在原目录。`, stopAndRetry ? "停止并重试" : "应用模型", stopAndRetry)) return;
  state.runtimeModelSubmitting = true; renderRuntimeModelPanel(plan.session.tasks);
  const body = { taskId, modelId, expectedRevision: plan.session.models?.revision || 0, stopAndRetry, confirmed: true, ...(stopAndRetry ? { expectedAttemptId: task.activeAttemptId } : {}) };
  try { await startJob(stopAndRetry ? `换模型重试 ${taskId}` : `更新任务模型 ${taskId}`, requestKey => api(`/api/v1/workspaces/${workspaceId}/plannings/${plan.planningId}/session/models`, { method: "POST", body: JSON.stringify({ requestKey, ...body }) }), false, true); }
  finally { state.runtimeModelSubmitting = false; if (state.planning?.planningId === plan.planningId) renderRuntimeModelPanel(state.planning.session.tasks); }
}
function renderSession() {
  const box = $("#task-list"); const session = state.planning.session;
  if (!session) {
    if (globalThis.tokenCouponSessionControls) globalThis.tokenCouponSessionControls.render({ buttons: [] });
    else { $("#session-controls").replaceChildren(); delete $("#session-controls").dataset.signature; }
  }
  renderSessionContinue(session);
  renderControlFeedback(session);
  renderExecutionFloatingStatus();
  const tasks = session?.tasks || [], running = tasks.filter(task => task.status === "running" && !pendingTaskInteraction(task)), waitingForUser = tasks.filter(task => task.status === "blocked" && task.reasonCode === "user_input_required");
  const waiting = tasks.filter(task => pendingTaskInteraction(task)).length;
  const progress = $("#session-progress"), completed = tasks.filter(task => task.status === "succeeded").length;
  const progressSignature = JSON.stringify([session?.status, tasks.map(task => [task.status, task.reasonCode]), waiting, session?.maxParallel]);
  if (progress.dataset.signature !== progressSignature) {
    progress.dataset.signature = progressSignature;
    const statusLabel = session ? waitingForUser.length ? "等待用户决策" : waiting ? "等待人工处理" : statuses[session.status] || session.status : "尚未启动 Session";
    const metrics = session ? [["成功", `${completed}/${tasks.length}`, "completed"], ["运行中", running.length, "running"], ...(waiting ? [["等待回答／审批", waiting, "waiting"]] : []), ["待执行", tasks.filter(task => ["planned", "created", "blocked", "ready", "paused"].includes(task.status)).length, "pending"], ["失败／中断", tasks.filter(task => ["failed", "timed_out", "interrupted", "cancelled", "unavailable"].includes(task.status)).length, "errors"], ["并发上限", session.maxParallel || 1, "parallel"]] : [];
    const model = { statusLabel, statusTone: statusClass(session?.status), hasSession: !!session, completed, total: tasks.length, metrics: metrics.map(([label, value, kind]) => ({ label, value, kind })) };
    if (globalThis.tokenCouponExecutionProgress) globalThis.tokenCouponExecutionProgress.render(model);
    else {
      progress.replaceChildren();
      const status = document.createElement("span"); status.className = `execution-state badge ${model.statusTone}`; status.textContent = model.statusLabel; progress.append(status);
      if (session) {
        const track = document.createElement("progress"); track.max = tasks.length || 1; track.value = completed; track.setAttribute("aria-label", "已完成任务比例"); progress.append(track);
        const metricsRoot = document.createElement("div"); metricsRoot.className = "execution-metrics";
        for (const metricData of model.metrics) {
          const metric = document.createElement("div"); metric.className = "execution-metric"; metric.dataset.kind = metricData.kind; const text = document.createElement("span"), count = document.createElement("strong"); text.textContent = metricData.label + " "; count.textContent = String(metricData.value); metric.append(text, count); metricsRoot.append(metric);
        }
        progress.append(metricsRoot);
      }
    }
  }
  const health = session?.health;
  show($("#execution-planner-help"), !!session && ["failed", "interrupted", "blocked", "paused", "cancelled"].includes(session.status));
  show($("#session-health"), !!session);
  $("#session-health-title").textContent = health ? `${statuses[session.status] || session.status} · 已检测 ${new Date(health.checkedAt).toLocaleTimeString()}` : "执行状态尚未检测";
  $("#session-health-message").textContent = health?.message || "点击重新检测确认执行进程状态。";
  $("#session-health").classList.toggle("notice-warn", !!health && health.state !== "active" && session.status !== "succeeded");
  show($("#session-recover"), !!health?.recoveryRequired);
  $("#session-progress").className = `session-progress ${statusClass(session?.status)}`;
  renderTaskDependencies(tasks); renderLiveTaskReplies(tasks); renderRuntimeModelPanel(tasks);
  renderAttemptChoices(tasks);
  if (!session?.tasks) {
    const emptyMessage = state.planning.status === "approved" ? "草案已批准，点击“运行计划”启动。" : "完成审查和批准后，任务进度会显示在这里。";
    if (globalThis.tokenCouponTaskBoard) globalThis.tokenCouponTaskBoard.render({ emptyMessage, groups: [] });
    else box.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }
  if (globalThis.tokenCouponTaskBoard) globalThis.tokenCouponTaskBoard.render(taskBoardViewModel(session, tasks));
  else {
  ensureTaskBoard(box);
  const existingRows = new Map([...box.querySelectorAll(".task-row")].map(row => [row.dataset.taskId, row]));
  for (const [id, row] of existingRows) if (!tasks.some(task => task.taskId === id)) row.remove();
  for (const task of session.tasks) {
    const row = existingRows.get(task.taskId) || document.createElement("div"); row.className = "task-row"; row.dataset.taskId = task.taskId;
    const target = box.querySelector(`[data-group="${taskBoardGroup(task.status)}"] .task-board-rows`);
    if (row.parentElement !== target) target.append(row);
    const dependencyStates = (task.dependsOn || state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId)?.dependsOn || []).map(id => { const dependency = tasks.find(item => item.taskId === id); return [id, dependency?.status, dependency?.title]; });
    const pending = pendingTaskInteraction(task);
    const signature = JSON.stringify([task, dependencyStates, session.models?.overrides?.[task.taskId], session.health?.state, session.health?.recoveryRequired, state.taskActivity?.[task.taskId], pending?.requestId, pending?.request.kind]);
    const elapsedText = task.currentAttempt?.startedAt ? ` · 耗时 ${Math.max(0, Math.floor(((task.currentAttempt.finishedAt ? Date.parse(task.currentAttempt.finishedAt) : Date.now()) - Date.parse(task.currentAttempt.startedAt)) / 1000))} 秒` : "";
    if (row.dataset.signature === signature) { const clock = row.querySelector(".task-elapsed"); if (clock) clock.textContent = elapsedText; continue; }
    const expanded = !!row.querySelector("details[open]"); row.dataset.signature = signature;
    const status = task.status; const icon = status === "succeeded" ? "✓" : status === "failed" ? "!" : status === "running" ? "◌" : status === "blocked" ? "Ⅱ" : "·";
    const definition = state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId);
    const attempt = task.currentAttempt, execution = attempt?.execution || task.execution || definition?.task.execution || {};
    const runner = attempt?.runnerId || execution.runnerId || "未知 Runner";
    const model = attempt?.reportedModel ? reportedModelLabel(attempt.reportedModel, attempt.reportedModelSource) : execution.modelId ? `${execution.modelId}（配置模型）` : "沿用 Runner 默认，实际模型未报告";
    const elapsed = attempt?.startedAt ? ` · 耗时 ${Math.max(0, Math.floor(((attempt.finishedAt ? Date.parse(attempt.finishedAt) : Date.now()) - Date.parse(attempt.startedAt)) / 1000))} 秒` : "";
    const recent = attempt?.activity || state.taskActivity?.[task.taskId];
    const taskStatusLabel = status === "blocked" && task.reasonCode === "user_input_required" ? "等待用户决策" : status === "blocked" && task.reasonCode === "dependency_not_succeeded" ? "等待前置任务" : taskExecutionLabel(task);
    row.innerHTML = `<span class="task-icon ${pending ? "blocked" : status}">${pending ? "Ⅱ" : icon}</span><span><span class="task-name">${esc(task.title || definition?.task.title || task.taskId)}</span><span class="task-sub">${esc(task.taskId)} · ${esc(runner)} / ${esc(model)}</span><span class="task-sub">${task.attempts?.length || 0} 次 attempt<span class="task-elapsed">${elapsed}</span>${task.reasonCode ? ` · ${esc(task.reasonCode)}` : ""}</span><span class="task-sub">${esc(pending ? "请在上方“审批与回答”处理；提交后继续当前任务" : recent || (status === "planned" ? `等待依赖：${(task.dependsOn || definition?.dependsOn || []).join("、") || "等待调度"}` : task.reasonCode === "user_input_required" ? "已暂停自动调度，请查看最新 Attempt 的结论" : attempt?.lastActivityAt ? `最近活动：${new Date(attempt.lastActivityAt).toLocaleTimeString()}` : "等待输出"))}</span>${task.result?.summary ? `<details class="foldout"><summary>任务结果摘要${task.result.truncated ? "（已截断，查看完整回复）" : ""}</summary><pre>${esc(task.result.summary)}</pre></details>` : ""}</span><span class="badge ${statusClass(pending ? "blocked" : status)}">${esc(taskStatusLabel)}</span>`; if (expanded && row.querySelector("details")) row.querySelector("details").open = true;
    const dependencies = task.dependsOn || definition?.dependsOn || [];
    const dependencyLine = document.createElement("div"); dependencyLine.className = "task-dependency-chips";
    const unfinishedDependencies = dependencies.filter(id => !tasks.some(item => item.taskId === id && item.status === "succeeded"));
    const dependencyCaption = document.createElement("span"); dependencyCaption.className = "task-sub"; dependencyCaption.textContent = unfinishedDependencies.length ? "等待前置任务完成：" : "前置任务已全部完成：";
    if (dependencies.length) dependencyLine.append(dependencyCaption);
    const appendDependency = id => { const dep = tasks.find(item => item.taskId === id), chip = document.createElement("span"); chip.className = `dependency-chip ${statusClass(dep?.status)}`; chip.textContent = `${dep?.title || id}（${statuses[dep?.status] || "状态待核验"}）`; dependencyLine.append(chip); };
    for (const id of unfinishedDependencies.length ? unfinishedDependencies : dependencies) appendDependency(id);
    if (unfinishedDependencies.length && unfinishedDependencies.length < dependencies.length) { const complete = document.createElement("span"); complete.className = "task-sub"; complete.textContent = "已完成的前置任务："; dependencyLine.append(complete); for (const id of dependencies.filter(id => !unfinishedDependencies.includes(id))) appendDependency(id); }
    if (!dependencies.length) dependencyLine.textContent = "起始任务 · 无前置依赖";
    row.children[1].append(dependencyLine);
    const nextModel = session.models?.overrides?.[task.taskId];
    if (nextModel) { const note = document.createElement("span"); note.className = "task-sub"; note.textContent = `下次启动模型：${nextModel.modelId || "沿用 Session 启动配置"}；当前 Attempt 不原地变更`; row.children[1].append(note); }
    const id = task.activeAttemptId || task.attempts?.at(-1)?.attemptId;
    const conclusion = executionConclusion(status, task.reasonCode);
    if (conclusion) { const outcome = document.createElement("p"); outcome.className = `task-outcome ${statusClass(status)}`; outcome.textContent = conclusion; row.children[1].append(outcome); }
    const detail = document.createElement("button"); detail.type = "button"; detail.className = "button button-quiet"; detail.textContent = "查看明细"; detail.addEventListener("click", () => showDagTaskDetails(task.taskId)); row.append(detail);
    if (id) { const view = document.createElement("button"); view.className = "button button-quiet"; view.textContent = "查看回复与工具活动"; view.addEventListener("click", () => void openTaskDetails(id)); row.append(view); }
    if (status === "succeeded") { const results = document.createElement("button"); results.className = "button button-quiet"; results.textContent = "查看任务生成结果"; results.addEventListener("click", () => void openTaskResults(task.taskId)); row.append(results); }
    if (["failed", "timed_out", "cancelled", "interrupted"].includes(status) && (task.dependsOn || definition?.dependsOn || []).every(id => tasks.some(item => item.taskId === id && item.status === "succeeded")) && !session.health?.recoveryRequired && !["active", "unknown", "identity_conflict"].includes(session.health?.state)) {
      const retry = document.createElement("button"); retry.className = "button button-quiet"; retry.textContent = `重试 ${task.taskId}`; retry.addEventListener("click", () => startSessionAction("session/retry", `重试 ${task.taskId}`, { taskId: task.taskId })); row.append(retry);
    }
  }
  for (const column of box.querySelectorAll(".task-board-column")) {
    const rows = [...column.querySelectorAll(".task-row")], overflow = column.querySelector(".task-board-overflow"), extra = column.querySelector(".task-board-extra");
    column.querySelector(".task-board-count").textContent = ` ${rows.length}`;
    rows.slice(3).forEach(row => extra.append(row));
    overflow.querySelector("summary").textContent = `展开其余 ${Math.max(0, rows.length - 3)} 项任务`;
    show(overflow, rows.length > 3);
  }
  }
  const pendingControl = session.pendingControl || (session.controlState?.requestId && !session.controlState.acknowledgedAt ? session.controlState : null);
  acknowledgeResumedSession();
  const busy = !!state.submittingControl || state.controlJob?.status === "running", controlButtons = [];
  if (["running", "pausing"].includes(session.status)) {
    controlButtons.push({ label: pendingControl?.kind === "pause" || session.status === "pausing" ? "等待当前任务收尾…" : "暂停会话", className: "button button-session-pause", title: "停止继续派发任务；当前运行任务完成后暂停，不冻结模型进程。", disabled: busy || !!pendingControl || session.status === "pausing", onClick: () => startSessionAction("session/pause", "暂停会话") });
    controlButtons.push({ label: pendingControl?.kind === "cancel" ? "正在取消…" : "取消会话", className: "button button-session-cancel", disabled: busy || pendingControl?.kind === "cancel", onClick: () => startSessionAction("session/cancel", "取消会话") });
  }
  if (session.status === "succeeded" && session.isolation?.mode === "git-worktree") {
    controlButtons.push({ label: "生成交付报告", className: "button button-primary", disabled: busy, onClick: () => startSessionAction("session/delivery", "生成交付报告") });
  }
  if (globalThis.tokenCouponSessionControls) globalThis.tokenCouponSessionControls.render({ buttons: controlButtons });
  else {
    const controls = $("#session-controls"), controlSignature = JSON.stringify([session.status, session.health?.state, session.health?.recoveryRequired, tasks.map(task => task.status), session.isolation?.mode, pendingControl?.requestId, pendingControl?.kind, state.controlJob?.jobId, state.controlJob?.status, state.submittingControl]);
    if (controls.dataset.signature === controlSignature) return;
    controls.dataset.signature = controlSignature; controls.replaceChildren();
    for (const model of controlButtons) {
      const button = document.createElement("button"); button.type = "button"; button.className = model.className; button.textContent = model.label; button.disabled = model.disabled;
      if (model.title) button.title = model.title;
      button.addEventListener("click", model.onClick); controls.append(button);
    }
  }

}
function openRevisionPlanning() {
  const plan = state.planning;
  if (!plan?.draft || !state.workspace) return;
  if (functionPolicy("revision") && !state.operationRoutingSupported) { showToast("请重启后台并刷新页面，以使用指定的关联修订方式。", true); return; }
  if (!$("#revision-planning-dialog")) {
    const dialog = document.createElement("dialog"); dialog.id = "revision-planning-dialog"; dialog.className = "reference-dialog";
    dialog.innerHTML = `<div class="section-title"><h3>基于当前计划新建修订</h3><button type="button" class="text-button" id="revision-planning-close">取消</button></div><p id="revision-planning-source" class="hint"></p><p>原计划与执行记录保留。新建网页修订计划后，在 GPT／Claude 读取原计划和执行证据，补齐决策，再重新审查、批准。新计划不会直接继承完成状态或失败现场的文件。</p><label for="revision-planning-message">本次需要补充或调整什么？</label><textarea id="revision-planning-message" rows="4" maxlength="4096" placeholder="例如：授权在现有约束内补齐数据库与依赖选型；请先列出方案供我确认。"></textarea><p id="revision-planning-error" class="field-error" role="status"></p><button id="revision-planning-create" type="button" class="button button-primary">创建关联修订计划</button>`;
    document.body.append(dialog); $("#revision-planning-close").addEventListener("click", () => dialog.close());
    $("#revision-planning-create").addEventListener("click", () => void confirmRevisionPlanning());
    const textarea = $("#revision-planning-message"), shortcut = document.createElement("p");
    shortcut.id = "revision-planning-shortcut"; shortcut.className = "composer-shortcut-hint"; shortcut.textContent = "Enter 发送 · Shift+Enter 换行";
    textarea.setAttribute("aria-describedby", shortcut.id); textarea.insertAdjacentElement("afterend", shortcut);
    bindTextareaEnterSubmit(textarea, () => $("#revision-planning-create").click());
  }
  state.revisionPlanningContext = { workspaceId: state.workspace.workspaceId, planningId: plan.planningId, expectedRevision: plan.revision, expectedPlanHash: plan.draft.planHash };
  $("#revision-planning-source").textContent = `${plan.draft.plan.title} · draft-${plan.draft.draftRevision} · ${shortId(plan.planningId)}`;
  $("#revision-planning-source").nextElementSibling.textContent = selectedOperationIsWeb("revision") ? "原计划与执行记录保留。新建网页修订计划后，在所选网页继续规划与审查；新计划不会继承原批准或完成状态。" : "按修订设置调用本机 Agent，附带原计划与有效需求作为参考，生成关联新计划。原记录保留；新计划仍须重新审查、批准，不继承失败现场文件。";
  $("#revision-planning-error").textContent = ""; $("#revision-planning-message").value = "";
  $("#revision-planning-dialog").showModal();
}
async function confirmRevisionPlanning() {
  const context = state.revisionPlanningContext;
  if (!context || context.workspaceId !== state.workspace?.workspaceId || context.planningId !== state.planning?.planningId) return;
  const button = $("#revision-planning-create"); button.disabled = true;
  try {
    const job = await startJob("创建关联修订计划", requestKey => api(`/api/v1/workspaces/${context.workspaceId}/plannings/${context.planningId}/fork`, { method: "POST", body: JSON.stringify({ requestKey, confirmed: true, expectedRevision: context.expectedRevision, expectedPlanHash: context.expectedPlanHash, ...($("#revision-planning-message").value.trim() ? { message: $("#revision-planning-message").value.trim() } : {}) }) }), true);
    if (job?.status !== "succeeded") { $("#revision-planning-error").textContent = job?.error || "尚未创建成功，请查看操作提示后重试。"; return; }
    $("#revision-planning-dialog").close();
    await loadPlanningListAndSelect(job.result.planningId);
    showActionFeedback("已创建关联修订计划", selectedOperationIsWeb("revision") ? "复制网页继续提示，在所选网页补齐规划并审查；原 Session 保留。" : "本机 Agent 已返回关联修订结果。核对草案或澄清问题后继续；原 Session 保留。");
  } finally { button.disabled = false; }
}
function sessionContinueAction(session) {
  const tasks = session?.tasks || [];
  if (!session) return { disabled: true, message: "启动 Session 后可从这里继续执行。" };
  if (session.status === "succeeded") return { disabled: true, message: "全部任务已完成，可查看结果或生成交付报告。" };
  if (session.health?.recoveryRequired) return { kind: "recover", message: "先核验 Runner 已停止并修复中断记录，再从此处继续。" };
  if (["running", "pausing"].includes(session.status) || tasks.some(task => task.status === "running") || ["active", "unknown", "identity_conflict"].includes(session.health?.state) || !session.health) return { disabled: true, message: "执行中或状态尚未核实；可使用“重新检测状态”。" };
  const decisionBlockers = tasks.filter(task => task.status === "blocked" && task.reasonCode === "user_input_required");
  if (decisionBlockers.length) return { disabled: true, blockers: decisionBlockers, message: `等待用户决策：${decisionBlockers.map(task => task.title || task.taskId).join("、")}。查看阻塞回复，补充材料或授权后新建关联修订，重新审查并批准；当前会话不能直接重试。` };
  if (session.isolation?.status === "blocked" || tasks.some(task => task.status === "blocked" && task.reasonCode && task.reasonCode !== "dependency_not_succeeded")) return { disabled: true, message: "存在 Git 整合或其他阻塞问题，请先查看诊断并处理，再继续执行。" };
  const failures = tasks.filter(task => ["failed", "timed_out", "cancelled", "interrupted"].includes(task.status));
  const targets = failures.filter(task => (task.dependsOn || state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId)?.dependsOn || []).every(id => tasks.some(item => item.taskId === id && item.status === "succeeded")));
  if (targets.length) return { kind: "retry", targets, message: `从失败／中断任务重新执行，保留 ${tasks.filter(task => task.status === "succeeded").length} 个已完成任务。` };
  if (failures.length) return { disabled: true, message: "失败任务的前置依赖尚未成功，请先处理依赖或 Git 整合问题。" };
  if (tasks.some(task => ["planned", "blocked"].includes(task.status))) return { kind: "resume", message: "继续调度剩余任务，保留全部已完成任务。" };
  return { disabled: true, message: "暂无可直接继续的任务，请检查执行状态与 Git 整合记录。" };
}
function renderSessionContinue(session) {
  const action = sessionContinueAction(session), button = $("#session-continue");
  if (globalThis.tokenCouponSessionContinue) {
    const blockers = (action.blockers || []).flatMap(task => {
      const attemptId = task.activeAttemptId || task.attempts?.at(-1)?.attemptId;
      return attemptId ? [{ taskId: task.taskId, label: action.blockers.length === 1 ? "查看阻塞回复" : `查看阻塞：${task.title || task.taskId}`, onView: () => void openTaskDetails(attemptId) }] : [];
    });
    globalThis.tokenCouponSessionContinue.render({
      label: action.kind === "recover" ? "核验断点状态" : "从断点继续执行",
      disabled: !!action.disabled || !!state.submittingJob || state.activeJob?.status === "running",
      message: action.message,
      blockers,
      onContinue: openSessionContinue,
      onRevise: openRevisionPlanning,
    });
    return;
  }
  button.disabled = !!action.disabled || !!state.submittingJob || state.activeJob?.status === "running";
  button.textContent = action.kind === "recover" ? "核验断点状态" : "从断点继续执行";
  $("#session-continue-hint").textContent = action.message;
  let actions = $("#session-blocker-actions");
  if (!actions) { actions = document.createElement("div"); actions.id = "session-blocker-actions"; actions.className = "button-row"; $("#session-continue-hint").after(actions); }
  const signature = JSON.stringify((action.blockers || []).map(task => [task.taskId, task.attempts?.at(-1)?.attemptId]));
  show(actions, !!action.blockers?.length);
  if (actions.dataset.signature === signature) return;
  actions.dataset.signature = signature; actions.replaceChildren();
  for (const task of action.blockers || []) {
    const attemptId = task.activeAttemptId || task.attempts?.at(-1)?.attemptId;
    if (!attemptId) continue;
    const view = document.createElement("button"); view.type = "button"; view.className = "button button-quiet"; view.textContent = action.blockers.length === 1 ? "查看阻塞回复" : `查看阻塞：${task.title || task.taskId}`;
    view.addEventListener("click", () => void openTaskDetails(attemptId)); actions.append(view);
  }
  if (action.blockers?.length) {
    const revise = document.createElement("button"); revise.type = "button"; revise.className = "button button-primary"; revise.textContent = "补充决策并新建关联修订";
    revise.addEventListener("click", openRevisionPlanning); actions.append(revise);
  }
}
function openSessionContinue() {
  const session = state.planning?.session, action = sessionContinueAction(session);
  if (action.disabled) { showToast(action.message); return; }
  if (action.kind === "recover") { void diagnoseAndRecover(); return; }
  state.continueContext = { workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, sessionId: session.sessionId, kind: action.kind, targets: (action.targets || []).map(task => ({ taskId: task.taskId, attemptId: task.attempts?.at(-1)?.attemptId })) };
  const select = $("#session-continue-target"); select.replaceChildren();
  if (action.kind === "retry") for (const task of action.targets) select.add(new Option(`${task.title || task.taskId} · ${statuses[task.status] || task.status}`, task.taskId));
  else select.add(new Option("继续所有满足依赖的未完成任务", "__resume__"));
  $("#session-continue-description").textContent = `${action.message} 失败任务会创建新 Attempt，保留旧文件与日志；成功后继续调度满足依赖的后续任务。`;
  $("#session-continue-error").textContent = ""; $("#session-continue-dialog").showModal();
}
async function confirmSessionContinue() {
  const context = state.continueContext, session = state.planning?.session, action = sessionContinueAction(session), taskId = $("#session-continue-target").value;
  const target = action.targets?.find(task => task.taskId === taskId), original = context?.targets.find(task => task.taskId === taskId);
  if (!context || context.workspaceId !== state.workspace?.workspaceId || context.planningId !== state.planning?.planningId || context.sessionId !== session?.sessionId || action.disabled || context.kind !== action.kind || action.kind === "retry" && (!target || target.attempts?.at(-1)?.attemptId !== original?.attemptId)) {
    $("#session-continue-error").textContent = "执行状态已变化，请关闭后重新选择继续起点。"; return;
  }
  $("#session-continue-dialog").close(); state.continueContext = null;
  await startSessionAction(action.kind === "retry" ? "session/retry" : "session/resume", "从断点继续执行", action.kind === "retry" ? { taskId } : {});
}
async function openTaskResults(taskId) {
  const view = { workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, taskId, files: [], total: 0, summary: "正在读取此任务的文件归属记录…", hasMore: false, loading: false, preview: null, error: "" };
  state.taskResultView = view;
  $("#task-results-title").textContent = `${state.planning.session.tasks.find(task => task.taskId === taskId)?.title || taskId} · 生成结果`;
  renderTaskResults(view); $("#task-results-dialog").showModal();
  await loadTaskResultPage(view, 0);
}
function renderTaskResults(view) {
  const mount = $("#task-results-content-root");
  const model = { summary: view.summary, files: view.files, total: view.total, hasMore: view.hasMore, loadingMore: view.loading, preview: view.preview, error: view.error };
  const callbacks = {
    onPreview: path => void previewTaskResult(view, path),
    onCopyPath: async file => { try { await copyText(file.absolutePath); showToast("文件路径已复制。"); } catch { showCopyFallback("复制生成文件路径", file.absolutePath); } },
    onLoadMore: () => { if (view.nextOffset !== null) void loadTaskResultPage(view, view.nextOffset); },
  };
  if (globalThis.tokenCouponTaskResults) { globalThis.tokenCouponTaskResults.render(mount, model, callbacks); return; }
  $("#task-results-summary").textContent = model.summary;
  $("#task-results-error").textContent = model.error;
  $("#task-results-path").textContent = model.preview?.absolutePath || "";
  $("#task-results-preview").textContent = model.preview?.content || "";
  show($("#task-results-preview-wrap"), !!model.preview); show($("#task-results-more"), model.hasMore);
  $("#task-results-more").disabled = model.loadingMore;
  renderTaskResultFiles(view);
}
async function loadTaskResultPage(view, offset) {
  if (view.loading) return; view.loading = true; renderTaskResults(view);
  try {
    const data = await api(`/api/v1/workspaces/${view.workspaceId}/plannings/${view.planningId}/tasks/${encodeURIComponent(view.taskId)}/files?offset=${offset}`);
    if (state.taskResultView !== view || state.workspace?.workspaceId !== view.workspaceId || state.planning?.planningId !== view.planningId) return;
    Object.assign(view, { files: [...view.files, ...data.files], nextOffset: data.nextOffset, total: data.total, hasMore: data.nextOffset !== null });
    view.summary = `${data.message}\n执行目录：${data.executionDirectory || "未记录"}${data.commit ? `\n任务提交：${data.commit}` : ""}\n已显示 ${view.files.length}/${data.total} 个文件`;
  } catch (error) { if (state.taskResultView === view) view.error = error.message; }
  finally { view.loading = false; if (state.taskResultView === view) renderTaskResults(view); }
}
function renderTaskResultFiles(view) {
  const root = $("#task-results-files"), wasOpen = !!root.querySelector("details[open]"); root.replaceChildren();
  const extra = document.createElement("details"); extra.className = "task-results-overflow foldout"; extra.open = wasOpen;
  const summary = document.createElement("summary"); summary.textContent = `展开其余 ${Math.max(0, view.files.length - 3)} 个文件`; extra.append(summary);
  for (const [index, file] of view.files.entries()) {
    const row = document.createElement("article"), path = document.createElement("code"), preview = document.createElement("button"), copy = document.createElement("button"); row.className = "task-result-file";
    path.textContent = file.absolutePath; path.title = file.path;
    preview.type = "button"; preview.className = "text-button"; preview.textContent = `预览 ${file.path}`; preview.addEventListener("click", () => void previewTaskResult(view, file.path));
    copy.type = "button"; copy.className = "text-button"; copy.textContent = "复制路径"; copy.addEventListener("click", async () => { try { await copyText(file.absolutePath); showToast("文件路径已复制。"); } catch { showCopyFallback("复制生成文件路径", file.absolutePath); } });
    row.append(path, preview, copy); (index < 3 ? root : extra).append(row);
  }
  if (view.files.length > 3) root.append(extra);
}
async function previewTaskResult(view, path) {
  const request = view.previewRequest = (view.previewRequest || 0) + 1; view.error = ""; renderTaskResults(view);
  try {
    const data = await api(`/api/v1/workspaces/${view.workspaceId}/plannings/${view.planningId}/tasks/${encodeURIComponent(view.taskId)}/files?path=${encodeURIComponent(path)}`);
    if (state.taskResultView !== view || request !== view.previewRequest) return;
    view.preview = { absolutePath: data.file.absolutePath, content: data.file.content + (data.file.truncated ? "\n[预览已截断]" : "") };
  } catch (error) { if (state.taskResultView === view && request === view.previewRequest) { view.preview = null; view.error = error.message; } }
  finally { if (state.taskResultView === view && request === view.previewRequest) renderTaskResults(view); }
}
function renderAttemptChoices(tasks) {
  const select = $("#attempt-select"), previous = state.attemptSelection?.selectedAttemptId || select.value;
  const choices = tasks.flatMap(task => (task.attempts || []).map((attempt, index) => {
    const projected = task.currentAttempt?.attemptId === attempt.attemptId ? task.currentAttempt : {};
    return { ...attempt, taskId: task.taskId, label: `${task.title || task.taskId} · 第 ${index + 1} 次 · ${shortId(attempt.attemptId)}`, active: task.activeAttemptId === attempt.attemptId,
      at: projected.startedAt || attempt.lastActivityAt || projected.finishedAt || "" };
  }));
  const identity = `${state.workspace?.workspaceId}:${state.planning?.planningId}:${state.planning?.session?.sessionId}`;
  if (state.attemptSelection?.identity !== identity) state.attemptSelection = { identity, mode: "auto", selectedAttemptId: "" };
  state.attemptChoices = choices;
  const activeChoices = choices.filter(item => item.active);
  state.latestAttemptChoice = (activeChoices.length ? activeChoices : [...choices].reverse()).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
  show($("#attempt-reader"), !!choices.length);
  show($("#attempt-empty"), !choices.length);
  const signature = JSON.stringify([state.workspace?.workspaceId, state.planning?.planningId, choices]);
  if (!globalThis.tokenCouponAttemptSelection && signature !== state.attemptChoiceSignature) {
    state.attemptChoiceSignature = signature; select.replaceChildren();
    for (const choice of choices) select.add(new Option(choice.label, choice.attemptId));
  }
  state.attemptSelection.selectedAttemptId = state.attemptSelection.mode === "history" && choices.some(item => item.attemptId === previous) ? previous : state.latestAttemptChoice?.attemptId || "";
  if (!globalThis.tokenCouponAttemptSelection) select.value = state.attemptSelection.selectedAttemptId;
  renderAttemptSelectionContext();
  const selectedAttemptId = state.attemptSelection.selectedAttemptId;
  const projection = tasks.find(task => task.currentAttempt?.attemptId === selectedAttemptId)?.currentAttempt;
  if (projection && state.attemptView?.attemptId === selectedAttemptId && state.attemptView.workspaceId === state.workspace?.workspaceId && state.attemptView.planningId === state.planning?.planningId) {
    const changed = state.attemptView.attempt?.status !== projection.status;
    state.attemptView.attempt = { ...state.attemptView.attempt, ...projection };
    if (changed) void readSelectedAttempt(true);
  }
  if (choices.length) void selectAttempt();
}
async function openTaskDetails(attemptId) {
  const workspaceId = state.workspace?.workspaceId, planningId = state.planning?.planningId;
  await planTab("attempts");
  if (state.route?.tab !== "attempts" || state.workspace?.workspaceId !== workspaceId || state.planning?.planningId !== planningId) return;
  if (attemptId && state.attemptChoices?.some(option => option.attemptId === attemptId)) { state.attemptSelection.mode = "history"; state.attemptSelection.selectedAttemptId = attemptId; }
  else { state.attemptSelection.mode = "auto"; state.attemptSelection.selectedAttemptId = state.latestAttemptChoice?.attemptId || ""; }
  if (!globalThis.tokenCouponAttemptSelection) $("#attempt-select").value = state.attemptSelection.selectedAttemptId;
  renderAttemptSelectionContext();
  await selectAttempt();
  const target = $("#attempt-reader").classList.contains("hidden") ? $("#attempt-empty") : $("#attempt-reader");
  target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "smooth" });
}
function renderAttemptSelectionContext() {
  const selectedAttemptId = state.attemptSelection?.selectedAttemptId || $("#attempt-select").value;
  const selected = state.attemptChoices?.find(item => item.attemptId === selectedAttemptId), latest = state.latestAttemptChoice;
  const historical = !!selected && !selected.active && selected.attemptId !== latest?.attemptId;
  const model = {
    choices: (state.attemptChoices || []).map(item => ({ attemptId: item.attemptId, label: item.label })),
    selectedAttemptId,
    contextText: selected ? `${selected.active ? "运行中任务记录" : historical ? "历史执行记录 · 不是本次重试返回" : "最近一次执行记录"}：${selected.label}${selected.at ? ` · ${new Date(selected.at).toLocaleString()}` : ""}` : "请选择执行记录。",
    historical,
    latestDisabled: !latest || selected?.attemptId === latest.attemptId,
  };
  if (globalThis.tokenCouponAttemptSelection) {
    globalThis.tokenCouponAttemptSelection.render(model, {
      onSelect(attemptId) {
        if (!state.attemptSelection) return;
        state.attemptSelection.mode = "history"; state.attemptSelection.selectedAttemptId = attemptId;
        void selectAttempt();
      },
      onLatest() {
        if (!state.attemptSelection) return;
        state.attemptSelection.mode = "auto"; state.attemptSelection.selectedAttemptId = state.latestAttemptChoice?.attemptId || "";
        void selectAttempt();
      },
    });
    return;
  }
  $("#attempt-selection-context").textContent = model.contextText;
  $("#attempt-selection-context").classList.toggle("is-history", historical);
  $("#attempt-show-latest").disabled = model.latestDisabled;
}
async function selectAttempt() {
  renderAttemptSelectionContext();
  const attemptId = state.attemptSelection?.selectedAttemptId || $("#attempt-select").value;
  if (!attemptId || !state.workspace || !state.planning) return;
  const identity = `${state.workspace.workspaceId}:${state.planning.planningId}:${attemptId}`;
  if (state.attemptView?.identity !== identity) {
    state.attemptView = { identity, rawRevision: 0, attemptId, workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, cursor: 0, messages: new Map(), tools: [], raw: [], seen: new Set(), finalText: "", textStream: "", notice: "", loaded: false, toolsPage: 0, rawPage: 0, rawFilter: "" };
    if (globalThis.tokenCouponAttemptMessages) globalThis.tokenCouponAttemptMessages.render({ messages: [], emptyMessage: "正在读取执行记录…" });
    else $("#attempt-messages").replaceChildren();
    if (globalThis.tokenCouponAttemptTools) globalThis.tokenCouponAttemptTools.render({ tools: [], openEventKeys: [] });
    else $("#attempt-tools").replaceChildren();
    if (!globalThis.tokenCouponAttemptRawEvents) $("#attempt-raw").textContent = "";
    await readSelectedAttempt();
  } else if (!state.attemptView.loaded || ["running", "created"].includes(state.attemptView.attempt?.status)) await readSelectedAttempt();
  else renderAttemptView();
}
function projectAttemptEvent(view, event) {
  if (view.seen.has(event.sequence)) return; view.seen.add(event.sequence);
  view.raw.push(event);
  const p = event.payload || {}, type = event.type;
  if (type === "runner.model.reported") {
    view.reportedModel = p.model; view.reportedModelSource = p.source;
    return;
  }
  if ((type === "message.delta" || type === "message.completed") && p.root !== false) {
    view.semanticMessages = true;
    const id = p.messageId || "semantic-stream";
    const old = view.messages.get(id) || { text: "", completed: false };
    view.messages.set(id, { text: type === "message.delta" ? old.text + (p.text || "") : p.text || old.text, completed: type === "message.completed" });
  } else if (type === "runner.output") {
    const structured = p.structuredEvent;
    if (typeof p.finalText === "string") view.finalText = p.finalText;
    else if (structured?.type === "result" && typeof structured.result === "string") view.finalText = structured.result; // legacy Claude CLI artifacts
    const semanticDuplicate = view.semanticMessages || structured?.type?.startsWith("codex.message.") || structured?.type === "assistant";
    if (!semanticDuplicate && p.stream === "stdout") {
      const legacyDelta = structured?.event?.delta?.type === "text_delta" ? structured.event.delta.text : undefined;
      const text = p.displayText ?? p.agentText ?? legacyDelta ?? (!structured ? p.text : "");
      if (text) { view.textStream += text; view.messages.set("output-stream", { text: view.textStream, completed: false }); }
    }
    if (p.stream === "stderr" && p.text) view.tools.push({ sequence: event.sequence, type: "stderr", text: p.text, timestamp: event.timestamp });
  } else if (["tool.started", "tool.completed", "command.completed", "runner.diagnostic", "interaction.requested", "interaction.resolved", "runner.native.started"].includes(type)) {
    view.tools.push({ sequence: event.sequence, type, text: p.summary || p.command || p.message || p.name || p.requestId || "", exitCode: p.exitCode, output: p.outputSummary, timestamp: event.timestamp });
    if (type === "runner.native.started" && p.reportedModel) view.reportedModel = p.reportedModel;
    if (view.taskId) { state.taskActivity ??= {}; state.taskActivity[view.taskId] = `${type === "tool.started" ? "正在执行" : type === "tool.completed" ? "已完成工具" : type}：${p.summary || p.command || p.name || p.message || ""}`; }
  }
}
async function readSelectedAttempt(force = false) {
  const view = state.attemptView;
  if (!view || view.loading || view.workspaceId !== state.workspace?.workspaceId || view.planningId !== state.planning?.planningId) return;
  if (view.hasMore && view.loaded && force !== true) return;
  view.loading = true;
  renderAttemptControls();
  try {
    for (let page = 0; page < 3; page++) {
      const result = await api(`/api/v1/workspaces/${view.workspaceId}/plannings/${view.planningId}/attempts/${view.attemptId}/events?offset=${view.cursor}${view.fileId ? `&fileId=${encodeURIComponent(view.fileId)}` : ""}`);
      if (state.attemptView !== view) return;
      if (result.reset) { view.messages.clear(); view.seen.clear(); view.tools = []; view.raw = []; view.rawRevision = (view.rawRevision || 0) + 1; delete view.reportedModel; delete view.reportedModelSource; view.finalText = ""; view.textStream = ""; view.semanticMessages = false; view.toolsPage = 0; view.rawPage = 0; view.notice = "记录文件发生变化，已从头重新读取。"; }
      view.attempt = result.attempt; view.taskId = result.taskId; view.fileId = result.fileId; view.cursor = result.cursor; view.hasMore = result.hasMore; view.loaded = true;
      if (result.malformed) view.notice = `有 ${result.malformed} 条记录无法解析，原始文件可能不完整。`;
      for (const event of result.events) projectAttemptEvent(view, event);
      if (!result.hasMore) break;
    }
    renderAttemptView();
  } catch (error) { if (state.attemptView === view) { view.notice = `记录暂不可读：${error.message}；可刷新重试。`; renderAttemptView(); } }
  finally { view.loading = false; if (state.attemptView === view) renderAttemptControls(); }
}
function renderAttemptView() { preserveExecutionReading(renderAttemptContent); }
function renderAttemptControls() {
  const model = { hasMore: !!state.attemptView?.hasMore, loading: !!state.attemptView?.loading };
  if (globalThis.tokenCouponAttemptRecordControls) {
    globalThis.tokenCouponAttemptRecordControls.render(model, {
      onRefresh: () => void readSelectedAttempt(true),
      onMore: () => void readSelectedAttempt(true),
    });
    return;
  }
  $("#attempt-refresh").disabled = model.loading;
  $("#attempt-more").disabled = model.loading;
  $("#attempt-more").textContent = model.loading ? "正在读取历史记录…" : "继续加载历史记录";
  show($("#attempt-more"), model.hasMore);
}
function ensureAttemptDiagnosticUI() {
  if (!globalThis.tokenCouponAttemptOverview && !$("#attempt-diagnose")) {
    const button = document.createElement("button"); button.id = "attempt-diagnose"; button.type = "button"; button.className = "button button-primary hidden"; button.textContent = "分析原因";
    $("#attempt-diagnostic-actions").append(button); button.addEventListener("click", () => void openAttemptDiagnosis());
  }
  if ($("#diagnosis-choice-dialog")) return;
  const choice = document.createElement("dialog"); choice.id = "diagnosis-choice-dialog"; choice.className = "diagnosis-choice-dialog";
  const choiceRoot = document.createElement("div"); choiceRoot.id = "diagnosis-choice-root"; choice.append(choiceRoot);
  document.body.append(choice);
  if (!globalThis.tokenCouponAttemptDiagnosisChoice) {
    choiceRoot.innerHTML = `<div class="section-title"><h3>选择分析方式</h3><button type="button" data-diagnosis-close class="text-button">关闭</button></div><div class="diagnosis-options"><button id="diagnosis-local" class="diagnosis-option" type="button"><strong>在此页面分析</strong><span>与 Codex 或 Claude Code 继续对话，可在下方选择模型。</span><small>会使用所选模型的调用额度</small></button><button id="diagnosis-web" class="diagnosis-option" type="button"><strong>复制提示到网页分析</strong><span>把证据保存在工作区，通过已连接的 GPT／Claude 网页读取分析。</span><small>使用网页额度，节省执行模型的诊断调用</small></button></div>`;
    choice.querySelector("[data-diagnosis-close]").addEventListener("click", () => choice.close());
    $("#diagnosis-local").addEventListener("click", () => { choice.close(); void openLocalAttemptDiagnosis(state.attemptDiagnosticContext); });
    $("#diagnosis-web").addEventListener("click", () => { choice.close(); void exportAttemptDiagnosis(state.attemptDiagnosticContext); });
  }
  const chat = document.createElement("dialog"); chat.id = "attempt-diagnosis-dialog"; chat.className = "diagnosis-chat-dialog";
  const chatRoot = document.createElement("div"); chatRoot.id = "attempt-diagnosis-dialog-root"; chat.append(chatRoot);
  document.body.append(chat);
  const reactDialog = globalThis.tokenCouponAttemptDiagnosisDialog;
  if (reactDialog) {
    renderAttemptDiagnosisDialog();
  } else {
    chatRoot.innerHTML = `<div class="section-title"><div><h3>任务诊断</h3><p id="attempt-diagnosis-context" class="hint"></p></div><button type="button" data-diagnosis-close class="text-button">关闭</button></div><select id="attempt-diagnosis-history-select" aria-label="历史诊断" class="hidden"></select><p id="attempt-diagnosis-status" class="diagnosis-chat-status" role="status"></p><section id="attempt-diagnosis-history" class="diagnosis-chat-history" aria-label="诊断对话"></section><form id="attempt-diagnosis-form" class="diagnosis-chat-composer"><label class="sr-only" for="attempt-diagnosis-reply">发送诊断问题</label><textarea id="attempt-diagnosis-reply" rows="3" maxlength="8192" placeholder="输入问题、补充事实，或讨论处理方案…"></textarea><div class="diagnosis-chat-footer"><div class="diagnosis-model-selectors"><label>助手<select id="attempt-diagnosis-runner"><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label><label>模型<select id="attempt-diagnosis-model"><option value="">默认模型</option><option value="__custom__">自定义模型…</option></select></label><label id="diagnosis-custom-wrap" class="hidden">模型 ID<input id="diagnosis-custom-model" maxlength="200" placeholder="输入模型 ID"></label></div><button id="attempt-diagnosis-send" type="submit" class="button button-primary">发送</button></div><p class="hint">发送会调用所选模型。这里只分析与讨论；修复、重试和计划变更需另行确认。</p></form>`;
    const diagnosisHistorySelect = $("#attempt-diagnosis-history-select"), diagnosisHistoryControls = document.createElement("div");
    diagnosisHistoryControls.id = "attempt-diagnosis-history-controls-root"; diagnosisHistorySelect.replaceWith(diagnosisHistoryControls); diagnosisHistoryControls.append(diagnosisHistorySelect);
    $(".diagnosis-model-selectors").id = "attempt-diagnosis-model-controls-root";
  }
  const exported = document.createElement("dialog"); exported.id = "diagnosis-export-dialog"; exported.className = "reference-dialog";
  exported.innerHTML = `<div class="section-title"><h3>到网页分析</h3><button type="button" data-diagnosis-close class="text-button">关闭</button></div><p id="diagnosis-export-status" role="status">正在保存证据…</p><label>证据文件<input id="diagnosis-export-path" readonly></label><p class="hint">在已连接 Token Coupon MCP 的 GPT／Claude 网页粘贴提示即可读取。网页无法直接访问本机路径；未启用 MCP 时，请上传此文件。此操作不调用本机诊断模型。</p><button id="diagnosis-export-copy" type="button" class="button button-primary" disabled>复制分析提示</button>`;
  document.body.append(exported);
  const exportRoot = document.createElement("div"); exportRoot.id = "diagnosis-export-root";
  while (exported.firstChild) exportRoot.append(exported.firstChild);
  exported.append(exportRoot);
  if (!reactDialog) chat.querySelector("[data-diagnosis-close]").addEventListener("click", () => chat.close());
  exported.querySelector("[data-diagnosis-close]").addEventListener("click", () => exported.close());
  if (!reactDialog) {
    const switchMode = document.createElement("button"); switchMode.type = "button"; switchMode.className = "text-button"; switchMode.textContent = "切换分析方式";
    switchMode.addEventListener("click", () => { chat.close(); showAttemptDiagnosisChoice(); }); chat.querySelector(".section-title").append(switchMode);
  }
  if (!globalThis.tokenCouponAttemptDiagnosisExport) {
    const dialog = exported;
    const switchMode = document.createElement("button"); switchMode.type = "button"; switchMode.className = "text-button"; switchMode.textContent = "切换分析方式";
    switchMode.addEventListener("click", () => { dialog.close(); showAttemptDiagnosisChoice(); }); dialog.querySelector(".section-title").append(switchMode);
  }
  $("#attempt-diagnosis-runner").addEventListener("change", () => { const context = state.attemptDiagnosticContext; if (context) { context.diagnosisRunnerId = $("#attempt-diagnosis-runner").value; context.diagnosisModelId = ""; void loadAttemptDiagnosticModels(context); } });
  $("#attempt-diagnosis-model").addEventListener("change", () => { const context = state.attemptDiagnosticContext; if (context) context.diagnosisModelId = $("#attempt-diagnosis-model").value; show($("#diagnosis-custom-wrap"), $("#attempt-diagnosis-model").value === "__custom__"); });
  $("#diagnosis-custom-model").addEventListener("input", () => { if (state.attemptDiagnosticContext) state.attemptDiagnosticContext.diagnosisCustomModelId = $("#diagnosis-custom-model").value; });
  $("#attempt-diagnosis-history-select").addEventListener("change", () => { const context = state.attemptDiagnosticContext; if (context) { context.selectedId = $("#attempt-diagnosis-history-select").value; renderAttemptDiagnosticHistory(context); } });
  $("#attempt-diagnosis-reply").addEventListener("input", () => { if (state.attemptDiagnosticContext) state.attemptDiagnosticContext.unsentText = $("#attempt-diagnosis-reply").value; });
  $("#attempt-diagnosis-form").addEventListener("submit", event => { event.preventDefault(); void sendAttemptDiagnosticMessage(); });
  const diagnosisInput = $("#attempt-diagnosis-reply"), diagnosisShortcut = document.createElement("p");
  diagnosisShortcut.className = "composer-shortcut-hint"; diagnosisShortcut.textContent = "Enter 发送 · Shift+Enter 换行";
  diagnosisInput.setAttribute("aria-describedby", "attempt-diagnosis-status diagnosis-shortcuts"); diagnosisShortcut.id = "diagnosis-shortcuts";
  diagnosisInput.insertAdjacentElement("afterend", diagnosisShortcut);
  const diagnosisComposerRoot = document.createElement("div"); diagnosisComposerRoot.id = "attempt-diagnosis-composer-root";
  if (!reactDialog) { diagnosisInput.before(diagnosisComposerRoot); diagnosisComposerRoot.append(diagnosisInput, diagnosisShortcut); }
  else { $("#attempt-diagnosis-composer-root").append(diagnosisShortcut); }
  bindTextareaEnterSubmit(diagnosisInput, () => $("#attempt-diagnosis-form").requestSubmit());
  $("#diagnosis-export-copy").addEventListener("click", () => void copyExportedDiagnosticPrompt());
}
function attemptDiagnosisDialogModel(context = state.attemptDiagnosticContext) {
  return {
    contextText: context ? `本次执行 ${shortId(context.attemptId)} · 只读分析` : "",
    statusText: context?.statusText || "",
    sendLabel: context?.running ? "分析中…" : context?.pendingSubmission ? "检查本次发送" : "发送",
    sendDisabled: !!context?.running,
  };
}
function renderAttemptDiagnosisDialog(context = state.attemptDiagnosticContext) {
  const mount = $("#attempt-diagnosis-dialog-root");
  if (!mount) return;
  const model = attemptDiagnosisDialogModel(context);
  if (globalThis.tokenCouponAttemptDiagnosisDialog) {
    globalThis.tokenCouponAttemptDiagnosisDialog.render(mount, model, {
      onClose: () => $("#attempt-diagnosis-dialog").close(),
      onSwitch: () => { $("#attempt-diagnosis-dialog").close(); showAttemptDiagnosisChoice(); },
    });
  } else {
    $("#attempt-diagnosis-context").textContent = model.contextText;
    $("#attempt-diagnosis-status").textContent = model.statusText;
    const send = $("#attempt-diagnosis-send"); send.disabled = model.sendDisabled; send.textContent = model.sendLabel;
  }
}
function setAttemptDiagnosisStatus(context, statusText) {
  if (context) context.statusText = statusText;
  renderAttemptDiagnosisDialog(context);
}
function showAttemptDiagnosisChoice() {
  const dialog = $("#diagnosis-choice-dialog"), mount = $("#diagnosis-choice-root");
  if (globalThis.tokenCouponAttemptDiagnosisChoice) {
    globalThis.tokenCouponAttemptDiagnosisChoice.render(mount, {
      onClose: () => dialog.close(),
      onLocal: () => { dialog.close(); void openLocalAttemptDiagnosis(state.attemptDiagnosticContext); },
      onWeb: () => { dialog.close(); void exportAttemptDiagnosis(state.attemptDiagnosticContext); },
    });
  }
  dialog.showModal();
}
function attemptDiagnosticPath(context) {
  return `/api/v1/workspaces/${context.workspaceId}/plannings/${context.planningId}/attempts/${context.attemptId}/diagnostics`;
}
function diagnosticContextIsCurrent(context) { return !!context && state.attemptDiagnosticContext === context; }
function selectedAttemptDiagnostic(context) { return context?.data?.diagnostics?.find(item => item.diagnosticId === context.selectedId); }
async function loadAttemptDiagnosticModels(context, savedModel = "") {
  if (!diagnosticContextIsCurrent(context)) return;
  const runnerId = context.diagnosisRunnerId || $("#attempt-diagnosis-runner")?.value || ( ["codex", "claude-code"].includes(context.runnerId) ? context.runnerId : "codex" );
  context.diagnosisRunnerId = runnerId;
  context.diagnosisModels = [];
  context.diagnosisModelId = "";
  const request = context.modelRequest = (context.modelRequest || 0) + 1;
  context.diagnosisModelsLoading = true;
  renderAttemptDiagnosticControls(context);
  try {
    const catalog = await runnerModelCatalog(runnerId, context.workspaceId);
    if (!diagnosticContextIsCurrent(context) || request !== context.modelRequest) return;
    context.diagnosisModels = (catalog.models || []).map(model => ({ id: model.id, label: model.label || model.id }));
  } catch { if (diagnosticContextIsCurrent(context)) setAttemptDiagnosisStatus(context, "候选模型暂不可读，可使用默认模型或填写模型 ID。"); }
  if (!diagnosticContextIsCurrent(context) || request !== context.modelRequest) return;
  if (savedModel && !context.diagnosisModels.some(model => model.id === savedModel)) context.diagnosisModels.push({ id: savedModel, label: savedModel });
  context.diagnosisModelId = savedModel;
  context.diagnosisModelsLoading = false;
  renderAttemptDiagnosticControls(context);
}
async function loadAttemptDiagnosticHistory(context) {
  const data = await api(attemptDiagnosticPath(context));
  context.data = data;
  if (!data.diagnostics.some(item => item.diagnosticId === context.selectedId)) context.selectedId = data.diagnostics.at(-1)?.diagnosticId;
  if (diagnosticContextIsCurrent(context)) renderAttemptDiagnosticHistory(context);
  return data;
}
function renderAttemptDiagnosticHistory(context) {
  if (!diagnosticContextIsCurrent(context)) return;
  const root = $("#attempt-diagnosis-history"), previousScroll = root.scrollTop, atBottom = root.scrollHeight - root.clientHeight - root.scrollTop < 50;
  const records = context.data?.diagnostics || [];
  const diagnostic = selectedAttemptDiagnostic(context);
  if (globalThis.tokenCouponAttemptDiagnosisHistory) {
    const runnerId = diagnostic?.runnerId || context.runnerId;
    globalThis.tokenCouponAttemptDiagnosisHistory.render(root, {
      messages: (diagnostic?.messages || []).map((message, index) => ({
        messageId: `${diagnostic?.diagnosticId || "empty"}:${index}`,
        role: message.role === "user" ? "user" : "assistant",
        heading: message.role === "user" ? "你" : `${labels[message.runnerId || runnerId] || "诊断助手"}${message.modelId ? ` · ${message.modelId}` : ""}`,
        content: message.content,
      })),
      emptyMessage: "从一个问题开始，例如：这次任务为什么中止？需要我确认什么？",
      showEmptyMessage: !diagnostic,
      ...(context.pendingSubmission && context.running ? { pendingMessage: context.pendingSubmission.body.message } : {}),
      ...(diagnostic?.error ? { errorMessage: `分析未完成：${diagnostic.error}` } : {}),
      running: !!context.running,
    });
  } else {
    root.replaceChildren();
    if (!diagnostic) { const empty = document.createElement("p"); empty.className = "diagnosis-chat-empty"; empty.textContent = "从一个问题开始，例如：这次任务为什么中止？需要我确认什么？"; root.append(empty); }
    for (const message of diagnostic?.messages || []) {
      const article = document.createElement("article"), heading = document.createElement("small"), body = document.createElement("div"); article.className = `diagnosis-chat-message is-${message.role}`;
      heading.textContent = message.role === "user" ? "你" : `${labels[message.runnerId || diagnostic.runnerId] || "诊断助手"}${message.modelId ? ` · ${message.modelId}` : ""}`;
      body.className = "diagnosis-chat-body"; appendHighlightedReply(body, message.content); article.append(heading, body); root.append(article);
    }
    if (context.pendingSubmission && context.running) {
      const article = document.createElement("article"), heading = document.createElement("small"), body = document.createElement("div"); article.className = "diagnosis-chat-message is-user"; heading.textContent = "你"; body.className = "diagnosis-chat-body"; body.textContent = context.pendingSubmission.body.message; article.append(heading, body); root.append(article);
    }
    if (diagnostic?.error) { const error = document.createElement("p"); error.className = "field-error"; error.textContent = `分析未完成：${diagnostic.error}`; root.append(error); }
    if (context.running) { const pending = document.createElement("p"); pending.className = "diagnosis-chat-pending"; pending.textContent = "正在分析…"; root.append(pending); }
  }
  renderAttemptDiagnosticControls(context);
  if (globalThis.tokenCouponAttemptDiagnosisComposer) {
    const composer = $("#attempt-diagnosis-composer-root"), input = $("#attempt-diagnosis-reply");
    globalThis.tokenCouponAttemptDiagnosisComposer.render(composer, { initialValue: context.unsentText ?? input.value, placeholder: input.placeholder }, value => { context.unsentText = value; }, () => $("#attempt-diagnosis-form").requestSubmit());
  }
  root.scrollTop = context.scrollAfterSend || atBottom ? root.scrollHeight : previousScroll; context.scrollAfterSend = false;
  renderAttemptDiagnosisDialog(context);
  if (!globalThis.tokenCouponAttemptDiagnosisControls) for (const id of ["attempt-diagnosis-runner", "attempt-diagnosis-model", "diagnosis-custom-model", "attempt-diagnosis-history-select"]) $("#" + id).disabled = !!context.running || !!context.pendingSubmission || !!context.diagnosisModelsLoading && ["attempt-diagnosis-model", "diagnosis-custom-model"].includes(id);
}
function renderAttemptDiagnosticControls(context) {
  if (!diagnosticContextIsCurrent(context)) return;
  const records = context.data?.diagnostics || [], disabled = !!context.running || !!context.pendingSubmission;
  const diagnostics = records.map((item, index) => ({ id: item.diagnosticId, label: `诊断 ${index + 1} · ${diagnosticStatuses[item.status] || item.status}` }));
  const model = {
    diagnostics,
    selectedDiagnosticId: context.selectedId || "",
    runnerId: context.diagnosisRunnerId || (["codex", "claude-code"].includes(context.runnerId) ? context.runnerId : "codex"),
    modelId: context.diagnosisModelId || "",
    models: context.diagnosisModels || [],
    customModelId: context.diagnosisCustomModelId || "",
    loading: !!context.diagnosisModelsLoading,
    disabled,
  };
  if (globalThis.tokenCouponAttemptDiagnosisControls) {
    globalThis.tokenCouponAttemptDiagnosisControls.renderHistory($("#attempt-diagnosis-history-controls-root"), diagnostics, model.selectedDiagnosticId, disabled, id => {
      context.selectedId = id;
      renderAttemptDiagnosticHistory(context);
    });
    globalThis.tokenCouponAttemptDiagnosisControls.renderModels($("#attempt-diagnosis-model-controls-root"), model, {
      onRunnerChange: runnerId => { context.diagnosisRunnerId = runnerId; context.diagnosisModelId = ""; void loadAttemptDiagnosticModels(context); },
      onModelChange: modelId => { context.diagnosisModelId = modelId; renderAttemptDiagnosticControls(context); },
      onCustomModelChange: modelId => { context.diagnosisCustomModelId = modelId; renderAttemptDiagnosticControls(context); },
    });
    return;
  }
  const history = $("#attempt-diagnosis-history-select");
  history.replaceChildren(...diagnostics.map(item => new Option(item.label, item.id))); history.value = model.selectedDiagnosticId; show(history, diagnostics.length > 1); history.disabled = disabled;
  const runner = $("#attempt-diagnosis-runner"), select = $("#attempt-diagnosis-model");
  runner.value = model.runnerId;
  select.replaceChildren(new Option(model.loading ? "正在加载模型…" : "默认模型", ""), ...model.models.map(item => new Option(item.label, item.id)), new Option("自定义模型…", "__custom__"));
  select.value = model.modelId;
  $("#diagnosis-custom-model").value = model.customModelId;
  show($("#diagnosis-custom-wrap"), model.modelId === "__custom__");
  for (const control of [runner, select, $("#diagnosis-custom-model")]) control.disabled = disabled || control !== runner && model.loading;
}
async function openAttemptDiagnosis() {
  ensureAttemptDiagnosticUI();
  const view = state.attemptView;
  if (!view || view.workspaceId !== state.workspace?.workspaceId || view.planningId !== state.planning?.planningId) return;
  const identity = `${view.workspaceId}:${view.planningId}:${view.attemptId}`;
  if (state.attemptDiagnosticContext?.identity !== identity) state.attemptDiagnosticContext = { identity, workspaceId: view.workspaceId, planningId: view.planningId, attemptId: view.attemptId, runnerId: view.attempt?.runnerId, modelId: view.attempt?.execution?.modelId };
  if (state.desktopRecoveredDiagnoses?.has(identity)) { state.attemptDiagnosticContext.unsentText = state.desktopRecoveredDiagnoses.get(identity); state.desktopRecoveredDiagnoses.delete(identity); }
  const policy = functionPolicy("diagnosis");
  if (policy?.priority === "agent") await openLocalAttemptDiagnosis(state.attemptDiagnosticContext);
  else if (policy?.priority === "web") await exportAttemptDiagnosis(state.attemptDiagnosticContext);
  else showAttemptDiagnosisChoice();
}
async function openLocalAttemptDiagnosis(context) {
  if (!diagnosticContextIsCurrent(context)) return;
  $("#attempt-diagnosis-dialog").showModal();
  setAttemptDiagnosisStatus(context, "读取已保存的诊断…");
  try {
    await loadAttemptDiagnosticHistory(context);
    if (!diagnosticContextIsCurrent(context)) return;
    const saved = selectedAttemptDiagnostic(context);
    const policy = functionPolicy("diagnosis");
    const usePolicy = policy?.priority === "agent" && saved?.status !== "running";
    context.diagnosisRunnerId = usePolicy ? policy.agent.runnerId : saved?.runnerId || (["codex", "claude-code"].includes(context.runnerId) ? context.runnerId : "codex");
    await loadAttemptDiagnosticModels(context, usePolicy ? policy.agent.modelId || "" : saved ? saved.modelId || "" : (context.runnerId === context.diagnosisRunnerId ? context.modelId : "") || "");
    if (diagnosticContextIsCurrent(context)) { setAttemptDiagnosisStatus(context, saved ? "可继续讨论，或在下方切换模型后发送。" : "输入问题并发送后开始分析。"); $("#attempt-diagnosis-reply").value = context.unsentText || ""; }
  } catch (error) { if (diagnosticContextIsCurrent(context)) setAttemptDiagnosisStatus(context, `暂时无法读取：${error.message}`); }
}
async function sendAttemptDiagnosticMessage() {
  const context = state.attemptDiagnosticContext;
  if (!context || context.running) return;
  const text = $("#attempt-diagnosis-reply").value.trim();
  if (!context.pendingSubmission) {
    if (!text) { setAttemptDiagnosisStatus(context, "先输入一个问题，例如“请分析这次失败的原因”。"); return; }
    const runnerId = context.diagnosisRunnerId || $("#attempt-diagnosis-runner").value, value = context.diagnosisModelId ?? $("#attempt-diagnosis-model").value, modelId = value === "__custom__" ? (context.diagnosisCustomModelId ?? $("#diagnosis-custom-model").value).trim() : value;
    if (value === "__custom__" && !modelId) { setAttemptDiagnosisStatus(context, "请填写模型 ID。"); return; }
    const diagnostic = selectedAttemptDiagnostic(context), isReply = diagnostic?.status === "completed";
    context.pendingSubmission = { path: attemptDiagnosticPath(context) + (isReply ? `/${diagnostic.diagnosticId}/replies` : ""), body: { requestKey: key(), message: text, runnerId, ...(modelId ? { modelId } : {}) } };
  }
  context.running = true; context.unsentText = text; context.scrollAfterSend = true; renderAttemptDiagnosticHistory(context);
  try {
    const submission = context.pendingSubmission;
    let job = await api(submission.path, { method: "POST", body: JSON.stringify(submission.body) });
    // Accepted sends leave the composer ready for the next question; preserve newer input.
    if (diagnosticContextIsCurrent(context)) {
      const composer = $("#attempt-diagnosis-reply");
      if (composer.value.trim() === submission.body.message) composer.value = "";
      context.unsentText = composer.value;
    } else if (context.unsentText?.trim() === submission.body.message) context.unsentText = "";
    while (job.status === "running") {
      if (diagnosticContextIsCurrent(context)) setAttemptDiagnosisStatus(context, "正在分析，关闭窗口后仍会保存结果。");
      await new Promise(resolve => setTimeout(resolve, 900)); job = await api(`/api/v1/jobs/${job.jobId}`);
    }
    context.pendingSubmission = null;
    if (job.status !== "succeeded") throw new Error(job.error || "本次分析中断，请重新发送。");
    context.selectedId = job.result.diagnosticId;
    await loadAttemptDiagnosticHistory(context);
    if (diagnosticContextIsCurrent(context)) setAttemptDiagnosisStatus(context, "分析已保存，可继续追问。");
  } catch (error) {
    if (diagnosticContextIsCurrent(context)) setAttemptDiagnosisStatus(context, `分析未完成：${error.message}${context.pendingSubmission ? "。再次点击“检查本次发送”将查询同一请求，避免重复调用。" : ""}`);
  } finally { context.running = false; if (diagnosticContextIsCurrent(context)) renderAttemptDiagnosticHistory(context); }
}
async function exportAttemptDiagnosis(context) {
  if (!diagnosticContextIsCurrent(context)) return;
  $("#diagnosis-export-dialog").showModal();
  context.exportState = { status: "正在把诊断证据保存到当前工作区…", path: "", copyLabel: "复制分析提示", copyDisabled: true };
  renderAttemptDiagnosticExport(context);
  try {
    const result = await api(`${attemptDiagnosticPath(context)}/export`, { method: "POST", body: "{}" });
    if (!diagnosticContextIsCurrent(context)) return;
    context.exported = result; context.exportState = { status: `证据已保存${result.truncated ? "（日志按限额截取）" : ""}。复制简短提示，到网页发送即可。`, path: result.absolutePath, copyLabel: "复制分析提示", copyDisabled: false };
    renderAttemptDiagnosticExport(context);
    await copyExportedDiagnosticPrompt();
  } catch (error) { if (diagnosticContextIsCurrent(context)) { context.exportState = { status: `保存未完成：${error.message}`, path: "", copyLabel: "复制分析提示", copyDisabled: true }; renderAttemptDiagnosticExport(context); } }
}
function renderAttemptDiagnosticExport(context) {
  const mount = $("#diagnosis-export-root"), model = context.exportState || { status: "正在保存证据…", path: "", copyLabel: "复制分析提示", copyDisabled: true };
  if (globalThis.tokenCouponAttemptDiagnosisExport) {
    globalThis.tokenCouponAttemptDiagnosisExport.render(mount, model, { onClose: () => $("#diagnosis-export-dialog").close(), onCopy: () => void copyExportedDiagnosticPrompt(), onSwitch: () => { $("#diagnosis-export-dialog").close(); showAttemptDiagnosisChoice(); } });
    return;
  }
  $("#diagnosis-export-status").textContent = model.status; $("#diagnosis-export-path").value = model.path;
  $("#diagnosis-export-copy").textContent = model.copyLabel; $("#diagnosis-export-copy").disabled = model.copyDisabled;
}
async function copyExportedDiagnosticPrompt() {
  const result = state.attemptDiagnosticContext?.exported;
  if (!result) return;
  try { await copyText(result.prompt); if (state.attemptDiagnosticContext) { state.attemptDiagnosticContext.exportState.copyLabel = "已复制 · 再次复制"; renderAttemptDiagnosticExport(state.attemptDiagnosticContext); } }
  catch { showCopyFallback("复制网页分析提示", result.prompt); }
}
function reportedModelLabel(model, source) {
  const label = source === "claude-sdk-init" ? "SDK 启动报告" : source === "claude-sdk-assistant" ? "回复模型" : source === "claude-sdk-model-usage" ? "SDK 用量报告" : "Runner 已报告";
  return `${model}（${label}）`;
}
function renderAttemptContent() {
  ensureAttemptDiagnosticUI();
  const view = state.attemptView; if (!view) return;
  const a = view.attempt || {}, box = $("#attempt-messages"), scrollTop = box.scrollTop;
  const model = a.reportedModel || view.reportedModel;
  const attemptState = `${a.runnerId || "Runner"} / ${model ? reportedModelLabel(model, a.reportedModelSource || view.reportedModelSource) : a.execution?.modelId ? `${a.execution.modelId}（配置模型）` : "实际模型未报告"} · ${statuses[a.status] || a.status || "读取中"}${a.reason ? ` · ${a.reason}` : ""}${a.exitCode === null || a.exitCode === undefined ? "" : ` · 退出码 ${a.exitCode}`}`;
  const attemptNotice = `${view.notice || ""}${view.hasMore ? " 还有历史内容待加载，当前不是完整记录。" : ""} 有更新时保留当前阅读位置。`;
  const oldMessages = new Map([...box.querySelectorAll(".attempt-message")].map(message => [message.dataset.messageId, message]));
  const messageAnchor = [...oldMessages.values()].find(message => message.offsetTop + message.offsetHeight > box.scrollTop), anchorOffset = messageAnchor ? messageAnchor.offsetTop - box.scrollTop : 0;
  const messages = [...view.messages].map(([messageId, message]) => ({ ...message, messageId }));
  if (view.finalText && !view.semanticMessages && view.textStream.endsWith(view.finalText) && view.textStream !== view.finalText) {
    const stream = messages.find(message => message.text === view.textStream);
    if (stream) stream.text = view.textStream.slice(0, -view.finalText.length);
  }
  // The final answer often repeats the last streamed message; replace that body rather than double print.
  if (view.finalText) {
    const matching = messages.findIndex(message => message.text.trim() === view.finalText.trim());
    if (matching >= 0) messages[matching] = { ...messages[matching], text: view.finalText, completed: true, final: true };
    else messages.push({ messageId: "final-result", text: view.finalText, completed: true, final: true });
  }
  const replyHeading = ["created", "running"].includes(a.status) ? "模型回复 · 接收中" : "模型回复";
  const conclusion = executionConclusion(a.status);
  const diagnosable = ["failed", "timed_out", "cancelled", "interrupted", "needs_input"].includes(a.status);
  const outcome = [conclusion, a.reason, a.exitCode !== undefined && a.exitCode !== null ? `退出码 ${a.exitCode}` : ""].filter(Boolean).join(" · ");
  if (globalThis.tokenCouponAttemptOverview) {
    globalThis.tokenCouponAttemptOverview.render({ state: attemptState, notice: attemptNotice, outcome, outcomeClass: statusClass(a.status), outcomeVisible: !!conclusion, replyHeading, diagnoseVisible: diagnosable }, () => void openAttemptDiagnosis());
  } else {
    $("#attempt-state").textContent = attemptState;
    $("#attempt-notice").textContent = attemptNotice;
    $("#attempt-reply-heading").textContent = replyHeading;
    $("#attempt-outcome").textContent = outcome;
    $("#attempt-outcome").className = `attempt-outcome ${statusClass(a.status)}`; show($("#attempt-outcome"), !!conclusion);
    show($("#attempt-diagnose"), diagnosable);
  }
  const orderedMessages = messages.filter(item => item.text.trim()).reverse();
  if (globalThis.tokenCouponAttemptMessages) {
    const viewMessages = orderedMessages.map((message, index) => ({
      messageId: message.messageId,
      title: `${orderedMessages.length - index}.${index === 0 ? " 最新回复" : ""}${message.final ? " · 最终结论" : !message.completed ? " · 接收记录" : ""}`,
      text: message.text,
    }));
    globalThis.tokenCouponAttemptMessages.render({ messages: viewMessages, emptyMessage: "尚无模型正文；可展开工具活动或原始事件查看。" });
    box.scrollTop = messageAnchor?.isConnected ? messageAnchor.offsetTop - anchorOffset : scrollTop;
  } else {
    const retained = new Set(orderedMessages.map(message => message.messageId));
    for (const [id, element] of oldMessages) if (!retained.has(id)) element.remove();
    if (orderedMessages.length && !oldMessages.size) box.replaceChildren();
    for (const [index, message] of orderedMessages.entries()) {
      const article = oldMessages.get(message.messageId) || document.createElement("article"); article.className = "attempt-message"; article.dataset.messageId = message.messageId;
      if (!article.children.length) article.append(document.createElement("strong"), document.createElement("pre"));
      const title = article.children[0], pre = article.children[1];
      title.textContent = `${orderedMessages.length - index}.${index === 0 ? " 最新回复" : ""}${message.final ? " · 最终结论" : !message.completed ? " · 接收记录" : ""}`;
      if (article.replyText !== message.text) { pre.replaceChildren(); appendHighlightedReply(pre, message.text); article.replyText = message.text; }
      if (box.children[index] !== article) box.insertBefore(article, box.children[index] || null);
    }
    if (!messages.length) box.textContent = "尚无模型正文；可展开工具活动或原始事件查看。";
    box.scrollTop = messageAnchor?.isConnected ? messageAnchor.offsetTop - anchorOffset : scrollTop;
  }
  const tools = $("#attempt-tools"), toolScroll = tools.scrollTop, rawScroll = $("#attempt-raw").scrollTop;
  const oldTools = new Map([...tools.querySelectorAll("details")].map(item => [item.dataset.eventKey, item]));
  const toolPageState = activityPageState(view, "tools", view.tools), toolPage = toolPageState.items;
  if (globalThis.tokenCouponAttemptTools) {
    const openEventKeys = [...oldTools.values()].filter(element => element.open).map(element => element.dataset.eventKey).filter(Boolean);
    globalThis.tokenCouponAttemptTools.render({
      openEventKeys,
      tools: toolPage.map(tool => ({
        eventKey: String(tool.sequence),
        summary: `${tool.timestamp ? new Date(tool.timestamp).toLocaleTimeString() + " · " : ""}${tool.type}${tool.exitCode === undefined ? "" : ` · 退出码 ${tool.exitCode}`} · ${tool.text.slice(0, 180)}`,
        text: [tool.text, tool.output].filter(Boolean).join("\n"),
        isError: !!tool.exitCode && tool.exitCode !== 0 || tool.type === "stderr",
      })),
    });
  } else {
    for (const [eventKey, element] of oldTools) if (!toolPage.some(tool => String(tool.sequence) === eventKey)) element.remove();
    for (const [index, tool] of toolPage.entries()) { const details = oldTools.get(String(tool.sequence)) || document.createElement("details"), signature = JSON.stringify(tool);
      if (details.dataset.signature !== signature) { details.dataset.signature = signature; details.replaceChildren(); const summary = document.createElement("summary"), pre = document.createElement("pre"); details.className = "foldout"; details.dataset.eventKey = String(tool.sequence); if (tool.exitCode && tool.exitCode !== 0 || tool.type === "stderr") details.classList.add("activity-error"); summary.textContent = `${tool.timestamp ? new Date(tool.timestamp).toLocaleTimeString() + " · " : ""}${tool.type}${tool.exitCode === undefined ? "" : ` · 退出码 ${tool.exitCode}`} · ${tool.text.slice(0, 180)}`; pre.textContent = [tool.text, tool.output].filter(Boolean).join("\n"); details.append(summary, pre); }
      if (tools.children[index] !== details) tools.insertBefore(details, tools.children[index] || null);
    }
  }
  if (globalThis.tokenCouponAttemptToolsPagination) globalThis.tokenCouponAttemptToolsPagination.render({
    pageLabel: toolPageState.label, previousDisabled: toolPageState.page === 0, nextDisabled: toolPageState.page + 1 >= toolPageState.pages,
  }, {
    onPrevious: () => { if (state.attemptView) { state.attemptView.toolsPage--; renderAttemptView(); } },
    onNext: () => { if (state.attemptView) { state.attemptView.toolsPage++; renderAttemptView(); } },
  });
  const filterValue = view.rawFilter ?? $("#attempt-event-filter").value;
  if (globalThis.tokenCouponAttemptRawEvents) globalThis.tokenCouponAttemptRawEvents.render($("#attempt-raw-root"), {
    identity: `${view.identity}:${view.rawRevision || 0}`,
    events: view.raw.map(event => ({ line: JSON.stringify(event), type: event.type, stream: event.payload?.stream })),
    filterValue, initialPage: view.rawPage || 0, hasMore: !!view.hasMore,
  }, {
    onFilter: value => { if (state.attemptView === view) view.rawFilter = value; },
    onPageChange: page => { if (state.attemptView === view) view.rawPage = page; },
  });
  else {
    const filter = filterValue.trim(), raw = view.raw.filter(event => !filter || event.type.includes(filter) || event.payload?.stream === filter);
    const rawPage = activityPageState(view, "raw", raw), rawLines = rawPage.items.map(event => JSON.stringify(event));
    $("#attempt-raw").textContent = rawLines.join("\n");
  }
  tools.scrollTop = toolScroll; $("#attempt-raw").scrollTop = rawScroll;
  renderAttemptControls();
}
function appendHighlightedReply(root, text) {
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const verdict = !fenced && /^\s*(?:#{1,6}\s*|[-*]\s*|\*\*)?(?:完成结论|验证结果|测试结果|中止结论|错误|失败原因|取消原因|任务失败|Error:|FAIL\b)/i.test(line);
    if (verdict) { const mark = document.createElement("span"); mark.className = /错误|失败|中止|取消|Error:|FAIL\b/i.test(line) ? "reply-verdict reply-error" : "reply-verdict reply-success"; mark.textContent = line; root.append(mark); }
    else root.append(document.createTextNode(line));
    root.append(document.createTextNode("\n"));
  }
}
function activityPageState(view, kind, items) {
  const size = 15, pages = Math.max(1, Math.ceil(items.length / size));
  view[`${kind}Page`] = Math.max(0, Math.min(view[`${kind}Page`] || 0, pages - 1));
  const page = view[`${kind}Page`];
  const label = `第 ${page + 1} / ${pages} 页 · 已加载 ${items.length} 条${view.hasMore ? "（还有历史待加载）" : ""}`;
  const reactOwned = kind === "raw" ? globalThis.tokenCouponAttemptRawEvents : kind === "tools" ? globalThis.tokenCouponAttemptToolsPagination : undefined;
  if (!reactOwned) {
    $("#attempt-" + kind + "-page").textContent = label;
    $("#attempt-" + kind + "-prev").disabled = page === 0;
    $("#attempt-" + kind + "-next").disabled = page + 1 >= pages;
  }
  return { items: items.slice(page * size, (page + 1) * size), page, pages, label };
}
function startSessionAction(action, label, extra = {}) {
  if (action === "session/pause" || action === "session/cancel") return startControlAction(action.endsWith("pause") ? "pause" : "cancel", label, extra);
  return startJob(label, (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/${action}`, { method: "POST", body: JSON.stringify({ requestKey, ...extra }) }));
}
function controlViewKey(workspaceId = state.workspace?.workspaceId, planningId = state.planning?.planningId) { return `${workspaceId}:${planningId}`; }
function renderControlFeedback(session) {
  const key = controlViewKey(), stored = state.controlFeedback?.get(key), target = $("#session-control-status");
  if (!session) { target.textContent = ""; return; }
  if (stored?.executionId && stored.executionId !== session.executionId) state.controlFeedback.delete(key);
  const pending = session.pendingControl || (session.controlState?.requestId && !session.controlState.acknowledgedAt ? session.controlState : null);
  if (pending && ["running", "pausing"].includes(session.status)) {
    const active = session.tasks.filter(task => task.status === "running"), waiting = active.filter(task => pendingTaskInteraction(task)).length;
    target.textContent = pending.kind === "pause" ? `暂停请求已接收${session.status === "pausing" ? "，已停止后续派发" : "，等待运行 owner 接收"}；等待 ${active.length} 个任务收尾${active.length ? `：${active.map(task => task.title || task.taskId).join("、")}` : ""}${waiting ? `；${waiting} 项审批或回答仍需处理` : ""}。当前模型不会被强行中断。` : "取消请求已接收，正在等待 Runner 停止；已有文件与执行记录保留。";
  } else if ((stored || session.controlState?.requestId) && ["paused", "cancelled", "succeeded", "failed", "interrupted"].includes(session.status)) {
    target.textContent = session.status === "paused" ? "会话已暂停；已完成任务保留，可从断点继续。" : session.status === "cancelled" ? "会话已取消；已有结果和记录保留。" : session.status === "succeeded" ? "任务已全部完成，无需暂停。" : `会话已结束：${statuses[session.status]}，请查看任务结论。`;
  } else target.textContent = state.controlFeedback?.get(key)?.message || "";
}
async function startControlAction(kind, label, extra = {}) {
  const workspaceId = state.workspace?.workspaceId, planningId = state.planning?.planningId;
  if (!workspaceId || !planningId) return;
  if (state.controlJob?.status === "running" || state.submittingControl) {
    $("#session-control-status").textContent = `已有“${state.controlJob?.kind === "session.pause" ? "暂停" : "控制"}”请求等待确认；正在查询同一请求。`;
    return;
  }
  const requestKey = key(), context = { workspaceId, planningId, sessionId: state.planning.session?.sessionId, label, kind };
  state.submittingControl = true;
  state.controlFeedback ??= new Map(); state.controlFeedback.set(controlViewKey(workspaceId, planningId), { message: kind === "pause" ? "正在提交暂停请求；当前任务批次会先收尾。" : "正在提交取消请求。", executionId: state.planning.session?.executionId });
  renderControlFeedback(state.planning.session);
  for (const button of $("#session-controls").querySelectorAll("button")) button.disabled = true;
  try {
    const job = await api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}/session/${kind}`, { method: "POST", body: JSON.stringify({ requestKey, ...extra }) });
    state.controlJob = { ...job, context }; state.submittingControl = false;
    if (workspaceId === state.workspace?.workspaceId && planningId === state.planning?.planningId) renderSession();
    if (job.status === "running") void pollControlJob(job.jobId, context); else await completeControlJob(job, context);
  } catch (error) {
    state.submittingControl = false; state.controlFeedback.set(controlViewKey(workspaceId, planningId), { message: `控制请求未确认：${error.message}。请重新检测会话状态，不要重复启动 Session。` });
    if (workspaceId === state.workspace?.workspaceId && planningId === state.planning?.planningId) renderSession();
  }
}
async function pollControlJob(jobId, context) {
  while (state.controlJob?.jobId === jobId) {
    await new Promise(resolve => setTimeout(resolve, 900));
    let job;
    try { job = await api(`/api/v1/jobs/${jobId}`); }
    catch (error) { if (context.workspaceId === state.workspace?.workspaceId && context.planningId === state.planning?.planningId) $("#session-control-status").textContent = `控制状态暂不可读：${error.message}。请求可能仍在处理；请重新检测状态。`; continue; }
    if (state.controlJob?.jobId !== jobId) return;
    state.controlJob = { ...job, context };
    if (job.status !== "running") { await completeControlJob(job, context); return; }
  }
}
async function completeControlJob(job, context) {
  const status = job.result?.status;
  const sameView = context.workspaceId === state.workspace?.workspaceId && context.planningId === state.planning?.planningId;
  state.controlFeedback ??= new Map();
  if (job.status === "succeeded" && job.result?.phase === "requested") {
    state.controlFeedback.set(controlViewKey(context.workspaceId, context.planningId), { executionId: job.result.executionId, requestId: job.result.requestId, message: `${context.kind === "pause" ? "暂停" : "取消"}请求已持久化，等待运行 owner 处理；可重新检测状态。` });
    if (sameView) await refreshAll();
  } else if (sameView) {
    const message = job.status !== "succeeded" ? `控制请求失败：${job.error || statuses[job.status] || job.status}。请重新检测状态。`
      : status === "paused" ? "会话已暂停；已完成任务保留，恢复时只调度未完成任务。"
        : status === "cancelled" ? "会话已取消；已有结果和任务记录保留。"
          : status === "succeeded" ? "任务已全部完成，无需暂停。"
            : `控制请求已确认，会话状态：${statuses[status] || status || "待刷新"}。`;
    $("#session-control-status").textContent = message;
    state.controlFeedback.set(controlViewKey(context.workspaceId, context.planningId), { message });
    $("#session-health").dataset.controlState = job.status === "succeeded" ? status || "acknowledged" : "failed";
    await refreshAll();
  }
  state.controlJob = null;
  if (sameView) renderSession();
}
async function diagnoseAndRecover() {
  try {
    const workspaceId = state.workspace?.workspaceId, planningId = state.planning?.planningId;
    if (!workspaceId || !planningId) return;
    const result = await api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}/session/diagnosis`);
    if (workspaceId !== state.workspace?.workspaceId || planningId !== state.planning?.planningId) return;
    addLog(`Session 诊断：${result.state}；保存状态：${result.savedStatus}`, "session.diagnosis");
    if (result.state === "owner_exited") {
      if (!await askConfirm("核验后恢复 Session", "请确认对应 Runner 已停止。此操作只修复恢复状态，不会自动重试任务。", "恢复 Session")) return;
      await startSessionAction("session/recover", "恢复 Session", { confirmedStopped: true });
    } else showToast(`Session 状态：${result.state}；${result.savedStatus}`);
  } catch (error) { showToast(error.message, true); }
}
async function renderInteractions() {
  const root = $("#interaction-list");
  if (!state.workspace || !state.planning) return;
  const workspaceId = state.workspace.workspaceId, planningId = state.planning.planningId;
  let items; try { items = await api(`/api/v1/workspaces/${workspaceId}/interactions/${planningId}`); } catch { return; }
  if (workspaceId !== state.workspace?.workspaceId || planningId !== state.planning?.planningId) return;
  preserveExecutionReading(() => {
  state.planning.interactions = items; state.waitingInteractions = items.length;
  renderSession();
  const questionCount = items.filter(item => item.request.kind === "question").length;
  const approvalCount = items.filter(item => item.request.kind === "approval").length;
  const summary = !items.length ? "当前没有待处理请求。" : questionCount === items.length ? "Runner 正在等待你的回答。请选择答案或补充具体信息；回答会发送给对应任务，不代表批准计划或工具操作。" : approvalCount === items.length ? "工具正在等待你的批准。请核对操作理由、具体命令和工作目录，再决定本次允许或拒绝。" : `${questionCount} 项任务提问、${approvalCount} 项工具审批、${items.length - questionCount - approvalCount} 项表单／网页确认，请分别处理。`;
  if (globalThis.tokenCouponPendingApprovalOverview) globalThis.tokenCouponPendingApprovalOverview.render({ count: items.length, summary });
  else { $("#pending-approval-count").textContent = `${items.length} 项`; $("#pending-approval-summary").textContent = summary; }
  $("#pending-approval-box").classList.toggle("has-pending", !!items.length);
  show($("#pending-action-banner"), !!items.length);
  $("#pending-action-label").textContent = `${items.length} 项等待你审批／回答 · ${state.workspace.label}`;
  notifyPendingApprovals(items);
  const signature = JSON.stringify([workspaceId, planningId, items]);
  if (state.interactionSignature === signature) return;
  state.interactionSignature = signature;
  const answers = new Map([...root.querySelectorAll("input[data-question-id]")].map(input => [input.id, { value: input.value, checked: input.checked }]));
  if (root.childElementCount) {
    globalThis.tokenCouponPendingApprovalText?.unmountWithin(root);
    globalThis.tokenCouponPendingApprovalDecision?.unmountWithin(root);
    globalThis.tokenCouponPendingRunnerQuestions?.unmountWithin(root);
    globalThis.tokenCouponPendingInteractionGuidance?.unmountWithin(root);
    globalThis.tokenCouponPendingElicitation?.unmountWithin(root);
  }
  root.replaceChildren(); state.waitingInteractions = items.length; renderPlanOverview();
  for (const interaction of items) {
    const card = document.createElement("div"); card.className = "interaction-card"; card.dataset.requestId = interaction.requestId;
    const request = interaction.request;
    const task = state.planning.session?.tasks?.find(task => task.taskId === interaction.owner.taskId);
    const taskTitle = task?.title || state.planning.draft?.plan.tasks.find(entry => entry.task.id === interaction.owner.taskId)?.task.title;
    const kindLabel = request.kind === "question" ? "提问" : request.kind === "approval" ? "工具审批" : "表单／网页确认";
    const headingDetail = request.kind === "question" ? taskTitle : request.title || taskTitle;
    card.innerHTML = `<h4>${esc(labels[interaction.owner.runnerId] || interaction.owner.runnerId)} ${kindLabel}${headingDetail ? ` · ${esc(headingDetail)}` : ""}</h4><p class="small">任务 ${esc(interaction.owner.taskId)}</p>`;
    const summary = request.summary?.trim();
    const questionTexts = (request.questions || []).map(question => question.text?.trim());
    if (summary && !(request.kind === "question" && (questionTexts.includes(summary) || summary === questionTexts.join("\n")))) {
      appendApprovalText(card, "approval-reason", "审批说明", summary, `${interaction.requestId}:summary`, 8, 1200);
    }
    if (request.kind === "question") {
      const attempt = task?.currentAttempt;
      const context = (!interaction.owner.attemptId || attempt?.attemptId === interaction.owner.attemptId) && attempt?.lastReply;
      const text = typeof context === "string" ? context.replace(/^<<<TOKEN_COUPON_(?:DONE|NEEDS_INPUT):[a-f0-9]+>>>\s*$/gm, "").trim() : "";
      if (text && text !== summary && !questionTexts.includes(text)) {
        const background = document.createElement("div"); background.className = "runner-question-context";
        const label = document.createElement("strong"), body = document.createElement("p"); label.textContent = "提问背景 · Runner 原文"; body.textContent = text;
        background.append(label, body); card.append(background);
      }
    }
    if (request.kind === "approval") {
      if (request.operation?.command) appendApprovalText(card, "approval-command", "待审批命令", request.operation.command, `${interaction.requestId}:command`, 6, 800, true);
      if (request.cwd) { const cwd = document.createElement("p"); cwd.className = "hint"; cwd.textContent = `工作目录：${request.cwd}`; card.append(cwd); }
      if (globalThis.tokenCouponPendingApprovalDecision) {
        const actions = document.createElement("div"); actions.className = "approval-decision-react-root"; card.append(actions);
        globalThis.tokenCouponPendingApprovalDecision.render(actions, {
          onAllow: () => respondInteraction(interaction.requestId, { kind: "approval", decision: "allow-once" }),
          onDeny: () => respondInteraction(interaction.requestId, { kind: "approval", decision: "deny" }),
        });
      } else {
        const actions = document.createElement("div"); actions.className = "interaction-actions";
        for (const [decision, text] of [["allow-once", "本次允许"], ["deny", "拒绝本次操作"]]) {
          const button = document.createElement("button"); button.className = `button ${decision === "allow-once" ? "button-primary" : "button-quiet"}`; button.textContent = text;
          button.addEventListener("click", () => respondInteraction(interaction.requestId, { kind: "approval", decision })); actions.append(button);
        }
        card.append(actions);
      }
    } else if (request.kind === "elicitation") {
      renderCodexElicitation(card, interaction);
    } else {
      renderRunnerQuestions(card, interaction, answers);
    }
    appendInteractionGuidance(card, interaction);
    root.append(card);
  }
  });
}
function appendApprovalText(parent, className, title, text, storageKey, maxLines, maxChars, code = false) {
  if (globalThis.tokenCouponPendingApprovalText) {
    const mount = document.createElement("div"); mount.className = "approval-text-react-root"; parent.append(mount);
    globalThis.tokenCouponPendingApprovalText.render(mount, { className, title, text, storageKey, maxLines, maxChars, code });
    return;
  }
  const lines = text.split("\n");
  const makeBody = value => { const body = document.createElement(code ? "pre" : "p"); body.className = className; body.textContent = value; return body; };
  if (lines.length <= maxLines && text.length <= maxChars) {
    const label = document.createElement("strong"); label.className = "approval-field-label"; label.textContent = title; parent.append(label, makeBody(text)); return;
  }
  const details = document.createElement("details"); details.className = `foldout approval-text-foldout ${className}-foldout`;
  const summary = document.createElement("summary"); summary.textContent = `${title} · ${lines.length} 行，点击查看全文`;
  let stored = ""; try { stored = sessionStorage.getItem(`tc-approval-fold:${storageKey}`) || ""; } catch { /* Storage is optional. */ }
  details.open = stored === "open";
  const preview = makeBody(lines.slice(0, maxLines).join("\n") + (lines.length > maxLines ? "\n…（其余内容已折叠）" : "\n…（部分字符已折叠）")); preview.classList.add("approval-text-preview");
  const full = makeBody(text); full.classList.add("approval-text-full"); preview.hidden = details.open; full.hidden = !details.open;
  details.append(summary, preview, full);
  details.addEventListener("toggle", () => { preview.hidden = details.open; full.hidden = !details.open; try { sessionStorage.setItem(`tc-approval-fold:${storageKey}`, details.open ? "open" : "closed"); } catch { /* Storage is optional. */ } });
  parent.append(details);
}
function renderRunnerQuestions(card, interaction, drafts) {
  if (globalThis.tokenCouponPendingRunnerQuestions) {
    const mount = document.createElement("div"); mount.className = "runner-questions-react-root"; card.append(mount);
    globalThis.tokenCouponPendingRunnerQuestions.render(mount, {
      requestId: interaction.requestId,
      questions: interaction.request.questions || [],
      drafts: Object.fromEntries(drafts),
      onSubmit: answers => void respondInteraction(interaction.requestId, { kind: "question", answers }),
    });
    return;
  }
  const readers = [], questions = interaction.request.questions || [];
  const hint = document.createElement("p"); hint.className = "hint runner-question-help";
  const submit = document.createElement("button"); submit.type = "button"; submit.className = "button button-primary"; submit.textContent = "发送回答并继续";
  const update = () => {
    const incomplete = readers.some(({ question, read }) => question.required !== false && !read());
    submit.disabled = !questions.length || incomplete;
    hint.textContent = !questions.length ? "Runner 未提供具体问题，请使用下方“拒绝并指导”说明下一步。" : incomplete ? "请先选择一个答案，或在允许自定义时填写具体说明。" : "回答只发送给当前任务；计划批准、工具审批和会话取消仍由各自入口处理。";
  };
  for (const question of questions) {
    const fieldset = document.createElement("fieldset"); fieldset.className = "runner-question";
    const legend = document.createElement("legend"); legend.textContent = question.text || "Runner 未提供具体问题"; fieldset.append(legend);
    const options = question.options || [], choices = [];
    const allowText = options.length ? question.allowFreeText === true : question.allowFreeText !== false;
    let custom, input, textLabel;
    const sync = () => { if (textLabel) show(textLabel, !options.length || !!custom?.checked); update(); };
    const optionLabel = (input, text) => { const label = document.createElement("label"); label.className = "runner-question-option"; const span = document.createElement("span"); span.textContent = text; label.append(input, span); return label; };
    for (const option of options) {
      const choice = document.createElement("input"); choice.type = question.multiple ? "checkbox" : "radio";
      choice.name = `${interaction.requestId}:${question.id}`; choice.id = `interaction-option:${interaction.requestId}:${question.id}:${option.id}`;
      choice.dataset.questionId = question.id; choice.dataset.optionId = option.id; choice.value = option.id; choice.checked = drafts.get(choice.id)?.checked || false;
      choice.addEventListener("change", () => { if (custom && choice.checked) custom.checked = false; sync(); });
      choices.push(choice); fieldset.append(optionLabel(choice, option.label));
    }
    if (allowText) {
      if (options.length) {
        custom = document.createElement("input"); custom.type = "radio"; custom.name = `${interaction.requestId}:${question.id}`;
        custom.id = `interaction-custom:${interaction.requestId}:${question.id}`; custom.dataset.questionId = question.id;
        custom.checked = drafts.get(custom.id)?.checked || false;
        custom.addEventListener("change", () => { if (custom.checked) choices.forEach(choice => { choice.checked = false; }); sync(); });
        fieldset.append(optionLabel(custom, "自定义回答"));
      }
      textLabel = document.createElement("label"); textLabel.className = "runner-question-text"; textLabel.textContent = options.length ? "请说明你的决定或补充信息" : "请补充这个问题需要的信息";
      input = document.createElement("input"); input.type = question.secret ? "password" : "text"; input.autocomplete = "off";
      input.id = `interaction-answer:${interaction.requestId}:${question.id}`; input.dataset.questionId = question.id; input.value = drafts.get(input.id)?.value || "";
      input.placeholder = options.length ? "例如：选择其他方案，并说明具体要求" : "填写上方问题所需的具体信息";
      input.setAttribute("aria-label", `回答：${question.text}`); input.addEventListener("input", update); textLabel.append(input); fieldset.append(textLabel);
    }
    const read = () => {
      if (!options.length || custom?.checked) { const text = input?.value.trim(); return text ? { questionId: question.id, text } : undefined; }
      const optionIds = choices.filter(choice => choice.checked).map(choice => choice.dataset.optionId);
      return optionIds.length ? { questionId: question.id, optionIds } : undefined;
    };
    readers.push({ question, read }); card.append(fieldset); sync();
  }
  submit.addEventListener("click", () => { update(); if (!submit.disabled) void respondInteraction(interaction.requestId, { kind: "question", answers: readers.map(({ read }) => read()).filter(Boolean) }); });
  card.append(hint, submit); update();
}
function appendInteractionGuidance(card, interaction) {
  if (!["codex", "claude-code"].includes(interaction.owner.runnerId)) return;
  if (globalThis.tokenCouponPendingInteractionGuidance) {
    const mount = document.createElement("div"); mount.className = "interaction-guidance-react-root"; card.append(mount);
    globalThis.tokenCouponPendingInteractionGuidance.render(mount, {
      kind: interaction.request.kind,
      onInvalid: () => showToast("请填写调整指导；当前请求尚未提交。", true),
      onSubmit: text => {
        const kind = interaction.request.kind;
        const reply = kind === "approval" ? { kind, decision: "deny", guidance: text } : kind === "elicitation" ? { kind, action: "decline", guidance: text } : { kind: "question", answers: [], guidance: text };
        void respondInteraction(interaction.requestId, reply);
      },
    });
    return;
  }
  const area = document.createElement("div"); area.className = "approval-guidance";
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "button button-quiet interaction-no"; toggle.textContent = "NO, tell what to do · 拒绝并指导"; toggle.setAttribute("aria-expanded", "false");
  const editor = document.createElement("div"); editor.className = "guidance-editor hidden";
  const guidance = document.createElement("textarea"); guidance.maxLength = 4096; guidance.rows = 3; guidance.setAttribute("aria-label", "拒绝后的调整指导"); guidance.placeholder = "说明应采用的替代方案、临时要求或下一步操作。";
  const note = document.createElement("p"); note.className = "hint"; note.textContent = interaction.request.kind === "elicitation" ? "当前 MCP 请求会被拒绝；指导在当前原生轮次结束后交给 Codex，继续同一 Attempt。不会作为表单答案发给 MCP。" : "拒绝当前建议并传递调整说明；后续工具请求仍需单独审批。";
  const apply = document.createElement("button"); apply.type = "button"; apply.className = "button button-primary"; apply.textContent = "拒绝并提交指导";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button button-quiet"; cancel.textContent = "放弃指导";
  toggle.addEventListener("click", () => { show(editor, true); toggle.setAttribute("aria-expanded", "true"); guidance.focus(); });
  cancel.addEventListener("click", () => { show(editor, false); toggle.setAttribute("aria-expanded", "false"); });
  apply.addEventListener("click", () => {
    const text = guidance.value.trim(); if (!text) { showToast("请填写调整指导；当前请求尚未提交。", true); guidance.focus(); return; }
    const kind = interaction.request.kind;
    const reply = kind === "approval" ? { kind, decision: "deny", guidance: text } : kind === "elicitation" ? { kind, action: "decline", guidance: text } : { kind: "question", answers: [], guidance: text };
    void respondInteraction(interaction.requestId, reply);
  });
  const actions = document.createElement("div"); actions.className = "button-row"; actions.append(apply, cancel); editor.append(guidance, note, actions); area.append(toggle, editor); card.append(area);
}
function renderCodexElicitation(card, interaction) {
  const request = interaction.request, elicitation = request.elicitation || {};
  if (globalThis.tokenCouponPendingElicitation) {
    const schema = elicitation.requestedSchema;
    const mode = elicitation.mode === "url" ? "url" : elicitation.mode === "form" && schema?.properties ? "form" : "unsupported";
    const mount = document.createElement("div"); mount.className = "elicitation-react-root"; card.append(mount);
    globalThis.tokenCouponPendingElicitation.render(mount, {
      mode,
      url: elicitation.url,
      schema,
      onAcceptUrl: () => void respondInteraction(interaction.requestId, { kind: "elicitation", action: "accept" }),
      onSubmit: content => void respondInteraction(interaction.requestId, { kind: "elicitation", action: "accept", content }),
      onDecline: () => void respondInteraction(interaction.requestId, { kind: "elicitation", action: "decline" }),
      onCancel: () => void respondInteraction(interaction.requestId, { kind: "elicitation", action: "cancel" }),
    });
    return;
  }
  if (elicitation.mode === "url") {
    const destination = document.createElement("p"); destination.className = "elicitation-destination";
    let host = "目标网站";
    try { host = new URL(elicitation.url).host; } catch { /* URL was validated by the Runner */ }
    destination.textContent = "授权或确认页面：" + host;
    const link = document.createElement("a"); link.href = elicitation.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "在新标签页打开安全连接";
    const actions = document.createElement("div"); actions.className = "interaction-actions";
    const accept = document.createElement("button"); accept.type = "button"; accept.className = "button button-primary"; accept.textContent = "已完成，继续执行";
    accept.addEventListener("click", () => respondInteraction(interaction.requestId, { kind: "elicitation", action: "accept" }));
    const decline = document.createElement("button"); decline.type = "button"; decline.className = "button button-quiet"; decline.textContent = "拒绝";
    decline.addEventListener("click", () => respondInteraction(interaction.requestId, { kind: "elicitation", action: "decline" }));
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button button-quiet"; cancel.textContent = "取消此请求";
    cancel.addEventListener("click", () => respondInteraction(interaction.requestId, { kind: "elicitation", action: "cancel" }));
    actions.append(accept, decline, cancel); card.append(destination, link, actions);
    return;
  }
  const schema = elicitation.requestedSchema;
  if (elicitation.mode !== "form" || !schema || !schema.properties) {
    const warning = document.createElement("p"); warning.className = "hint"; warning.textContent = "当前表单格式不受支持。Runner 已安全拒绝该请求；如任务仍在运行，可查看诊断信息。"; card.append(warning);
    return;
  }
  const form = document.createElement("form"); form.className = "elicitation-form";
  const required = new Set(schema.required || []), controls = new Map();
  for (const [name, field] of Object.entries(schema.properties)) {
    const label = document.createElement("label"); label.className = "elicitation-field";
    const heading = document.createElement("span"); heading.className = "elicitation-field-heading";
    heading.textContent = (field.title || name) + (required.has(name) ? " · 必填" : "");
    label.append(heading);
    if (field.description) { const description = document.createElement("small"); description.textContent = field.description; label.append(description); }
    let control;
    const choices = Array.isArray(field.enum) ? field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] || value }))
      : Array.isArray(field.oneOf) ? field.oneOf.map((entry) => ({ value: entry.const, label: entry.title }))
      : field.type === "array" && Array.isArray(field.items?.enum) ? field.items.enum.map((value) => ({ value, label: value }))
      : field.type === "array" && Array.isArray(field.items?.anyOf) ? field.items.anyOf.map((entry) => ({ value: entry.const, label: entry.title }))
      : undefined;
    if (field.type === "boolean") {
      control = document.createElement("input"); control.type = "checkbox";
      if (typeof field.default === "boolean") control.checked = field.default;
      control.addEventListener("change", () => { control.dataset.touched = "true"; });
    } else if (choices) {
      control = document.createElement("select"); control.multiple = field.type === "array";
      if (!control.multiple) {
        const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "请选择"; control.append(placeholder);
      }
      for (const choice of choices) { const option = document.createElement("option"); option.value = choice.value; option.textContent = choice.label; control.append(option); }
      if (field.type === "array" && Array.isArray(field.default)) for (const option of control.options) option.selected = field.default.includes(option.value);
      else if (typeof field.default === "string") control.value = field.default;
    } else {
      control = document.createElement("input");
      control.type = field.type === "number" || field.type === "integer" ? "number" : "text";
      if (field.type === "number") control.step = "any";
      if (field.type === "integer") control.step = "1";
      if (field.type === "string") {
        if (field.format === "email") control.type = "email";
        else if (field.format === "date") control.type = "date";
        else if (field.format === "uri") control.type = "url";
        if (field.minLength !== undefined) control.minLength = field.minLength;
        if (field.maxLength !== undefined) control.maxLength = field.maxLength;
      }
      if (field.minimum !== undefined) control.min = field.minimum;
      if (field.maximum !== undefined) control.max = field.maximum;
      if (field.default !== undefined) control.value = String(field.default);
    }
    control.dataset.elicitationField = name;
    control.required = required.has(name) && (field.type === "number" || field.type === "integer" || field.type === "string" && (!!choices || (field.minLength || 0) > 0) || field.type === "array" && (field.minItems || 0) > 0);
    controls.set(name, { control, field }); label.append(control); form.append(label);
  }
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "button button-primary"; submit.textContent = "提交并继续";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const content = {};
    for (const [name, item] of controls) {
      const { control, field } = item;
      if (field.type === "boolean") {
        if (required.has(name) || field.default !== undefined || control.checked || control.dataset.touched === "true") content[name] = control.checked;
      } else if (field.type === "array") {
        const values = [...control.selectedOptions].map((option) => option.value);
        if (required.has(name) || values.length) content[name] = values;
      } else if (control.value !== "" || required.has(name) && field.type === "string") {
        content[name] = field.type === "number" ? Number(control.value) : field.type === "integer" ? Number.parseInt(control.value, 10) : control.value;
      }
    }
    const missing = [...required].find(name => !Object.hasOwn(content, name));
    if (missing) { controls.get(missing)?.control.focus(); showToast("请填写必填项：" + (controls.get(missing)?.field.title || missing), true); return; }
    void respondInteraction(interaction.requestId, { kind: "elicitation", action: "accept", content });
  });
  const actions = document.createElement("div"); actions.className = "interaction-actions";
  for (const [action, label] of [["decline", "拒绝此请求"], ["cancel", "取消此请求"]]) {
    const button = document.createElement("button"); button.type = "button"; button.className = "button button-quiet"; button.textContent = label; button.addEventListener("click", () => void respondInteraction(interaction.requestId, { kind: "elicitation", action })); actions.append(button);
  }
  card.append(form, actions);
}
async function respondInteraction(requestId, reply) {
  try { await api(`/api/v1/workspaces/${state.workspace.workspaceId}/interactions/${requestId}`, { method: "POST", body: JSON.stringify(reply) }); showToast("已提交给对应 Runner。"); await renderInteractions(); }
  catch (error) { showToast(error.message, true); }
}
function notifyPendingApprovals(items) {
  state.notifiedRequests ??= new Set();
  const fresh = items.filter(item => !state.notifiedRequests.has(item.requestId));
  for (const item of fresh) state.notifiedRequests.add(item.requestId);
  const base = `${state.planning?.draft?.plan.title || "orchestrator-tokenCoupon"} · orchestrator-tokenCoupon`;
  document.title = items.length ? `【${items.length} 项待审批】${base}` : base;
  if (fresh.length && (document.hidden || !document.hasFocus())) {
    const workspaceId = state.workspace?.workspaceId, planningId = state.planning?.planningId;
    const requestedTaskId = fresh.length === 1 ? fresh[0].owner?.taskId ?? fresh[0].taskId : undefined;
    const taskId = typeof requestedTaskId === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(requestedTaskId) ? requestedTaskId : undefined;
    if (window.tokenCouponDesktop && state.desktopNotificationsEnabled) {
      void window.tokenCouponDesktop.showNotification({ title: "orchestrator-tokenCoupon · 需要你的决定", body: `${fresh.length} 个新请求，打开本机页面核对后允许或拒绝。`, ...(workspaceId && planningId ? { workspaceId, planningId, ...(taskId ? { taskId } : {}) } : {}) })
        .then(shown => { if (!shown) $("#notification-status").textContent = "系统通知不可用，页面内仍会显示待审批。"; })
        .catch(() => { $("#notification-status").textContent = "系统通知不可用，页面内仍会显示待审批。"; });
    } else if (!window.tokenCouponDesktop && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { const note = new Notification("orchestrator-tokenCoupon · 需要你的决定", { body: `${fresh.length} 个新请求，打开本机页面核对后允许或拒绝。`, tag: `tc-${state.workspace?.workspaceId}-${state.planning?.planningId}` }); note.onclick = () => { window.focus(); if (workspaceId && planningId) void navigate(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planningId)}/execution`); note.close(); }; } catch { $("#notification-status").textContent = "系统通知不可用，仍保留页签和页面提醒。"; }
    }
  }
  while (state.notifiedRequests.size > 500) state.notifiedRequests.delete(state.notifiedRequests.values().next().value);
}

window.addEventListener("token-coupon:navigate-to-task", event => {
  const target = event.detail;
  if (!target || !/^[A-Za-z0-9_-]{1,128}$/.test(target.workspaceId || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(target.planningId || "") ||
      target.taskId !== undefined && !/^[A-Za-z0-9._-]{1,100}$/.test(target.taskId)) return;
  const path = `/workspaces/${encodeURIComponent(target.workspaceId)}/plans/${encodeURIComponent(target.planningId)}/execution`;
  void navigate(path).then(() => {
    if (state.route?.workspaceId !== target.workspaceId || state.route?.planningId !== target.planningId || !target.taskId) return;
    const row = [...document.querySelectorAll(".task-row")].find(item => item.dataset.taskId === target.taskId);
    if (!row) return;
    row.classList.add("desktop-notification-focus"); row.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => row.classList.remove("desktop-notification-focus"), 3200);
  });
});
function statusClass(status) { if (["succeeded", "approved"].includes(status)) return "badge-success"; if (["failed", "timed_out", "cancelled", "interrupted"].includes(status)) return "badge-error"; if (["running", "pausing", "blocked", "paused", "unavailable"].includes(status)) return "badge-warning"; return "badge-neutral"; }

const planningStages = { preparing: "准备调用", starting: "启动 Agent", initializing: "初始化连接", waiting_model: "等待模型回复", receiving: "正在接收回复", validating: "校验回复", repairing: "自动修正回复", completed: "校验完成，正在保存", failed: "调用已结束，正在保存", cancelled: "取消收尾中" };
function planningJobLabel(job) { return job.kind === "planning.review" ? "审查草案" : job.kind === "planning.retry" ? "重试规划" : job.kind === "planning.draft.revise" ? "修订草案" : "开始规划"; }
function isPlanningJob(job) { return !!job?.progress && job.kind?.startsWith("planning.") && !["planning.run", "planning.approve", "planning.draft.save"].includes(job.kind); }
function acceptPlanningJob(job) {
  if (!isPlanningJob(job)) return;
  const previous = state.planningProgressJob;
  if (previous?.jobId === job.jobId && (previous.status !== "running" && job.status === "running" || Date.parse(previous.updatedAt) > Date.parse(job.updatedAt))) return;
  state.planningProgressJob = job;
  try { sessionStorage.setItem(`tc-planning-job-${job.workspaceId}`, job.jobId); } catch { /* Status remains available through the Plan view. */ }
  const context = state.jobContexts?.get(job.jobId) || (state.jobContext?.jobId === job.jobId ? state.jobContext : null);
  if (context && job.planningId) { context.planningId = job.planningId; renderJobPlanLink(context); }
  renderPlanningProgress();
}
function renderPlanningProgress() {
  let root = $("#planning-progress");
  if (!root) {
    root = document.createElement("section"); root.id = "planning-progress"; root.className = "card planning-progress hidden";
    root.innerHTML = '<div class="section-title"><h3 id="planning-progress-title">本机规划进度</h3><span id="planning-progress-stage" class="badge badge-neutral" role="status" aria-live="polite"></span></div><div id="planning-progress-metrics" class="planning-progress-metrics"></div><p id="planning-progress-detail" class="hint"></p><p id="planning-progress-idle" class="notice notice-warn hidden" role="status"></p><div id="planning-progress-reply" class="hidden"><strong>最新模型回复 · 尚未通过校验</strong><p id="planning-progress-preview"></p></div><details id="planning-progress-raw" class="hidden"><summary>查看回复原文片段</summary><pre></pre></details><div class="button-row"><a id="planning-progress-open" class="button button-quiet">查看规划记录</a><button id="planning-progress-cancel" type="button" class="button button-quiet">取消本次调用</button><button id="planning-progress-retry" type="button" class="button button-primary hidden">在原规划重试</button></div>';
    $("#operation-status-stack").after(root);
    $("#planning-progress-cancel").onclick = async () => {
      const job = state.planningProgressJob; if (!job || job.status !== "running") return;
      $("#planning-progress-cancel").disabled = true;
      try { await api(`/api/v1/jobs/${job.jobId}/cancel`, { method: "POST", body: JSON.stringify({ workspaceId: job.workspaceId }) }); $("#planning-progress-detail").textContent = "已请求取消，等待本次 Agent 收尾。"; state.planningCancelRequested = job.jobId; }
      catch (error) { $("#planning-progress-cancel").disabled = false; showToast(error.message, true); }
    };
    $("#planning-progress-retry").onclick = async () => {
      const job = state.planningProgressJob;
      if (!job?.planningId || job.workspaceId !== state.workspace?.workspaceId || state.activeJob?.status === "running") return;
      await startJob("重试规划", requestKey => api(`/api/v1/workspaces/${job.workspaceId}/plannings/${job.planningId}/planner-retry`, { method: "POST", body: JSON.stringify({ requestKey }) }));
    };
  }
  const job = state.planningProgressJob, p = job?.progress;
  const visible = !!job && job.workspaceId === state.workspace?.workspaceId && ["new", "plan", "workspaces"].includes(state.route?.page) && (state.route.page !== "plan" || state.route.planningId === job.planningId);
  show(root, visible); if (!visible) return;
  const running = job.status === "running";
  const setText = (selector, text) => { const element = $(selector); if (element.textContent !== text) element.textContent = text; };
  const stage = running ? planningStages[p?.stage || "preparing"] || "正在处理" : statuses[job.status] || job.status;
  $("#planning-progress-title").textContent = `${planningJobLabel(job)} · ${state.plannings.find(item => item.planningId === job.planningId)?.title || "本机 Agent"}`;
  setText("#planning-progress-stage", stage);
  $("#planning-progress-stage").className = `badge ${statusClass(running ? "running" : job.status)}`;
  const elapsed = Math.max(0, Math.floor(((running ? Date.now() : Date.parse(job.updatedAt)) - Date.parse(p?.startedAt || job.createdAt)) / 1000));
  const timestamp = value => value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "尚无";
  const metrics = [labels[p?.runnerId] || "本机 Agent", p?.reportedModel ? `${p.reportedModel}（实际报告）` : `${p?.configuredModel || "Runner 默认模型"}（配置值）`, `第 ${p?.requestId || 1} 次调用`, `已用 ${Number.isFinite(elapsed) ? elapsed : 0} 秒`, `最近模型输出：${timestamp(p?.lastOutputAt)}`, `后台状态更新：${timestamp(p?.updatedAt || job.updatedAt)}`];
  $("#planning-progress-metrics").replaceChildren(...metrics.map(text => { const node = document.createElement("span"); node.textContent = text; return node; }));
  $("#planning-progress-detail").textContent = state.planningCancelRequested === job.jobId && running ? "已请求取消，等待本次 Agent 收尾。" : job.error || p?.detail || (running ? `第 ${p?.requestId || 1} 次调用 · 本机 Agent 无固定总时限，仍可取消。` : job.status === "succeeded" ? "本轮处理已完成；澄清或草案以规划记录为准，批准和执行仍需单独操作。" : "执行记录已保留；查看原规划后决定是否重试。");
  const silent = running && Date.now() - Date.parse(p?.lastOutputAt || p?.startedAt || job.createdAt) >= 60_000;
  const disconnected = running && Date.now() - Date.parse(p?.updatedAt || job.updatedAt) >= 35_000;
  show($("#planning-progress-idle"), silent || disconnected);
  $("#planning-progress-idle").textContent = disconnected ? "后台进度暂未更新，尚不能确认调用状态。正在重新查询；不要重复启动规划。" : "已超过 60 秒没有新回复，后台仍持有本次调用；这不代表上游网络或模型健康。可以继续等待，或取消本次调用。";
  const preview = p?.replyPreview || "";
  show($("#planning-progress-reply"), !!preview); setText("#planning-progress-preview", preview);
  $("#planning-progress-reply strong").textContent = job.status === "succeeded" ? "最新模型回复 · 详见规划记录" : "最新模型回复 · 尚未通过校验";
  show($("#planning-progress-raw"), !!p?.rawPreview); setText("#planning-progress-raw pre", p?.rawPreview || "");
  const link = $("#planning-progress-open"); show(link, !!job.planningId); link.href = `#/workspaces/${encodeURIComponent(job.workspaceId)}/plans/${encodeURIComponent(job.planningId || "")}`;
  show($("#planning-progress-cancel"), running); $("#planning-progress-cancel").disabled = state.planningCancelRequested === job.jobId;
  show($("#planning-progress-retry"), !!job.planningId && p?.role !== "review" && ["failed", "cancelled", "interrupted"].includes(job.status));
  $("#planning-progress-retry").disabled = state.activeJob?.status === "running";
}
function consumePlanningProgress(data) {
  const { jobId, kind, progress } = data.payload || {};
  if (!jobId || !progress || data.workspaceId !== state.workspace?.workspaceId || progress.planningId !== data.planningId) return;
  if (state.activeJob && state.activeJob.jobId !== jobId) return;
  if (state.planningProgressJob?.jobId === jobId && Date.parse(state.planningProgressJob.progress?.updatedAt) > Date.parse(progress.updatedAt)) return;
  if (state.planningProgressJob?.jobId === jobId && state.planningProgressJob.status !== "running") return;
  const job = { ...(state.activeJob || state.planningProgressJob?.jobId === jobId && state.planningProgressJob || {}), jobId, kind, workspaceId: data.workspaceId, planningId: data.planningId, progress, status: "running", createdAt: progress.startedAt, updatedAt: progress.updatedAt };
  if (state.activeJob?.jobId === jobId) state.activeJob = job;
  acceptPlanningJob(job);
}
async function restorePlanningProgress(workspaceId, sequence = state.navigationSequence) {
  if (!state.plannerProgressSupported) return;
  const selected = state.route?.page === "plan" ? state.plannings.find(plan => plan.planningId === state.route.planningId)?.localOperation : null;
  let job = selected || state.plannings.map(plan => plan.localOperation).find(item => item?.status === "running" && (state.route?.page !== "plan" || item.planningId === state.route.planningId));
  const remembered = sessionStorage.getItem(`tc-planning-job-${workspaceId}`);
  if (!job && remembered) { try { job = await api(`/api/v1/jobs/${remembered}`); } catch { return; } }
  if (state.workspace?.workspaceId !== workspaceId || state.navigationSequence !== sequence || job?.workspaceId !== workspaceId || !isPlanningJob(job)) return;
  if (state.activeJob && state.activeJob.jobId !== job.jobId) return;
  acceptPlanningJob(job);
  if (job.status === "running" && !state.activeJob) {
    state.activeJob = job; state.jobContexts ??= new Map();
    state.jobContexts.set(job.jobId, { workspaceId, planningId: job.planningId, label: planningJobLabel(job), submittedAt: Date.parse(job.createdAt), jobId: job.jobId });
    void pollJob(job.jobId, planningJobLabel(job));
  }
}

function operationNoticeMatches(context) {
  return context.workspaceId === state.workspace?.workspaceId && (!context.planningId || context.planningId === state.planning?.planningId && state.route?.page === "plan");
}
function operationFailureMessage(label, error) {
  if (String(error).includes("pending_inputs_require_plan")) return { text: `${label} · 暂不能审查：还有补充需求待处理`, tone: "warning", action: "处理补充需求" };
  if (/review_required|review_stale|review_missing|draft_missing|pending_inputs/.test(String(error))) return { text: `${label} · 前置条件待处理`, tone: "warning", action: "查看计划状态" };
  return { text: `${label} · 操作未完成${error ? `：${String(error).replace(/^[a-z][a-z0-9_]*[：:]\s*/, "").slice(0, 160)}` : ""}`, tone: "error", action: "查看计划与处理方法" };
}
function rememberOperationNotice(job, label, context) {
  if (!context) return;
  context.planningId ||= job.planningId || job.result?.planningId;
  const id = `${context.workspaceId}:${context.planningId || ""}:${job.jobId || context.feedbackId}`;
  const failure = job.status !== "succeeded" ? operationFailureMessage(label, job.error) : null;
  const notice = { id, job, context: { ...context }, label, text: failure?.text || $("#job-label").textContent, tone: failure?.tone || "info", action: failure?.action };
  state.operationNotices ??= new Map(); state.operationNotices.set(id, notice);
  while (state.operationNotices.size > 50) state.operationNotices.delete(state.operationNotices.keys().next().value);
  $("#job-bar").dataset.noticeId = id;
  $("#job-bar").dataset.tone = notice.tone;
  if (failure) $("#job-label").textContent = failure.text;
  $("#job-feedback-diagnostic").textContent = job.error || ""; show($("#job-feedback-details"), !!job.error);
  $("#job-feedback-details").open = false;
  $("#job-feedback-next").textContent = notice.action || ""; show($("#job-feedback-next"), !!notice.action && !!context.planningId);
  $("#job-feedback-next").onclick = () => void planTab(String(job.error).includes("pending_inputs_require_plan") ? "overview" : "review");
  renderOperationNotices();
}
function dismissOperationNotice(id) {
  state.dismissedOperationNotices ??= new Set(); state.dismissedOperationNotices.add(id); renderOperationNotices();
}
function renderOperationNotices() {
  const root = $("#operation-feedback-list"), history = $("#operation-feedback-history-list"); if (!root || !history) return;
  root.replaceChildren(); history.replaceChildren();
  const latest = $("#job-bar").dataset.noticeId;
  const rows = [...(state.operationNotices?.values() || [])].filter(row => operationNoticeMatches(row.context));
  const dismissed = state.dismissedOperationNotices ??= new Set();
  const running = $("#job-bar").dataset.state === "running" && !latest;
  const visible = rows.slice().reverse().filter(row => !dismissed.has(row.id));
  const current = visible.find(row => row.id === latest);
  const ordered = current ? [current, ...visible.filter(row => row !== current)] : visible;
  // Clear old banners, not their Jobs or domain state. A running operation
  // consumes one of the two slots; older records remain available on demand.
  for (const row of ordered.slice(running ? 1 : 2)) dismissed.add(row.id);
  for (const row of rows) {
    if (row.id === latest) { show($("#job-bar"), !dismissed.has(row.id)); show($("#job-feedback-close")); }
    const restore = document.createElement("button"); restore.type = "button"; restore.className = "text-button";
    restore.textContent = `${row.text}${dismissed.has(row.id) ? " · 提示已关闭，点击查看" : ""}`;
    restore.onclick = () => { state.dismissedOperationNotices?.delete(row.id); state.operationNotices.delete(row.id); state.operationNotices.set(row.id, row); renderOperationNotices(); };
    history.append(restore);
    if (row.id === latest || dismissed.has(row.id)) continue;
    const card = document.createElement("section"); card.className = `operation-notice notice notice-${row.tone === "error" ? "error" : row.tone === "warning" ? "warn" : "success"}`;
    const title = document.createElement("strong"); title.textContent = row.text;
    const close = document.createElement("button"); close.type = "button"; close.className = "notification-dismiss"; close.textContent = "×"; close.setAttribute("aria-label", "关闭本次操作提示"); close.onclick = () => dismissOperationNotice(row.id);
    const details = document.createElement("details"), summary = document.createElement("summary"), diagnostic = document.createElement("pre"); summary.textContent = "查看操作诊断"; diagnostic.textContent = row.job.error || row.text; details.append(summary, diagnostic);
    card.append(title, close, details); root.append(card);
  }
  if (!rows.some(row => row.id === latest) && $("#job-bar").dataset.state !== "running") show($("#job-bar"), false);
  show($("#operation-feedback-history"), !!rows.length);
}
async function startJob(label, submit, waitForCompletion = false, allowDuringExecution = false) {
  if (!state.workspace) return;
  if (state.submittingJob || state.activeJob?.status === "running" && !allowDuringExecution) { showToast("当前已有操作正在运行，完成后再提交下一步。", true); return; }
  state.submittingJob = true; const context = { feedbackId: key(), workspaceId: state.workspace.workspaceId, workspaceLabel: state.workspace.label, planningId: state.planning?.planningId, planTitle: state.planning?.draft?.plan?.title || state.planning?.title, sessionId: state.planning?.session?.sessionId, submittedAt: Date.now(), label };
  state.jobContext = context; delete $("#job-bar").dataset.noticeId; delete $("#job-bar").dataset.tone; show($("#job-feedback-close"), false); show($("#job-feedback-details"), false); show($("#job-feedback-next"), false); show($("#job-bar")); $("#job-bar").dataset.state = "running"; $("#job-label").textContent = `${label} · 正在提交…`; show($("#job-bar .spinner")); show($("#job-view-result"), false); show($("#cancel-job"), false);
  renderJobPlanLink(context);
  renderOperationNotices();
  try {
    const job = await submit(context.feedbackId); context.jobId = job.jobId; state.activeJob = job; state.jobContexts ??= new Map(); state.jobContexts.set(job.jobId, context); rememberExecutionJob(job, context); acceptPlanningJob(job); state.submittingJob = false; show($("#cancel-job"), job.status === "running"); show($("#job-bar")); $("#job-label").textContent = `${label} · ${job.status === "running" ? "处理中" : statuses[job.status] || job.status}`; renderJobPlanLink(context);
    if (job.status === "running") {
      acknowledgeResumedSession();
      const completion = pollJob(job.jobId, label);
      if (waitForCompletion) return await completion;
    } else await completeJob(job, label);
    return job;
  } catch (error) { state.submittingJob = false; $("#job-bar").dataset.state = "failed"; $("#job-label").textContent = `${label} · 提交未完成：${error.message}`; show($("#job-bar .spinner"), false); show($("#cancel-job"), false); rememberOperationNotice({ status: "failed", error: error.message }, label, context); return undefined; }
}
function rememberExecutionJob(job, context) {
  if (context && (["planning.run", "session.resume", "session.retry"].includes(job.kind) || state.executionNotice?.jobId === job.jobId)) {
    state.executionNotice = { jobId: job.jobId, context, status: job.status, outcome: job.result?.status };
    renderExecutionFloatingStatus();
  }
}
function renderExecutionFloatingStatus() {
  const root = $("#execution-floating-status"), notice = state.executionNotice;
  if (!root || !notice?.context?.planningId) { if (root) show(root, false); return; }
  const context = notice.context, samePlan = state.route?.page === "plan" && state.route.workspaceId === context.workspaceId && state.route.planningId === context.planningId;
  show(root, !samePlan);
  const session = state.workspace?.workspaceId === context.workspaceId && state.planning?.planningId === context.planningId ? state.planning.session : null;
  if (session) notice.outcome = session.status;
  const status = notice.status === "running" ? ["pausing", "paused", "blocked"].includes(notice.outcome) ? notice.outcome : "running" : notice.outcome || notice.status;
  $("#execution-floating-title").textContent = context.planTitle || "执行计划";
  $("#execution-floating-state").textContent = `${context.workspaceLabel || "项目"} · ${status === "running" ? "执行中" : statuses[status] || status}`;
  root.dataset.state = status; root.href = `#/workspaces/${encodeURIComponent(context.workspaceId)}/plans/${encodeURIComponent(context.planningId)}/execution`;
  root.title = "返回该计划的执行进度"; root.onclick = event => { event.preventDefault(); void navigate(root.getAttribute("href").slice(1)); };
  if (state.activeJob?.jobId === notice.jobId && !samePlan) show($("#job-bar"), false);
  else if (state.activeJob?.jobId === notice.jobId && state.resumedJobAcknowledged !== notice.jobId) show($("#job-bar"));
  renderOperationNotices();
}
function renderJobPlanLink(context) {
  const link = $("#job-plan-link"), planningId = context?.planningId, workspaceId = context?.workspaceId;
  if (!link) return;
  if (!planningId || !workspaceId) { show(link, false); return; }
  const title = context.planTitle || "未命名计划";
  link.href = `#${routePath({ page: "plan", workspaceId, planningId, tab: "execution" })}`;
  link.textContent = `${title}${context.workspaceLabel ? ` · ${context.workspaceLabel}` : ""}`;
  link.title = `${title} · ${planningId}`;
  link.onclick = event => { event.preventDefault(); void navigate(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planningId)}/execution`); };
  show(link, true);
}
function acknowledgeResumedSession() {
  const job = state.activeJob, session = state.planning?.session;
  if (job?.status !== "running" || job.kind !== "session.resume") return;
  const context = state.jobContexts?.get(job.jobId);
  if (!context || context.workspaceId !== state.workspace?.workspaceId || context.planningId !== state.planning?.planningId) return;
  if (session?.sessionId === context.sessionId && Date.parse(session?.health?.checkedAt) >= context.submittedAt && session?.status === "running" && session.health?.state === "active" && !session.health.recoveryRequired && session.tasks.some(task => task.status === "running")) {
    // The job continues to be polled; execution status now supplies the feedback.
    state.resumedJobAcknowledged = job.jobId; show($("#job-bar"), false);
  } else if (state.resumedJobAcknowledged === job.jobId) {
    show($("#job-bar")); $("#job-label").textContent = "恢复 Session · 正在核验执行状态";
  }
}
async function pollJob(jobId, label) {
  while (state.activeJob?.jobId === jobId) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    let job; try { job = await api(`/api/v1/jobs/${jobId}`); } catch (error) { $("#job-label").textContent = `连接中断，操作记录仍保留 · ${shortId(jobId)}`; continue; }
    if (state.activeJob?.jobId !== jobId) return;
    state.activeJob = job; rememberExecutionJob(job, state.jobContexts?.get(jobId));
    acceptPlanningJob(job);
    if (job.status !== "running") { await completeJob(job, label); return job; }
  }
}
async function completeJob(job, label) {
  acceptPlanningJob(job);
  const previousNotice = [...(state.operationNotices?.values() || [])].find(row => row.job.jobId === job.jobId);
  const context = state.jobContexts?.get(job.jobId) || previousNotice?.context || state.jobContext; state.jobContexts?.delete(job.jobId);
  rememberExecutionJob(job, context);
  const domainStatus = job.result?.status;
  const awaitingUser = job.status === "succeeded" && domainStatus === "blocked" && Array.isArray(job.result?.waitingForUser) && job.result.waitingForUser.length > 0;
  const executionFailed = job.status === "succeeded" && ["failed", "cancelled", "interrupted", "blocked"].includes(domainStatus) && !awaitingUser;
  $("#job-bar").dataset.state = awaitingUser ? "blocked" : executionFailed ? "failed" : job.status;
  $("#job-label").textContent = `${label} · ${awaitingUser ? `等待用户决策（${job.result.waitingForUser.length} 个任务）` : executionFailed ? `操作已结束，任务${statuses[domainStatus] || domainStatus}` : job.status === "succeeded" ? "已完成" : statuses[job.status] || job.status}${job.error ? `：${job.error}` : ""}`;
  if (job.kind?.startsWith("session.model") && job.result?.effect) $("#job-label").textContent += ` · ${job.result.effect}`;
  show($("#job-bar")); show($("#job-bar .spinner"), false); show($("#cancel-job"), false); show($("#job-view-result"), !!context?.planningId);
  $("#job-view-result").textContent = job.kind === "session.recover" ? "查看恢复状态" : awaitingUser ? "查看阻塞与处理方法" : "查看任务结果";
  $("#job-view-result").onclick = () => void openOperationResult(context, job);
  state.activeJob = null; rememberOperationNotice(job, label, context); renderExecutionFloatingStatus();
  if (job.kind === "planning.run") { state.runRequestKey = null; state.runInFlight = false; }
  if (job.status === "succeeded") {
    showToast(awaitingUser ? "任务已按计划停在决策门禁处；查看最新 Attempt 回复并处理后，再继续相关规划。" : executionFailed ? `${label}已结束，任务${statuses[domainStatus] || domainStatus}；详情与恢复入口见执行页。` : ["external_context", "handoff_claim"].includes(job.result?.nextAction) ? "输入已登记，等待网页通过 MCP 读取并提交结果。" : `${label}已完成。`);
    if (job.kind === "session.delivery" && typeof job.result?.instructions === "string") addLog(job.result.instructions, "delivery");
    const planningId = job.result?.planningId;
    if (planningId && job.workspaceId === state.workspace?.workspaceId && state.route?.page === "new") await loadPlanningListAndSelect(planningId);
    await refreshAll();
    if (job.kind === "planning.approve" && state.planning?.planningId === job.result?.planningId && state.planning?.status === "approved") await planTab("execution");
    if (state.planning) renderReviewContinuation();
  } else { if (job.planningId) await refreshAll(); }
}
async function openOperationResult(context, job) {
  if (!context?.workspaceId || !context?.planningId) { showToast("该操作未关联计划，请从工作区选择规划记录。", true); return; }
  if (isPlanningJob(job)) { await navigate(`/workspaces/${encodeURIComponent(context.workspaceId)}/plans/${encodeURIComponent(context.planningId)}`); return; }
  try {
    await navigate(`/workspaces/${encodeURIComponent(context.workspaceId)}/plans/${encodeURIComponent(context.planningId)}/execution`);
    if (state.workspace?.workspaceId !== context.workspaceId || state.planning?.planningId !== context.planningId || state.route?.tab !== "execution") return;
    await loadPlanning(context.planningId);
    if (state.planning?.planningId !== context.planningId || state.workspace?.workspaceId !== context.workspaceId) return;
    const session = state.planning.session;
    if (session?.tasks.some(task => task.status === "blocked" && task.reasonCode === "user_input_required")) {
      showActionFeedback("任务等待用户决策", sessionContinueAction(session).message);
      const target = $("#session-blocker-actions"); target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center", behavior: "smooth" }); return;
    }
    if (job.kind !== "session.recover" && session?.tasks.some(task => task.attempts?.length)) { await openTaskDetails(); return; }
    showActionFeedback(job.kind === "session.recover" ? "已打开恢复状态" : "已打开任务状态", job.kind === "session.recover" ? `${session?.health?.message || "当前状态已重新读取。"} 本次完成的是中断状态处理；需要时在任务面板选择重试或继续执行。` : session?.health?.message || "当前尚无 Attempt 记录，请在任务面板查看启动或恢复入口。");
    const target = session ? $("#session-health") : $("#task-list"); target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) { showToast(error.message, true, "execution"); }
}
async function loadPlanningListAndSelect(planningId) {
  state.plannings = await api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings`);
  renderPlanningList();
  if (state.plannings.some((item) => item.planningId === planningId)) await selectPlanning(planningId);
}

function workspaceFormIsCurrent(generation) {
  if (!state.creatingWorkspace || generation !== state.folderSelectionGeneration) return false;
  return state.workspaceFormContext?.kind === "authorization" ? state.route?.page === "connect" && !!authorizationFormHost(state.workspaceFormContext.requestId) : state.route?.page === "workspaces" && !state.workspace;
}
function authorizationFormHost(requestId) {
  return [...$("#remote-approvals").querySelectorAll(".remote-approval-card")].find(card => card.dataset.requestId === requestId)?.querySelector(".authorization-workspace-form");
}
function renderWorkspaceFormMode() {
  const authorization = state.workspaceFormContext?.kind === "authorization";
  const target = authorization && state.creatingWorkspace ? authorizationFormHost(state.workspaceFormContext.requestId) : $("#workspace-form-host");
  if (state.creatingWorkspace && authorization && !target) { cancelDirectoryPicker(); state.creatingWorkspace = false; state.folderSelectionGeneration = (state.folderSelectionGeneration || 0) + 1; }
  const host = target || $("#workspace-form-host"); if ($("#workspace-form").parentElement !== host) host.append($("#workspace-form"));
  const creating = !!state.creatingWorkspace; show($("#workspace-form"), creating);
  if (!creating && $("#directory-dialog")?.open) $("#directory-dialog").close();
  for (const id of ["workspace-selection-tools", "workspace-cards"]) show($("#" + id), !creating || authorization);
  show($("#workspace-selection-heading"));
  for (const [id, active] of [["workspace-existing", !creating], ["add-workspace-main", creating]]) { $("#" + id).classList.toggle("active", active); $("#" + id).setAttribute("aria-pressed", String(active)); }
  for (const card of $("#remote-approvals").querySelectorAll(".remote-approval-card")) {
    const active = authorization && creating && card.dataset.requestId === state.workspaceFormContext?.requestId;
    const selector = card.querySelector(".remote-workspace-label"); if (selector) show(selector, !active);
    card.refreshAuthorizationState?.();
    for (const [selector, pressed] of [[".authorization-existing-workspace", !active], [".authorization-new-workspace", active]]) {
      const button = card.querySelector(selector); button?.classList.toggle("active", pressed); button?.setAttribute("aria-pressed", String(pressed));
    }
  }
}
function closeWorkspaceForm() {
  cancelDirectoryPicker();
  state.creatingWorkspace = false; state.folderSelectionGeneration = (state.folderSelectionGeneration || 0) + 1;
  state.workspaceFormContext = null;
  $("#workspace-picker-status").textContent = "";
  $("#workspace-native-choice").open = false;
  for (const id of ["workspace-path", "workspace-label"]) $("#" + id).value = "";
  $("#workspace-selected-path").textContent = "尚未选择文件夹"; $("#workspace-manual-path").open = false;
  show($("#workspace-path-error"), false); $("#workspace-path").removeAttribute("aria-invalid");
  renderWorkspaceFormMode(); show($("#action-feedback"), false);
}
async function openWorkspaceForm(requestId, openNative = false) {
  const authorization = typeof requestId === "string";
  if (authorization) {
    if (state.route?.page !== "connect" || !authorizationFormHost(requestId)) return;
  } else {
    await navigate("/workspaces"); if (state.route?.page !== "workspaces" || state.workspace) return;
  }
  state.workspaceFormContext = authorization ? { kind: "authorization", requestId } : { kind: "project" };
  state.creatingWorkspace = true; state.folderSelectionGeneration = (state.folderSelectionGeneration || 0) + 1;
  $("#workspace-path").value = ""; $("#workspace-label").value = ""; $("#workspace-selected-path").textContent = "尚未选择文件夹";
  show($("#workspace-path-error"), false); renderWorkspaceFormMode();
  if (openNative) await openDirectoryPicker();
  else await openDirectoryBrowser();
}
$("#workspace-path-browse").addEventListener("click", () => void openWorkspaceForm(undefined, false));
$("#workspace-form-back").addEventListener("click", closeWorkspaceForm);
$("#workspace-existing").addEventListener("click", closeWorkspaceForm);
$("#workspace-back").addEventListener("click", () => void navigate("/workspaces"));
$("#workspace-rename-open").addEventListener("click", () => {
  const workspace = state.workspace; if (!workspace) return;
  state.renameWorkspaceId = workspace.workspaceId; $("#workspace-rename-path").textContent = workspace.path; $("#workspace-rename-label").value = workspace.label; $("#workspace-rename-error").textContent = ""; $("#workspace-rename-dialog").showModal(); $("#workspace-rename-label").focus();
});
$("#workspace-rename-cancel").addEventListener("click", () => $("#workspace-rename-dialog").close());
$("#workspace-rename-save").addEventListener("click", async () => {
  const workspaceId = state.renameWorkspaceId, label = $("#workspace-rename-label").value.trim(), button = $("#workspace-rename-save");
  if (!workspaceId || !label) { $("#workspace-rename-error").textContent = "请输入 1–80 个字符的名称。"; return; }
  button.disabled = true;
  try {
    const updated = await api(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, { method: "PATCH", body: JSON.stringify({ label }) });
    state.workspaces = state.workspaces.map(item => item.workspaceId === workspaceId ? updated : item);
    if (state.workspace?.workspaceId === workspaceId) state.workspace = updated;
    renderWorkspaces(); renderPlanningList(); renderWorkspaceAccess(); renderConnectionSummary(); renderConnectionClients(); renderRemoteGrants(state.grants || []);
    $("#workspace-detail-title").textContent = `${updated.label} · 计划`; $("#workspace-rename-dialog").close(); showToast(`工作区名称已更新为“${updated.label}”。`);
  } catch (error) { $("#workspace-rename-error").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#add-workspace-toggle").addEventListener("click", () => void openWorkspaceForm());
$("#add-workspace-main").addEventListener("click", () => void openWorkspaceForm());
$("#browse-workspace-path").addEventListener("click", () => void openDirectoryBrowser());
$("#use-current-directory").addEventListener("click", () => { if (state.environment?.currentDirectory) $("#workspace-path").value = state.environment.currentDirectory; show($("#workspace-path-error"), false); });
$("#workspace-path").addEventListener("input", () => { clearInputFeedback(); $("#workspace-path").removeAttribute("aria-invalid"); show($("#workspace-path-error"), false); });
$("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (state.registeringWorkspace) return;
  clearInputFeedback(); show($("#workspace-path-error"), false);
  const context = state.workspaceFormContext, generation = state.folderSelectionGeneration, submit = $("#workspace-form button[type=submit]");
  state.registeringWorkspace = true; submit.disabled = true;
  try {
    if (!$("#workspace-path").value.trim()) throw new Error("请选择项目文件夹，或展开手动填写路径。");
    const workspace = await api("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ path: $("#workspace-path").value.trim(), label: $("#workspace-label").value.trim() }) });
    state.workspaces = [...state.workspaces.filter(item => item.workspaceId !== workspace.workspaceId), workspace]; renderWorkspaces();
    if (!workspaceFormIsCurrent(generation)) { showToast("工作区已登记，可从工作区列表选择；当前页面保持不变。"); return; }
    closeWorkspaceForm();
    if (context?.kind === "authorization") {
      await refreshRemoteApprovals();
      const card = [...$("#remote-approvals").querySelectorAll(".remote-approval-card")].find(card => card.dataset.requestId === context.requestId);
      const select = card?.querySelector(".remote-workspace-select");
      if (select) { select.value = workspace.workspaceId; card.dispatchEvent(new Event("change", { bubbles: true })); showToast("工作区已登记并选中，请核对网页来源与权限后授权。"); }
      else showActionFeedback("工作区已登记", "原网页授权请求已结束，请从网页重新发起授权并选择此工作区。");
    } else { await selectWorkspace(workspace.workspaceId); showToast(`项目已添加：${workspace.path}`); }
  } catch (error) {
    if (generation !== state.folderSelectionGeneration) { showToast(error.message, true); return; }
    $("#workspace-path-error").textContent = error.message; show($("#workspace-path-error")); $("#workspace-path").setAttribute("aria-invalid", "true");
  } finally { state.registeringWorkspace = false; submit.disabled = false; }
});
$("#copy-web-planning").addEventListener("click", async () => {
  if (!state.workspace || !await confirmPlanChanges()) return;
  const executionDefaults = { runnerId: $("#runner-id").value, mode: "managed", ...($("#runner-model").value.trim() ? { modelId: $("#runner-model").value.trim() } : {}) };
  if (!executionDefaults.runnerId) { showToast("请先选择执行 Runner。", true); return; }
  let header; try { header = webpageSelectionHeader(state.workspace?.workspaceId); } catch (error) { showToast(error.message, true); return; }
  const prompt = [
    header, "使用 Token Coupon MCP，为已授权项目开始一次新的规划。",
    "本轮仅负责规划／审查。用户需求中的实现、测试和交付应写入待批准计划，由本机 Runner 后续执行；不要在网页沙箱编写源码、安装依赖、执行测试或生成交付 ZIP。",
    `项目名称：${JSON.stringify(state.workspace.label)}`,
    `项目标识（先用 workspace_query 核实授权）：${JSON.stringify(state.workspace.workspaceId)}`,
    `执行默认配置（传给 planning_prepare.executionDefaults）：${JSON.stringify(executionDefaults)}`,
    "第一个动作实际调用此连接的 workspace_query 核实项目。工具不可用、授权失败或连接中断时说明阻断原因，不改用网页沙箱完成任务。",
    "使用查询返回的 workspaceId、本条消息的需求／参考文件和 executionDefaults 创建 planning_prepare，再 handoff_claim 领取，读取返回的规划协议。",
    "按需使用 repository_query 的 repo_list、repo_read 或 repo_search 调研项目；读取计划文件后先校验技术选型、依赖和测试安排。",
    "信息不足时按返回协议提交澄清，再在网页向我提问；信息足够后按协议生成草案并 external_submit。沿用项目约定或用户明确授权的默认方案，缺少影响实现的关键决策时先澄清，不自行扩大需求范围。",
    "根据真实工具回执确认提交结果；成功后报告 planningId 和草案／审查状态，失败时按 diagnostic 修正。文字回复或下载附件不能代替提交，也不能作为本机测试通过的证据。",
    "草案生成或修订后接着审查一次；需要用户取舍的问题集中提问，避免无限修订。审查报告也须通过 MCP 提交。",
    "批准、执行和 Runner 工具审批由我在 本地控制台 操作。",
    "我的需求／项目内参考文件：",
    ...(state.referenceFile ? [`先通过 repository_query 读取项目内文件：${JSON.stringify(state.referenceFiles?.length ? state.referenceFiles : [state.referenceFile])}，再规划；本机预览不能代替本轮读取证据。`] : []),
  ].join("\n");
  try { await copyText(prompt); showToast("网页规划提示已复制。到对应网页粘贴，再补充需求或相对文件路径；尚未创建规划。"); }
  catch { showCopyFallback("复制网页规划提示", prompt); }
});
$("#start-planning").addEventListener("click", async () => {
  const request = $("#request-text").value.trim(); if (!request) { showToast("先写下需求。", true); return; }
  if (!await confirmPlanChanges()) return;
  const provider = $("#planner-provider").value;
  const model = $("#planner-model").value.trim();
  const payload = { request, provider, ...(model ? { model } : {}), executionDefaults: { runnerId: $("#runner-id").value, mode: "managed", ...( $("#runner-model").value.trim() ? { modelId: $("#runner-model").value.trim() } : {}) } };
  const job = await startJob("开始规划", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings`, { method: "POST", body: JSON.stringify({ ...payload, requestKey }) }));
  if (job && ["running", "succeeded"].includes(job.status)) {
    $("#request-text").value = "";
    globalThis.tokenCouponPlannerRequestComposer?.setValue("");
  }
});
if (!globalThis.tokenCouponPlannerRequestComposer) bindTextareaEnterSubmit($("#request-text"), () => $("#start-planning").click());
$("#new-task").addEventListener("click", startNewTask);
$("#new-task-sidebar").addEventListener("click", startNewTask);
const refreshModelCatalogs = () => { void loadRunnerModels(true); void loadPlannerModels(true); };
document.addEventListener("token-coupon:refresh-models", refreshModelCatalogs);
if (!globalThis.tokenCouponModelCatalogStatus) $("#refresh-models").addEventListener("click", refreshModelCatalogs);
$("#reply-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (state.replying) return;
  const message = $("#reply-text").value.trim();
  if (!message) { showToast("请先填写回复。", true); return; }
  if (!state.planning) { showToast("请先选择一个规划。", true); return; }
  if (functionPolicy("planning") && !state.operationRoutingSupported) { showToast("请重启后台并刷新页面，以按设置继续规划。", true); return; }
  if (!await confirmPlanChanges()) return;
  const path = `/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/replies`;
  state.replying = true; $("#reply-text").disabled = true; globalThis.tokenCouponReplyComposer?.setDisabled(true); renderRequirements();
  try {
    const planner = policySelection("planning");
    const job = await startJob("提交回复", (requestKey) => api(path, { method: "POST", body: JSON.stringify({ requestKey, message, ...(planner ? { planner } : {}) }) }), true);
    if (job?.status === "succeeded") { $("#reply-text").value = ""; globalThis.tokenCouponReplyComposer?.setValue(""); }
  } finally { state.replying = false; $("#reply-text").disabled = false; globalThis.tokenCouponReplyComposer?.setDisabled(false); if (state.planning) renderRequirements(); }
});
if (!globalThis.tokenCouponReplyComposer) bindTextareaEnterSubmit($("#reply-text"), () => $("#reply-form").requestSubmit());
$("#review-button").addEventListener("click", async () => {
  if (!state.planning || !await confirmPlanChanges()) return;
  const mode = $("#reviewer-mode")?.value || "planning";
  const current = state.planning, workspaceId = state.workspace.workspaceId;
  const local = !selectedOperationIsWeb("review");
  if (local) {
    const pending = (current.externalOperations || []).filter(operation => operation.role === "review" && operation.isCurrent !== false && ["prepared", "submitting"].includes(externalOperationState(operation)));
    if (pending.some(operation => externalOperationState(operation) === "submitting")) { showToast("网页审查正在提交校验，请等待结果后再切换。", true); return; }
    if (pending.length) {
      if (!await askConfirm("改用本机审查", "这会取消当前网页审查等待，并使已领取网页的旧提交失效。当前草案和历史报告保留，随后调用所选 Agent／API 审查。", "确认接管并审查")) return;
      if (state.workspace?.workspaceId !== workspaceId || state.planning?.planningId !== current.planningId || state.planning.draft?.planHash !== current.draft?.planHash) { showToast("计划或草案已变化，请重新确认审查。", true); return; }
      try { for (const operation of pending) await api(`/api/v1/workspaces/${workspaceId}/external/${operation.operationId}/cancel`, { method: "POST", body: "{}" }); }
      catch (error) { showToast(`接管未完成：${error.message}`, true); return; }
      if (state.workspace?.workspaceId !== workspaceId || state.planning?.planningId !== current.planningId || state.planning.draft?.planHash !== current.draft?.planHash) { showToast("旧网页审查已取消，当前页面或草案已变化；请在目标计划重新发起审查。", true); return; }
    }
  }
  if (mode === "planning" && isWebMcp(current.config.provider) && current.workflow?.role === "review") { await copyResumePrompt(); return; }
  const model = $("#reviewer-model")?.value.trim() || "";
  const reviewer = mode === "planning" ? undefined : { mode, ...(model ? { model } : {}) };
  await startJob("审查草案", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/review`, { method: "POST", body: JSON.stringify({ requestKey, ...(reviewer ? { reviewer } : {}) }) }));
});
$("#approve-button").addEventListener("click", async () => {
  if (!await confirmPlanChanges()) return;
  if (!state.planning.review?.current) { showToast("批准前请先审查当前草案。", true); return; }
  const waivedFindingIds = $("#waiver-toggle").checked ? (state.planning.review?.findings || []).filter((item) => item.severity === "error").map((item) => item.findingId) : [];
  const waiverReason = $("#waiver-reason").value.trim();
  if (waivedFindingIds.length && !waiverReason) { showToast("显式豁免需要填写理由。", true); return; }
  await startJob("批准草案", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/approve`, { method: "POST", body: JSON.stringify({ requestKey, draftRevision: state.planning.draft.draftRevision, waivedFindingIds, ...(waiverReason ? { waiverReason } : {}) }) }));
});
$("#waiver-toggle").addEventListener("change", (event) => show($("#waiver-reason"), event.target.checked));
$("#run-button").addEventListener("click", async () => {
  if (state.runInFlight || state.activeJob?.status === "running") return;
  if (!await confirmPlanChanges()) return;
  const plan = state.planning?.draft?.plan, config = state.runConfiguration; if (!plan || !config) return;
  const launch = { workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, planHash: state.planning.draft.planHash, draftRevision: state.planning.draft.draftRevision };
  if (config.needsReconfirm || !config.mode || $("#run-configuration-error").textContent) { showToast($("#run-configuration-error").textContent || "请先确认本次启动参数。", true); return; }
  const candidates = verificationCandidates(plan, state.planning.verificationTasks);
  const selection = runExecutionSelection(config, plan);
  const body = { isolation: config.isolation, maxParallel: Number(config.maxParallel), expectedPlanHash: state.planning.draft.planHash, expectedDraftRevision: state.planning.draft.draftRevision, ...(selection ? { executionSelection: selection } : {}), ...(config.isolation === "git-worktree" ? { verificationTaskId: config.verificationTaskId } : {}) };
  if (body.isolation === "shared" && body.maxParallel !== 1) { showToast("共享工作区只支持单任务串行。", true); return; }
  if (body.isolation === "git-worktree" && !candidates.some(item => item.taskId === body.verificationTaskId)) { showToast("所选最终验证任务与当前草案依赖不一致，请重新选择。", true); return; }
  if (body.isolation === "git-worktree" && !await refreshGitReadiness(true)) { showToast(state.gitReadiness?.message || "请先完成 Git 执行准备。", true); return; }
  if (state.workspace?.workspaceId !== launch.workspaceId || state.planning?.planningId !== launch.planningId || state.planning?.draft?.planHash !== launch.planHash || state.planning?.draft?.draftRevision !== launch.draftRevision) { showToast("计划或工作区已变化，请在目标计划中重新确认运行参数。", true); return; }
  state.runInFlight = true; state.runRequestKey ||= key(); renderRunConfiguration();
  const requestKey = state.runRequestKey;
  const job = await startJob("运行计划", () => api("/api/v1/workspaces/" + launch.workspaceId + "/plannings/" + launch.planningId + "/run", { method: "POST", body: JSON.stringify({ requestKey, ...body }) }));
  if (!job) state.runRequestKey = null;
  state.runInFlight = false; renderRunConfiguration();
});
function persistRunConfiguration(modeOverride, deferReactRender = false, fieldOverride) {
  if (!state.runConfiguration || !state.runConfigKey) return;
  state.runConfiguration.edited = true; state.runConfiguration.needsReconfirm = false;
  const selectedMode = modeOverride === "default" || modeOverride === "custom" ? modeOverride : undefined;
  state.runConfiguration.mode = selectedMode ?? document.querySelector('input[name="run-mode-choice"]:checked')?.value ?? state.runConfiguration.mode;
  state.runConfiguration.maxParallel = Number(fieldOverride?.field === "parallel" ? fieldOverride.value : $("#run-parallel").value);
  state.runConfiguration.isolation = fieldOverride?.field === "isolation" ? fieldOverride.value : $("#run-isolation").value;
  state.runConfiguration.verificationTaskId = fieldOverride?.field === "verification" ? fieldOverride.value : $("#run-verification").value;
  if (state.runConfiguration.isolation === "shared") { state.runConfiguration.maxParallel = 1; $("#run-parallel").value = "1"; }
  try { localStorage.setItem(state.runConfigKey, JSON.stringify(state.runConfiguration)); } catch { /* Keep current selection in memory. */ }
  if (deferReactRender) queueMicrotask(renderRunConfiguration);
  else renderRunConfiguration();
}
if (!globalThis.tokenCouponRunModeSelector) for (const input of document.querySelectorAll('input[name="run-mode-choice"]')) input.addEventListener("change", persistRunConfiguration);
if (!globalThis.tokenCouponRunParameters) for (const id of ["run-parallel", "run-isolation", "run-verification"]) $("#" + id).addEventListener("change", persistRunConfiguration);
$("#revise-run-tasks")?.remove();
$("#configure-task-agents").addEventListener("click", openTaskAgentConfig);
$("#task-agent-config-cancel").addEventListener("click", () => $("#task-agent-config-dialog").close());
$("#task-agent-config-save").addEventListener("click", () => void saveTaskAgentConfig());
$("#toggle-plan-edit").addEventListener("click", () => state.editingPlan ? confirmPlanChanges() : openPlanEditor());
$("#save-plan").addEventListener("click", savePlanEditor);
$("#unsaved-plan-save").addEventListener("click", () => decidePlanChanges("save"));
$("#unsaved-plan-discard").addEventListener("click", () => decidePlanChanges("discard"));
$("#unsaved-plan-cancel").addEventListener("click", () => decidePlanChanges("cancel"));
$("#unsaved-plan-dialog").addEventListener("cancel", (event) => { event.preventDefault(); decidePlanChanges("cancel"); });
$("#local-state-keep").addEventListener("click", () => decideLocalInputNavigation("keep"));
$("#local-state-discard").addEventListener("click", () => decideLocalInputNavigation("discard"));
$("#local-state-cancel").addEventListener("click", () => decideLocalInputNavigation("cancel"));
$("#unsaved-local-state-dialog").addEventListener("cancel", event => { event.preventDefault(); decideLocalInputNavigation("cancel"); });
window.addEventListener("beforeunload", (event) => { if (planHasChanges()) { event.preventDefault(); event.returnValue = ""; } });
$("#cancel-job").addEventListener("click", async () => { if (!state.activeJob) return; try { await api(`/api/v1/jobs/${state.activeJob.jobId}/cancel`, { method: "POST", body: JSON.stringify({ workspaceId: state.activeJob.workspaceId }) }); $("#job-label").textContent = "已请求取消，正在等待 Runner 收尾"; } catch (error) { showToast(error.message, true); } });
$("#refresh").addEventListener("click", () => void manualRefresh());
$("#refresh-feedback-close").addEventListener("click", () => show($("#refresh-feedback-wrap"), false)); $("#reconnect").addEventListener("click", () => { void reconnectDesktop(); }); $("#clear-log").addEventListener("click", () => { $("#event-log").replaceChildren(); });
$("#desktop-reconnect").addEventListener("click", () => { void reconnectDesktop(); });
$("#desktop-restore-inputs").addEventListener("click", () => { void restoreDesktopRecovery(); });
$("#desktop-connection-close").addEventListener("click", () => { show($("#desktop-connection-banner"), false); });
$("#toast-close").addEventListener("click", () => { clearTimeout(state.toastTimer); show($("#toast"), false); });
$("#budget-extension-confirm").addEventListener("click", () => void confirmBudgetExtension());
$("#budget-extension-cancel").addEventListener("click", () => { $("#budget-extension-dialog").close(); state.budgetOperationId = null; });
$("#confirm-action-yes").addEventListener("click", () => settleConfirmAction(true));
$("#confirm-action-no").addEventListener("click", () => settleConfirmAction(false));
$("#confirm-action-dialog").addEventListener("cancel", event => { event.preventDefault(); settleConfirmAction(false); });
if (!globalThis.tokenCouponSessionContinue) $("#session-continue").addEventListener("click", openSessionContinue);
$("#session-continue-confirm").addEventListener("click", () => void confirmSessionContinue());
$("#session-continue-cancel").addEventListener("click", () => { $("#session-continue-dialog").close(); state.continueContext = null; });
if (!globalThis.tokenCouponDagFocusSelector) $("#dag-focus").addEventListener("change", () => { if (!state.dagView) return; state.dagView.focusId = $("#dag-focus").value; state.dagView.autoFocus = false; updateTaskDag(true); });
$("#dag-current").addEventListener("click", () => { if (!state.dagView) return; state.dagView.autoFocus = true; state.dagView.depth = 2; updateTaskDag(true); });
$("#dag-expand").addEventListener("click", () => { if (!state.dagView) return; state.dagView.depth++; updateTaskDag(true); fitTaskDag(); });
$("#dag-collapse").addEventListener("click", () => { if (!state.dagView) return; state.dagView.depth = Math.max(1, state.dagView.depth - 1); updateTaskDag(true); fitTaskDag(); });
for (const root of [$("#dag-viewport"), $("#task-dependencies")]) {
  const activate = event => { const target = event.target.closest("[data-dag-detail]"); if (target) { event.preventDefault(); showDagTaskDetails(target.dataset.dagDetail); } };
  root.addEventListener("click", activate); root.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") activate(event); });
}
$("#dag-viewport").addEventListener("wheel", event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setTaskDagZoom((state.dagView?.zoom || 1) * (event.deltaY < 0 ? 1.1 : 0.9)); }, { passive: false });
window.addEventListener("resize", () => { if ($("#dag-dialog").open) centerTaskDag(); });
$("#dag-task-close").addEventListener("click", () => $("#dag-task-dialog").close());
$("#dag-close").addEventListener("click", () => $("#dag-dialog").close());
$("#dag-zoom-in").addEventListener("click", () => setTaskDagZoom((state.dagView?.zoom || 1) + 0.25));
$("#dag-zoom-out").addEventListener("click", () => setTaskDagZoom((state.dagView?.zoom || 1) - 0.25));
$("#dag-fit").addEventListener("click", fitTaskDag);
$("#dag-reset").addEventListener("click", () => setTaskDagZoom(1));
$("#dag-dialog").addEventListener("click", event => { if (event.target === $("#dag-dialog")) $("#dag-dialog").close(); });
$("#dag-dialog").addEventListener("close", () => { state.dagView = null; });
$("#task-results-close").addEventListener("click", () => { $("#task-results-dialog").close(); state.taskResultView = null; });
$("#task-results-dialog").addEventListener("cancel", () => { state.taskResultView = null; });
if (!globalThis.tokenCouponTaskResults) $("#task-results-more").addEventListener("click", () => { const view = state.taskResultView; if (view && view.nextOffset !== null) void loadTaskResultPage(view, view.nextOffset); });
$("#copy-fallback-close").addEventListener("click", () => $("#copy-fallback-dialog").close());
$("#copy-fallback-select").addEventListener("click", () => { $("#copy-fallback-text").focus(); $("#copy-fallback-text").select(); });
$("#copy-fallback-copy").addEventListener("click", async () => { try { await copyText($("#copy-fallback-text").value); $("#copy-fallback-dialog").close(); showToast("文本已复制。"); } catch { $("#copy-fallback-text").focus(); $("#copy-fallback-text").select(); $("#copy-fallback-description").textContent = "浏览器仍未授予剪贴板权限，请按 Ctrl+C 复制选中文本。"; $("#copy-fallback-description").className = "notice notice-warn"; } });
$("#parallel").addEventListener("change", () => { if ($("#parallel").value !== "1") $("#isolation").value = "git-worktree"; });
$("#isolation").addEventListener("change", () => { if ($("#isolation").value === "shared") $("#parallel").value = "1"; show($("#verification-wrap"), $("#isolation").value === "git-worktree"); });
async function changeRemote(action, message, onboarding = false) {
  if (state.remoteMutation) return;
  state.remoteMutation = true;
  const route = state.route || parseRoute(location.hash.slice(1) || "/connect");
  if (onboarding && route.page === "connect" && !state.managingConnection) state.connectionFlow = { kind: "connection", startedAt: Date.now() };
  for (const id of ["remote-quick", "remote-save", "remote-test", "remote-stop", "remote-cancel", "remote-reuse", "reuse-test"]) $(`#${id}`).disabled = true;
  show($("#remote-error"), false);
  try {
    await action(); if (onboarding) state.connectionConfigDirty = false; showToast(message);
  }
  catch (error) { state.connectionFlow = null; $("#remote-error").textContent = error.message; show($("#remote-error")); showToast(error.message, true, "remote-connection"); }
  finally { state.remoteMutation = false; await refreshRemoteConnection(); }
}
function remotePort() {
  const port = Number($("#remote-port").value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("本机网关端口必须是 1024 到 65535 之间的整数");
  return port;
}
function confirmConnectionReplacement(port, mode) {
  const current = state.remoteStatus;
  if (!current?.enabled || !current.publicOrigin) return true;
  const samePort = port === Number(new URL(current.gatewayAddress || "http://127.0.0.1:4178").port);
  if (mode === "quick_tunnel" && current.mode === mode && current.gateway === "running" && samePort) return true;
  return askConfirm("重新配置网页连接", "此操作会重新配置当前连接，地址可能变化，原网页授权可能失效。完成后请核对 MCP 地址，并按提示重新授权。", "继续配置");
}
$("#remote-quick").addEventListener("click", async () => {
  if (state.remoteStatus?.quickTunnel?.available === false) { showToast(state.remoteStatus.quickTunnel.reason || "当前后台暂不支持快捷连接。", true); return; }
  let port;
  try {
    if (!$("#quick-consent").checked) throw new Error("请先确认使用 Cloudflare 和自动下载连接组件。");
    port = remotePort();
  } catch (error) { showToast(error.message, true); return; }
  if (!await confirmConnectionReplacement(port, "quick_tunnel")) return;
  return changeRemote(() => {
    const scopes = ["planning:read", "planning:write"];
    if ($("#quick-repository").checked) scopes.push("repository:read");
    if ($("#quick-session-read").checked) scopes.push("session:read");

    const project = $("#quick-workspace").value ? { workspaceId: $("#quick-workspace").value } : { connectionOnly: true };
    return api("/api/v1/remote-connection/quick", { method: "POST", body: JSON.stringify({ consent: true, ...project, scopes, port }) });
  }, "正在使用快捷连接，现有隧道可用时会继续复用。", true);
});
$("#remote-save").addEventListener("click", async () => {
  let port; try { port = remotePort(); } catch (error) { showToast(error.message, true); return; }
  if (!await confirmConnectionReplacement(port, "fixed_https")) return;
  return changeRemote(() => api("/api/v1/remote-connection", { method: "POST", body: JSON.stringify({ publicOrigin: $("#remote-origin").value.trim(), port }) }), "固定 HTTPS 网关已启动，正在验证公网入口。", true);
});
$("#remote-test").addEventListener("click", () => changeRemote(() => api("/api/v1/remote-connection/test", { method: "POST", body: "{}" }), "正在重新测试原地址，不会重放规划或执行请求。"));
$("#remote-copy").addEventListener("click", async () => {
  const url = state.remoteStatus?.mcpUrl;
  if (!url) return;
  try { await copyText(url); $("#remote-copy-feedback").textContent = "已复制当前已验证地址。粘贴到 ChatGPT／Claude 的 MCP 连接设置，再发起 OAuth。"; $("#reuse-copy-feedback").textContent = "已复制当前 MCP 地址。"; showToast("当前 MCP 地址已复制。"); }
  catch { $("#remote-mcp-url").select(); $("#remote-copy-feedback").textContent = "无法访问剪贴板，地址已选中，请按 Ctrl+C 复制。"; $("#reuse-copy-feedback").textContent = "地址已选中，请按 Ctrl+C 复制。"; showActionFeedback("请手动复制", "地址已选中，请按 Ctrl+C 复制。", "warning"); }
});
$("#remote-stop").addEventListener("click", async () => {
  if (!await askConfirm("停止公网连接", "停止后将撤销现有网页授权。再次建立快捷连接时地址可能变化，需要在网页更新并重新授权。已有计划和执行任务会保留。", "停止连接", true)) return;
  state.connectionFlow = null;
  return changeRemote(() => api("/api/v1/remote-connection/stop", { method: "POST", body: "{}" }), "连接已停止。需要新地址时再点击新建快捷连接，并更新网页配置。");
});
$("#remote-cancel").addEventListener("click", () => $("#remote-stop").click());
$("#remote-refresh").addEventListener("click", () => void refreshRemoteConnection());
async function openReferenceFiles() {
  if (!state.workspace || state.nativePicking) return;
  const workspaceId = state.workspace.workspaceId; state.nativePicking = true;
  showActionFeedback("正在打开 Windows 文件选择", "可多选当前工作区的参考文件，取消不会修改当前规划。");
  try {
    const result = await api("/api/v1/native-picker", { method: "POST", body: JSON.stringify({ kind: "files", workspaceId }) });
    if (workspaceId !== state.workspace?.workspaceId) return;
    if (result.cancelled) { $("#file-search-status").textContent = "系统文件选择已取消；当前已选文件保留。"; showActionFeedback("已取消选择", "未更改规划参考文件。"); return; }
    const previousSelections = new Set(state.fileSelections || []);
    state.fileWorkspace = workspaceId; state.fileChosen = null; state.fileSelections = new Set([...previousSelections, ...result.paths]); state.filePath = "."; state.fileQuery = ""; $("#file-name-search").value = ""; $("#file-search-status").textContent = "系统选择的文件已载入；名称搜索用于工作区内只读浏览。";
    const root = $("#file-list"); root.replaceChildren();
    for (const path of result.paths) { const row = document.createElement("label"), checkbox = document.createElement("input"), button = document.createElement("button"); row.className = "file-choice"; checkbox.type = "checkbox"; checkbox.checked = true; checkbox.setAttribute("aria-label", `选择参考文件 ${path}`); checkbox.addEventListener("change", () => { checkbox.checked ? state.fileSelections.add(path) : state.fileSelections.delete(path); renderFileSelection(); }); button.type = "button"; button.className = "file-entry"; button.textContent = path; button.addEventListener("click", () => previewReferenceFile(path)); row.append(checkbox, button); root.append(row); }
    show($("#file-parent"), false); show($("#file-more"), false); $("#file-current-path").textContent = "系统选择的参考文件"; show($("#file-preview-wrap"), false); renderFileSelection(); if (!$("#file-dialog").open) $("#file-dialog").showModal();
    showActionFeedback("已选择参考文件", `共 ${result.paths.length} 个，可预览后用于新 Plan。`);
  } catch (error) { showActionFeedback("文件选择未完成", error.message, "validation"); }
  finally { state.nativePicking = false; }
}
async function openReferenceDialog() {
  if (!state.workspace) return;
  state.fileWorkspace = state.workspace.workspaceId; state.fileChosen = null; state.fileSelections = new Set(); state.fileQuery = ""; state.filePath = ".";
  $("#file-name-search").value = ""; $("#file-list").replaceChildren(); $("#file-search-status").textContent = "可搜索当前目录，也可按文件夹逐层浏览。"; $("#file-current-path").textContent = ".";
  show($("#file-parent"), true); show($("#file-more"), false); show($("#file-preview-wrap"), false); show($("#file-error"), false); renderFileSelection();
  $("#file-dialog").showModal();
}
async function browseWorkspaceFiles() {
  if (!state.workspace) return;
  state.fileWorkspace = state.workspace.workspaceId; state.fileChosen = null; state.fileSelections ??= new Set(); state.fileQuery = "";
  $("#file-name-search").value = ""; $("#file-current-path").textContent = "."; show($("#file-parent"), true); show($("#file-preview-wrap"), false); show($("#file-error"), false);
  if (!$("#file-dialog").open) $("#file-dialog").showModal();
  await listReferenceFiles(".", 0, ""); renderFileSelection();
}
function directoryRecentKey() {
  const profile = tokenCouponClient.connection?.().handshake?.profileId || location.host;
  return `tc-directory:${profile}:${state.environment?.platform || "unknown"}:${!!state.environment?.isWsl}`;
}
function directoryFolderIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("directory-folder-icon");
  path.setAttribute("d", "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"); svg.append(path); return svg;
}
function renderDirectoryLocations(shortcuts = []) {
  const root = $("#directory-shortcuts"); root.replaceChildren();
  const locations = [...(state.environment?.home ? [{ label: "主目录", path: state.environment.home }] : []), ...shortcuts,
    ...(state.workspaces || []).slice(0, 6).map(item => ({ label: item.label, path: item.path }))];
  let recent = ""; try { recent = localStorage.getItem(directoryRecentKey()) || ""; } catch { /* Optional preference. */ }
  if (recent) locations.push({ label: "最近选择", path: recent });
  const seen = new Set();
  for (const item of locations) {
    if (seen.has(item.path)) continue; seen.add(item.path);
    const button = document.createElement("button"); button.type = "button"; button.className = "text-button"; button.textContent = item.label; button.title = item.path;
    button.onclick = () => { $("#directory-query").value = ""; void loadDirectoryBrowser(item.path, 0, ""); }; root.append(button);
  }
}
function renderDirectorySelection() {
  const data = state.directoryBrowser, dirty = $("#directory-path").value.trim() !== data?.path;
  const usable = !!data?.validated && !data.loading && !data.systemPicking && !dirty;
  $("#directory-selection").textContent = usable ? `选择：${data.selectedPath}` : dirty ? "路径已修改，请先定位后再选择。" : "请先打开一个有效文件夹。";
  $("#directory-selection").title = usable ? data.selectedPath : "";
  $("#directory-use").disabled = !usable;
  $("#directory-open-system").disabled = !window.tokenCouponDesktop?.chooseWorkspaceFolder || !!data?.loading || !!data?.systemPicking || !!state.nativePicking;
  $("#directory-open-system").title = window.tokenCouponDesktop?.chooseWorkspaceFolder ? "打开系统文件夹选择窗口，可确认选择或取消返回" : "此入口需使用桌面应用；远程浏览器请在本弹窗选择文件夹";
}
async function openDirectoryBrowser() {
  if (!state.creatingWorkspace) return;
  let dialog = $("#directory-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog"); dialog.id = "directory-dialog"; dialog.className = "workspace-directory-picker";
    dialog.setAttribute("aria-labelledby", "directory-title"); dialog.setAttribute("aria-describedby", "directory-description");
    dialog.innerHTML = `<header class="directory-header"><div><h3 id="directory-title">选择工作区文件夹</h3><span id="directory-environment"></span></div><button id="directory-close" type="button" class="directory-icon-button" aria-label="关闭文件夹选择">×</button></header><p id="directory-description" class="sr-only">读取后台电脑的目录，远程电脑也可使用。单击文件夹进入，确认后回填路径；不自动登记或授权。搜索仅查当前目录。</p><div class="directory-path-bar"><label class="sr-only" for="directory-path">文件夹路径</label><input id="directory-path" autocomplete="off" placeholder="输入路径，例如 D:\\项目 或 /home/…"><button id="directory-go" type="button" class="button button-quiet">定位</button></div><nav class="directory-location-bar" aria-label="文件夹导航"><div class="directory-navigation"><button id="directory-back" type="button" class="directory-icon-button" aria-label="后退" title="后退">←</button><button id="directory-forward" type="button" class="directory-icon-button" aria-label="前进" title="前进">→</button><button id="directory-parent" type="button" class="directory-icon-button" aria-label="上一级" title="上一级">↑</button></div><div id="directory-breadcrumbs" aria-label="目录位置"></div><label class="sr-only" for="directory-query">搜索当前目录名称</label><input id="directory-query" type="search" autocomplete="off" placeholder="搜索当前目录"></nav><details id="directory-locations" class="directory-locations"><summary>常用位置与已有工作区</summary><nav id="directory-shortcuts" aria-label="常用位置与工作区"></nav></details><div class="directory-list-heading"><span>文件夹</span><span id="directory-status" role="status"></span></div><div id="directory-error-box" class="directory-error-box hidden"><span id="directory-error" role="status"></span><button id="directory-retry" type="button" class="button button-quiet">重试</button></div><div class="directory-content"><div id="directory-list" class="directory-folder-list" aria-label="当前目录的文件夹"></div><button id="directory-more" type="button" class="button button-quiet hidden">加载更多</button></div><footer class="directory-footer"><span id="directory-selection" role="status"></span><div><button id="directory-open-system" type="button" class="button button-quiet">在文件资源管理器中打开</button><button id="directory-cancel" type="button" class="button button-quiet">取消</button><button id="directory-use" type="button" class="button button-primary">选择此文件夹</button></div></footer>`;
    document.body.append(dialog);
    const close = () => { state.directoryRequest = (state.directoryRequest || 0) + 1; clearTimeout(state.directorySearchTimer); dialog.close(); };
    $("#directory-close").onclick = close; $("#directory-cancel").onclick = close;
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => { if (!dialog.open) { state.directoryRequest = (state.directoryRequest || 0) + 1; clearTimeout(state.directorySearchTimer); } });
    const go = () => { $("#directory-query").value = ""; void loadDirectoryBrowser($("#directory-path").value.trim(), 0, ""); };
    $("#directory-go").onclick = go;
    $("#directory-path").onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); go(); } };
    $("#directory-path").oninput = () => { state.directoryPathEdit = (state.directoryPathEdit || 0) + 1; renderDirectorySelection(); };
    $("#directory-query").oninput = () => {
      clearTimeout(state.directorySearchTimer); const view = state.directoryBrowser;
      state.directorySearchTimer = setTimeout(() => { if (view === state.directoryBrowser && dialog.open) void loadDirectoryBrowser(view.path, 0, $("#directory-query").value); }, 250);
    };
    $("#directory-parent").onclick = () => { $("#directory-query").value = ""; void loadDirectoryBrowser(state.directoryBrowser.parent, 0, ""); };
    for (const [id, delta] of [["directory-back", -1], ["directory-forward", 1]]) $("#" + id).onclick = () => {
      const data = state.directoryBrowser, index = data.historyIndex + delta;
      if (data.history[index]) { $("#directory-query").value = ""; void loadDirectoryBrowser(data.history[index], 0, "", index); }
    };
    $("#directory-more").onclick = () => void loadDirectoryBrowser(state.directoryBrowser.path, state.directoryBrowser.nextOffset, state.directoryBrowser.query);
    $("#directory-retry").onclick = () => void loadDirectoryBrowser(state.directoryBrowser.requestedPath, 0, $("#directory-query").value);
    const applyDirectory = (path, view) => {
      if (view !== state.directoryBrowser || !dialog.open || !workspaceFormIsCurrent(view.formGeneration)) return;
      $("#workspace-path").value = path; $("#workspace-selected-path").textContent = path; show($("#workspace-path-error"), false);
      try { localStorage.setItem(directoryRecentKey(), path); } catch { /* Selection works without persistence. */ }
      $("#workspace-path").dispatchEvent(new Event("input", { bubbles: true })); close();
    };
    $("#directory-open-system").onclick = async () => {
      if ($("#directory-open-system").disabled) return;
      const view = state.directoryBrowser, button = $("#directory-open-system");
      view.systemPicking = true; state.nativePicking = true; button.textContent = "正在选择文件夹…"; button.setAttribute("aria-busy", "true");
      $("#directory-status").textContent = "请在系统窗口选择文件夹，或取消返回"; renderDirectorySelection();
      try {
        const initialPath = view.validated && $("#directory-path").value.trim() === view.path ? view.selectedPath : undefined;
        const result = await window.tokenCouponDesktop.chooseWorkspaceFolder(initialPath);
        if (view !== state.directoryBrowser || !dialog.open || !workspaceFormIsCurrent(view.formGeneration)) return;
        if (result.canceled) { $("#directory-status").textContent = "已取消系统选择，原路径保留"; return; }
        if (typeof result.path !== "string" || !result.path) throw new Error("系统选择器未返回文件夹路径，请重试。");
        applyDirectory(result.path, view);
      } catch (error) {
        if (view === state.directoryBrowser && dialog.open) { $("#directory-error").textContent = `系统选择未完成：${error.message}`; show($("#directory-error-box")); }
      } finally {
        state.nativePicking = false; view.systemPicking = false; button.textContent = "在文件资源管理器中打开"; button.removeAttribute("aria-busy");
        if (dialog.open) renderDirectorySelection();
      }
    };
    $("#directory-use").onclick = () => {
      const value = state.directoryBrowser;
      if (!value?.validated || value.loading || value.systemPicking || $("#directory-path").value.trim() !== value.path) return;
      applyDirectory(value.selectedPath, value);
    };
  }
  state.directoryBrowser = { formGeneration: state.folderSelectionGeneration, history: [], historyIndex: -1, validated: false };
  $("#directory-query").value = ""; $("#directory-error").textContent = ""; $("#directory-list").replaceChildren(); $("#directory-locations").open = false;
  $("#directory-back").disabled = true; $("#directory-forward").disabled = true; $("#directory-parent").disabled = true;
  let recent = ""; try { recent = localStorage.getItem(directoryRecentKey()) || ""; } catch { /* Optional preference. */ }
  const initialPath = $("#workspace-path").value.trim() || recent || state.environment?.home || "";
  $("#directory-path").value = initialPath; renderDirectoryLocations();
  dialog.showModal(); await loadDirectoryBrowser(initialPath, 0, "");
}
async function loadDirectoryBrowser(path, offset = 0, query = "", historyIndex) {
  clearTimeout(state.directorySearchTimer);
  const request = state.directoryRequest = (state.directoryRequest || 0) + 1, view = state.directoryBrowser, edit = state.directoryPathEdit || 0;
  view.loading = true; view.validated = false; view.requestedPath = path;
  $("#directory-status").textContent = "正在读取…"; $("#directory-error").textContent = ""; show($("#directory-error-box"), false);
  const root = $("#directory-list"); root.setAttribute("aria-busy", "true");
  if (!offset) { root.replaceChildren(); for (let i = 0; i < 3; i++) { const skeleton = document.createElement("div"); skeleton.className = "directory-skeleton"; skeleton.setAttribute("aria-hidden", "true"); root.append(skeleton); } }
  renderDirectorySelection();
  try {
    const data = await api(`/api/v1/directories?path=${encodeURIComponent(path || "")}&offset=${offset}&query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(12000) });
    if (request !== state.directoryRequest || !$("#directory-dialog").open || !workspaceFormIsCurrent(view.formGeneration)) return;
    if (!offset) {
      if (historyIndex !== undefined) view.historyIndex = historyIndex;
      else if (view.history[view.historyIndex] !== data.path) { view.history = view.history.slice(0, view.historyIndex + 1); view.history.push(data.path); view.historyIndex = view.history.length - 1; }
    }
    Object.assign(view, { path: data.path, selectedPath: data.path, parent: data.parent, query, nextOffset: data.nextOffset, loading: false, validated: true });
    if (edit === (state.directoryPathEdit || 0)) $("#directory-path").value = data.path;
    $("#directory-environment").textContent = data.environment?.label || "后台电脑 · 可远程浏览";
    $("#directory-status").textContent = `${data.path} · ${data.totalMatches ?? data.entries.length} 个文件夹`;
    $("#directory-status").title = $("#directory-status").textContent;
    const navigateDirectory = target => { $("#directory-query").value = ""; void loadDirectoryBrowser(target, 0, ""); };
    const crumbs = $("#directory-breadcrumbs"); crumbs.replaceChildren();
    for (const item of data.breadcrumbs || [{ label: data.path, path: data.path }]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "text-button"; button.textContent = item.label; button.title = item.path; button.onclick = () => navigateDirectory(item.path); crumbs.append(button);
    }
    renderDirectoryLocations(data.shortcuts || []);
    if (!offset) root.replaceChildren();
    for (const entry of data.entries) {
      const button = document.createElement("button"); button.type = "button"; button.className = "directory-folder-row"; button.dataset.directoryPath = entry.path;
      const name = document.createElement("span"); name.className = "directory-folder-name"; name.textContent = entry.name; button.title = entry.path;
      const chevron = document.createElement("span"); chevron.className = "directory-chevron"; chevron.setAttribute("aria-hidden", "true"); chevron.textContent = "›";
      button.append(directoryFolderIcon(), name);
      const registered = state.workspaces?.find(workspace => workspace.path === entry.path);
      if (registered) { const badge = document.createElement("small"); badge.className = "directory-registered"; badge.textContent = "已有工作区"; button.append(badge); }
      button.append(chevron); button.onclick = () => navigateDirectory(entry.path); root.append(button);
    }
    if (!root.children.length) { const empty = document.createElement("p"); empty.className = "directory-empty"; empty.textContent = query ? "没有匹配的文件夹，可清空搜索或选择当前文件夹。" : "此文件夹没有子目录，可以直接选择。"; root.append(empty); }
    root.setAttribute("aria-busy", "false");
    $("#directory-back").disabled = view.historyIndex <= 0; $("#directory-forward").disabled = view.historyIndex >= view.history.length - 1;
    $("#directory-parent").disabled = !data.parent; show($("#directory-more"), data.nextOffset !== null && data.nextOffset !== undefined);
    renderDirectorySelection();
  } catch (error) {
    if (request !== state.directoryRequest || !$("#directory-dialog").open) return;
    view.loading = false; view.validated = false; root.setAttribute("aria-busy", "false"); if (!offset) root.replaceChildren();
    $("#directory-error").textContent = `无法打开文件夹：${error.message}。检查路径后重试，或选择常用位置。`; show($("#directory-error-box")); $("#directory-locations").open = true;
    $("#directory-status").textContent = "目录读取失败"; renderDirectorySelection();
  }
}
function closeNavigation() { document.body.classList.remove("navigation-open"); $("#mobile-navigation").setAttribute("aria-expanded", "false"); }
$("#mobile-navigation").addEventListener("click", () => { const opened = document.body.classList.toggle("navigation-open"); $("#mobile-navigation").setAttribute("aria-expanded", String(opened)); });
$("#sidebar-close").addEventListener("click", closeNavigation);
$("#nav-backdrop").addEventListener("click", closeNavigation);
window.addEventListener("keydown", event => { if (event.key === "Escape") closeNavigation(); });
async function listReferenceFiles(path, offset = 0, query = state.fileQuery || "", historyIndex) {
  const workspaceId = state.fileWorkspace, request = state.fileRequest = (state.fileRequest || 0) + 1;
  try {
    show($("#file-error"), false);
    const data = await api(`/api/v1/workspaces/${workspaceId}/repository?tool=repo_list&path=${encodeURIComponent(path)}&offset=${offset}&query=${encodeURIComponent(query)}`);
    if (request !== state.fileRequest || workspaceId !== state.fileWorkspace) return;
    if (state.fileHistoryWorkspace !== workspaceId) { state.fileHistoryWorkspace = workspaceId; state.fileHistory = []; state.fileHistoryIndex = -1; }
    if (!offset) {
      if (historyIndex !== undefined) state.fileHistoryIndex = historyIndex;
      else if (state.fileHistory[state.fileHistoryIndex] !== data.path) { state.fileHistory = state.fileHistory.slice(0, state.fileHistoryIndex + 1); state.fileHistory.push(data.path); state.fileHistoryIndex = state.fileHistory.length - 1; }
    }
    state.filePath = data.path; state.fileNextOffset = data.nextOffset; state.fileQuery = query;
    const breadcrumbs = $("#file-breadcrumbs"); breadcrumbs.replaceChildren();
    let childPath = ".";
    for (const part of [".", ...(data.path || ".").split("/").filter(part => part && part !== ".")]) {
      if (part !== ".") childPath = childPath === "." ? part : `${childPath}/${part}`;
      const target = childPath, button = document.createElement("button"); button.className = "text-button"; button.type = "button"; button.textContent = part === "." ? "项目" : part; button.onclick = () => void listReferenceFiles(target, 0, ""); breadcrumbs.append(button);
    }
    $("#file-back").disabled = state.fileHistoryIndex <= 0; $("#file-forward").disabled = state.fileHistoryIndex >= state.fileHistory.length - 1;
    const root = $("#file-list"); if (!offset) root.replaceChildren();
    $("#file-current-path").textContent = data.path;
    if (document.activeElement !== $("#file-directory-path")) $("#file-directory-path").value = data.path;
    $("#file-search-status").textContent = query ? `${data.totalMatches} 个名称匹配 · 当前目录 ${data.path}` : `当前目录共 ${data.totalMatches} 项 · 可分页浏览`;
    $("#file-parent").disabled = data.path === "." || !data.path;
    for (const entry of data.entries) {
      if (!["directory", "file"].includes(entry.type)) continue;
      const button = document.createElement("button"); button.className = "file-entry";
      button.textContent = `${entry.type === "directory" ? "▸" : "▤"} ${entry.name}`;
      const child = !data.path || data.path === "." ? entry.name : `${data.path}/${entry.name}`;
      button.addEventListener("click", () => entry.type === "directory" ? listReferenceFiles(child) : previewReferenceFile(child));
      if (entry.type === "file") {
        const row = document.createElement("div"), checkbox = document.createElement("input"); row.className = "file-choice"; checkbox.type = "checkbox"; checkbox.setAttribute("aria-label", `选择参考文件 ${child}`); checkbox.checked = state.fileSelections.has(child);
        checkbox.addEventListener("change", () => { checkbox.checked ? state.fileSelections.add(child) : state.fileSelections.delete(child); renderFileSelection(); }); row.append(checkbox, button); root.append(row);
      } else root.append(button);
    }
    if (!root.children.length) root.innerHTML = query ? '<div class="empty-state">当前目录没有匹配名称的文件或文件夹。</div>' : '<div class="empty-state">目录中没有可浏览文件。</div>';
    show($("#file-more"), data.nextOffset !== null);
  } catch (error) { if (request === state.fileRequest) { $("#file-error").textContent = error.message; show($("#file-error")); } }
}
async function previewReferenceFile(path, startLine = 1) {
  const workspaceId = state.fileWorkspace, request = state.filePreviewRequest = (state.filePreviewRequest || 0) + 1;
  state.fileChosen = null; renderFileSelection();
  try {
    show($("#file-error"), false);
    const data = await api(`/api/v1/workspaces/${workspaceId}/repository?tool=repo_read&path=${encodeURIComponent(path)}&startLine=${startLine}`);
    if (request !== state.filePreviewRequest || workspaceId !== state.fileWorkspace) return;
    state.fileChosen = data.path; state.fileStartLine = startLine;
    $("#file-preview-title").textContent = `${data.path} · 从第 ${startLine} 行开始`;
    $("#file-preview").textContent = data.content + (data.truncated ? "\n[预览已截断]" : "");
    show($("#file-preview-wrap")); $("#file-preview-wrap").open = true;
    show($("#file-next-lines"), data.content.split("\n").length >= 200 || data.truncated); renderFileSelection();
  } catch (error) { if (request === state.filePreviewRequest) { show($("#file-preview-wrap"), false); $("#file-error").textContent = error.message; show($("#file-error")); } }
}
for (const button of document.querySelectorAll("[data-route]")) button.addEventListener("click", () => void navigate(button.dataset.route));
if (!globalThis.tokenCouponPlanTabs) for (const button of document.querySelectorAll("[data-plan-tab]")) button.addEventListener("click", () => void planTab(button.dataset.planTab));
window.addEventListener("hashchange", () => { if (state.initialized) void applyRoute(location.hash.slice(1) || "/connect", true); });
$("#connection-next").addEventListener("click", () => void navigate("/workspaces"));
$("#connection-local").addEventListener("click", () => void navigate("/workspaces"));
$("#connection-manage").addEventListener("click", () => { state.managingConnection = true; state.connectionFlow = null; setConnectionTab("authorization"); });
$("#remote-reuse").addEventListener("click", async () => {
  state.managingConnection = false;
  const status = state.remoteStatus;
  if (status?.transport === "ready" && !state.remoteUnavailable && (!status.lastProbeAt || Date.now() - status.lastProbeAt <= 45_000)) {
    state.reusedOrigin = status.publicOrigin;
    showToast(status.validGrants ? "已复用当前公网入口，请手工选择工作区；网页调用状态见上方。" : "已复用公网入口；网页尚未授权，请更新网页连接并完成 OAuth。"); await navigate("/workspaces");
  }
  else { state.connectionFlow = { kind: "connection", startedAt: Date.now() }; $("#remote-test").click(); }
});
$("#connection-repair").addEventListener("click", async () => {
  const pending = state.pendingRemoteApprovals?.filter(item => new Date(item.expiresAt).getTime() > Date.now()).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  if (pending) { await openAuthorizationRequest(pending.requestId); return; }
  const previous = state.route?.page === "plan" ? { path: state.routeHash, workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId } : state.connectionReturn;
  await navigate("/connect");
  if (state.route?.page !== "connect") return;
  state.connectionReturn = previous; state.managingConnection = true; state.connectionFlow = null;
  renderConnectionEntry(); renderConnectionClients();
  $("#remote-setup").open = true; $("#connection-records").open = true; $("#authorization-panel").scrollIntoView({ block: "start" });
});
$("#authorization-arrival-open").addEventListener("click", () => {
  const request = state.pendingRemoteApprovals?.filter(item => new Date(item.expiresAt).getTime() > Date.now()).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  if (request) void openAuthorizationRequest(request.requestId);
});
$("#connection-return-plan").addEventListener("click", async () => {
  if (!state.connectionReturn?.path) return;
  const path = state.connectionReturn.path;
  await navigate(path);
  if (state.routeHash === path) state.connectionReturn = null;
});
$("#connection-copy-current").addEventListener("click", () => $("#remote-copy").click());
$("#connection-verify-web").addEventListener("click", async () => {
  let header; try { header = webpageSelectionHeader(); } catch (error) { showToast(error.message, true); return; }
  const prompt = [header, "仅做只读连接验证：实际调用一次 workspace_query({})，不重试，不调用其他工具。",
    "汇总获准项目，以及回执 connection 中的 MCP 地址、buildId、clientFingerprint、名称来源和 traceId；报告实际调用的工具连接名，无法取得时写未知，不能把本机备注当认证身份。",
    "不创建 Planning、不领取或提交审查、不批准或执行。不在网页沙箱执行代码。失败保留原始错误及 traceId（如有），不要据此猜测项目未授权。"].join("\n");
  try { await copyText(prompt); showToast("连接验证提示已复制。请在网页实际选择对应连接后发送；仅核验，不启动业务。"); }
  catch { showCopyFallback("复制只读连接验证提示", prompt); }
});
$("#connection-compare-url").addEventListener("click", () => {
  const result = $("#connection-url-result");
  try {
    const url = new URL($("#connection-client-url").value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("请填写不带凭据或参数的完整 HTTPS MCP 地址（以 /mcp 结尾）。");
    const current = state.remoteStatus?.publicOrigin ? `${state.remoteStatus.publicOrigin}/mcp` : null;
    result.textContent = current && url.href === current ? "地址与当前入口一致。还需检查 OAuth 授权及实际工具调用。" : "地址不一致。请复制当前 MCP 地址，在对应网页更新或重新添加连接并重新授权；本地复用不会同步网页设置。";
  } catch (error) { result.textContent = error.message; }
});
for (const id of ["remote-origin", "remote-port", "quick-workspace", "quick-repository", "quick-session-read"]) $("#" + id).addEventListener("input", () => { state.connectionConfigDirty = true; });
$("#reuse-copy-url").addEventListener("click", () => $("#remote-copy").click());
$("#reuse-test").addEventListener("click", () => $("#remote-test").click());
$("#workspace-new-plan").addEventListener("click", startNewTask);
async function openWorkspaceAuthorization() {
  if (state.workspace) { state.authorizationWorkspace = { ...state.workspace }; state.connectionReturn = { path: state.routeHash, workspaceId: state.workspace.workspaceId, planningId: state.planning?.planningId }; }
  state.managingConnection = true; state.grantSignature = "";
  await navigate("/connect"); if (state.route?.page !== "connect") return;
  setConnectionTab("authorization"); renderConnectionEntry(); await refreshRemoteApprovals(); renderConnectionClients();
  $("#authorization-workspace-context").textContent = state.authorizationWorkspace ? `当前工作区：${state.authorizationWorkspace.label}。选择已有网页授权并增加此工作区；原有项目和 MCP 地址保留。` : "为网页客户端选择可访问的工作区。";
}
$("#workspace-manage-access").addEventListener("click", openWorkspaceAuthorization);
$("#workspace-enable-access").addEventListener("click", openWorkspaceAuthorization);
$("#plan-workspace-access").addEventListener("click", openWorkspaceAuthorization);
$("#git-browse-project").addEventListener("click", async () => { await openReferenceDialog(); await browseWorkspaceFiles(); });
$("#git-browse-files").addEventListener("click", () => {
  if (!state.workspace) return;
  state.gitFilesDialog = { workspaceId: state.workspace.workspaceId, selection: new Set(state.gitSelectedPaths || []) };
  $("#git-files-workspace").textContent = state.workspace.path;
  $("#git-files-filter").value = "";
  renderGitFileTree(state.gitFileChanges || [], $("#git-file-list"));
  $("#git-files-dialog").showModal();
});
$("#git-files-filter").addEventListener("input", () => renderGitFileTree(state.gitFileChanges || [], $("#git-file-list")));
function finishGitFileSelection(applied = false) {
  const snapshot = state.gitFilesDialog; state.gitFilesDialog = null;
  if (snapshot && snapshot.workspaceId === state.workspace?.workspaceId) {
    if (!applied) { const valid = new Set((state.gitFileChanges || []).map(item => item.path)); state.gitSelectedPaths = new Set([...snapshot.selection].filter(path => valid.has(path))); }
    $("#git-files-filter").value = ""; renderGitFileTree(state.gitFileChanges || [], $("#git-file-list"));
  }
  if ($("#git-files-dialog").open) $("#git-files-dialog").close();
}
$("#git-files-close").addEventListener("click", () => finishGitFileSelection());
$("#git-files-apply").addEventListener("click", () => finishGitFileSelection(state.gitFilesDialog?.workspaceId === state.workspace?.workspaceId));
$("#git-files-dialog").addEventListener("cancel", event => { event.preventDefault(); finishGitFileSelection(); });
$("#git-files-dialog").addEventListener("close", () => {
  // Native close events are queued. An event from the preceding dialog must not
  // cancel a newly opened selection, or change another workspace’s selection.
  if (!$("#git-files-dialog").open) finishGitFileSelection();
});
$("#git-open-system").addEventListener("click", async () => {
  const workspace = state.workspace;
  if (!workspace || !window.tokenCouponDesktop?.openWorkspaceFolder) return;
  $("#git-system-status").textContent = "正在打开文件资源管理器…";
  try {
    await window.tokenCouponDesktop.openWorkspaceFolder(workspace.path);
    if (state.workspace?.workspaceId === workspace.workspaceId) $("#git-system-status").textContent = "已请求打开此工作区。外部修改文件后，请点击“重新检查”。";
  } catch (error) { if (state.workspace?.workspaceId === workspace.workspaceId) $("#git-system-status").textContent = `未能打开文件资源管理器：${error.message}`; }
});
$("#git-preview-selected").addEventListener("click", () => previewGitFromUI("selected"));
$("#git-preview-close").addEventListener("click", () => { $("#git-preview-dialog").close(); state.gitPreview = null; });
$("#git-confirm-commit").addEventListener("click", confirmGitCommit);
$("#git-save-identity").addEventListener("click", async () => {
  const workspace = state.workspace, name = $("#git-name").value.trim(), email = $("#git-email").value.trim();
  if (!workspace) return;
  if (!name || !email || /[\r\n\0]/.test(name + email) || !$("#git-email").checkValidity()) {
    $("#git-identity-error").textContent = "请填写提交者姓名和有效邮箱；仅用于 Git 提交记录。"; return;
  }
  $("#git-identity-error").textContent = "";
  if (!await askConfirm("保存仓库 Git 身份", `仅修改此仓库 Git 身份：${workspace.path}\n${name} <${email}>`, "保存身份") || state.workspace?.workspaceId !== workspace.workspaceId) return;
  const job = await startJob("保存仓库身份", requestKey => api(`/api/v1/workspaces/${workspace.workspaceId}/git/identity`, { method: "POST", body: JSON.stringify({ requestKey, confirmed: true, name, email }) }), true);
  if (state.workspace?.workspaceId !== workspace.workspaceId) return;
  await refreshGitReadiness(true);
  if (job?.status === "succeeded") $("#git-identity").open = false;
});

if (!globalThis.tokenCouponAttemptSelection) {
  $("#attempt-select").addEventListener("change", () => { if (state.attemptSelection) { state.attemptSelection.mode = "history"; state.attemptSelection.selectedAttemptId = $("#attempt-select").value; } void selectAttempt(); });
  $("#attempt-show-latest").addEventListener("click", () => { if (state.attemptSelection) { state.attemptSelection.mode = "auto"; state.attemptSelection.selectedAttemptId = state.latestAttemptChoice?.attemptId || ""; } $("#attempt-select").value = state.latestAttemptChoice?.attemptId || ""; void selectAttempt(); });
}
$("#execution-latest-details").addEventListener("click", () => void openTaskDetails());
$("#copy-execution-clarification").addEventListener("click", () => void openRevisionPlanning());
if (!globalThis.tokenCouponAttemptRecordControls) {
  $("#attempt-refresh").addEventListener("click", () => readSelectedAttempt(true));
  $("#attempt-more").addEventListener("click", () => readSelectedAttempt(true));
}
if (!globalThis.tokenCouponAttemptRawEvents) $("#attempt-event-filter").addEventListener("input", () => { if (state.attemptView) { state.attemptView.rawFilter = $("#attempt-event-filter").value; state.attemptView.rawPage = 0; } renderAttemptView(); });

$("#composer-back").addEventListener("click", () => state.workspace && selectWorkspace(state.workspace.workspaceId));
$("#copy-plan-resume").addEventListener("click", copyResumePrompt);
$("#copy-review-continue").addEventListener("click", copyResumePrompt);
$("#workspace-open-file").addEventListener("click", openReferenceDialog);
$("#file-browse-workspace").addEventListener("click", () => void browseWorkspaceFiles());
$("#file-open-native").addEventListener("click", () => void openReferenceFiles());
const jumpReferencePath = () => { clearTimeout(state.fileSearchTimer); state.fileQuery = ""; $("#file-name-search").value = ""; void listReferenceFiles($("#file-directory-path").value.trim() || ".", 0, ""); };
$("#file-directory-go").addEventListener("click", jumpReferencePath);
$("#file-directory-path").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); jumpReferencePath(); } });
$("#file-close").addEventListener("click", () => { state.fileRequest++; state.filePreviewRequest++; $("#file-dialog").close(); });
$("#file-dialog").addEventListener("close", () => { state.fileRequest = (state.fileRequest || 0) + 1; state.filePreviewRequest = (state.filePreviewRequest || 0) + 1; });
$("#plan-logs-details").addEventListener("toggle", () => { if ($("#plan-logs-details").open) void loadPlanLogs(); });
$("#file-parent").addEventListener("click", () => { const parts = (state.filePath || ".").split("/").filter(part => part !== "."); parts.pop(); void listReferenceFiles(parts.join("/") || "."); });
$("#file-more").addEventListener("click", () => void listReferenceFiles(state.filePath, state.fileNextOffset, state.fileQuery || ""));
$("#file-name-search").addEventListener("input", () => {
  clearTimeout(state.fileSearchTimer);
  const query = $("#file-name-search").value.trim();
  state.fileSearchTimer = setTimeout(() => { if (state.fileWorkspace) void listReferenceFiles(state.filePath || ".", 0, query); }, 250);
});
$("#file-next-lines").addEventListener("click", () => state.fileChosen && previewReferenceFile(state.fileChosen, state.fileStartLine + 200));
$("#file-use").addEventListener("click", async () => {
  if (state.fileWorkspace !== state.workspace?.workspaceId) return;
  const paths = [...(state.fileSelections || [])]; if (!paths.length && state.fileChosen) paths.push(state.fileChosen);
  if (!paths.length) return;
  state.referenceFiles = paths; state.referenceFile = paths[0]; $("#file-dialog").close(); renderReference(); await startNewTask();
});

function renderFileSelection() {
  const count = state.fileSelections?.size || 0;
  $("#file-selection-count").textContent = count ? `已选择 ${count} 个参考文件` : state.fileChosen ? `当前预览：${state.fileChosen}` : "可勾选多个文件，或预览后使用当前文件";
  $("#file-use").disabled = !count && !state.fileChosen;
}
function cancelDirectoryPicker(message = "") {
  const controller = state.directoryPickerController; if (!controller) return;
  state.directoryPickerController = null; controller.abort(); state.nativePicking = false;
  const button = $("#choose-workspace-native"); button.disabled = false; button.textContent = desktopFolderPicker ? "选择文件夹" : "在后台 Windows 打开选择窗口"; button.removeAttribute("aria-busy");
  show($("#cancel-directory-picker"), false);
  if (message) { $("#workspace-picker-status").textContent = message; $("#workspace-manual-path").open = true; }
}
const pickerStatus = document.createElement("p"); pickerStatus.id = "workspace-picker-status"; pickerStatus.className = "hint"; pickerStatus.setAttribute("role", "status"); pickerStatus.setAttribute("aria-live", "polite");
const desktopFolderPicker = typeof window.tokenCouponDesktop?.chooseWorkspaceFolder === "function";
const cancelPicker = document.createElement("button"); cancelPicker.id = "cancel-directory-picker"; cancelPicker.type = "button"; cancelPicker.className = "button button-quiet hidden"; cancelPicker.textContent = "取消选择";
const nativeChoice = document.createElement("details"); nativeChoice.id = "workspace-native-choice"; nativeChoice.className = "foldout";
nativeChoice.innerHTML = desktopFolderPicker
  ? '<summary>桌面应用：本机文件夹选择器</summary><p class="hint">在当前电脑选择工作区文件夹。</p><button id="choose-workspace-native" type="button" class="button button-quiet">选择文件夹</button>'
  : '<summary>同机使用：Windows 原生窗口</summary><p class="hint">仅在运行后台的 Windows 已解锁桌面打开，另一台电脑看不到此窗口。远程使用请点“浏览后台目录”。</p><button id="choose-workspace-native" type="button" class="button button-quiet">在后台 Windows 打开选择窗口</button>';
$("#choose-workspace-directory").textContent = "浏览后台目录";
$("#choose-workspace-directory").after(nativeChoice); nativeChoice.append(cancelPicker, pickerStatus);
cancelPicker.addEventListener("click", () => cancelDirectoryPicker("已取消 Windows 选择；可浏览后台目录或手动填写路径。"));
async function openDirectoryPicker() {
  if (state.nativePicking) { showActionFeedback("系统选择窗口仍在等待", desktopFolderPicker ? "请完成或取消当前文件夹选择。" : "请在运行后台的 Windows 桌面选择或取消；也可返回选择已有工作区。"); return; }
  const generation = state.folderSelectionGeneration, button = $("#choose-workspace-native"), controller = new AbortController();
  state.directoryPickerController = controller;
  state.nativePicking = true; button.disabled = true; button.textContent = "正在选择文件夹…"; button.setAttribute("aria-busy", "true");
  show(cancelPicker, !desktopFolderPicker); pickerStatus.textContent = desktopFolderPicker ? "正在打开本机文件夹选择器；如需取消，请关闭系统窗口。" : "正在请求 Windows 文件夹窗口；未看到窗口时，可取消并手动填写。";
  showActionFeedback("正在打开文件夹选择窗口", desktopFolderPicker ? "请在当前电脑选择或取消文件夹。" : "请在运行后台的 Windows 桌面选择或取消；如果窗口在后台，可通过任务栏切换。也可返回选择已有工作区。");
  const reminder = desktopFolderPicker ? undefined : setTimeout(() => { if (state.directoryPickerController === controller && generation === state.folderSelectionGeneration) { pickerStatus.textContent = "仍在等待 Windows 窗口。若桌面没有弹窗，请取消选择并手动填写路径；最多等待 5 分钟。"; showActionFeedback("等待系统文件夹选择", pickerStatus.textContent); } }, 12000);
  const deadline = desktopFolderPicker ? undefined : setTimeout(() => { if (state.directoryPickerController === controller) cancelDirectoryPicker("本次选择等待超时，已请求取消。可重试或手动填写路径。"); }, 310000);
  try {
    const result = desktopFolderPicker
      ? await window.tokenCouponDesktop.chooseWorkspaceFolder()
      : await api("/api/v1/native-picker", { method: "POST", body: JSON.stringify({ kind: "directory" }), signal: controller.signal });
    if (controller.signal.aborted || !workspaceFormIsCurrent(generation)) return;
    if (result.cancelled || result.canceled) {
      if ($("#workspace-path").value.trim() || $("#workspace-label").value.trim()) showActionFeedback("已取消文件夹选择", "原路径与名称已保留，可以继续编辑或登记工作区。");
      else { closeWorkspaceForm(); showActionFeedback("已取消新建工作区", "已返回工作区选择，原有授权选择与任务保留。"); }
      return;
    }
    const selectedPath = result.path || result.paths?.[0];
    if (typeof selectedPath !== "string" || !selectedPath) throw new Error("folder_picker_result_invalid：文件夹选择器没有返回路径");
    $("#workspace-path").value = selectedPath; $("#workspace-selected-path").textContent = selectedPath; show($("#workspace-form")); show($("#workspace-path-error"), false);
    pickerStatus.textContent = "文件夹已选择，填写名称后添加项目。";
    showActionFeedback("已选择文件夹", `${selectedPath}。填写名称后点击“添加项目”登记。`);
  } catch (error) {
    if (controller.signal.aborted || !workspaceFormIsCurrent(generation)) return;
    pickerStatus.textContent = "系统选择未完成，可重新选择或手动填写。";
    $("#workspace-path-error").textContent = error.message; show($("#workspace-path-error")); $("#workspace-manual-path").open = true; showActionFeedback("系统选择器未打开", `${error.message}。可手动填写路径或返回已有工作区。`, "validation");
  }
  finally { if (reminder) clearTimeout(reminder); if (deadline) clearTimeout(deadline); if (state.directoryPickerController === controller) { state.directoryPickerController = null; state.nativePicking = false; button.disabled = false; button.textContent = desktopFolderPicker ? "选择文件夹" : "在后台 Windows 打开选择窗口"; button.removeAttribute("aria-busy"); show(cancelPicker, false); } }
}
$("#choose-workspace-directory").addEventListener("click", () => { cancelDirectoryPicker(); void openDirectoryBrowser(); });
$("#choose-workspace-native").addEventListener("click", openDirectoryPicker);
$("#open-runtime-model").addEventListener("click", async () => { await planTab("models"); if (state.route?.tab === "models") $("#runtime-model-task").focus({ preventScroll: true }); });
if (!globalThis.tokenCouponRuntimeModelControls) {
  $("#runtime-model-task").addEventListener("change", () => selectRuntimeModelTask($("#runtime-model-task").value));
  $("#runtime-model-choice").addEventListener("change", () => { state.runtimeModelChoice = $("#runtime-model-choice").value; renderRuntimeModelControls(); });
  $("#runtime-model-custom").addEventListener("input", () => { state.runtimeModelCustomValue = $("#runtime-model-custom").value; });
}
$("#runtime-model-save").addEventListener("click", () => changeRuntimeModel(false));
$("#runtime-model-retry").addEventListener("click", () => changeRuntimeModel(true));
$("#enable-notifications").addEventListener("click", async () => {
  if (window.tokenCouponDesktop) {
    const enabled = !state.desktopNotificationsEnabled;
    try {
      state.desktopNotificationsEnabled = await window.tokenCouponDesktop.setNotificationsEnabled(enabled);
      $("#enable-notifications").textContent = state.desktopNotificationsEnabled ? "关闭桌面提醒" : "开启桌面提醒";
      $("#notification-status").textContent = state.desktopNotificationsEnabled ? "已开启：新审批到达且页面在后台时发送系统通知。" : "桌面提醒已关闭，页面内仍会显示待审批。";
      if (state.desktopNotificationsEnabled) {
        const shown = await window.tokenCouponDesktop.showNotification({ title: "orchestrator-tokenCoupon", body: "桌面提醒已开启。" });
        if (!shown) $("#notification-status").textContent = "桌面提醒设置已保存，但当前系统不支持弹出通知；页面内仍会显示待审批。";
      }
    } catch { $("#notification-status").textContent = "桌面提醒设置未保存；请检查本机应用状态。"; }
    return;
  }
  if (typeof Notification === "undefined") { $("#notification-status").textContent = "当前浏览器不支持系统通知，仍保留页签和页面提醒。"; return; }
  try { const permission = await Notification.requestPermission(); $("#notification-status").textContent = permission === "granted" ? "已开启：新审批到达且页面在后台时发送系统通知。" : "未开启系统通知，仍保留页签和页面提醒。"; } catch { $("#notification-status").textContent = "系统通知不可用，仍保留页签和页面提醒。"; }
});
$("#action-feedback-close").addEventListener("click", () => show($("#action-feedback"), false));
$("#page-error-dismiss").addEventListener("click", () => show($("#page-error"), false));
$("#authorization-copy-url").addEventListener("click", () => $("#remote-copy").click());
$("#git-refresh").addEventListener("click", () => refreshGitReadiness(true));
for (const button of document.querySelectorAll("[data-connection-tab]")) button.addEventListener("click", () => { state.managingConnection = button.dataset.connectionTab === "authorization"; setConnectionTab(button.dataset.connectionTab); });
for (const button of document.querySelectorAll("[data-connection-mode]")) button.addEventListener("click", () => { state.connectionMode = button.dataset.connectionMode; state.managingConnection = false; setConnectionTab("transport"); renderConnectionEntry(); });
$("#workspace-browse").addEventListener("click", openWorkspaceForm);
$("#session-check").addEventListener("click", () => refreshAll());
$("#session-recover").addEventListener("click", diagnoseAndRecover);
$("#pending-action-open").addEventListener("click", async () => { await planTab("execution"); $("#pending-approval-box").scrollIntoView({ block: "start", behavior: "smooth" }); });
if (!globalThis.tokenCouponAttemptToolsPagination) for (const [direction, delta] of [["prev", -1], ["next", 1]]) $("#attempt-tools-" + direction).addEventListener("click", () => { if (!state.attemptView) return; state.attemptView.toolsPage += delta; renderAttemptView(); });
if (!globalThis.tokenCouponAttemptRawEvents) for (const [direction, delta] of [["prev", -1], ["next", 1]]) $("#attempt-raw-" + direction).addEventListener("click", () => { if (!state.attemptView) return; state.attemptView.rawPage += delta; renderAttemptView(); });
if (!state.remotePoll) state.remotePoll = setInterval(() => void refreshRemoteConnection(), 3000);
setInterval(() => { if (state.workspace && (!state.activeJob || ["planning.run", "session.resume", "session.retry"].includes(state.activeJob.kind))) { void refreshAll(); if (state.planning?.session?.status === "running") void readSelectedAttempt(); } }, 5000);
void init();

setInterval(() => { if (state.planningProgressJob?.status === "running") renderPlanningProgress(); }, 1000);

$("#connection-prompt-client").addEventListener("change", event => {
  state.promptGrantId = event.target.value; renderConnectionIdentity();
});
$("#connection-identity-verify").addEventListener("click", () => $("#connection-verify-web").click());

$("#job-feedback-close").addEventListener("click", () => { const id = $("#job-bar").dataset.noticeId; if (id) dismissOperationNotice(id); });

for (const [id, delta] of [["file-back", -1], ["file-forward", 1]]) $("#" + id).addEventListener("click", () => {
  const index = state.fileHistoryIndex + delta, path = state.fileHistory?.[index];
  if (path !== undefined) void listReferenceFiles(path, 0, "", index);
});
