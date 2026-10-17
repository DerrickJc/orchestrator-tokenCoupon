const $ = (selector) => document.querySelector(selector);
const state = { workspaces: [], workspace: null, plannings: [], planning: null, providers: [], runners: [], environment: null, activeJob: null, eventSource: null, lastEventId: 0, reconnectAttempts: 0, reconnectTimer: null, savedPlanText: "", editedPlanHash: "", toastTimer: null, budgetOperationId: null, remotePoll: null, remoteMutation: false, remoteFetching: false, remoteRefreshPending: false, remoteStatus: null, remoteApprovalsSignature: "", seenAuthorizationRequests: new Set(), authorizationCountdown: null };
const statuses = { collecting: "收集中", draft_ready: "草案待处理", approved: "已批准", execution_created: "执行已创建", succeeded: "已完成", failed: "失败", cancelled: "已取消", running: "运行中", paused: "已暂停", blocked: "等待处理", interrupted: "已中断", ready: "准备就绪", planned: "待执行", timed_out: "超时" };
const isWebMcp = value => ["chatgpt-mcp", "web-mcp", "claude-mcp"].includes(value);
const labels = { codex: "Codex", "claude-code": "Claude Code", dsh: "DeepSeek Harness (dsh)", mock: "离线模拟" };
Object.assign(state, { editingPlan: false, editBase: null, savingPlan: false, replying: false, unsavedDecision: null });
Object.assign(state, { confirmActionResolve: null });
Object.assign(state, { selectedWorkspaces: new Set(), workspaceFilter: false, directorySelections: new Set(), referenceFiles: [] });
statuses.unavailable = "状态待核验"; statuses.pausing = "正在暂停"; statuses.created = "正在启动";

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
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

const remoteScopeLabels = {
  "repository:read": "读取项目文件（只读调研）",
  "planning:read": "查看草案、审查与规划状态",
  "planning:write": "提交规划/审查结果（不能批准草案）",
  "session:read": "查看 Session、任务状态与交付证据",
  "session:control": "运行、暂停、恢复或重试已批准计划",
};
async function refreshRemoteConnection() {
  if (state.remoteFetching) { state.remoteRefreshPending = true; return; }
  state.remoteFetching = true;
  try {
    const status = await api("/api/v1/remote-connection");
    state.remoteStatus = status;
    const badge = $("#remote-status");
    const phases = { stopped: "未连接", checking: "检查组件", downloading: "下载组件", verifying: "校验组件", starting: "启动网关", discovering: "建立隧道", probing: "测试公网连接", reconnecting: "正在重试", ready: "公网入口可用", disconnected: "连接已中断", error: "连接失败" };
    badge.textContent = status.transport === "ready" ? status.validGrants ? "公网可用 · 网页授权有效" : "公网可用 · 网页待授权" : phases[status.transport] || "未连接";
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
    $("#remote-progress").textContent = state.pendingRemoteApprovals?.length ? `已收到 ${state.pendingRemoteApprovals.length} 个网页 OAuth 请求，请在下方核对客户端、项目和权限后决定。` : check && ["checking", "retrying"].includes(check.state) ? `${check.background ? "后台检查，当前入口保持可用" : "正在验证当前入口"} · 第 ${check.attempt}/${check.maxAttempts} 次${check.state === "retrying" ? `；将自动重试，无需重复点击。${check.lastError || ""}` : ""}` : status.addressChanged && !status.validGrants ? "地址已变化，原网页授权不适用；请复制新地址，到 ChatGPT／Claude 更新连接并重新授权。" : status.transport === "ready" ? status.validGrants ? "公网自检通过；网页授权有效。实际工具调用结果见客户端卡片。" : "公网自检通过；尚无有效网页授权，复用入口不会自动连接 GPT。" : status.busy ? `${phases[status.transport]}，可点击停止取消。` : "建立公网入口后，还需在对应网页完成项目授权。";
    if (status.startupReadiness && status.transport !== "ready") {
      const remaining = Math.max(0, Math.ceil((status.startupReadiness.deadlineAt - Date.now()) / 1000));
      badge.textContent = "新地址就绪检查中";
      $("#remote-progress").textContent = `已取得新地址，正在校验 DNS、Cloudflare 路由和 MCP · 第 ${status.startupReadiness.round} 轮 · 最多再等待 ${remaining} 秒。通过校验前入口不可用；可停止取消，无需重复新建连接。${check?.lastError ? ` 最近诊断：${check.lastError}` : ""}`;
    } else if (status.transport === "error" && status.nextProbeAt) {
      $("#remote-progress").textContent = `当前校验未通过，约 ${Math.max(0, Math.ceil((status.nextProbeAt - Date.now()) / 1000))} 秒后自动复检；保留当前地址，也可手动重测。`;
    }
    show($("#remote-url-wrap"), Boolean(status.mcpUrl)); show($("#remote-setup"), Boolean(status.mcpUrl));
    $("#remote-mcp-url").value = status.mcpUrl || "";
    $("#remote-quick").disabled = state.remoteMutation || status.busy;
    $("#remote-quick").textContent = status.enabled && status.mode === "quick_tunnel" && status.gateway === "running" ? "继续使用当前连接" : "新建快捷连接";
    $("#remote-save").disabled = state.remoteMutation || status.busy;
    $("#remote-stop").disabled = state.remoteMutation || !status.enabled;
    show($("#remote-cancel"), !!status.busy); $("#remote-cancel").disabled = state.remoteMutation || !status.enabled;
    $("#remote-test").disabled = state.remoteMutation || status.busy || !status.enabled || status.gateway !== "running";
    const checking = check && ["checking", "retrying"].includes(check.state);
    const connectionError = checking ? "" : status.lastError || "";
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
  } finally {
    state.remoteFetching = false;
    if (state.remoteRefreshPending) { state.remoteRefreshPending = false; queueMicrotask(() => void refreshRemoteConnection()); }
  }
}
async function refreshRemoteApprovals() {
  let requests; let grants;
  try { [requests, grants] = await Promise.all([api("/api/v1/remote-connection/approvals"), api("/api/v1/remote-connection/grants")]); }
  catch { state.authorizationsFresh = false; return; }
  state.authorizationsFresh = true;
  state.grants = grants;
  state.pendingRemoteApprovals = requests;
  const root = $("#remote-approvals");
  const signature = JSON.stringify([requests, state.workspaces.map(({ workspaceId, label }) => ({ workspaceId, label }))]);
  // Preserve each request's selections when another browser submits a request.
  if (signature !== state.remoteApprovalsSignature) {
  const selections = new Map([...root.querySelectorAll(".remote-approval-card[data-request-id]")].map(card => [card.dataset.requestId, {
    source: card.querySelector(".remote-source-select")?.value || "", workspaceId: card.querySelector(".remote-workspace-select")?.value || "",
    workspaceIds: selectedProjects(card.querySelector(".remote-projects") || document.createElement("fieldset")), scopes: [...card.querySelectorAll(".remote-scope-list.permissions input:checked")].map(input => input.value),
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
    const sourceSelect = document.createElement("select"); sourceSelect.className = "remote-source-select"; sourceSelect.append(new Option("请选择网页来源", ""), new Option("ChatGPT", "chatgpt"), new Option("Claude", "claude"), new Option("其他", "other")); sourceSelect.value = saved?.source || "";
    const sourceLabel = document.createElement("label"); sourceLabel.textContent = "网页来源（必选）"; sourceLabel.append(sourceSelect); card.append(sourceLabel);
    const projects = projectCheckboxes(saved?.workspaceIds || []); projects.classList.add("remote-projects");
    projects.querySelector("legend").textContent = "勾选额外授权的工作区";
    const moreProjects = document.createElement("details"); moreProjects.className = "foldout"; moreProjects.innerHTML = "<summary>同时授权其他工作区（可选，可多选）</summary>"; moreProjects.append(projects);
    workspaceLabel.append(workspaceSelect); card.append(workspaceLabel);
    const permissions = document.createElement("fieldset"); permissions.className = "remote-scope-list permissions";
    const legend = document.createElement("legend"); legend.textContent = "1 · 权限（默认均未授权）"; permissions.append(legend);
    for (const scope of request.requestedScopes.filter(scope => scope !== "session:control")) {
      const label = document.createElement("label"); label.className = "remote-scope";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = scope;
      checkbox.checked = !!saved?.scopes.includes(scope);
      const text = document.createElement("span"); text.textContent = remoteScopeLabels[scope] || scope;
      label.append(checkbox, text); permissions.append(label);
    }
    card.append(permissions, workspaceLabel, moreProjects);
    workspaceLabel.firstChild.textContent = "2 · 工作区";
    empty.textContent = "请选择已有工作区，或新建工作区";
    workspaceSelect.append(new Option("＋ 新建工作区…", "__new__"));
    const formHost = document.createElement("div"); formHost.className = "authorization-workspace-form";
    let previousWorkspace = workspaceSelect.value;
    workspaceSelect.addEventListener("change", () => {
      if (workspaceSelect.value === "__new__") { workspaceSelect.value = previousWorkspace; void openWorkspaceForm(request.requestId); }
      else { previousWorkspace = workspaceSelect.value; if (state.creatingWorkspace && state.workspaceFormContext?.requestId === request.requestId) closeWorkspaceForm(); }
    });
    card.append(formHost);
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
      const missing = [!sourceSelect.value ? "请选择网页来源" : "", workspaceMissing ? "请选择已有工作区，或登记新工作区" : "", !permissions.querySelector("input:checked") ? "请至少勾选一项权限" : ""].filter(Boolean);
      allow.disabled = !!missing.length; allow.title = missing.join("；"); validation.textContent = missing.length ? `尚不能授权：${missing.join("；")}。` : "已就绪，可授权所选工作区与权限。";
      sourceSelect.setAttribute("aria-invalid", String(!sourceSelect.value)); workspaceSelect.setAttribute("aria-invalid", String(workspaceMissing)); validation.classList.toggle("authorization-ready", !missing.length);
      clearInputFeedback();
    };
    card.addEventListener("change", updateAllow); updateAllow(); card.append(validation);
    allow.addEventListener("click", () => {
      const scopes = [...permissions.querySelectorAll("input:checked")].map((input) => input.value);
      if (!state.workspaces.some(workspace => workspace.workspaceId === workspaceSelect.value) || !scopes.length || !sourceSelect.value) { updateAllow(); return; }
      void decideRemoteApproval(request.requestId, { decision: "allow", workspaceId: workspaceSelect.value, workspaceIds: [...new Set([workspaceSelect.value, ...selectedProjects(projects)])], source: sourceSelect.value, scopes }, allow);
    });
    actions.append(deny, allow); card.append(actions); root.append(card);
  }
  }
  renderWorkspaceFormMode();
  renderAuthorizationHistory();
  const grantRoot = $("#remote-grants");
  const grantSignature = JSON.stringify([grants, state.workspaces.map(item => [item.workspaceId, item.label]), state.authorizationWorkspace?.workspaceId]);
  if (state.grantSignature === grantSignature) return; state.grantSignature = grantSignature; grantRoot.replaceChildren();
  if (!grants.length) { grantRoot.innerHTML = '<div class="empty-state">没有有效网页授权。</div>'; return; }
  for (const grant of grants) {
    const card = document.createElement("article"); card.className = "remote-approval-card remote-grant-card";
    const heading = document.createElement("div"); heading.className = "remote-approval-heading";
    const title = document.createElement("b"); title.textContent = `${grant.alias || grant.source || grant.clientName} · ${(grant.workspaceIds || [grant.workspaceId]).length} 个项目`;
    const expires = document.createElement("span"); expires.className = "muted small"; expires.textContent = `到期：${new Date(grant.expiresAt).toLocaleString()}`;
    heading.append(title, expires); card.append(heading);
    const detail = document.createElement("details"); detail.className = "foldout"; const permissionTitle = document.createElement("summary"); permissionTitle.textContent = "1 · 已授予权限";
    const permissionText = document.createElement("p"); permissionText.textContent = grant.scopes.map(scope => remoteScopeLabels[scope] || scope).join("；") + "。调整权限请从原网页重新发起 OAuth。"; detail.append(permissionTitle, permissionText); card.append(detail);
    const source = document.createElement("select"); source.append(new Option("请选择来源", ""), new Option("ChatGPT", "chatgpt"), new Option("Claude", "claude"), new Option("其他", "other")); source.value = grant.source || "";
    const alias = document.createElement("input"); alias.placeholder = "连接名称（例如我的 Claude）"; alias.value = grant.alias || "";
    const identity = document.createElement("details"); identity.className = "foldout"; identity.innerHTML = "<summary>连接名称与网页来源</summary>"; identity.append(source, alias);
    const projects = projectCheckboxes(grant.workspaceIds || [grant.workspaceId]); card.append(projects, identity);
    const save = document.createElement("button"); save.className = "button button-primary"; save.textContent = "保存工作区授权";
    save.addEventListener("click", async () => {
      const workspaceIds = selectedProjects(projects);
      if (!source.value || !workspaceIds.length) { identity.open = true; showToast("请选择网页来源和至少一个项目。", true); return; }
      if (!await askConfirm("确认网页项目权限", "此连接将只能访问当前勾选的项目；取消勾选的项目会立即停止授权。", "保存权限")) return;
      save.disabled = true;
      try { await api(`/api/v1/remote-connection/grants/${grant.grantId}`, { method: "POST", body: JSON.stringify({ workspaceIds, source: source.value, alias: alias.value }) }); showToast("来源与项目授权已保存；公网地址保持不变。"); state.grantSignature = ""; await refreshRemoteConnection(); }
      catch (error) { showToast(error.message, true); save.disabled = false; }
    });
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "button button-quiet"; revoke.textContent = "撤销此连接";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try { await api(`/api/v1/remote-connection/grants/${encodeURIComponent(grant.grantId)}/revoke`, { method: "POST", body: "{}" }); showToast("该网页客户端授权已撤销。"); await refreshRemoteConnection(); }
      catch (error) { showToast(error.message, true); revoke.disabled = false; }
    });
    const actions = document.createElement("div"); actions.className = "remote-approval-actions"; actions.append(save);
    const target = state.authorizationWorkspace;
    if (target && !(grant.workspaceIds || [grant.workspaceId]).includes(target.workspaceId)) {
      const add = document.createElement("button"); add.className = "button button-primary"; add.textContent = `授权并打开“${target.label}”`;
      add.addEventListener("click", async () => {
        if (!source.value) { identity.open = true; showToast("请先选择此连接的网页来源。", true); return; }
        if (!await askConfirm("授权另一个工作区", `允许此网页连接按已有权限访问“${target.label}”？原有工作区授权保留，MCP 地址不变。`, "授权并打开")) return;
        add.disabled = true;
        try {
          await api(`/api/v1/remote-connection/grants/${grant.grantId}`, { method: "POST", body: JSON.stringify({ workspaceIds: [...new Set([...(grant.workspaceIds || [grant.workspaceId]), target.workspaceId])], source: source.value, alias: alias.value }) });
          await refreshRemoteConnection(); showToast("工作区已授权，可在同一网页 MCP 连接中继续。地址和其他授权保持不变。");
          await selectWorkspace(target.workspaceId);
          state.authorizationWorkspace = null; state.connectionReturn = null;
        } catch (error) { showToast(error.message, true); add.disabled = false; }
      }); actions.prepend(add);
    }
    const danger = document.createElement("details"); danger.className = "foldout"; danger.innerHTML = "<summary>撤销授权</summary>"; danger.append(revoke);
    card.append(actions, danger); grantRoot.append(card);
  }
}
function renderAuthorizationHistory() {
  const requests = (state.remoteStatus?.authorizationRequests || []).filter(item => item.status !== "pending").slice(-12).reverse();
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
  const root = document.createElement("fieldset"); root.className = "remote-scope-list";
  const legend = document.createElement("legend"); legend.textContent = "2 · 可访问的工作区"; root.append(legend);
  for (const workspace of state.workspaces) {
    const label = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = workspace.workspaceId; checkbox.checked = selected.includes(workspace.workspaceId);
    label.append(checkbox, document.createTextNode(workspace.label)); root.append(label);
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
  if (parts[0] !== "workspaces") return { page: "connect" };
  if (!parts[1]) return { page: "workspaces" };
  if (parts[2] === "new") return { page: "new", workspaceId: parts[1] };
  if (parts[2] === "plans" && parts[3]) return { page: "plan", workspaceId: parts[1], planningId: parts[3], tab: ["overview", "draft", "review", "execution", "models", "attempts"].includes(parts[4]) ? parts[4] : "overview" };
  return { page: "workspaces", workspaceId: parts[1] };
}
function routePath(route) {
  if (!route.workspaceId) return route.page === "connect" ? "/connect" : "/workspaces";
  const base = `/workspaces/${encodeURIComponent(route.workspaceId)}`;
  return route.page === "new" ? `${base}/new` : route.page === "plan" ? `${base}/plans/${encodeURIComponent(route.planningId)}${route.tab !== "overview" ? `/${route.tab}` : ""}` : base;
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
    if (route.workspaceId && !state.workspaces.some(item => item.workspaceId === route.workspaceId)) throw new Error("该工作区未登记，请重新选择。");
    state.route = route;
    if (previous?.workspaceId !== route.workspaceId || previous?.planningId !== route.planningId) {
      for (const id of ["dag-dialog", "task-results-dialog", "session-continue-dialog"]) if ($("#" + id).open) $("#" + id).close();
      state.dagView = null; state.taskResultView = null; state.continueContext = null;
    }
    if (route.page !== "connect") state.connectionFlow = null;
    if (!route.workspaceId) {
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
    if (route.page === "plan" && previous?.page === "plan" && previous.planningId === route.planningId && previous.tab !== route.tab) $(`#${route.tab}-tab`)?.scrollIntoView({ block: "start" });
    if (route.page === "new" && previous?.page !== "new") (isWebMcp($("#planner-provider").value) ? $("#copy-web-planning") : $("#request-text")).focus();
  } catch (error) {
    if (sequence !== state.navigationSequence) return;
    showToast(error.message, true); state.route = { page: "workspaces" }; state.routeHash = "/workspaces";
    history.replaceState(null, "", "#/workspaces"); renderRoute();
  }
}
function renderRoute() {
  const route = state.route || { page: "connect" };
  for (const page of document.querySelectorAll("[data-page]")) show(page, page.dataset.page === route.page);
  for (const button of document.querySelectorAll("[data-route]")) { const active = button.dataset.route === (route.page === "connect" ? "/connect" : "/workspaces"); button.classList.toggle("active", active); button.setAttribute("aria-current", active ? "page" : "false"); }
  show($("#planning-panel"), route.page === "plan" && !!state.planning);
  show($("#workspace-detail"), route.page === "workspaces" && !!state.workspace);
  show($("#workspace-selection"), route.page === "workspaces" && !state.workspace);
  if (state.workspaceFormContext?.kind === "authorization" ? route.page !== "connect" : route.page !== "workspaces" || state.workspace) state.creatingWorkspace = false;
  renderWorkspaceFormMode();
  show($("#new-task"), route.page !== "connect");
  $("#project-title").textContent = route.page === "connect" ? "连接中心" : state.workspace?.label || "工作区与计划";
  $("#project-path").textContent = route.page === "connect" ? "新建或复用网页模型连接" : state.workspace?.path || "选择一个后台可访问的项目目录";
  $("#workspace-detail-title").textContent = `${state.workspace?.label || "项目"} · 计划`;
  $("#journey-plan").classList.toggle("active", route.page === "plan" || route.page === "new");
  const composer = $("#new-planning"), host = route.page === "plan" ? $("#plan-settings-host") : $("#composer-host");
  if (composer.parentElement !== host) host.append(composer);
  show(composer, route.page === "new" || route.page === "plan");
  for (const panel of document.querySelectorAll("[data-plan-panel]")) show(panel, panel.dataset.planPanel === route.tab);
  for (const button of document.querySelectorAll("[data-plan-tab]")) { const selected = button.dataset.planTab === route.tab || button.dataset.planTab === "execution" && ["models", "attempts"].includes(route.tab); button.classList.toggle("active", selected); button.setAttribute("aria-current", selected ? "page" : "false"); }
  document.title = route.page === "plan" ? `${state.planning?.draft?.plan?.title || "Plan"} · Token Coupon` : `${route.page === "connect" ? "连接" : "工作区"} · Token Coupon`;
  closeNavigation();
  clearInputFeedback();
  if ($("#page-error").dataset.context && !["global", `${state.workspace?.workspaceId || ""}:${state.planning?.planningId || ""}`].includes($("#page-error").dataset.context)) show($("#page-error"), false);
  if (route.page !== "plan") show($("#selection-feedback"), false);
  if (!state.planning) show($("#pending-action-banner"), false);
  renderWorkspaceAccess(); renderReference(); renderConnectionSummary();
  if (state.planning) renderRunConfiguration();
}
function renderConnectionEntry() {
  const status = state.remoteStatus; if (!status) return;
  const reusable = status.enabled && status.gateway === "running" && !!status.publicOrigin;
  state.connectionMode ||= reusable ? "reuse" : "new";
  setConnectionTab(state.managingConnection ? "authorization" : state.connectionTab || "transport");
  for (const button of document.querySelectorAll("[data-connection-mode]")) button.classList.toggle("active", button.dataset.connectionMode === state.connectionMode);
  show($("#connection-reuse"), reusable && state.connectionMode === "reuse");
  show($("#connection-empty-reuse"), !reusable && state.connectionMode === "reuse");
  $("#connection-reuse-status").textContent = state.remoteUnavailable ? "状态暂不可用" : status.transport === "ready" ? status.validGrants ? "入口可用 · 授权有效" : "入口可用 · 网页待授权" : status.busy ? "正在检查" : "需要重测";
  $("#connection-reuse-status").className = `badge ${status.transport === "ready" && status.validGrants ? "badge-success" : "badge-warning"}`;
  $("#connection-reuse-description").textContent = `${status.validGrants || 0} 个有效网页授权。复用只继续使用当前入口，不会更新 GPT／Claude 保存的地址或恢复失效授权。`;
  $("#reuse-address-label").textContent = status.transport === "ready" && !state.remoteUnavailable ? "当前 MCP 地址" : "当前入口地址（等待验证）";
  $("#reuse-mcp-address").textContent = status.publicOrigin ? `${status.publicOrigin}/mcp` : "尚未取得地址";
  show($("#quick-address-policy"), status.mode === "quick_tunnel");
  $("#remote-reuse").textContent = status.transport === "ready" ? "继续：选择工作区" : "重测当前连接";
  $("#remote-reuse").disabled = state.remoteMutation || status.busy || state.remoteUnavailable;
  $("#reuse-test").disabled = state.remoteMutation || status.busy || state.remoteUnavailable || !status.enabled || status.gateway !== "running";
  $("#reuse-copy-url").disabled = !status.mcpUrl || state.remoteUnavailable;
  $("#connection-next").disabled = status.transport !== "ready";
  show($("#remote-connection"), state.connectionMode === "new");
  $("#authorization-count").textContent = status.pendingApprovals ? `(${status.pendingApprovals} 待处理)` : "";
  const approvals = $("#remote-approvals"); show(approvals, !!state.pendingRemoteApprovals?.length);
  renderConnectionSummary();
}
function renderConnectionSummary() {
  const root = $("#workspace-connection-summary"), remote = state.remoteStatus;
  show(root, state.route?.page !== "connect");
  const grants = (state.grants || []).filter(grant => new Date(grant.expiresAt).getTime() > Date.now() && (!state.workspace || (grant.workspaceIds || [grant.workspaceId]).includes(state.workspace.workspaceId)));
  const sources = grants.map(grant => {
    const projects = (grant.workspaceIds || [grant.workspaceId]).map(id => state.workspaces.find(item => item.workspaceId === id)?.label || id).join("、");
    return state.workspace ? `${grant.source || "来源待确认"} 已获准访问本项目` : `${grant.source || "来源待确认"} 已授权（${projects}）`;
  });
  const inactive = (remote?.authorizationStates || []).filter(item => item.status !== "active" && (!state.workspace || item.workspaceIds.includes(state.workspace.workspaceId)) && !grants.some(grant => grant.source === item.source));
  const lost = [...new Set(inactive.map(item => `${item.source} ${item.status === "expired" ? "授权已过期" : "授权已撤销"}`))].join("；");
  const pending = !state.remoteUnavailable && state.authorizationsFresh !== false ? state.pendingRemoteApprovals?.filter(item => new Date(item.expiresAt).getTime() > Date.now()) || [] : [];
  const authorization = pending.length ? `收到 ${pending.length} 个网页授权请求，等待本机确认` : state.authorizationsFresh === false ? "网页授权状态暂不可用（上次记录仅供参考）" : [sources.join("；"), lost].filter(Boolean).join("；") || "网页待授权";
  const toolState = remote?.transport === "ready" && state.authorizationsFresh !== false ? remote.remoteClientVerified ? " · 网页工具：已观测成功调用" : grants.length ? " · 网页工具：待实际调用验证" : "" : "";
  root.textContent = `${state.remoteUnavailable ? "连接状态暂不可用（上次状态仅供参考）" : remote?.transport === "ready" ? "公网入口可用" : remote?.busy ? "公网入口验证中" : "公网入口未就绪"} · ${authorization}${toolState} · ${state.workspace ? `工作区：${state.workspace.label}` : "未选择工作区，请手工选择"}`;
  root.classList.toggle("notice-warn", !!state.remoteUnavailable);
  const active = (state.grants || []).filter(grant => new Date(grant.expiresAt).getTime() > Date.now());
  const authorizationUnknown = !state.remoteUnavailable && remote?.transport === "ready" && state.authorizationsFresh === false;
  const needsAuthorization = !state.remoteUnavailable && !authorizationUnknown && remote?.transport === "ready" && !active.length;
  const needsVerification = !state.remoteUnavailable && !authorizationUnknown && remote?.transport === "ready" && active.length && !remote.remoteClientVerified;
  show($("#connection-action-needed"), state.route?.page !== "connect" && !!(pending.length || authorizationUnknown || needsAuthorization || needsVerification));
  const verificationOnly = !!needsVerification && !pending.length;
  $("#connection-action-title").textContent = pending.length ? "已收到网页授权请求，等待本机确认" : authorizationUnknown ? "网页授权状态暂不可用，请刷新重试" : needsAuthorization ? remote.addressChanged ? "公网地址已变化，需要更新网页连接并重新授权" : "公网入口可用，网页尚未完成授权" : "已授权，可以发起一次验证提示";
  show($("#connection-action-description"), !verificationOnly);
  show($("#connection-repair"), !verificationOnly); show($("#connection-copy-current"), !verificationOnly);
  show($("#connection-verify-web"), verificationOnly); $("#connection-verify-web").textContent = "复制网页提示";
  $("#connection-action-description").textContent = pending.length ? `最新请求来自 ${pending[0].clientName || "网页客户端"}，请检查项目和权限后再授权。网页授权与公网入口状态分开显示。` : authorizationUnknown ? "公网入口可用，但本次授权列表读取失败；缓存信息仅供参考，尚不能确认网页是否已授权。请先刷新状态，无需重建隧道。" : needsAuthorization ? `${remote.previousMcpUrl ? `原地址：${remote.previousMcpUrl}。` : ""}当前地址：${remote.mcpUrl || remote.publicOrigin + "/mcp"}。${state.reusedOrigin === remote.publicOrigin ? "你已复用该公网入口；" : ""}请在对应网页使用当前地址并完成 OAuth，本机复用不会自动修改网页配置。` : "公网自检与 OAuth 授权已具备；请在已连接的网页发送一次验证提示。内部 connection_probe 不计作网页工具验证。";
  show($("#authorization-arrival"), pending.length > 0);
  if (pending.length) $("#authorization-arrival-description").textContent = `${pending[0].clientName || "网页客户端"} · 请求 ${shortId(pending[0].requestId)} · 请在本机确认项目与权限。`;
  $("#connection-repair").textContent = pending.length ? "打开授权审批" : needsAuthorization ? "查看连接与授权步骤" : "查看客户端与最近调用";
  $("#connection-copy-current").disabled = !remote?.mcpUrl;
}
function renderConnectionClients() {
  const remote = state.remoteStatus || {}, root = $("#connection-current-clients"), history = $("#connection-history-clients");
  const clients = remote.clients || (state.grants || []).map(grant => ({ ...grant, name: grant.alias || grant.clientName || grant.source, status: "active", mcpUrl: remote.mcpUrl }));
  root.replaceChildren(); history.replaceChildren();
  const active = clients.filter(client => client.status === "active"), old = clients.filter(client => client.status !== "active");
  $("#connection-client-count").textContent = state.remoteUnavailable || state.authorizationsFresh === false ? "授权状态暂不可用" : `${active.length} 个有效 · ${old.length} 个历史`;
  if (!active.length) root.innerHTML = '<p class="empty-state">当前没有有效的网页授权。复用公网入口不会恢复授权；请到对应网页更新地址并重新连接。</p>';
  for (const client of clients) {
    const card = document.createElement("article"); card.className = "connection-client";
    const names = (client.workspaceIds || [client.workspaceId]).map(id => state.workspaces.find(workspace => workspace.workspaceId === id)?.label || "已移除项目").join("、");
    const labels = { active: "授权有效", expired: "授权已过期", revoked: "授权已撤销", address_changed: "地址不匹配" };
    const call = client.lastCall;
    card.innerHTML = `<div class="section-title"><strong>${esc(client.name || client.source || "网页客户端")}</strong><span class="badge ${client.status === "active" ? "badge-success" : "badge-warning"}">${esc(labels[client.status])}</span></div><p>${esc(client.source || "来源待确认")} · 项目：${esc(names)}</p><p class="small connection-endpoint">${esc(client.mcpUrl || "地址尚未记录")}</p><p>${call ? `${call.outcome === "success" ? "最近工具调用成功" : "最近工具调用失败"}：${esc(call.tool)} · ${esc(new Date(call.at).toLocaleString())}${call.code ? ` · ${esc(call.code)}` : ""}` : "尚无该授权客户端的实际工具调用记录"}</p>`;
    (client.status === "active" ? root : history).append(card);
  }
  show($("#connection-history"), !!old.length);
  const check = remote.probeCheck;
  $("#connection-check-details").textContent = `${remote.lastProbeAt ? `最近公网自检：${new Date(remote.lastProbeAt).toLocaleString()}` : "尚无成功的公网自检"}${check ? ` · 检查 ${check.attempt}/${check.maxAttempts} · ${check.state}${check.lastError ? ` · ${check.lastError}` : ""}` : ""}${remote.diagnosticsUnavailable ? " · 调用诊断存储暂不可用，不能保证记录完整" : ""}`;
  const calls = $("#connection-recent-calls"); calls.replaceChildren();
  if (!remote.recentCalls?.length) calls.innerHTML = '<p class="empty-state">当前入口尚无网页请求记录。若 GPT 已报错，请先核对网页保存的 URL；内部自检不显示为业务调用。</p>';
  for (const entry of remote.recentCalls || []) {
    const line = document.createElement("p"); line.className = "small connection-call";
    line.textContent = `${new Date(entry.at).toLocaleString()} · ${entry.stage === "authentication" ? "认证失败，工具未执行" : entry.stage === "tool" ? `${entry.tool} ${entry.outcome === "success" ? "成功" : "失败"}` : `${entry.method || "请求"} 已到达网关`} · ${entry.code || `HTTP ${entry.httpStatus || "—"}`} · 追踪 ID：${entry.traceId}`; calls.append(line);
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
  $("#plan-stage").textContent = stage;
  $("#plan-stage").className = `badge ${statusClass(session?.status || plan.status)}`;
  $("#plan-next-action").textContent = session ? waiting ? "Runner 正在等待你的批准或回答，进入执行页处理。" : "进入执行与结果页查看任务状态、恢复操作和交付证据。" : plan.status === "approved" ? "草案已批准。查看本次并发与隔离配置后，到执行页运行。" : review?.current ? "核对审查结论和必要的豁免记录，然后在审查页批准。" : plan.draft ? "查看草案；在网页继续审查，提交有效报告后再批准。" : "到已连接的网页继续需求澄清与规划。可复制下方提示，在新会话恢复同一 Plan。";
  if (plan.workflow) $("#plan-next-action").textContent = plan.workflow.detail;
  $("#plan-summary").innerHTML = `<div><strong>${plan.draft?.plan?.tasks?.length || 0}</strong><span>计划任务</span></div><div><strong>${session?.tasks?.filter(task => task.status === "succeeded").length || 0}</strong><span>执行完成</span></div><div><strong>${review?.current ? "有效" : review ? "已过期" : "待提交"}</strong><span>审查报告</span></div>`;
  const approved = plan.workflow ? plan.workflow.stage === "approved" : plan.status === "approved";
  const target = session || approved ? "execution" : review?.current || plan.workflow?.role === "review" || plan.workflow?.stage?.startsWith("review_") ? "review" : plan.draft ? "draft" : "overview";
  $("#plan-primary-action").textContent = target === "execution" ? "查看执行与结果" : target === "review" ? "核对并批准" : target === "draft" ? "查看草案" : "复制网页继续提示";
  $("#plan-primary-action").onclick = () => target === "overview" ? $("#copy-plan-resume").click() : planTab(target);
  $("#copy-plan-resume").disabled = !isWebMcp(plan.config.provider);
}
function renderReference() {
  const root = $("#reference-summary"); if (!root) return;
  show(root, !!state.referenceFile);
  root.textContent = state.referenceFile ? `规划参考：${(state.referenceFiles?.length ? state.referenceFiles : [state.referenceFile]).join("、")}。复制提示会携带相对路径，由网页重新读取；不会上传未选择的文件。` : "";
}
async function copyResumePrompt() {
  if (!state.planning || !await confirmPlanChanges()) return;
  const prompt = ["通过 Token Coupon MCP 继续已有计划，不新建 Planning，也不在网页执行代码。",
    `项目：${JSON.stringify(state.workspace.label)}；workspaceId：${state.workspace.workspaceId}；planningId：${state.planning.planningId}。`,
    "先调用 workspace_query 核实授权，再 planning_query 读取该 Planning 的最新需求、草案、审查与待处理操作。",
    "有待处理操作时用 handoff_query / handoff_claim 获取协议；否则根据当前目标 planning_prepare，继续规划或审查，再 external_submit。",
    "以本地最新版本为准；历史原文仅按需 conversation_read，不能用当前网页聊天覆盖已保存的需求。工具不可用时报告阻断。",
    "草案生成或修订后接着审查一次；需要用户取舍的问题集中提问，避免无限修订。批准、执行与恢复 Session 由我在 4177 操作。",
    `本次继续目标：${state.planning.workflow?.detail || "继续当前计划并复审"}。当前草案 draft-${state.planning.draft?.draftRevision || "尚未生成"}；以 planning_query 返回的最新版本为准。`,
    "先完成已有规划／修订操作，再审查新版本；已有有效审查则停止重复审查，给出明确 A/B/C 下一步（含自定义）。"].join("\n");
  try { await navigator.clipboard.writeText(prompt); showToast("继续提示已复制。在任一获准网页发送，恢复同一 Plan；没有启动执行。"); }
  catch { showCopyFallback("复制已有计划的继续提示", prompt); }
}

async function init() {
  try {
    const health = await api("/api/v1/health");
    state.environment = health.workspaceEnvironment;
    if (health.mcp?.localReady) { $("#mcp-local-address").textContent = `本机 MCP 地址：${health.mcp.url}`; show($("#mcp-connection")); }
    const environment = state.environment;
    $("#workspace-path-help").textContent = environment?.isWsl
      ? `后台运行于 WSL${environment.distro ? `（${environment.distro}）` : ""}。支持 /home/…、~/…、D:\\…；Windows 路径会转换后检查。`
      : `后台运行于 ${environment?.platform || "本机"}，请填写后台可访问的绝对目录或 ~/目录。`;
    $("#use-current-directory").disabled = !environment?.currentDirectory;
    $("#connection-dot").classList.add("online"); $("#connection-label").textContent = "Daemon 已连接";
    $("#daemon-status").textContent = `Daemon · ${health.epoch.slice(0, 8)}`; $("#daemon-status").className = "badge badge-success";
    [state.workspaces, state.providers, state.runners] = await Promise.all([api("/api/v1/workspaces"), api("/api/v1/providers"), api("/api/v1/runners")]);
    renderProviders(); renderRunners(); renderWorkspaces(); connectEvents();
    await refreshRemoteConnection();
    state.initialized = true;
    await applyRoute(location.hash.slice(1) || "/connect", true);
    await maybeNavigateToAuthorization();
  } catch (error) { disconnected(error); }
}
function disconnected(error) { $("#connection-dot").classList.remove("online"); $("#connection-label").textContent = "连接中断"; $("#daemon-status").textContent = "Daemon · 未连接"; $("#daemon-status").className = "badge badge-error"; showToast(error.message || "无法连接本机服务", true); }
function renderProviders() {
  const select = $("#planner-provider"); select.replaceChildren();
  const other = document.createElement("optgroup"); other.label = "可选：API / 离线模式";
  for (const provider of state.providers) {
    if (["chatgpt-web", "chatgpt-mcp"].includes(provider.id) && state.providers.some(item => item.id === "web-mcp")) continue;
    const option = new Option(provider.available ? provider.label : `${provider.label} · 未连接`, provider.id);
    option.disabled = !provider.available;
    if (isWebMcp(provider.id)) select.add(option); else other.append(option);
  }
  if (other.children.length) select.append(other);
  const update = () => {
    const provider = select.value, mcp = isWebMcp(provider);
    show($("#planner-model-wrap"), !mcp && provider !== "mock");
    show($("#web-planning-guide"), mcp); show($("#local-request-wrap"), !mcp); show($("#start-planning"), !mcp);
    $("#planning-entry-label").textContent = mcp ? "WEB PLANNING" : "NEW PLANNING";
    $("#planning-entry-step").textContent = mcp ? "执行配置" : "01 · 需求";
    $("#planning-entry-title").textContent = mcp ? "网页规划准备与执行配置" : "描述你想完成的工作";
    $("#new-task").textContent = "新建 Plan";
    $("#new-task-sidebar").textContent = "＋ 新建 Plan";
    $("#planner-model").placeholder = mcp ? "网页所选模型名称（仅记录）" : "输入自定义模型 ID";
    const current = mcp ? "" : provider === "mock" ? "mock" : state.providers.find(item => item.id === provider)?.model || "";
    renderModelPicker("planner", { models: current && current !== "mock" ? [{ id: current, label: `${current}（已配置）` }] : [], customAllowed: true }, current, mcp ? "在所选网页选择" : "使用已配置模型");
    $("#planner-model-hint").textContent = mcp ? "此处仅记录名称；实际模型在对应网页中切换。" : "可选择接口公布的模型，也可输入自定义 ID。";
    $("#planner-help").textContent = mcp ? "需求、文件调研、规划和审查在网页完成；这里配置执行、编辑草案、审批和观测。" : "按当前 API 或离线模拟配置生成草案。";
    $("#start-planning").textContent = mcp ? "登记需求，等待网页" : "开始规划";
    show($("#provider-notice"), false); void loadPlannerModels();
  };
  select.value = state.providers.some(item => item.id === "web-mcp") ? "web-mcp" : state.providers.some(item => item.id === "chatgpt-mcp") ? "chatgpt-mcp" : state.providers.find(item => item.available)?.id || ""; select.onchange = update;
  $("#planner-model-choice").onchange = () => applyModelChoice("planner"); update();
}
function renderRunners() {
  const select = $("#runner-id"); select.replaceChildren();
  const ordered = ["codex", "claude-code", "dsh", "mock"].flatMap(id => state.runners.filter(item => item.id === id));
  for (const runner of ordered) {
    const option = new Option(`${labels[runner.id] || runner.id}${runner.available ? "" : " · 未就绪"}`, runner.id);
    option.disabled = !runner.available; select.add(option);
  }
  const stored = localStorage.getItem("tc-runner-id");
  select.value = stored && [...select.options].some(option => option.value === stored && !option.disabled) ? stored : ordered.find(runner => runner.id !== "mock" && runner.available)?.id || "mock";
  const update = () => {
    localStorage.setItem("tc-runner-id", select.value);
    renderModelPicker("runner", { models: [], customAllowed: select.value !== "mock" }, localStorage.getItem(`tc-model-${select.value}`) || "", "沿用 Runner 默认模型");
    void loadRunnerModels();
  };
  select.onchange = update;
  $("#runner-model").onchange = () => localStorage.setItem(`tc-model-${select.value}`, $("#runner-model").value.trim());
  $("#runner-model-choice").onchange = () => { applyModelChoice("runner"); localStorage.setItem(`tc-model-${select.value}`, $("#runner-model").value.trim()); };
  update();
}
function renderModelPicker(prefix, catalog, current, defaultLabel) {
  const select = $(`#${prefix}-model-choice`), input = $(`#${prefix}-model`);
  select.replaceChildren(new Option(defaultLabel, ""));
  for (const model of catalog.models || []) select.add(new Option(`${model.label}${model.label !== model.id ? ` · ${model.id}` : ""}${model.isDefault ? "（工具推荐）" : ""}`, model.id));
  if (catalog.customAllowed) select.add(new Option(prefix === "planner" && isWebMcp($("#planner-provider").value) ? "记录网页模型名称…" : "自定义模型 ID…", "__custom__"));
  select.value = current && [...select.options].some(option => option.value === current) ? current : current && catalog.customAllowed ? "__custom__" : "";
  input.value = catalog.customAllowed || catalog.models?.some(model => model.id === current) ? current : "";
  show(input, select.value === "__custom__"); input.disabled = !catalog.customAllowed;
}
function applyModelChoice(prefix) {
  const select = $(`#${prefix}-model-choice`), input = $(`#${prefix}-model`), custom = select.value === "__custom__";
  input.value = custom ? "" : select.value;
  show(input, custom); if (custom) input.focus();
}
async function loadRunnerModels(refresh = false) {
  const runnerId = $("#runner-id").value; if (!runnerId) return;
  const workspaceId = state.workspace?.workspaceId || "";
  const sequence = state.runnerModelRequest = (state.runnerModelRequest || 0) + 1;
  $("#runner-model-hint").textContent = "正在读取本机工具的模型目录…";
  const params = new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(refresh ? { refresh: "1" } : {}) });
  try {
    const catalog = await api(`/api/v1/runners/${encodeURIComponent(runnerId)}/models?${params}`);
    if (sequence !== state.runnerModelRequest || runnerId !== $("#runner-id").value || workspaceId !== (state.workspace?.workspaceId || "")) return;
    renderModelPicker("runner", catalog, $("#runner-model").value.trim(), "沿用 Runner 默认模型");
    $("#runner-model-hint").textContent = catalog.error || (runnerId === "mock" ? "离线模拟无需选择模型。" : `${catalog.models.length} 个候选模型，来自本机工具目录；实际调用仍取决于账户和接口。`);
  } catch (error) { if (sequence === state.runnerModelRequest) $("#runner-model-hint").textContent = `${error.message}；仍可使用默认模型或自定义 ID。`; }
}
async function loadPlannerModels(refresh = false) {
  const sequence = state.plannerModelRequest = (state.plannerModelRequest || 0) + 1;
  if ($("#planner-provider").value !== "deepseek-api") return;
  try {
    const catalog = await api(`/api/v1/providers/deepseek-api/models${refresh ? "?refresh=1" : ""}`);
    if (sequence !== state.plannerModelRequest || $("#planner-provider").value !== "deepseek-api") return;
    renderModelPicker("planner", catalog, $("#planner-model").value.trim(), "使用已配置模型");
    $("#planner-model-hint").textContent = catalog.error || "候选项来自当前 Planner 接口，可选或自定义模型 ID。";
  } catch (error) { if (sequence === state.plannerModelRequest) $("#planner-model-hint").textContent = error.message; }
}
function renderWorkspaces() {
  const list = $("#workspace-list"); list.replaceChildren();
  const cards = $("#workspace-cards"); cards.replaceChildren();
  if (!state.workspaces.length) { renderWorkspaceSelection(); list.innerHTML = '<div class="muted small" style="padding:8px">尚未添加项目</div>'; cards.innerHTML = '<div class="empty-state">添加一个项目目录，或先完成上一步连接。</div>'; return; }
  for (const workspace of state.workspaces) {
    const button = document.createElement("button"); button.className = `workspace-item ${state.workspace?.workspaceId === workspace.workspaceId ? "active" : ""}`; button.innerHTML = `<span class="workspace-glyph">⌂</span><span>${esc(workspace.label)}</span>`;
    button.addEventListener("click", () => selectWorkspace(workspace.workspaceId)); list.append(button);
    const card = document.createElement("button"); card.className = `project-card ${state.workspace?.workspaceId === workspace.workspaceId ? "selected" : ""}`;
    card.innerHTML = `<span class="eyebrow">WORKSPACE</span><strong>${esc(workspace.label)}</strong><span class="muted small">${esc(workspace.path)}</span><span class="card-link">打开工作区 →</span>`;
    card.addEventListener("click", () => selectWorkspace(workspace.workspaceId));
    const choice = document.createElement("div"); choice.className = "workspace-choice";
    const label = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = workspace.workspaceId; checkbox.checked = state.selectedWorkspaces.has(workspace.workspaceId);
    label.className = "workspace-choice-label"; label.append(checkbox, document.createTextNode(`选择 ${workspace.label}`));
    checkbox.addEventListener("change", () => { checkbox.checked ? state.selectedWorkspaces.add(workspace.workspaceId) : state.selectedWorkspaces.delete(workspace.workspaceId); renderWorkspaceSelection(); });
    choice.append(label, card); cards.append(choice);
  }
  renderWorkspaceSelection();
}
function renderWorkspaceSelection() {
  const ids = state.workspaces.filter(item => state.selectedWorkspaces.has(item.workspaceId)).map(item => item.workspaceId);
  $("#workspace-selection-status").textContent = ids.length ? `已选择 ${ids.length} 个工作区；点击项目卡片打开，Plan 与授权仍按项目分别管理。` : "尚未勾选工作区";
  $("#workspace-open-selected").disabled = !ids.length;
  for (const choice of $("#workspace-cards").querySelectorAll(".workspace-choice")) {
    const selected = state.selectedWorkspaces.has(choice.querySelector("input").value);
    choice.classList.toggle("selected", selected); show(choice, !state.workspaceFilter || selected);
  }
}
function renderPlanningList() {
  const root = $("#planning-list"); root.replaceChildren();
  const cards = $("#workspace-plan-cards"); cards.replaceChildren();
  show($("#planning-nav-heading"), !!state.workspace);
  for (const planning of state.plannings) {
    const button = document.createElement("button"); button.className = `workspace-item ${state.planning?.planningId === planning.planningId ? "active" : ""}`;
    const title = planning.draft?.plan?.title || planning.messages?.[0]?.content?.slice(0, 28) || "新规划";
    button.innerHTML = `<span class="workspace-glyph">↗</span><span>${esc(title)}<small class="muted small">${esc(planning.workflow?.label || statuses[planning.session?.status] || statuses[planning.status] || planning.status)}</small></span>`;
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
    card.innerHTML = `<span class="badge ${statusClass(planning.session?.status || planning.status)}">${esc(planning.workflow?.label || statuses[planning.session?.status] || statuses[planning.status] || planning.status)}</span><strong>${esc(title)}</strong><span class="muted small">${planning.draft?.plan?.tasks?.length || 0} 个任务</span><span class="card-link">打开计划 →</span>`;
    card.addEventListener("click", () => void selectPlanning(planning.planningId)); cards.append(card);
  }
  if (!state.plannings.length) cards.innerHTML = '<div class="empty-state">还没有 Plan。新建规划，或在网页通过 MCP 提交，之后会出现在这里。</div>';
}
function selectWorkspace(workspaceId) { return navigate(`/workspaces/${encodeURIComponent(workspaceId)}`); }
async function loadWorkspace(workspaceId, sequence = state.navigationSequence) {
  state.workspace = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId); state.planning = null; renderWorkspaces();
  state.referenceFile = null; state.referenceFiles = []; renderReference();
  $("#new-task").disabled = !state.workspace; $("#start-planning").disabled = !state.workspace; $("#copy-web-planning").disabled = !state.workspace; void loadRunnerModels();
  const plannings = await api(`/api/v1/workspaces/${workspaceId}/plannings`);
  if (state.workspace?.workspaceId !== workspaceId || sequence !== state.navigationSequence) return;
  state.plannings = plannings;
  renderPlanningList();
}
function connectEvents() {
  clearTimeout(state.reconnectTimer);
  state.eventSource?.close();
  state.eventSource = new EventSource(`/api/v1/events?after=${state.lastEventId}`);
  const connected = () => { state.reconnectAttempts = 0; $("#connection-dot").classList.add("online"); $("#connection-label").textContent = "Daemon 已连接"; if (state.initialized) { void refreshAll(); void readSelectedAttempt(); } };
  state.eventSource.addEventListener("hello", connected);
  state.eventSource.onopen = connected;
  state.eventSource.onerror = () => {
    state.eventSource?.close(); state.eventSource = null; $("#connection-dot").classList.remove("online");
    if (state.reconnectAttempts >= 5) { $("#connection-label").textContent = "需要重新连接"; return; }
    $("#connection-label").textContent = "正在重连";
    const delay = Math.min(16000, 1000 * (2 ** state.reconnectAttempts)) + Math.floor(Math.random() * 250);
    state.reconnectAttempts += 1; state.reconnectTimer = setTimeout(connectEvents, delay);
  };
  state.eventSource.onmessage = (event) => consumeEvent(event);
  for (const type of ["job.started", "job.succeeded", "job.failed", "job.cancel_requested", "job.cancelled", "planning.updated", "review.completed", "planning.approved", "execution.completed", "draft.saved", "draft.revised", "interaction.requested", "interaction.resolved", "runner.output", "task.activity", "workspace.registered", "external.prepared", "external.completed", "external.handoff", "remote_authorization.updated", "remote_authorization.pending", "remote_authorization.decided", "remote_authorization.revoked", "session.model.updated", "task.model-switch.waiting", "remote_connection.updated", "remote_connection.started", "remote_connection.stopped"]) {
    state.eventSource.addEventListener(type, (event) => consumeEvent(event));
  }
}
function consumeEvent(event) {
  let data; try { data = JSON.parse(event.data); } catch { return; }
  const sequence = Number(event.lastEventId || data.sequence); if (Number.isFinite(sequence)) state.lastEventId = Math.max(state.lastEventId, sequence);
  if (data.workspaceId === state.workspace?.workspaceId && data.planningId === state.planning?.planningId) logPlanEvent(data);
  if (data.type === "task.model-switch.waiting" && data.workspaceId === state.workspace?.workspaceId && data.planningId === state.planning?.planningId) { $("#job-label").textContent = data.payload?.message || "目标任务正在收尾，等待安全重试"; show($("#job-bar")); }
  if (data.type?.startsWith("remote_")) void refreshRemoteConnection();
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
  const planning = await api(`/api/v1/workspaces/${workspaceId}/plannings/${planningId}`);
  if (workspaceId !== state.workspace?.workspaceId || sequence !== state.navigationSequence || state.route?.planningId !== planningId) return;
  state.planning = planning;
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
  if (!needed) return true;
  const data = state.gitReadiness?.workspaceId === state.workspace?.workspaceId ? state.gitReadiness : null;
  if (state.gitResultWorkspace !== state.workspace?.workspaceId) $("#git-commit-result").textContent = "";
  $("#git-workspace-path").textContent = `工作区：${state.workspace?.path || ""}`;
  $("#git-readiness-message").textContent = data?.message || "正在检查 Git 仓库、首次提交和运行记录…";
  $("#git-readiness").classList.toggle("git-ready", data?.state === "ready");
  $("#git-readiness-commands").textContent = (data?.commands || []).join("\n");
  $("#git-readiness-paths").textContent = (data?.paths || []).join("\n");
  show($("#git-manual-help"), !!(data?.commands?.length || data?.paths?.length));
  const actions = $("#git-readiness-actions"); actions.replaceChildren();
  $("#git-steps").textContent = `检查仓库 → 检查基线 → 处理变更 → 就绪 · 当前：${({ not_repository: "等待初始化", no_commit: "等待首次提交", metadata_tracked: "修复运行记录跟踪", dirty: "等待确认提交", ready: "全部完成" })[data?.state] || "检查中／需处理"}`;
  const selection = $("#git-file-selection"), files = $("#git-file-list");
  const signature = JSON.stringify([state.workspace?.workspaceId, data?.changes]);
  show(selection, ["dirty", "no_commit"].includes(data?.state) && data?.changes?.some(item => !item.runtime));
  if (state.gitFilesSignature !== signature) {
    state.gitFilesSignature = signature; files.replaceChildren();
    renderGitFileTree((data?.changes || []).filter(item => !item.runtime), files);
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
    button.disabled = !!state.activeJob; button.addEventListener("click", () => prepareGitFromUI(action)); actions.append(button);
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
  if (state.gitSelectionWorkspace !== state.workspace?.workspaceId) { state.gitSelectionWorkspace = state.workspace?.workspaceId; state.gitSelectedPaths = new Set(); }
  const tree = { dirs: new Map(), files: [] }, allPaths = changes.map(item => item.path);
  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean); let node = tree;
    for (const part of parts.slice(0, -1)) { if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], name: part }); node = node.dirs.get(part); }
    node.files.push(change);
  }
  const selectAll = document.createElement("label"); selectAll.className = "git-tree-select-all";
  const all = document.createElement("input"); all.type = "checkbox"; all.dataset.allFiles = "true"; all.checked = allPaths.length > 0 && allPaths.every(path => state.gitSelectedPaths.has(path));
  all.addEventListener("change", () => { state.gitSelectedPaths = new Set(all.checked ? allPaths : []); for (const input of root.querySelectorAll("input[data-file-path]")) input.checked = all.checked; updateGitFolderChecks(root); });
  selectAll.append(all, document.createTextNode(` 全选本次变更（${allPaths.length} 个文件）`)); root.append(selectAll);
  const makeFile = change => {
    const label = document.createElement("label"); label.className = "git-tree-file";
    const input = document.createElement("input"); input.type = "checkbox"; input.dataset.filePath = change.path; input.checked = state.gitSelectedPaths.has(change.path);
    input.addEventListener("change", () => { if (input.checked) state.gitSelectedPaths.add(change.path); else state.gitSelectedPaths.delete(change.path); updateGitFolderChecks(root); });
    const status = change.staged ? "已暂存" : change.code === "??" ? "未跟踪" : "未暂存";
    label.append(input, document.createTextNode(`${change.path} · ${status}${change.staged && change.unstaged ? "（另有未暂存修改，需手工处理）" : ""}`)); return label;
  };
  const renderNode = (node, parent, prefix = "") => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name, details = document.createElement("details"), summary = document.createElement("summary"), label = document.createElement("label");
      details.className = "git-tree-folder"; label.className = "git-tree-folder-label";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.folderPath = path;
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => { const matches = allPaths.filter(file => file.startsWith(`${path}/`)); for (const file of matches) checkbox.checked ? state.gitSelectedPaths.add(file) : state.gitSelectedPaths.delete(file); details.querySelectorAll("input[data-file-path]").forEach(input => input.checked = checkbox.checked); updateGitFolderChecks(root); });
      label.append(checkbox, document.createTextNode(` ${name}/`)); summary.append(label); details.append(summary);
      for (const file of child.files) details.append(makeFile(file)); renderNode(child, details, path); parent.append(details);
    }
    for (const file of node.files) parent.append(makeFile(file));
  };
  renderNode(tree, root);
  updateGitFolderChecks(root);
}
function updateGitFolderChecks(root) {
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
    const paths = [...document.querySelectorAll('#git-file-list input[data-file-path]:checked')].map(input => input.dataset.filePath);
    const preview = await api(`/api/v1/workspaces/${workspaceId}/git/preview`, { method: "POST", body: JSON.stringify({ mode, paths }) });
    if (workspaceId !== state.workspace?.workspaceId) return;
    state.gitPreview = { ...preview, workspaceId };
    $("#git-preview-summary").textContent = `${state.workspace.path} · ${preview.paths.length} 个文件 · ${preview.head === "unborn" ? "首次提交" : `基线 ${preview.head.slice(0, 8)}`}`;
    const box = $("#git-preview-content"); box.replaceChildren();
    for (const item of preview.previews) {
      const details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre"); details.className = "foldout";
      summary.textContent = `${item.code} ${item.path}${item.truncated ? " · 预览已截断，请手工核对完整文件" : ""}`; pre.textContent = item.text; details.append(summary, pre); box.append(details);
    }
    $("#git-commit-message").value = preview.suggestedMessage;
    $("#git-preview-error").textContent = "";
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
  const candidates = verificationCandidates(plan.draft.plan, plan.verificationTasks);
  const radio = document.querySelector(`input[name="run-mode-choice"][value="${config.mode}"]`);
  for (const item of document.querySelectorAll('input[name="run-mode-choice"]')) item.checked = item === radio;
  show($("#run-custom-fields"), config.mode === "custom");
  const verification = $("#run-verification");
  const previousVerification = config.verificationTaskId;
  verification.replaceChildren();
  if (!candidates.length) verification.add(new Option("没有满足依赖要求的最终验证任务", ""));
  for (const candidate of candidates) verification.add(new Option(`${candidate.title} · ${candidate.taskId}`, candidate.taskId));
  verification.value = candidates.some(item => item.taskId === previousVerification) ? previousVerification : candidates.length === 1 ? candidates[0].taskId : "";
  config.verificationTaskId = verification.value;
  $("#run-parallel").value = String(config.maxParallel || 1);
  $("#run-isolation").value = config.isolation || "git-worktree";
  const shared = config.isolation === "shared";
  show($("#run-verification-wrap"), !shared);
  const taskModes = [...new Set(plan.draft.plan.tasks.map(({ task }) => `${labels[task.execution.runnerId] || task.execution.runnerId}${task.execution.modelId ? ` / ${task.execution.modelId}` : " / 沿用 Runner 自身配置"}`))];
  $("#run-configuration-summary").textContent = `${config.needsReconfirm ? "草案版本已变化，旧参数仅供参考；请重新选择默认或自定义后再启动。 " : ""}批准草案：draft-${plan.approval.draftRevision}。任务 Runner／模型：${taskModes.join("；") || "未设置"}。本次隔离和并发设置不会修改已批准任务。`;
  $("#run-configuration-status").textContent = config.needsReconfirm ? "参数待重新确认" : config.mode ? "已批准，待配置启动" : "批准后待配置";
  $("#run-configuration-status").className = `badge ${config.needsReconfirm ? "badge-warning" : "badge-success"}`;
  let error = "";
  if (config.needsReconfirm || !config.mode) error = "请明确选择默认参数或自定义参数，然后点击“确认参数并运行”。";
  else if (config.mode === "default" && !candidates.length) error = "计划没有满足最终验证规则的任务；可选择自定义共享工作区，或修订草案的任务依赖。";
  else if (config.isolation === "shared" && Number(config.maxParallel) !== 1) error = "共享工作区只支持并发 1，请修正参数。";
  else if (config.isolation === "git-worktree" && !candidates.some(item => item.taskId === config.verificationTaskId)) error = "请选择依赖图合法的最终验证任务。";
  const gitReady = renderGitReadiness(config.isolation === "git-worktree");
  $("#run-configuration-error").textContent = error || (!gitReady ? `暂不能运行：${state.gitReadiness?.workspaceId === state.workspace?.workspaceId ? state.gitReadiness.message : "正在检查 Git 准备状态。"}` : state.activeJob || state.runInFlight ? "正在处理当前操作，请等待完成。" : "");
  $("#run-button").disabled = !!error || !gitReady || !!state.activeJob || !!state.runInFlight;
  try { localStorage.setItem(key, JSON.stringify(config)); } catch { /* Run preferences remain in memory. */ }
  state.runConfigDirty = !!config.edited && !config.needsReconfirm;
}
function startNewTask() {
  if (!state.workspace) return;
  return navigate(`/workspaces/${encodeURIComponent(state.workspace.workspaceId)}/new`);
}
async function refreshAll() {
  if (!state.workspace) return;
  try {
    const workspaceId = state.workspace.workspaceId;
    const plannings = await api(`/api/v1/workspaces/${workspaceId}/plannings`);
    if (state.workspace?.workspaceId !== workspaceId) return;
    state.plannings = plannings;
    renderPlanningList();
    const id = state.planning?.planningId;
    if (id && state.plannings.some((plan) => plan.planningId === id) && state.route?.page === "plan") await loadPlanning(id);
    renderWorkspaceAccess();
  } catch (error) { showToast(error.message, true); }
}
function renderPlanning() {
  const plan = state.planning; if (!plan) return;
  $("#planning-title").textContent = plan.draft?.plan?.title || (plan.messages?.[0]?.content || "规划详情").slice(0, 70);
  $("#planning-meta").textContent = `Planning ${shortId(plan.planningId)} · revision ${plan.revision} · ${plan.config.provider} / ${plan.config.model}`;
  $("#planning-status").textContent = plan.workflow?.label || statuses[plan.session?.status] || statuses[plan.status] || plan.session?.status || plan.status;
  $("#planning-status").className = `badge ${statusClass(plan.session?.status || plan.status)}`;
  $("#turn-count").textContent = `${plan.messages?.length || 0} 条`;
  const conversation = $("#conversation"); conversation.replaceChildren();
  for (const message of (plan.messages || []).slice(-30)) {
    const item = document.createElement("article"); item.className = `message ${message.role === "user" ? "user" : "assistant"}`;
    item.innerHTML = `<div class="message-label">${message.role === "user" ? "你" : "Planner"}</div><div>${esc(message.content)}</div>`; conversation.append(item);
  }
  const pendingInputs = [...new Map((plan.externalOperations || []).filter((operation) => operation.role === "plan" && ["prepared", "stale", "interrupted", "failed"].includes(operation.state) && operation.message && !(plan.messages || []).some((message) => message.messageId === operation.sourceMessageId)).reverse().map(operation => [operation.sourceMessageId || operation.operationId, operation])).values()];
  for (const operation of pendingInputs) {
    const item = document.createElement("article"); item.className = "message user";
    item.innerHTML = `<div class="message-label">你 · ${externalOperationState(operation) === "prepared" ? "已登记，等待网页" : "已登记，需要继续处理"}</div><div>${esc(operation.message)}</div>`; conversation.append(item);
  }
  $("#turn-count").textContent = `${(plan.messages?.length || 0) + pendingInputs.length} 条`;
  if (!conversation.children.length) conversation.innerHTML = '<div class="empty-state">本轮还没有对话内容。</div>';
  renderRequirements(); renderDraft(); renderReview(); renderSession(); renderInteractions(); renderRunConfiguration();
  renderExternalOperations(); renderHandoffs();
  const canEdit = !!plan.draft && !plan.execution;
  $("#toggle-plan-edit").disabled = !canEdit || state.savingPlan; $("#review-button").disabled = !plan.draft || !!plan.execution;
  $("#review-button").textContent = isWebMcp(plan.config.provider) ? plan.workflow?.role === "review" ? "继续当前审查" : plan.review?.current ? "重新审查" : "准备网页审查" : "运行审查";
  $("#approve-button").disabled = !plan.draft || !plan.review?.current || plan.workflow?.role === "plan" || plan.status === "approved" || plan.status === "execution_created" || !!plan.execution;
  renderPlanOverview();
  const banner = $("#plan-workflow-banner"); banner.replaceChildren();
  const heading = document.createElement("strong"); heading.textContent = plan.workflow?.label || $("#planning-status").textContent;
  const detail = document.createElement("p"); detail.textContent = plan.workflow?.detail || $("#plan-next-action").textContent;
  banner.append(heading, detail);
  if (plan.approval && plan.approval.planHash === plan.draft?.planHash) {
    const approval = document.createElement("p"); approval.textContent = `已批准 draft-${plan.approval.draftRevision} · ${new Date(plan.approval.approvedAt).toLocaleString()} · 审查 ${shortId(plan.approval.reviewId)}`; banner.append(approval);
    if (!plan.execution && plan.review?.current && plan.workflow?.role !== "plan") { const run = document.createElement("button"); run.className = "button button-primary"; run.textContent = "查看配置并运行计划"; run.onclick = () => planTab("execution"); banner.append(run); }
  }
  if (plan.workflow?.approvalNotice) { const notice = document.createElement("p"); notice.textContent = plan.workflow.approvalNotice; banner.append(notice); }
  if (state.route?.tab === "draft" && isWebMcp(plan.config.provider) && !plan.execution && (!plan.approval || !plan.review?.current || plan.workflow?.role === "plan") && (!plan.review?.current || plan.workflow?.role === "plan")) {
    const resume = document.createElement("button"); resume.className = "button button-primary"; resume.textContent = "复制继续当前计划并复审提示"; resume.onclick = copyResumePrompt; banner.append(resume);
  }
  banner.classList.toggle("notice-success", !!plan.approval && !!plan.review?.current && !plan.execution && plan.workflow?.role !== "plan");
  show($("#waiver-label"), !!plan.review?.current && plan.review.findings?.some(item => item.severity === "error") && !plan.approval);
}
function renderHandoffs() {
  const root = $("#handoff-panel"); if (!root) return;
  root.replaceChildren(); show(root, isWebMcp(state.planning.config.provider));
  if (!isWebMcp(state.planning.config.provider)) return;
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
    copy.addEventListener("click", () => void copyHandoffPrompt(slot.prompt)); card.append(title, line, meta, copy); root.append(card);
  }
  for (const role of ["plan", "review"]) for (const target of ["chatgpt", "claude"]) {
    const button = document.createElement("button"); button.className = "button button-quiet"; button.textContent = `交给 ${target === "chatgpt" ? "ChatGPT" : "Claude"}${role === "plan" ? "继续规划" : "审查"}`;
    button.disabled = !!state.planning.execution || role === "review" && !state.planning.draft;
    button.addEventListener("click", async () => {
      if (!await confirmPlanChanges()) return;
      const connected = (state.grants || []).some(grant => grant.source === target && (grant.workspaceIds || [grant.workspaceId]).includes(state.workspace.workspaceId) && grant.scopes.includes("planning:write"));
      if (!connected) { showToast(`请先在连接区为 ${target} 授权当前项目，并保存对应来源。`, true); state.managingConnection = true; await navigate("/connect"); renderConnectionEntry(); return; }
      const job = await startJob("准备网页交接", requestKey => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/handoff`, { method: "POST", body: JSON.stringify({ requestKey, role, target }) }), true);
      if (job?.status === "succeeded") await copyHandoffPrompt(job.result.prompt);
    }); root.append(button);
  }
}
async function copyHandoffPrompt(prompt) {
  if (!prompt) return;
  try { await navigator.clipboard.writeText(prompt); showToast("接手提示已复制。到目标网页发送一次即可。请保持本地服务运行。"); }
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
  $("#reply-text").placeholder = pending.length ? `还有 ${pending.length} 项需求待澄清，请回答 Planner 的问题` : "回答澄清问题，或补充需求";
  const mcp = isWebMcp(state.planning.config.provider);
  show($("#supplement-input"), !mcp);
  $("#supplement-input summary").textContent = mcp ? "登记补充需求（需要在网页继续）" : "回答澄清／补充需求";
  if (!mcp) $("#supplement-input").open = true;
  const pendingOperation = (state.planning.externalOperations || []).find((operation) => operation.role === "plan" && externalOperationState(operation) === "prepared");
  $("#reply-status").textContent = state.replying ? "正在提交回复…" : pendingOperation ? "回复已登记，等待网页 读取并提交结果。请在已连接 MCP 的 ChatGPT 对话中继续规划。" : mcp ? "此处只登记补充需求；需在 ChatGPT 或 Claude 网页中继续，模型才会生成结果。" : "发送回复后，Planner 会继续规划并更新对话。";
  $("#send-reply").textContent = state.replying ? "正在提交…" : mcp ? "登记补充需求，等待网页" : "发送回复";
  $("#send-reply").disabled = state.replying || !!state.planning.execution;
}
function renderDraft() {
  const draft = state.planning.draft; const target = $("#plan-view");
  const expanded = new Set([...target.querySelectorAll("details[open]")].map(item => item.dataset.taskId)); target.replaceChildren();
  if (!draft) { closePlanEditor(); target.innerHTML = `<div class="empty-state">${isWebMcp(state.planning.config.provider) ? "等待网页模型生成草案；请在 ChatGPT／Claude 中提出需求或回答澄清。" : "Planner 正在收集需求，或尚未生成草案。回答上方的问题后继续。"}</div>`; return; }
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
  for (const entry of draft.plan.tasks) {
    const card = document.createElement("details"); card.className = "plan-card"; card.dataset.taskId = entry.task.id; card.open = expanded.has(entry.task.id);
    card.innerHTML = `<summary><span>${esc(entry.task.title)}</span><span class="muted small">${esc(entry.task.id)} · ${entry.task.schemaVersion === 2 ? "结构化任务" : "旧版正文"} · 查看详情</span></summary>`;
    const sections = document.createElement("div"); sections.className = "plan-field-preview";
    const content = entry.task.schemaVersion === 2
      ? [["需求目标", entry.task.objective], ["设计与技术方案", entry.task.approach], ["实施步骤", entry.task.steps], ["交付物", entry.task.deliverables], ["验收标准", entry.task.acceptanceCriteria], ["约束", entry.task.constraints], ["其他说明", entry.task.notes]]
      : [["任务正文", entry.task.prompt]];
    for (const [label, value] of content) {
      if (value === undefined || value === "" || Array.isArray(value) && !value.length) continue;
      const section = document.createElement("section"), heading = document.createElement("strong"), body = document.createElement("p"); heading.textContent = label;
      body.textContent = Array.isArray(value) ? value.map((line, index) => `${index + 1}. ${line}`).join("\n") : value; section.append(heading, body); sections.append(section);
    }
    const meta = document.createElement("div"); meta.className = "task-meta"; meta.textContent = `依赖：${entry.dependsOn.join(", ") || "无"} · ${labels[entry.task.execution.runnerId] || entry.task.execution.runnerId}${entry.task.execution.modelId ? ` / ${entry.task.execution.modelId}` : " / Runner 默认模型"}`;
    card.append(sections, meta); target.append(card);
  }
  renderPlanEditControls();
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
}
function closePlanEditor() {
  state.editingPlan = false; state.editBase = null; state.editedPlanHash = "";
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
      for (const key of Object.keys(names)) if (JSON.stringify(entry.task[key] ?? null) !== JSON.stringify(before.task[key] ?? null)) changed.push(`任务 ${id} · ${names[key]}`);
    }
    box.textContent = `草案差异 · ${edited.title !== old.title ? `计划标题：${old.title} → ${edited.title}\n` : ""}修改 ${changed.length} 项 / 新增 ${added.length} 项 / 删除 ${removed.length} 项\n${changed.length ? changed.map(item => `• ${item}`).join("\n") : "正文无字段修改"}${added.length ? `\n新增任务：${added.join("、")}` : ""}${removed.length ? `\n删除任务：${removed.join("、")}` : ""}`;
  } catch (error) { box.textContent = `JSON 校验失败：${error.message}`; }
}
function renderReview() {
  const plan = state.planning, review = plan.review, box = $("#review-view");
  const signature = JSON.stringify([state.workspace.workspaceId, plan.planningId, plan.draft?.planHash, review, plan.workflow, plan.approval, plan.execution, plan.reviewHistory, plan.approvalHistory, plan.reviewReadError]);
  // A poll with no review change must not close an open select or move a typing cursor.
  if (state.renderedReviewSignature === signature) return;
  state.renderedReviewSignature = signature; box.replaceChildren();
  const key = `${state.workspace.workspaceId}:${plan.planningId}:${plan.draft?.planHash}:${review?.reviewId}`;
  if (state.reviewChoiceContext?.key !== key) {
    if (state.reviewChoiceContext?.planningId === plan.planningId && state.reviewChoiceContext.dirty) showToast("草案或审查版本已变化，旧处理选择不再适用，请重新确认。", true);
    let choices = {}; try { choices = JSON.parse(sessionStorage.getItem(`tc-review-${key}`) || "{}"); } catch { /* Invalid local input is not a review record. */ }
    state.reviewChoiceContext = { key, planningId: plan.planningId, choices, dirty: Object.keys(choices).length > 0 };
  }
  const summary = document.createElement("section"); summary.className = `review-overview ${review?.current ? "is-current" : ""}`;
  const summaryTitle = document.createElement("strong"); summaryTitle.textContent = review ? `${review.current ? "有效审查" : "审查已过期"} · draft-${review.draftRevision}` : plan.workflow?.label || "当前草案尚无有效审查";
  const summaryText = document.createElement("p"); summaryText.textContent = review ? `${review.reviewId ? `Review ${shortId(review.reviewId)} · ` : ""}${review.summary || "无总结"}` : plan.workflow?.detail || "先准备审查，再到网页领取并提交报告。";
  summary.append(summaryTitle, summaryText);
  box.append(summary);
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
  if (plan.reviewHistory?.length || plan.approvalHistory?.length) {
    const history = document.createElement("details"); history.className = "foldout";
    const heading = document.createElement("summary"); heading.textContent = "历史审查与批准（只读，不适用于本版）"; history.append(heading);
    for (const previous of plan.reviewHistory || []) { const text = document.createElement("p"); text.textContent = `draft-${previous.draftRevision} · ${previous.summary} · ${previous.findings.length} 个问题`; history.append(text); }
    for (const previous of plan.approvalHistory || []) { const text = document.createElement("p"); text.textContent = `历史批准 draft-${previous.draftRevision} · ${new Date(previous.recordedAt).toLocaleString()}`; history.append(text); }
    box.append(history);
  }
  renderReviewActions(review);
  const web = isWebMcp(plan.config.provider) && !plan.execution && (!plan.approval || !review?.current || plan.workflow?.role === "plan") && (!review?.current || plan.workflow?.role === "plan");
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
  const title = document.createElement("p"); title.className = "hint"; title.textContent = "选择对应建议后，一次提交全部修订；暂不处理不代表解决或豁免。"; root.append(title);
  const button = document.createElement("button"); button.className = "button button-primary"; button.textContent = "合并提交修订建议"; button.addEventListener("click", () => submitReviewRevision(review)); root.append(button);
}
async function submitReviewRevision(review) {
  const actions = [...$("#review-view").querySelectorAll(".finding-choice")].map((row) => ({ findingId: row.dataset.findingId, choice: row.querySelector("select").value, custom: row.querySelector("textarea").value.trim() }));
  if (actions.some((item) => item.choice === "custom" && !item.custom)) {
    for (const row of $("#review-view").querySelectorAll(".finding-choice")) { const invalid = row.querySelector("select").value === "custom" && !row.querySelector("textarea").value.trim(); row.querySelector(".field-error").textContent = "请填写自定义修订说明"; show(row.querySelector(".field-error"), invalid); }
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
  await startJob("按审查意见修订草案", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/revise`, { method: "POST", body: JSON.stringify({ requestKey, message, reviewId: review.reviewId, expectedPlanHash: state.planning.draft.planHash, expectedDraftRevision: state.planning.draft.draftRevision }) }));
}
function executionConclusion(status) {
  return status === "succeeded" ? "完成结论：任务已成功完成" : status === "interrupted" ? "中止结论：执行已中断，需核验后恢复" : status === "cancelled" ? "中止结论：任务已取消" : ["failed", "timed_out"].includes(status) ? `错误结论：${status === "timed_out" ? "执行超时" : "任务失败"}` : status === "unavailable" ? "执行状态待核验" : "";
}
function renderTaskDependencies(tasks) {
  const root = $("#task-dependencies"), definitions = new Map((state.planning.draft?.plan.tasks || []).map(entry => [entry.task.id, entry]));
  const nodes = tasks.map(task => ({ id: task.taskId, title: task.title || definitions.get(task.taskId)?.task.title || task.taskId, status: task.status, deps: task.dependsOn || definitions.get(task.taskId)?.dependsOn || [] }));
  const signature = JSON.stringify(nodes); if (root.dataset.signature === signature) return;
  root.dataset.signature = signature; root.replaceChildren(); if (!nodes.length) return;
  const heading = document.createElement("h4"); heading.textContent = `任务依赖 · ${nodes.length} 个任务`; root.append(heading);
  const preview = document.createElement("div"); preview.className = "dag-preview";
  for (const node of nodes.slice(0, 6)) {
    const chip = document.createElement("span"); chip.className = "dag-preview-item"; chip.dataset.status = node.status;
    chip.textContent = `${node.title} · ${statuses[node.status] || node.status}${node.deps.length ? ` ← ${node.deps.map(id => byTitle(nodes, id)).join("、")}` : " · 起始"}`; preview.append(chip);
  }
  if (nodes.length > 6) { const rest = document.createElement("span"); rest.className = "dag-preview-more"; rest.textContent = `另有 ${nodes.length - 6} 个任务`; preview.append(rest); }
  root.append(preview);
  const full = document.createElement("button"); full.type = "button"; full.className = "button button-quiet task-dag-full";
  full.textContent = "放大查看完整 DAG";
  const byId = new Map(nodes.map(node => [node.id, node])), levels = new Map(), remaining = new Map(), children = new Map();
  for (const node of nodes) { remaining.set(node.id, node.deps.filter(id => byId.has(id)).length); for (const id of new Set(node.deps)) { if (!children.has(id)) children.set(id, []); children.get(id).push(node.id); } }
  const queue = nodes.filter(node => !remaining.get(node.id)).map(node => node.id);
  for (let i = 0; i < queue.length; i++) { const id = queue[i]; levels.set(id, levels.get(id) || 0); for (const child of children.get(id) || []) { levels.set(child, Math.max(levels.get(child) || 0, levels.get(id) + 1)); remaining.set(child, remaining.get(child) - 1); if (!remaining.get(child)) queue.push(child); } }
  const unresolved = nodes.filter(node => !queue.includes(node.id));
  for (const node of unresolved) levels.set(node.id, 0);
  const counts = new Map(), positions = new Map();
  for (const node of nodes) { const level = levels.get(node.id) || 0, row = counts.get(level) || 0; counts.set(level, row + 1); positions.set(node.id, { x: level * 204 + 12, y: row * 78 + 12 }); }
  const ns = "http://www.w3.org/2000/svg", make = (tag, attrs = {}) => { const el = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value)); return el; };
  const svg = make("svg", { width: (Math.max(...levels.values()) + 1) * 204, height: Math.max(...counts.values()) * 78 + 16, role: "img", "aria-label": "任务依赖 DAG，箭头从前置任务指向后续任务" });
  const defs = make("defs"), marker = make("marker", { id: "task-dag-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }); marker.append(make("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#8c9d87" })); defs.append(marker); svg.append(defs);
  for (const node of nodes) for (const dependency of node.deps) {
    if (!positions.has(dependency)) continue;
    const from = positions.get(dependency), to = positions.get(node.id), start = from.x + 174, mid = (start + to.x) / 2;
    const edge = make("path", { d: `M ${start} ${from.y + 26} C ${mid} ${from.y + 26}, ${mid} ${to.y + 26}, ${to.x - 3} ${to.y + 26}`, class: "dag-edge", "marker-end": "url(#task-dag-arrow)" }); edge.dataset.from = dependency; edge.dataset.to = node.id;
    const title = make("title"); title.textContent = `${dependency} → ${node.title}`; edge.append(title); svg.append(edge);
  }
  for (const node of nodes) {
    const { x, y } = positions.get(node.id), group = make("g", { class: "dag-node", "data-status": node.status, "data-task-id": node.id });
    const title = make("title"); title.textContent = `${node.title} (${node.id}) · ${statuses[node.status] || node.status}${node.deps.length ? "；依赖：" + node.deps.join("、") : "；起始任务"}`;
    const name = make("text", { x: x + 10, y: y + 21 }), status = make("text", { x: x + 10, y: y + 41, class: "dag-status" });
    name.textContent = node.title.length > 13 ? node.title.slice(0, 12) + "…" : node.title; status.textContent = statuses[node.status] || node.status;
    group.append(title, make("rect", { x, y, width: 174, height: 56, rx: 9 }), name, status); svg.append(group);
  }
  const identity = `${state.workspace.workspaceId}:${state.planning.planningId}`;
  full.addEventListener("click", () => openTaskDag(svg, identity)); root.append(full);
  if ($("#dag-dialog").open) {
    if (state.dagView?.identity === identity) updateTaskDag(svg);
    else $("#dag-dialog").close();
  }
  if (unresolved.length || nodes.some(node => node.deps.some(id => !byId.has(id)))) { const warning = document.createElement("p"); warning.className = "hint"; warning.textContent = "依赖记录不完整或存在环，请核对草案；图示不代表任务可执行。"; root.append(warning); }
}
function byTitle(nodes, id) { return nodes.find(node => node.id === id)?.title || id; }
function openTaskDag(svg, identity) {
  state.dagView = { identity, width: Number(svg.getAttribute("width")), height: Number(svg.getAttribute("height")), zoom: 1 };
  $("#dag-title").textContent = `${state.planning.draft?.plan.title || "任务"} · 完整依赖图`;
  updateTaskDag(svg); $("#dag-dialog").showModal(); fitTaskDag();
}
function updateTaskDag(svg) {
  const viewport = $("#dag-viewport"), x = viewport.scrollLeft, y = viewport.scrollTop;
  state.dagView.width = Number(svg.getAttribute("width")); state.dagView.height = Number(svg.getAttribute("height"));
  viewport.replaceChildren(svg.cloneNode(true)); setTaskDagZoom(state.dagView.zoom);
  viewport.scrollLeft = x; viewport.scrollTop = y;
}
function setTaskDagZoom(zoom) {
  const view = state.dagView, svg = $("#dag-viewport svg"); if (!view || !svg) return;
  view.zoom = Math.min(3, Math.max(0.15, zoom));
  svg.setAttribute("viewBox", `0 0 ${view.width} ${view.height}`);
  svg.setAttribute("width", String(Math.round(view.width * view.zoom))); svg.setAttribute("height", String(Math.round(view.height * view.zoom)));
  $("#dag-zoom-value").textContent = `${Math.round(view.zoom * 100)}%`;
}
function fitTaskDag() {
  const box = $("#dag-viewport"), view = state.dagView; if (!view) return;
  setTaskDagZoom(Math.min(1, (box.clientWidth || view.width) / view.width, (box.clientHeight || view.height) / view.height));
  box.scrollLeft = 0; box.scrollTop = 0;
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
  const controls = document.createElement("div"); controls.className = "interaction-actions"; controls.id = "session-controls"; box.append(board, controls);
}
function renderLiveTaskReplies(tasks) {
  let root = $("#live-task-replies"); if (!root) { root = document.createElement("section"); root.id = "live-task-replies"; root.className = "live-task-replies"; $("#session-progress").after(root); }
  const wasOpen = !!root.querySelector("details[open]");
  root.replaceChildren();
  const active = tasks.filter(item => ["running", "interrupted", "failed"].includes(item.status) && item.currentAttempt);
  const overflow = document.createElement("details"); overflow.className = "live-replies-overflow foldout"; overflow.open = wasOpen;
  const summary = document.createElement("summary"); summary.textContent = `展开其余 ${Math.max(0, active.length - 3)} 条任务动态`; overflow.append(summary);
  for (const [index, task] of active.entries()) {
    const attempt = task.currentAttempt, card = document.createElement("article"), heading = document.createElement("strong"), body = document.createElement("p"), activity = document.createElement("p");
    const model = attempt.reportedModel ? `${attempt.reportedModel}（实际已报告）` : attempt.execution?.modelId ? `${attempt.execution.modelId}（配置值）` : "Runner 默认模型，实际未验证";
    card.className = "live-task-reply"; heading.textContent = `${task.title || task.taskId} · ${statuses[task.status] || task.status} · ${model}`;
    body.textContent = attempt.lastReply ? `最新模型返回：${attempt.lastReply}` : "模型尚未返回文字；以工具活动及执行状态为准。";
    const time = attempt.lastActivityAt ? Date.parse(attempt.lastActivityAt) : NaN;
    activity.className = "hint"; activity.textContent = `${attempt.activity || "等待下一条可观测活动"}${Number.isFinite(time) ? ` · 距最近活动 ${Math.max(0, Math.floor((Date.now() - time) / 1000))} 秒` : ""}。长任务暂无输出不等于已停止。`;
    card.append(heading, body, activity); (index < 3 ? root : overflow).append(card);
  }
  if (active.length > 3) root.append(overflow);
  show(root, !!root.children.length);
}
function renderRuntimeModelPanel(tasks) {
  const candidates = tasks.filter(task => task.status !== "succeeded" && (task.execution?.runnerId || state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId)?.task.execution.runnerId) !== "mock");
  show($("#runtime-model-panel"), !!state.planning.session && !!candidates.length);
  show($("#runtime-model-empty"), !state.planning.session || !candidates.length);
  show($("#open-runtime-model"), !!state.planning.session && !!candidates.length);
  if (!candidates.length) return;
  const select = $("#runtime-model-task"), signature = JSON.stringify([state.workspace.workspaceId, state.planning.planningId, candidates.map(task => task.taskId)]);
  if (signature !== state.runtimeTaskSignature) {
    state.runtimeTaskSignature = signature; const previous = select.value; select.replaceChildren(...candidates.map(task => new Option(task.title || task.taskId, task.taskId)));
    if (candidates.some(task => task.taskId === previous)) select.value = previous;
    state.runtimeModelCatalogKey = null; void loadRuntimeModelChoices();
  }
  const target = candidates.find(task => task.taskId === select.value), busy = !!state.runtimeModelSubmitting || state.activeJob?.kind === "session.model-switch" && state.activeJob.status === "running";
  $("#runtime-model-save").disabled = busy;
  $("#runtime-model-retry").disabled = busy || target?.status !== "running" || state.planning.session.health?.state !== "active";
  if (!state.runtimeModelSubmitting) $("#runtime-model-status").textContent = `配置版本 ${state.planning.session.models?.revision || 0} · ${target?.title || target?.taskId || ""}：${statuses[target?.status] || ""}。运行中停止重试会等待当前批次安全收尾；不停止其他任务。`;
}
async function loadRuntimeModelChoices() {
  const plan = state.planning, workspaceId = state.workspace?.workspaceId, taskId = $("#runtime-model-task").value;
  if (!plan || !workspaceId || !taskId) return;
  const entry = plan.draft?.plan.tasks.find(item => item.task.id === taskId), runnerId = entry?.task.execution.runnerId;
  if (!runnerId) return;
  const identity = `${workspaceId}:${plan.planningId}:${taskId}`, request = state.runtimeModelRequest = (state.runtimeModelRequest || 0) + 1;
  const select = $("#runtime-model-choice"); select.replaceChildren(new Option("沿用草案模型", ""), new Option("自定义模型…", "__custom__")); $("#runtime-model-custom").value = "";
  try {
    const catalog = await api(`/api/v1/runners/${encodeURIComponent(runnerId)}/models?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (request !== state.runtimeModelRequest || `${state.workspace?.workspaceId}:${state.planning?.planningId}:${$("#runtime-model-task").value}` !== identity) return;
    for (const model of catalog.models || []) select.add(new Option(model.label || model.id, model.id), select.options.length - 1);
    const saved = plan.session?.models?.overrides?.[taskId]?.modelId;
    if (saved) { if (![...select.options].some(item => item.value === saved)) select.add(new Option(saved, saved), select.options.length - 1); select.value = saved; }
  } catch { $("#runtime-model-status").textContent = "候选模型暂不可读，可输入 Runner 支持的自定义模型 ID。"; }
  show($("#runtime-model-custom").parentElement, select.value === "__custom__");
}
async function changeRuntimeModel(stopAndRetry) {
  const plan = state.planning, workspaceId = state.workspace?.workspaceId, taskId = $("#runtime-model-task").value;
  const task = plan?.session?.tasks.find(item => item.taskId === taskId); if (!plan || !workspaceId || !task || state.runtimeModelSubmitting) return;
  const value = $("#runtime-model-choice").value, modelId = value === "__custom__" ? $("#runtime-model-custom").value.trim() : value || null;
  if (value === "__custom__" && !modelId) { $("#runtime-model-status").textContent = "请填写自定义模型 ID；尚未提交。"; return; }
  if (!await askConfirm(stopAndRetry ? "停止当前任务并换模型重试" : "设置后续执行模型", `${task.title || taskId} → ${modelId || "草案模型"}。旧 Attempt 和文件保留，不回滚修改；独立 worktree 的未完成改动保留在原目录。`, stopAndRetry ? "停止并重试" : "应用模型", stopAndRetry)) return;
  state.runtimeModelSubmitting = true; renderRuntimeModelPanel(plan.session.tasks);
  const body = { taskId, modelId, expectedRevision: plan.session.models?.revision || 0, stopAndRetry, confirmed: true, ...(stopAndRetry ? { expectedAttemptId: task.activeAttemptId } : {}) };
  try { await startJob(stopAndRetry ? `换模型重试 ${taskId}` : `更新任务模型 ${taskId}`, requestKey => api(`/api/v1/workspaces/${workspaceId}/plannings/${plan.planningId}/session/models`, { method: "POST", body: JSON.stringify({ requestKey, ...body }) }), false, true); }
  finally { state.runtimeModelSubmitting = false; if (state.planning?.planningId === plan.planningId) renderRuntimeModelPanel(state.planning.session.tasks); }
}
function renderSession() {
  const box = $("#task-list"); const session = state.planning.session;
  renderSessionContinue(session);
  const tasks = session?.tasks || [], running = tasks.filter(task => task.status === "running");
  const waiting = state.planning.interactions ? state.planning.interactions.length : state.waitingInteractions || 0;
  $("#session-progress").textContent = session ? `${waiting ? "等待人工处理" : statuses[session.status] || session.status} · 成功 ${tasks.filter(task => task.status === "succeeded").length}/${tasks.length} · 运行中 ${running.length} · 失败 ${tasks.filter(task => ["failed", "timed_out"].includes(task.status)).length} · 中断 ${tasks.filter(task => task.status === "interrupted").length} · 取消 ${tasks.filter(task => task.status === "cancelled").length} · 依赖等待 ${tasks.filter(task => ["planned", "blocked"].includes(task.status)).length} · 并发上限 ${session.maxParallel || 1}` : "尚未启动 Session";
  const health = session?.health;
  show($("#session-health"), !!session);
  $("#session-health-title").textContent = health ? `${statuses[session.status] || session.status} · 已检测 ${new Date(health.checkedAt).toLocaleTimeString()}` : "执行状态尚未检测";
  $("#session-health-message").textContent = health?.message || "点击重新检测确认执行进程状态。";
  $("#session-health").classList.toggle("notice-warn", !!health && health.state !== "active" && session.status !== "succeeded");
  show($("#session-recover"), !!health?.recoveryRequired);
  $("#session-progress").className = `session-progress ${statusClass(session?.status)}`;
  renderTaskDependencies(tasks); renderLiveTaskReplies(tasks); renderRuntimeModelPanel(tasks);
  renderAttemptChoices(tasks);
  if (!session?.tasks) { box.innerHTML = `<div class="empty-state">${state.planning.status === "approved" ? "草案已批准，点击“运行计划”启动。" : "完成审查和批准后，任务进度会显示在这里。"}</div>`; return; }
  ensureTaskBoard(box);
  const existingRows = new Map([...box.querySelectorAll(".task-row")].map(row => [row.dataset.taskId, row]));
  for (const [id, row] of existingRows) if (!tasks.some(task => task.taskId === id)) row.remove();
  for (const task of session.tasks) {
    const row = existingRows.get(task.taskId) || document.createElement("div"); row.className = "task-row"; row.dataset.taskId = task.taskId;
    const target = box.querySelector(`[data-group="${taskBoardGroup(task.status)}"] .task-board-rows`);
    if (row.parentElement !== target) target.append(row);
    const dependencyStates = (task.dependsOn || state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId)?.dependsOn || []).map(id => { const dependency = tasks.find(item => item.taskId === id); return [id, dependency?.status, dependency?.title]; });
    const signature = JSON.stringify([task, dependencyStates, session.models?.overrides?.[task.taskId], session.health?.state, session.health?.recoveryRequired, state.taskActivity?.[task.taskId]]);
    const elapsedText = task.currentAttempt?.startedAt ? ` · 耗时 ${Math.max(0, Math.floor(((task.currentAttempt.finishedAt ? Date.parse(task.currentAttempt.finishedAt) : Date.now()) - Date.parse(task.currentAttempt.startedAt)) / 1000))} 秒` : "";
    if (row.dataset.signature === signature) { const clock = row.querySelector(".task-elapsed"); if (clock) clock.textContent = elapsedText; continue; }
    const expanded = !!row.querySelector("details[open]"); row.dataset.signature = signature;
    const status = task.status; const icon = status === "succeeded" ? "✓" : status === "failed" ? "!" : status === "running" ? "◌" : status === "blocked" ? "Ⅱ" : "·";
    const definition = state.planning.draft?.plan.tasks.find(entry => entry.task.id === task.taskId);
    const attempt = task.currentAttempt, execution = attempt?.execution || task.execution || definition?.task.execution || {};
    const runner = attempt?.runnerId || execution.runnerId || "未知 Runner";
    const model = attempt?.reportedModel ? `${attempt.reportedModel}（Runner 已报告）` : execution.modelId ? `${execution.modelId}（配置模型）` : "沿用 Runner 默认，实际模型未报告";
    const elapsed = attempt?.startedAt ? ` · 耗时 ${Math.max(0, Math.floor(((attempt.finishedAt ? Date.parse(attempt.finishedAt) : Date.now()) - Date.parse(attempt.startedAt)) / 1000))} 秒` : "";
    const recent = attempt?.activity || state.taskActivity?.[task.taskId];
    row.innerHTML = `<span class="task-icon ${status}">${icon}</span><span><span class="task-name">${esc(task.title || definition?.task.title || task.taskId)}</span><span class="task-sub">${esc(task.taskId)} · ${esc(runner)} / ${esc(model)}</span><span class="task-sub">${task.attempts?.length || 0} 次 attempt<span class="task-elapsed">${elapsed}</span>${task.reasonCode ? ` · ${esc(task.reasonCode)}` : ""}</span><span class="task-sub">${esc(recent || (status === "planned" ? `等待依赖：${(task.dependsOn || definition?.dependsOn || []).join("、") || "等待调度"}` : attempt?.lastActivityAt ? `最近活动：${new Date(attempt.lastActivityAt).toLocaleTimeString()}` : "等待输出"))}</span>${task.result?.summary ? `<details class="foldout"><summary>任务结果摘要${task.result.truncated ? "（已截断，查看完整回复）" : ""}</summary><pre>${esc(task.result.summary)}</pre></details>` : ""}</span><span class="badge ${statusClass(status)}">${esc(statuses[status] || status)}</span>`; if (expanded && row.querySelector("details")) row.querySelector("details").open = true;
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
    if (nextModel) { const note = document.createElement("span"); note.className = "task-sub"; note.textContent = `下次启动模型：${nextModel.modelId || "沿用草案"}；当前 Attempt 不原地变更`; row.children[1].append(note); }
    const id = task.activeAttemptId || task.attempts?.at(-1)?.attemptId;
    const conclusion = executionConclusion(status);
    if (conclusion) { const outcome = document.createElement("p"); outcome.className = `task-outcome ${statusClass(status)}`; outcome.textContent = conclusion; row.children[1].append(outcome); }
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
  const controls = $("#session-controls"), controlSignature = JSON.stringify([session.status, session.health?.state, session.health?.recoveryRequired, tasks.map(task => task.status), session.isolation?.mode]);
  acknowledgeResumedSession();
  if (controls.dataset.signature === controlSignature) return;
  controls.dataset.signature = controlSignature; controls.replaceChildren();
  if (session.status === "running") {
    const pause = document.createElement("button"); pause.className = "button button-quiet"; pause.textContent = "暂停 Session"; pause.addEventListener("click", () => startSessionAction("session/pause", "暂停 Session")); controls.append(pause);
    const cancel = document.createElement("button"); cancel.className = "button button-quiet"; cancel.textContent = "取消 Session"; cancel.addEventListener("click", () => startSessionAction("session/cancel", "取消 Session")); controls.append(cancel);
  }
  if (["interrupted", "blocked", "failed", "unavailable"].includes(session.status)) {
    const diagnose = document.createElement("button"); diagnose.className = "button button-quiet"; diagnose.textContent = "检查并恢复"; diagnose.addEventListener("click", diagnoseAndRecover); controls.append(diagnose);
  }
  if (session.status === "succeeded" && session.isolation?.mode === "git-worktree") {
    const delivery = document.createElement("button"); delivery.className = "button button-primary"; delivery.textContent = "生成交付报告"; delivery.addEventListener("click", () => startSessionAction("session/delivery", "生成交付报告")); controls.append(delivery);
  }

}
function sessionContinueAction(session) {
  const tasks = session?.tasks || [];
  if (!session) return { disabled: true, message: "启动 Session 后可从这里继续执行。" };
  if (session.status === "succeeded") return { disabled: true, message: "全部任务已完成，可查看结果或生成交付报告。" };
  if (session.health?.recoveryRequired) return { kind: "recover", message: "先核验 Runner 已停止并修复中断记录，再从此处继续。" };
  if (["running", "pausing"].includes(session.status) || tasks.some(task => task.status === "running") || ["active", "unknown", "identity_conflict"].includes(session.health?.state) || !session.health) return { disabled: true, message: "执行中或状态尚未核实；可使用“重新检测状态”。" };
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
  button.disabled = !!action.disabled || !!state.submittingJob || state.activeJob?.status === "running";
  button.textContent = action.kind === "recover" ? "核验断点状态" : "从断点继续执行";
  $("#session-continue-hint").textContent = action.message;
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
  const view = { workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, taskId, files: [] };
  state.taskResultView = view;
  $("#task-results-title").textContent = `${state.planning.session.tasks.find(task => task.taskId === taskId)?.title || taskId} · 生成结果`;
  $("#task-results-summary").textContent = "正在读取此任务的文件归属记录…"; $("#task-results-files").replaceChildren(); $("#task-results-error").textContent = "";
  show($("#task-results-preview-wrap"), false); show($("#task-results-more"), false); $("#task-results-dialog").showModal();
  await loadTaskResultPage(view, 0);
}
async function loadTaskResultPage(view, offset) {
  if (view.loading) return; view.loading = true; $("#task-results-more").disabled = true;
  try {
    const data = await api(`/api/v1/workspaces/${view.workspaceId}/plannings/${view.planningId}/tasks/${encodeURIComponent(view.taskId)}/files?offset=${offset}`);
    if (state.taskResultView !== view || state.workspace?.workspaceId !== view.workspaceId || state.planning?.planningId !== view.planningId) return;
    Object.assign(view, { files: [...view.files, ...data.files], nextOffset: data.nextOffset });
    $("#task-results-summary").textContent = `${data.message}\n执行目录：${data.executionDirectory || "未记录"}${data.commit ? `\n任务提交：${data.commit}` : ""}\n已显示 ${view.files.length}/${data.total} 个文件`;
    renderTaskResultFiles(view); show($("#task-results-more"), data.nextOffset !== null);
  } catch (error) { if (state.taskResultView === view) $("#task-results-error").textContent = error.message; }
  finally { view.loading = false; $("#task-results-more").disabled = false; }
}
function renderTaskResultFiles(view) {
  const root = $("#task-results-files"), wasOpen = !!root.querySelector("details[open]"); root.replaceChildren();
  const extra = document.createElement("details"); extra.className = "task-results-overflow foldout"; extra.open = wasOpen;
  const summary = document.createElement("summary"); summary.textContent = `展开其余 ${Math.max(0, view.files.length - 3)} 个文件`; extra.append(summary);
  for (const [index, file] of view.files.entries()) {
    const row = document.createElement("article"), path = document.createElement("code"), preview = document.createElement("button"), copy = document.createElement("button"); row.className = "task-result-file";
    path.textContent = file.absolutePath; path.title = file.path;
    preview.type = "button"; preview.className = "text-button"; preview.textContent = `预览 ${file.path}`; preview.addEventListener("click", () => void previewTaskResult(view, file.path));
    copy.type = "button"; copy.className = "text-button"; copy.textContent = "复制路径"; copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(file.absolutePath); showToast("文件路径已复制。"); } catch { showCopyFallback("复制生成文件路径", file.absolutePath); } });
    row.append(path, preview, copy); (index < 3 ? root : extra).append(row);
  }
  if (view.files.length > 3) root.append(extra);
}
async function previewTaskResult(view, path) {
  const request = view.previewRequest = (view.previewRequest || 0) + 1; $("#task-results-error").textContent = "";
  try {
    const data = await api(`/api/v1/workspaces/${view.workspaceId}/plannings/${view.planningId}/tasks/${encodeURIComponent(view.taskId)}/files?path=${encodeURIComponent(path)}`);
    if (state.taskResultView !== view || request !== view.previewRequest) return;
    $("#task-results-path").textContent = data.file.absolutePath; $("#task-results-preview").textContent = data.file.content + (data.file.truncated ? "\n[预览已截断]" : ""); show($("#task-results-preview-wrap"));
  } catch (error) { if (state.taskResultView === view && request === view.previewRequest) { show($("#task-results-preview-wrap"), false); $("#task-results-error").textContent = error.message; } }
}
function renderAttemptChoices(tasks) {
  const select = $("#attempt-select"), previous = select.value;
  const choices = tasks.flatMap(task => (task.attempts || []).map((attempt, index) => ({ ...attempt, taskId: task.taskId, label: `${task.title || task.taskId} · 第 ${index + 1} 次 · ${shortId(attempt.attemptId)}`, active: task.activeAttemptId === attempt.attemptId })));
  show($("#attempt-reader"), !!choices.length);
  show($("#attempt-empty"), !choices.length);
  const signature = JSON.stringify([state.workspace?.workspaceId, state.planning?.planningId, choices]);
  if (signature !== state.attemptChoiceSignature) {
    state.attemptChoiceSignature = signature; select.replaceChildren();
    for (const choice of choices) select.add(new Option(choice.label, choice.attemptId));
    select.value = choices.some(item => item.attemptId === previous) ? previous : choices.find(item => item.active)?.attemptId || choices[0]?.attemptId || "";
  }
  const projection = tasks.find(task => task.currentAttempt?.attemptId === select.value)?.currentAttempt;
  if (projection && state.attemptView?.attemptId === select.value && state.attemptView.workspaceId === state.workspace?.workspaceId && state.attemptView.planningId === state.planning?.planningId) {
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
  if (attemptId && [...$("#attempt-select").options].some(option => option.value === attemptId)) $("#attempt-select").value = attemptId;
  await selectAttempt();
  const target = $("#attempt-reader").classList.contains("hidden") ? $("#attempt-empty") : $("#attempt-reader");
  target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "smooth" });
}
async function selectAttempt() {
  const attemptId = $("#attempt-select").value;
  if (!attemptId || !state.workspace || !state.planning) return;
  const identity = `${state.workspace.workspaceId}:${state.planning.planningId}:${attemptId}`;
  if (state.attemptView?.identity !== identity) {
    state.attemptView = { identity, attemptId, workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId, cursor: 0, messages: new Map(), tools: [], raw: [], seen: new Set(), finalText: "", textStream: "", notice: "", loaded: false, toolsPage: 0, rawPage: 0 };
    $("#attempt-messages").replaceChildren(); $("#attempt-tools").replaceChildren(); $("#attempt-raw").textContent = "";
    await readSelectedAttempt();
  } else if (!state.attemptView.loaded || ["running", "created"].includes(state.attemptView.attempt?.status)) await readSelectedAttempt();
  else renderAttemptView();
}
function projectAttemptEvent(view, event) {
  if (view.seen.has(event.sequence)) return; view.seen.add(event.sequence);
  view.raw.push(event);
  const p = event.payload || {}, type = event.type;
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
  try {
    for (let page = 0; page < 3; page++) {
      const result = await api(`/api/v1/workspaces/${view.workspaceId}/plannings/${view.planningId}/attempts/${view.attemptId}/events?offset=${view.cursor}${view.fileId ? `&fileId=${encodeURIComponent(view.fileId)}` : ""}`);
      if (state.attemptView !== view) return;
      if (result.reset) { view.messages.clear(); view.seen.clear(); view.tools = []; view.raw = []; view.finalText = ""; view.textStream = ""; view.semanticMessages = false; view.toolsPage = 0; view.rawPage = 0; view.notice = "记录文件发生变化，已从头重新读取。"; }
      view.attempt = result.attempt; view.taskId = result.taskId; view.fileId = result.fileId; view.cursor = result.cursor; view.hasMore = result.hasMore; view.loaded = true;
      if (result.malformed) view.notice = `有 ${result.malformed} 条记录无法解析，原始文件可能不完整。`;
      for (const event of result.events) projectAttemptEvent(view, event);
      if (!result.hasMore) break;
    }
    renderAttemptView();
  } catch (error) { if (state.attemptView === view) { view.notice = `记录暂不可读：${error.message}；可刷新重试。`; renderAttemptView(); } }
  finally { view.loading = false; }
}
function renderAttemptView() { preserveExecutionReading(renderAttemptContent); }
function renderAttemptContent() {
  const view = state.attemptView; if (!view) return;
  const a = view.attempt || {}, box = $("#attempt-messages"), scrollTop = box.scrollTop;
  const model = a.reportedModel || view.reportedModel;
  $("#attempt-state").textContent = `${a.runnerId || "Runner"} / ${model ? `${model}（已报告）` : a.execution?.modelId ? `${a.execution.modelId}（配置模型）` : "实际模型未报告"} · ${statuses[a.status] || a.status || "读取中"}${a.reason ? ` · ${a.reason}` : ""}${a.exitCode === null || a.exitCode === undefined ? "" : ` · 退出码 ${a.exitCode}`}`;
  $("#attempt-notice").textContent = `${view.notice || ""}${view.hasMore ? " 还有历史内容待加载，当前不是完整记录。" : ""} 有更新时保留当前阅读位置。`;
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
  $("#attempt-reply-heading").textContent = ["created", "running"].includes(a.status) ? "模型回复 · 接收中" : "模型回复";
  const conclusion = executionConclusion(a.status);
  $("#attempt-outcome").textContent = [conclusion, a.reason, a.exitCode !== undefined && a.exitCode !== null ? `退出码 ${a.exitCode}` : ""].filter(Boolean).join(" · ");
  $("#attempt-outcome").className = `attempt-outcome ${statusClass(a.status)}`; show($("#attempt-outcome"), !!conclusion);
  const orderedMessages = messages.filter(item => item.text.trim()).reverse();
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
  const tools = $("#attempt-tools"), toolScroll = tools.scrollTop, rawScroll = $("#attempt-raw").scrollTop;
  const oldTools = new Map([...tools.querySelectorAll("details")].map(item => [item.dataset.eventKey, item]));
  const toolPage = activityPage(view, "tools", view.tools);
  for (const [eventKey, element] of oldTools) if (!toolPage.some(tool => String(tool.sequence) === eventKey)) element.remove();
  for (const [index, tool] of toolPage.entries()) { const details = oldTools.get(String(tool.sequence)) || document.createElement("details"), signature = JSON.stringify(tool);
    if (details.dataset.signature !== signature) { details.dataset.signature = signature; details.replaceChildren(); const summary = document.createElement("summary"), pre = document.createElement("pre"); details.className = "foldout"; details.dataset.eventKey = String(tool.sequence); if (tool.exitCode && tool.exitCode !== 0 || tool.type === "stderr") details.classList.add("activity-error"); summary.textContent = `${tool.timestamp ? new Date(tool.timestamp).toLocaleTimeString() + " · " : ""}${tool.type}${tool.exitCode === undefined ? "" : ` · 退出码 ${tool.exitCode}`} · ${tool.text.slice(0, 180)}`; pre.textContent = [tool.text, tool.output].filter(Boolean).join("\n"); details.append(summary, pre); }
    if (tools.children[index] !== details) tools.insertBefore(details, tools.children[index] || null);
  }
  const filter = $("#attempt-event-filter").value.trim();
  const raw = view.raw.filter(event => !filter || event.type.includes(filter) || event.payload?.stream === filter);
  $("#attempt-raw").textContent = activityPage(view, "raw", raw).map(event => JSON.stringify(event)).join("\n");
  tools.scrollTop = toolScroll; $("#attempt-raw").scrollTop = rawScroll;
  show($("#attempt-more"), !!view.hasMore);
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
function activityPage(view, kind, items) {
  const size = 15, pages = Math.max(1, Math.ceil(items.length / size));
  view[`${kind}Page`] = Math.max(0, Math.min(view[`${kind}Page`] || 0, pages - 1));
  const page = view[`${kind}Page`];
  $("#attempt-" + kind + "-page").textContent = `第 ${page + 1} / ${pages} 页 · 已加载 ${items.length} 条${view.hasMore ? "（还有历史待加载）" : ""}`;
  $("#attempt-" + kind + "-prev").disabled = page === 0;
  $("#attempt-" + kind + "-next").disabled = page + 1 >= pages;
  return items.slice(page * size, (page + 1) * size);
}
function startSessionAction(action, label, extra = {}) {
  return startJob(label, (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/${action}`, { method: "POST", body: JSON.stringify({ requestKey, ...extra }) }));
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
  $("#pending-approval-count").textContent = `${items.length} 项`;
  $("#pending-approval-summary").textContent = items.length ? "执行正在等待你的决定。核对任务、命令和原因后选择允许或拒绝；问题填写后单独提交。" : "当前没有待处理请求。仅用户明确确认后才会允许工具执行。";
  $("#pending-approval-box").classList.toggle("has-pending", !!items.length);
  show($("#pending-action-banner"), !!items.length);
  $("#pending-action-label").textContent = `${items.length} 项等待你审批／回答 · ${state.workspace.label}`;
  notifyPendingApprovals(items);
  const signature = JSON.stringify([workspaceId, planningId, items]);
  if (state.interactionSignature === signature) return;
  state.interactionSignature = signature;
  const answers = new Map([...root.querySelectorAll("input[data-question-id]")].map(input => [input.id, input.value]));
  root.replaceChildren(); state.waitingInteractions = items.length; renderPlanOverview();
  for (const interaction of items) {
    const card = document.createElement("div"); card.className = "interaction-card";
    const request = interaction.request;
    card.innerHTML = `<h4>${esc(labels[interaction.owner.runnerId] || interaction.owner.runnerId)} 请求人工处理 · ${esc(request.title)}</h4><p class="small">任务 ${esc(interaction.owner.taskId)}</p>`;
    const reason = document.createElement("p"); reason.className = "approval-reason"; reason.textContent = request.summary || "Runner 请求人工处理"; card.append(reason);
    if (request.kind === "approval") {
      if (request.operation?.command) { const label = document.createElement("strong"); label.className = "approval-field-label"; label.textContent = "待审批命令"; const command = document.createElement("pre"); command.className = "approval-command"; command.textContent = request.operation.command; card.append(label, command); }
      if (request.cwd) { const cwd = document.createElement("p"); cwd.className = "hint"; cwd.textContent = `工作目录：${request.cwd}`; card.append(cwd); }
      const actions = document.createElement("div"); actions.className = "interaction-actions";
      for (const [decision, text] of [["allow-once", "本次允许"], ["deny", "拒绝本次操作"]]) {
        const button = document.createElement("button"); button.className = `button ${decision === "allow-once" ? "button-primary" : "button-quiet"}`; button.textContent = text;
        button.addEventListener("click", () => respondInteraction(interaction.requestId, { kind: "approval", decision })); actions.append(button);
      }
      if (["codex", "claude-code"].includes(interaction.owner.runnerId)) {
        const custom = document.createElement("details"); custom.className = "approval-guidance";
        const summary = document.createElement("summary"); summary.textContent = "NO，告诉 Runner 接下来怎么调整";
        const guidance = document.createElement("textarea"); guidance.maxLength = 4096; guidance.rows = 3; guidance.placeholder = "描述允许的替代方案或需要删除的动作。当前工具请求仍会被拒绝。";
        const apply = document.createElement("button"); apply.type = "button"; apply.className = "button button-quiet"; apply.textContent = "拒绝并提交指导";
        const note = document.createElement("p"); note.className = "hint"; note.textContent = "Codex／Claude Code 会在当前 Attempt 中收到调整说明；新的工具请求仍需单独审批。";
        apply.addEventListener("click", () => { const text = guidance.value.trim(); if (!text) { showToast("请填写调整指导，或直接选择拒绝本次操作。", true); return; } void respondInteraction(interaction.requestId, { kind: "approval", decision: "deny", guidance: text }); });
        custom.append(summary, guidance, note, apply); card.append(actions, custom);
      } else card.append(actions);
    } else {
      for (const question of request.questions || []) {
        const label = document.createElement("label"); label.className = "small"; label.textContent = question.text;
        const input = document.createElement("input"); input.id = `interaction-answer:${interaction.requestId}:${question.id}`; input.dataset.questionId = question.id; input.value = answers.get(input.id) || ""; input.placeholder = "输入回答"; label.append(input); card.append(label);
      }
      const button = document.createElement("button"); button.className = "button button-primary"; button.textContent = "提交回答"; button.addEventListener("click", () => {
        const answers = [...card.querySelectorAll("input[data-question-id]")].map((input) => ({ questionId: input.dataset.questionId, text: input.value })); void respondInteraction(interaction.requestId, { kind: "question", answers });
      }); card.append(button);
    }
    root.append(card);
  }
  });
}
async function respondInteraction(requestId, reply) {
  try { await api(`/api/v1/workspaces/${state.workspace.workspaceId}/interactions/${requestId}`, { method: "POST", body: JSON.stringify(reply) }); showToast("已提交给对应 Runner。"); await renderInteractions(); }
  catch (error) { showToast(error.message, true); }
}
function notifyPendingApprovals(items) {
  state.notifiedRequests ??= new Set();
  const fresh = items.filter(item => !state.notifiedRequests.has(item.requestId));
  for (const item of fresh) state.notifiedRequests.add(item.requestId);
  const base = `${state.planning?.draft?.plan.title || "Token Coupon"} · Token Coupon`;
  document.title = items.length ? `【${items.length} 项待审批】${base}` : base;
  if (fresh.length && typeof Notification !== "undefined" && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
    try { const workspaceId = state.workspace?.workspaceId, planningId = state.planning?.planningId; const note = new Notification("Token Coupon · 需要你的决定", { body: `${fresh.length} 个新请求，打开本机页面核对后允许或拒绝。`, tag: `tc-${state.workspace?.workspaceId}-${state.planning?.planningId}` }); note.onclick = () => { window.focus(); if (workspaceId && planningId) void navigate(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planningId)}/execution`); note.close(); }; } catch { $("#notification-status").textContent = "系统通知不可用，仍保留页签和页面提醒。"; }
  }
  while (state.notifiedRequests.size > 500) state.notifiedRequests.delete(state.notifiedRequests.values().next().value);
}
function statusClass(status) { if (["succeeded", "approved"].includes(status)) return "badge-success"; if (["failed", "timed_out", "cancelled", "interrupted"].includes(status)) return "badge-error"; if (["running", "pausing", "blocked", "paused", "unavailable"].includes(status)) return "badge-warning"; return "badge-neutral"; }

async function startJob(label, submit, waitForCompletion = false, allowDuringExecution = false) {
  if (!state.workspace) return;
  if (state.submittingJob || state.activeJob?.status === "running" && !allowDuringExecution) { showToast("当前已有操作正在运行，完成后再提交下一步。", true); return; }
  state.submittingJob = true; const context = { workspaceId: state.workspace.workspaceId, planningId: state.planning?.planningId, sessionId: state.planning?.session?.sessionId, submittedAt: Date.now(), label };
  state.jobContext = context; show($("#job-bar")); $("#job-bar").dataset.state = "running"; $("#job-label").textContent = `${label} · 正在提交…`; show($("#job-bar .spinner")); show($("#job-view-result"), false); show($("#cancel-job"), false);
  try {
    const job = await submit(key()); state.activeJob = job; state.jobContexts ??= new Map(); state.jobContexts.set(job.jobId, context); state.submittingJob = false; show($("#cancel-job"), job.status === "running"); show($("#job-bar")); $("#job-label").textContent = `${label} · ${job.status === "running" ? "处理中" : statuses[job.status] || job.status}`;
    if (job.status === "running") {
      acknowledgeResumedSession();
      const completion = pollJob(job.jobId, label);
      if (waitForCompletion) return await completion;
    } else await completeJob(job, label);
    return job;
  } catch (error) { state.submittingJob = false; $("#job-bar").dataset.state = "failed"; $("#job-label").textContent = `${label} · 提交未完成：${error.message}`; show($("#job-bar .spinner"), false); show($("#cancel-job"), false); showToast(error.message, true); return undefined; }
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
    state.activeJob = job;
    if (job.status !== "running") { await completeJob(job, label); return job; }
  }
}
async function completeJob(job, label) {
  const context = state.jobContexts?.get(job.jobId) || state.jobContext; state.jobContexts?.delete(job.jobId);
  const domainStatus = job.result?.status;
  const executionFailed = job.status === "succeeded" && ["failed", "cancelled", "interrupted", "blocked"].includes(domainStatus);
  $("#job-bar").dataset.state = executionFailed ? "failed" : job.status;
  $("#job-label").textContent = `${label} · ${executionFailed ? `操作已结束，任务${statuses[domainStatus] || domainStatus}` : job.status === "succeeded" ? "已完成" : statuses[job.status] || job.status}${job.error ? `：${job.error}` : ""}`;
  if (job.kind?.startsWith("session.model") && job.result?.effect) $("#job-label").textContent += ` · ${job.result.effect}`;
  show($("#job-bar")); show($("#job-bar .spinner"), false); show($("#cancel-job"), false); show($("#job-view-result"), !!context?.planningId);
  $("#job-view-result").textContent = job.kind === "session.recover" ? "查看恢复状态" : "查看任务结果";
  $("#job-view-result").onclick = () => void openOperationResult(context, job);
  state.activeJob = null;
  if (job.kind === "planning.run") { state.runRequestKey = null; state.runInFlight = false; }
  if (job.status === "succeeded") {
    showToast(executionFailed ? `${label}已结束，任务${statuses[domainStatus] || domainStatus}；详情与恢复入口见执行页。` : ["external_context", "handoff_claim"].includes(job.result?.nextAction) ? "输入已登记，等待网页通过 MCP 读取并提交结果。" : `${label}已完成。`);
    if (job.kind === "session.delivery" && typeof job.result?.instructions === "string") addLog(job.result.instructions, "delivery");
    const planningId = job.result?.planningId;
    if (planningId && job.workspaceId === state.workspace?.workspaceId && state.route?.page === "new") await loadPlanningListAndSelect(planningId);
    await refreshAll();
    if (job.kind === "planning.approve" && state.planning?.planningId === job.result?.planningId && state.planning?.status === "approved") await planTab("execution");
    if (state.planning && isWebMcp(state.planning.config.provider) && (job.kind === "planning.draft.save" || ["external_context", "handoff_claim"].includes(job.result?.nextAction))) {
      show($("#web-continue")); $("#web-continue-status").textContent = "本地已保存或登记修订，等待网页处理。复制提示到获准网页发送一次，继续当前计划并复审。";
    }
  } else showToast(job.error || `操作状态：${statuses[job.status] || job.status}`, job.status !== "interrupted", "execution");
}
async function openOperationResult(context, job) {
  if (!context?.workspaceId || !context?.planningId) { showToast("该操作未关联计划，请从工作区选择规划记录。", true); return; }
  try {
    await navigate(`/workspaces/${encodeURIComponent(context.workspaceId)}/plans/${encodeURIComponent(context.planningId)}/execution`);
    if (state.workspace?.workspaceId !== context.workspaceId || state.planning?.planningId !== context.planningId || state.route?.tab !== "execution") return;
    await loadPlanning(context.planningId);
    if (state.planning?.planningId !== context.planningId || state.workspace?.workspaceId !== context.workspaceId) return;
    const session = state.planning.session;
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
  if (state.creatingWorkspace && authorization && !target) { state.creatingWorkspace = false; state.folderSelectionGeneration = (state.folderSelectionGeneration || 0) + 1; }
  const host = target || $("#workspace-form-host"); if ($("#workspace-form").parentElement !== host) host.append($("#workspace-form"));
  const creating = !!state.creatingWorkspace; show($("#workspace-form"), creating);
  for (const id of ["workspace-selection-tools", "workspace-cards"]) show($("#" + id), !creating || authorization);
  show($("#workspace-selection-heading"));
  for (const [id, active] of [["workspace-existing", !creating], ["add-workspace-main", creating]]) { $("#" + id).classList.toggle("active", active); $("#" + id).setAttribute("aria-pressed", String(active)); }
}
function closeWorkspaceForm() {
  state.creatingWorkspace = false; state.folderSelectionGeneration = (state.folderSelectionGeneration || 0) + 1;
  state.workspaceFormContext = null;
  for (const id of ["workspace-path", "workspace-label"]) $("#" + id).value = "";
  $("#workspace-selected-path").textContent = "尚未选择文件夹"; $("#workspace-manual-path").open = false;
  show($("#workspace-path-error"), false); $("#workspace-path").removeAttribute("aria-invalid");
  renderWorkspaceFormMode(); show($("#action-feedback"), false);
}
async function openWorkspaceForm(requestId) {
  const authorization = typeof requestId === "string";
  if (authorization) {
    if (state.route?.page !== "connect" || !authorizationFormHost(requestId)) return;
  } else {
    await navigate("/workspaces"); if (state.route?.page !== "workspaces" || state.workspace) return;
  }
  state.workspaceFormContext = authorization ? { kind: "authorization", requestId } : { kind: "project" };
  state.creatingWorkspace = true; state.folderSelectionGeneration = (state.folderSelectionGeneration || 0) + 1;
  $("#workspace-path").value = ""; $("#workspace-label").value = ""; $("#workspace-selected-path").textContent = "尚未选择文件夹";
  show($("#workspace-path-error"), false); renderWorkspaceFormMode(); await openDirectoryPicker();
}
$("#workspace-form-back").addEventListener("click", closeWorkspaceForm);
$("#workspace-existing").addEventListener("click", closeWorkspaceForm);
$("#workspace-back").addEventListener("click", () => void navigate("/workspaces"));
$("#add-workspace-toggle").addEventListener("click", () => void openWorkspaceForm());
$("#add-workspace-main").addEventListener("click", () => void openWorkspaceForm());
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
  const prompt = [
    "使用 Token Coupon MCP，为已授权项目开始一次新的规划。",
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
    "批准、执行和 Runner 工具审批由我在 4177 操作。",
    "我的需求／项目内参考文件：",
    ...(state.referenceFile ? [`先通过 repository_query 读取项目内文件：${JSON.stringify(state.referenceFiles?.length ? state.referenceFiles : [state.referenceFile])}，再规划；本机预览不能代替本轮读取证据。`] : []),
  ].join("\n");
  try { await navigator.clipboard.writeText(prompt); showToast("网页规划提示已复制。到对应网页粘贴，再补充需求或相对文件路径；尚未创建规划。"); }
  catch { showCopyFallback("复制网页规划提示", prompt); }
});
$("#start-planning").addEventListener("click", async () => {
  const request = $("#request-text").value.trim(); if (!request) { showToast("先写下需求。", true); return; }
  if (!await confirmPlanChanges()) return;
  const provider = $("#planner-provider").value;
  const model = $("#planner-model").value.trim();
  const payload = { request, provider, ...(model ? { model } : {}), executionDefaults: { runnerId: $("#runner-id").value, mode: "managed", ...( $("#runner-model").value.trim() ? { modelId: $("#runner-model").value.trim() } : {}) } };
  const job = await startJob("开始规划", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings`, { method: "POST", body: JSON.stringify({ ...payload, requestKey }) }));
  if (job && ["running", "succeeded"].includes(job.status)) $("#request-text").value = "";
});
$("#new-task").addEventListener("click", startNewTask);
$("#new-task-sidebar").addEventListener("click", startNewTask);
$("#refresh-models").addEventListener("click", () => { void loadRunnerModels(true); void loadPlannerModels(true); });
$("#reply-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (state.replying) return;
  const message = $("#reply-text").value.trim();
  if (!message) { showToast("请先填写回复。", true); return; }
  if (!state.planning) { showToast("请先选择一个规划。", true); return; }
  if (!await confirmPlanChanges()) return;
  const path = `/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/replies`;
  state.replying = true; $("#reply-text").disabled = true; renderRequirements();
  try {
    const job = await startJob("提交回复", (requestKey) => api(path, { method: "POST", body: JSON.stringify({ requestKey, message }) }), true);
    if (job?.status === "succeeded") $("#reply-text").value = "";
  } finally { state.replying = false; $("#reply-text").disabled = false; if (state.planning) renderRequirements(); }
});
$("#review-button").addEventListener("click", async () => {
  if (!state.planning || !await confirmPlanChanges()) return;
  if (isWebMcp(state.planning.config.provider) && state.planning.workflow?.role === "review") { await copyResumePrompt(); return; }
  await startJob("审查草案", (requestKey) => api(`/api/v1/workspaces/${state.workspace.workspaceId}/plannings/${state.planning.planningId}/review`, { method: "POST", body: JSON.stringify({ requestKey }) }));
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
  if (config.needsReconfirm || !config.mode || $("#run-configuration-error").textContent) { showToast($("#run-configuration-error").textContent || "请先确认本次启动参数。", true); return; }
  const candidates = verificationCandidates(plan, state.planning.verificationTasks);
  const body = { isolation: config.isolation, maxParallel: Number(config.maxParallel), ...(config.isolation === "git-worktree" ? { verificationTaskId: config.verificationTaskId } : {}) };
  if (body.isolation === "shared" && body.maxParallel !== 1) { showToast("共享工作区只支持单任务串行。", true); return; }
  if (body.isolation === "git-worktree" && !candidates.some(item => item.taskId === body.verificationTaskId)) { showToast("所选最终验证任务与当前草案依赖不一致，请重新选择。", true); return; }
  if (body.isolation === "git-worktree" && !await refreshGitReadiness(true)) { showToast(state.gitReadiness?.message || "请先完成 Git 执行准备。", true); return; }
  state.runInFlight = true; state.runRequestKey ||= key(); renderRunConfiguration();
  const requestKey = state.runRequestKey;
  const job = await startJob("运行计划", () => api("/api/v1/workspaces/" + state.workspace.workspaceId + "/plannings/" + state.planning.planningId + "/run", { method: "POST", body: JSON.stringify({ requestKey, ...body }) }));
  if (!job) state.runRequestKey = null;
  state.runInFlight = false; renderRunConfiguration();
});
function persistRunConfiguration() {
  if (!state.runConfiguration || !state.runConfigKey) return;
  state.runConfiguration.edited = true; state.runConfiguration.needsReconfirm = false;
  state.runConfiguration.mode = document.querySelector('input[name="run-mode-choice"]:checked')?.value || state.runConfiguration.mode;
  state.runConfiguration.maxParallel = Number($("#run-parallel").value);
  state.runConfiguration.isolation = $("#run-isolation").value;
  state.runConfiguration.verificationTaskId = $("#run-verification").value;
  if (state.runConfiguration.isolation === "shared") { state.runConfiguration.maxParallel = 1; $("#run-parallel").value = "1"; }
  try { localStorage.setItem(state.runConfigKey, JSON.stringify(state.runConfiguration)); } catch { /* Keep current selection in memory. */ }
  renderRunConfiguration();
}
for (const input of document.querySelectorAll('input[name="run-mode-choice"]')) input.addEventListener("change", persistRunConfiguration);
for (const id of ["run-parallel", "run-isolation", "run-verification"]) $("#" + id).addEventListener("change", persistRunConfiguration);
$("#revise-run-tasks")?.remove();
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
$("#refresh").addEventListener("click", () => { void refreshAll(); void refreshRemoteConnection(); }); $("#reconnect").addEventListener("click", () => { state.reconnectAttempts = 0; void init(); }); $("#clear-log").addEventListener("click", () => { $("#event-log").replaceChildren(); });
$("#toast-close").addEventListener("click", () => { clearTimeout(state.toastTimer); show($("#toast"), false); });
$("#budget-extension-confirm").addEventListener("click", () => void confirmBudgetExtension());
$("#budget-extension-cancel").addEventListener("click", () => { $("#budget-extension-dialog").close(); state.budgetOperationId = null; });
$("#confirm-action-yes").addEventListener("click", () => settleConfirmAction(true));
$("#confirm-action-no").addEventListener("click", () => settleConfirmAction(false));
$("#confirm-action-dialog").addEventListener("cancel", event => { event.preventDefault(); settleConfirmAction(false); });
$("#session-continue").addEventListener("click", openSessionContinue);
$("#session-continue-confirm").addEventListener("click", () => void confirmSessionContinue());
$("#session-continue-cancel").addEventListener("click", () => { $("#session-continue-dialog").close(); state.continueContext = null; });
$("#dag-close").addEventListener("click", () => $("#dag-dialog").close());
$("#dag-zoom-in").addEventListener("click", () => setTaskDagZoom((state.dagView?.zoom || 1) + 0.25));
$("#dag-zoom-out").addEventListener("click", () => setTaskDagZoom((state.dagView?.zoom || 1) - 0.25));
$("#dag-fit").addEventListener("click", fitTaskDag);
$("#dag-reset").addEventListener("click", () => setTaskDagZoom(1));
$("#dag-dialog").addEventListener("click", event => { if (event.target === $("#dag-dialog")) $("#dag-dialog").close(); });
$("#dag-dialog").addEventListener("close", () => { state.dagView = null; });
$("#task-results-close").addEventListener("click", () => { $("#task-results-dialog").close(); state.taskResultView = null; });
$("#task-results-dialog").addEventListener("cancel", () => { state.taskResultView = null; });
$("#task-results-more").addEventListener("click", () => { const view = state.taskResultView; if (view && view.nextOffset !== null) void loadTaskResultPage(view, view.nextOffset); });
$("#copy-fallback-close").addEventListener("click", () => $("#copy-fallback-dialog").close());
$("#copy-fallback-select").addEventListener("click", () => { $("#copy-fallback-text").focus(); $("#copy-fallback-text").select(); });
$("#copy-fallback-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("#copy-fallback-text").value); $("#copy-fallback-dialog").close(); showToast("文本已复制。"); } catch { $("#copy-fallback-text").focus(); $("#copy-fallback-text").select(); showToast("浏览器仍未授予剪贴板权限，请按 Ctrl+C 复制选中文本。", true); } });
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
  try { await navigator.clipboard.writeText(url); $("#remote-copy-feedback").textContent = "已复制当前已验证地址。粘贴到 ChatGPT／Claude 的 MCP 连接设置，再发起 OAuth。"; $("#reuse-copy-feedback").textContent = "已复制当前 MCP 地址。"; showToast("当前 MCP 地址已复制。"); }
  catch { $("#remote-mcp-url").select(); $("#remote-copy-feedback").textContent = "无法访问剪贴板，地址已选中，请按 Ctrl+C 复制。"; $("#reuse-copy-feedback").textContent = "地址已选中，请按 Ctrl+C 复制。"; showToast("请复制已选中的地址。", true); }
});
$("#remote-stop").addEventListener("click", async () => {
  if (!await askConfirm("停止公网连接", "停止后将撤销现有网页授权。再次建立快捷连接时地址可能变化，需要在网页更新并重新授权。已有计划和执行任务会保留。", "停止连接", true)) return;
  state.connectionFlow = null;
  return changeRemote(() => api("/api/v1/remote-connection/stop", { method: "POST", body: "{}" }), "连接已停止。需要新地址时再点击新建快捷连接，并更新网页配置。");
});
$("#remote-cancel").addEventListener("click", () => $("#remote-stop").click());
$("#remote-refresh").addEventListener("click", () => void refreshRemoteConnection());
async function openReferenceFiles() {
  if (!state.workspace || !await confirmPlanChanges() || state.nativePicking) return;
  const workspaceId = state.workspace.workspaceId; state.nativePicking = true;
  showActionFeedback("正在打开 Windows 文件选择", "可多选当前工作区的参考文件，取消不会修改当前规划。");
  try {
    const result = await api("/api/v1/native-picker", { method: "POST", body: JSON.stringify({ kind: "files", workspaceId }) });
    if (workspaceId !== state.workspace?.workspaceId) return;
    if (result.cancelled) { showActionFeedback("已取消选择", "未更改规划参考文件。"); return; }
    state.fileWorkspace = workspaceId; state.fileChosen = null; state.fileSelections = new Set(result.paths); state.filePath = ".";
    const root = $("#file-list"); root.replaceChildren();
    for (const path of result.paths) { const row = document.createElement("label"), checkbox = document.createElement("input"), button = document.createElement("button"); row.className = "file-choice"; checkbox.type = "checkbox"; checkbox.checked = true; checkbox.setAttribute("aria-label", `选择参考文件 ${path}`); checkbox.addEventListener("change", () => { checkbox.checked ? state.fileSelections.add(path) : state.fileSelections.delete(path); renderFileSelection(); }); button.type = "button"; button.className = "file-entry"; button.textContent = path; button.addEventListener("click", () => previewReferenceFile(path)); row.append(checkbox, button); root.append(row); }
    show($("#file-parent"), false); show($("#file-more"), false); $("#file-current-path").textContent = "系统选择的参考文件"; show($("#file-preview-wrap"), false); renderFileSelection(); $("#file-dialog").showModal();
    showActionFeedback("已选择参考文件", `共 ${result.paths.length} 个，可预览后用于新 Plan。`);
  } catch (error) { showActionFeedback("文件选择未完成", error.message, "validation"); }
  finally { state.nativePicking = false; }
}
function closeNavigation() { document.body.classList.remove("navigation-open"); $("#mobile-navigation").setAttribute("aria-expanded", "false"); }
$("#mobile-navigation").addEventListener("click", () => { const opened = document.body.classList.toggle("navigation-open"); $("#mobile-navigation").setAttribute("aria-expanded", String(opened)); });
$("#sidebar-close").addEventListener("click", closeNavigation);
$("#nav-backdrop").addEventListener("click", closeNavigation);
window.addEventListener("keydown", event => { if (event.key === "Escape") closeNavigation(); });
async function listReferenceFiles(path, offset = 0) {
  const workspaceId = state.fileWorkspace, request = state.fileRequest = (state.fileRequest || 0) + 1;
  try {
    show($("#file-error"), false);
    const data = await api(`/api/v1/workspaces/${workspaceId}/repository?tool=repo_list&path=${encodeURIComponent(path)}&offset=${offset}`);
    if (request !== state.fileRequest || workspaceId !== state.fileWorkspace) return;
    state.filePath = data.path; state.fileNextOffset = data.nextOffset;
    const root = $("#file-list"); if (!offset) root.replaceChildren();
    $("#file-current-path").textContent = data.path;
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
    if (!root.children.length) root.innerHTML = '<div class="empty-state">目录中没有可浏览文件。</div>';
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
for (const button of document.querySelectorAll("[data-plan-tab]")) button.addEventListener("click", () => void planTab(button.dataset.planTab));
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
  const context = state.planning && state.workspace ? { workspaceId: state.workspace.workspaceId, planningId: state.planning.planningId } : state.connectionReturn;
  const prompt = ["通过当前选中的 Token Coupon MCP，仅做只读连接验证。请实际调用 workspace_query，汇总授权项目与真实工具回执；不创建 Planning、不领取或提交审查、不批准或执行。", context ? `核实后只读 planning_query：workspaceId=${context.workspaceId}，planningId=${context.planningId}，报告已有计划当前阶段。` : "工具不可用时，报告错误和追踪 ID（如有），不要用网页沙箱替代。"].join("\n");
  await copyHandoffPrompt(prompt);
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
$("#git-preview-selected").addEventListener("click", () => previewGitFromUI("selected"));
$("#git-preview-close").addEventListener("click", () => { $("#git-preview-dialog").close(); state.gitPreview = null; });
$("#git-confirm-commit").addEventListener("click", confirmGitCommit);
$("#git-save-identity").addEventListener("click", async () => {
  if (!state.workspace || !await askConfirm("保存仓库 Git 身份", `仅修改此仓库 Git 身份：${state.workspace.path}`, "保存身份")) return;
  await startJob("保存仓库身份", requestKey => api(`/api/v1/workspaces/${state.workspace.workspaceId}/git/identity`, { method: "POST", body: JSON.stringify({ requestKey, confirmed: true, name: $("#git-name").value, email: $("#git-email").value }) }), true);
  await refreshGitReadiness(true);
});
$("#attempt-select").addEventListener("change", selectAttempt);
$("#attempt-refresh").addEventListener("click", () => readSelectedAttempt(true));
$("#attempt-more").addEventListener("click", () => readSelectedAttempt(true));
$("#attempt-event-filter").addEventListener("input", () => { if (state.attemptView) state.attemptView.rawPage = 0; renderAttemptView(); });
$("#attempt-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("#attempt-messages").innerText || $("#attempt-messages").textContent); showToast("已复制当前加载的回复；如有更多历史请先继续加载。"); } catch { showToast("复制失败，可手工选择正文复制。", true); } });
$("#attempt-download").addEventListener("click", () => {
  if (!state.attemptView) return;
  const blob = new Blob([state.attemptView.raw.map(event => JSON.stringify(event)).join("\n") + "\n"], { type: "application/x-ndjson" }), url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `attempt-${state.attemptView.attemptId}-loaded-events.jsonl`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#composer-back").addEventListener("click", () => state.workspace && selectWorkspace(state.workspace.workspaceId));
$("#copy-plan-resume").addEventListener("click", copyResumePrompt);
$("#copy-review-continue").addEventListener("click", copyResumePrompt);
$("#workspace-open-file").addEventListener("click", openReferenceFiles);
$("#file-close").addEventListener("click", () => { state.fileRequest++; state.filePreviewRequest++; $("#file-dialog").close(); });
$("#file-dialog").addEventListener("close", () => { state.fileRequest = (state.fileRequest || 0) + 1; state.filePreviewRequest = (state.filePreviewRequest || 0) + 1; });
$("#plan-logs-details").addEventListener("toggle", () => { if ($("#plan-logs-details").open) void loadPlanLogs(); });
$("#file-parent").addEventListener("click", () => { const parts = (state.filePath || ".").split("/").filter(part => part !== "."); parts.pop(); void listReferenceFiles(parts.join("/") || "."); });
$("#file-more").addEventListener("click", () => void listReferenceFiles(state.filePath, state.fileNextOffset));
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
async function openDirectoryPicker() {
  if (state.nativePicking) { showActionFeedback("系统选择窗口仍在等待", "请在运行后台的 Windows 桌面选择或取消；也可返回选择已有工作区。"); return; }
  const generation = state.folderSelectionGeneration, button = $("#choose-workspace-directory");
  state.nativePicking = true; button.disabled = true; button.textContent = "正在选择文件夹…"; button.setAttribute("aria-busy", "true");
  showActionFeedback("正在打开文件夹选择窗口", "请在运行后台的 Windows 桌面选择或取消；如果窗口在后台，可通过任务栏切换。也可返回选择已有工作区。");
  const reminder = setTimeout(() => { if (state.nativePicking && generation === state.folderSelectionGeneration) showActionFeedback("等待系统文件夹选择", "请检查 Windows 桌面或任务栏中的文件夹窗口。可以返回选择已有工作区，或展开手动填写路径；系统窗口最多等待 5 分钟。"); }, 12000);
  try {
    const result = await api("/api/v1/native-picker", { method: "POST", body: JSON.stringify({ kind: "directory" }) });
    if (!workspaceFormIsCurrent(generation)) return;
    if (result.cancelled) { closeWorkspaceForm(); showActionFeedback("已取消新建工作区", "已返回工作区选择，原有授权选择与任务保留。"); return; }
    $("#workspace-path").value = result.paths[0]; $("#workspace-selected-path").textContent = result.paths[0]; show($("#workspace-form")); show($("#workspace-path-error"), false);
    showActionFeedback("已选择文件夹", `${result.paths[0]}。填写名称后点击“添加项目”登记。`);
  } catch (error) {
    if (!workspaceFormIsCurrent(generation)) return;
    $("#workspace-path-error").textContent = error.message; show($("#workspace-path-error")); $("#workspace-manual-path").open = true; showActionFeedback("系统选择器未打开", `${error.message}。可手动填写路径或返回已有工作区。`, "validation");
  }
  finally { clearTimeout(reminder); state.nativePicking = false; button.disabled = false; button.textContent = "选择文件夹"; button.removeAttribute("aria-busy"); }
}
$("#choose-workspace-directory").addEventListener("click", openDirectoryPicker);
$("#open-runtime-model").addEventListener("click", async () => { await planTab("models"); if (state.route?.tab === "models") $("#runtime-model-task").focus({ preventScroll: true }); });
$("#runtime-model-task").addEventListener("change", () => { void loadRuntimeModelChoices(); if (state.planning?.session) renderRuntimeModelPanel(state.planning.session.tasks); });
$("#runtime-model-choice").addEventListener("change", () => show($("#runtime-model-custom").parentElement, $("#runtime-model-choice").value === "__custom__"));
$("#runtime-model-save").addEventListener("click", () => changeRuntimeModel(false));
$("#runtime-model-retry").addEventListener("click", () => changeRuntimeModel(true));
$("#enable-notifications").addEventListener("click", async () => {
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
$("#workspace-open-selected").addEventListener("click", () => { state.workspaceFilter = true; renderWorkspaceSelection(); });
$("#workspace-clear-selected").addEventListener("click", () => { state.selectedWorkspaces.clear(); state.workspaceFilter = false; renderWorkspaces(); });
$("#session-check").addEventListener("click", () => refreshAll());
$("#session-recover").addEventListener("click", diagnoseAndRecover);
$("#pending-action-open").addEventListener("click", async () => { await planTab("execution"); $("#pending-approval-box").scrollIntoView({ block: "start", behavior: "smooth" }); });
for (const kind of ["tools", "raw"]) for (const [direction, delta] of [["prev", -1], ["next", 1]]) $("#attempt-" + kind + "-" + direction).addEventListener("click", () => { if (!state.attemptView) return; state.attemptView[`${kind}Page`] += delta; renderAttemptView(); });
if (!state.remotePoll) state.remotePoll = setInterval(() => void refreshRemoteConnection(), 3000);
setInterval(() => { if (state.workspace && (!state.activeJob || ["planning.run", "session.resume", "session.retry"].includes(state.activeJob.kind))) { void refreshAll(); if (state.planning?.session?.status === "running") void readSelectedAttempt(); } }, 5000);
void init();
