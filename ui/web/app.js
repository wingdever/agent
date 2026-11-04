"use strict";
// 纯前端静态交互：不调用任何后端 / fetch / ipc。
document.addEventListener("DOMContentLoaded", function () {
  var viewport = document.getElementById("viewport");
  var sidebar = document.getElementById("sidebar");
  var contextPanel = document.getElementById("contextPanel");

  // 替代 window.prompt / confirm / alert：这些在 Electron / 某些浏览器环境中不被支持
  function showModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.setAttribute("data-name", "modal-overlay");

      var box = document.createElement("div");
      box.className = "modal-box";
      box.setAttribute("data-name", "modal-box");

      var title = document.createElement("div");
      title.className = "modal-title";
      title.textContent = opts.title || "";
      box.appendChild(title);

      var input = null;
      var errEl = null;
      if (opts.kind === "alert" || opts.kind === "confirm") {
        var msg = document.createElement("div");
        msg.className = "modal-message";
        msg.textContent = opts.message || "";
        box.appendChild(msg);
      } else {
        input = document.createElement("input");
        input.className = "modal-input";
        input.type = "text";
        input.placeholder = opts.placeholder || "";
        input.value = opts.defaultValue || "";
        box.appendChild(input);

        errEl = document.createElement("div");
        errEl.className = "modal-error";
        errEl.hidden = true;
        box.appendChild(errEl);
      }

      var btnRow = document.createElement("div");
      btnRow.className = "modal-buttons";
      var cancelBtn = document.createElement("button");
      cancelBtn.className = "modal-cancel";
      cancelBtn.textContent = opts.cancelText || "取消";
      var okBtn = document.createElement("button");
      okBtn.className = "modal-ok";
      okBtn.textContent = opts.okText || "确定";
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      var done = false;
      function close(val) {
        if (done) return;
        done = true;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(val);
      }
      function submit() {
        if (opts.kind === "alert") { close(); return; }
        if (opts.kind === "confirm") { close(true); return; }
        var v = input.value.trim();
        if (!v) {
          errEl.textContent = opts.emptyError || "请输入内容";
          errEl.hidden = false;
          input.focus();
          return;
        }
        close(v);
      }

      cancelBtn.addEventListener("click", function () { close(opts.kind === "confirm" ? false : null); });
      okBtn.addEventListener("click", submit);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(opts.kind === "confirm" ? false : null); });
      if (input) {
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
          else if (e.key === "Escape") { e.preventDefault(); close(opts.kind === "confirm" ? false : null); }
        });
        setTimeout(function () { input.focus(); input.select(); }, 0);
      } else {
        setTimeout(function () { okBtn.focus(); }, 0);
      }
    });
  }
  function uiPrompt(title, defaultValue, extra) {
    return showModal(Object.assign({ kind: "prompt", title: title, defaultValue: defaultValue || "" }, extra || {}));
  }
  function uiConfirm(message) {
    return showModal({ kind: "confirm", title: "请确认", message: message, okText: "确定", cancelText: "取消" });
  }
  function uiAlert(message) {
    return showModal({ kind: "alert", title: "提示", message: message, okText: "确定" });
  }
  // 暴露给 settings.js 等后续模块复用（替代原生 prompt/confirm/alert）
  window.uiPrompt = uiPrompt;
  window.uiConfirm = uiConfirm;
  window.uiAlert = uiAlert;

  // 1) 标签切换：chat-tab / trajectory-tab
  var tabBtns = document.querySelectorAll(".tab-icons [data-target]");
  Array.prototype.forEach.call(tabBtns, function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(tabBtns, function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      if (b.getAttribute("data-target") === "trajectory-tab") {
        viewport.classList.add("show-trajectory");
        loadTrajectory(currentSessionId);
      } else {
        viewport.classList.remove("show-trajectory");
      }
    });
  });

  // 2) 左侧栏折叠
  document.getElementById("leftCollapse").addEventListener("click", function () {
    sidebar.classList.toggle("collapsed");
  });

  // 3) 右侧 context-panel 折叠/显示
  document.getElementById("rightCollapse").addEventListener("click", function () {
    if (contextPanel.hasAttribute("hidden")) contextPanel.removeAttribute("hidden");
    else contextPanel.setAttribute("hidden", "");
  });

  // 4) 点击 tool-call -> 填充并显示 context-panel
  var ctxDefault = document.querySelector(".context-default");
  var ctxDetail = document.getElementById("contextDetail");
  var ctxTitle = document.getElementById("ctxTitle");
  var ctxArgs = document.getElementById("ctxArgs");
  var ctxResult = document.getElementById("ctxResult");
  var ctxRefs = document.getElementById("ctxRefs");

  function showToolDetail(card) {
    var tool = card.getAttribute("data-tool");
    var op = card.getAttribute("data-op");
    var args = card.getAttribute("data-args");
    var result = card.getAttribute("data-result");
    ctxTitle.textContent = tool + " / " + op;
    try { ctxArgs.textContent = JSON.stringify(JSON.parse(args), null, 2); } catch (e) { ctxArgs.textContent = args || ""; }
    try { ctxResult.textContent = JSON.stringify(JSON.parse(result), null, 2); } catch (e) { ctxResult.textContent = result || ""; }
    var ref = tool;
    try { var a = JSON.parse(args); if (a && a.path) ref = a.path; } catch (e) {}
    ctxRefs.textContent = "（静态示例）引用自 " + ref;
    if (ctxDefault) ctxDefault.hidden = true;
    ctxDetail.hidden = false;
    contextPanel.removeAttribute("hidden");
  }

  // 产物预览：读取写文件类工具生成的文件，按扩展名渲染到右侧面板（与现有检视器合一）。
  var artifactPreview = document.getElementById("artifactPreview");
  var artifactPreviewTitle = document.getElementById("artifactPreviewTitle");
  var artifactPreviewBody = document.getElementById("artifactPreviewBody");
  var artifactPreviewOpen = document.getElementById("artifactPreviewOpen");
  var IMG_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, svg: 1, bmp: 1 };
  function renderArtifactBody(filePath, text) {
    if (!artifactPreviewBody) return;
    artifactPreviewBody.innerHTML = "";
    var lower = filePath.toLowerCase();
    var ext = (lower.split(".").pop() || "").split("?")[0];
    if (IMG_EXT[ext]) {
      var img = document.createElement("img");
      img.className = "artifact-img";
      img.src = "file://" + filePath;  // 本地文件直接预览
      img.alt = filePath;
      artifactPreviewBody.appendChild(img);
      return;
    }
    if (ext === "md" || ext === "markdown") {
      try {
        var html = (window.marked ? window.marked.parse(text) : text);
        artifactPreviewBody.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
      } catch (e) { artifactPreviewBody.textContent = text; }
      return;
    }
    if (ext === "html" || ext === "htm") {
      try {
        artifactPreviewBody.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(text) : text;
      } catch (e) { artifactPreviewBody.textContent = text; }
      return;
    }
    // 其余：纯文本 / 代码（前置 4 空格缩进 + 等宽）
    var pre = document.createElement("pre");
    pre.className = "artifact-code";
    pre.textContent = text;
    artifactPreviewBody.appendChild(pre);
  }
  async function previewArtifact(filePath) {
    if (!artifactPreview || !contextPanel) return;
    artifactPreview.hidden = false;
    if (ctxDetail) ctxDetail.hidden = true;
    if (ctxDefault) ctxDefault.hidden = true;
    contextPanel.removeAttribute("hidden");
    artifactPreviewTitle.textContent = "预览: " + filePath;
    artifactPreviewBody.innerHTML = "<div class='artifact-loading'>读取中…</div>";
    artifactPreviewOpen.hidden = true;
    try {
      var res = await window.AgentClient.call("fs", { op: "read", path: filePath });
      if (res && res.isDirectory) { artifactPreviewBody.innerHTML = "<div class='artifact-loading'>目录，无法预览</div>"; return; }
      var text = (res && res.content) || "";
      if (res && res.truncated) {
        var note = document.createElement("div");
        note.className = "artifact-note";
        note.textContent = "（文件过大，已截断预览）";
        artifactPreviewBody.appendChild(note);
      }
      renderArtifactBody(filePath, text);
      if (artifactPreviewOpen) {
        artifactPreviewOpen.hidden = false;
        artifactPreviewOpen.onclick = function () { window.open("file://" + filePath, "_blank"); };
      }
    } catch (e) {
      artifactPreviewBody.innerHTML = "<div class='artifact-error'>读取失败: " + (e && e.message ? e.message : e) + "</div>";
    }
  }

  // 6) add-workspace-btn -> folder-selector -> add-workspace(folder)
  var addWsBtn = document.querySelector(".add-workspace-btn");
  var treeList = document.querySelector(".workspace-session-tree-list");
  var searchBtn = document.querySelector(".search-btn");
  var searchInput = document.querySelector(".search-input");
  var trashBtn = document.querySelector(".trash-btn");
  var deletedList = document.querySelector(".deleted-sessions-list");

  // 搜索：切换输入框并按名称过滤当前会话列表
  if (searchBtn && searchInput) {
    searchBtn.addEventListener("click", function () {
      searchInput.hidden = !searchInput.hidden;
      if (!searchInput.hidden) searchInput.focus();
      else { searchInput.value = ""; applySessionFilter(""); }
    });
    searchInput.addEventListener("input", function () { applySessionFilter(searchInput.value.trim().toLowerCase()); });
  }
  function applySessionFilter(q) {
    document.querySelectorAll(".session-item").forEach(function (n) {
      var label = n.querySelector(".session-name-label");
      var name = label ? label.textContent.toLowerCase() : "";
      n.style.display = (!q || name.indexOf(q) !== -1) ? "" : "none";
    });
  }

  // 回收站：切换已软删会话视图（恢复 / 彻底删除）
  if (trashBtn && deletedList) {
    trashBtn.addEventListener("click", function () {
      var showing = !deletedList.hidden;
      deletedList.hidden = showing;
      if (!showing) loadDeletedSessions(deletedList);
    });
  }
  async function loadDeletedSessions(container) {
    container.innerHTML = "";
    try {
      var list = await window.AgentClient.call("storage", { op: "session.list", payload: { includeDeleted: true } });
      var deleted = (list || []).filter(function (s) { return s.deleted_at != null; });
      if (!deleted.length) { container.innerHTML = '<div class="empty-hint">回收站为空</div>'; return; }
      deleted.forEach(function (s) { renderDeletedSession(s, container); });
    } catch (e) { container.innerHTML = '<div class="empty-hint">回收站加载失败</div>'; }
  }
  function renderDeletedSession(sess, container) {
    var node = document.createElement("div");
    node.className = "session-item deleted";
    node.setAttribute("data-name", "session-item");
    node.setAttribute("data-id", String(sess.id));
    var label = document.createElement("span");
    label.className = "session-name-label";
    label.textContent = sess.name || ("会话 " + sess.id);
    var restoreBtn = document.createElement("button");
    restoreBtn.className = "restore-session-btn";
    restoreBtn.textContent = "恢复";
    var purgeBtn = document.createElement("button");
    purgeBtn.className = "purge-session-btn";
    purgeBtn.textContent = "彻底删除";
    node.appendChild(label); node.appendChild(restoreBtn); node.appendChild(purgeBtn);
    restoreBtn.addEventListener("click", async function () {
      try { await window.AgentClient.call("storage", { op: "session.restore", payload: { id: sess.id } }); if (node.parentNode) node.parentNode.removeChild(node); } catch (e) {}
    });
    purgeBtn.addEventListener("click", async function () {
      if (!(await uiConfirm("彻底删除该会话？不可恢复"))) return;
      try { await window.AgentClient.call("storage", { op: "session.delete", payload: { id: sess.id, hard: true } }); if (node.parentNode) node.parentNode.removeChild(node); } catch (e) {}
    });
    container.appendChild(node);
  }

  function renderWorkspace(ws) {
    var node = document.createElement("div");
    node.className = "workspace-item";
    node.setAttribute("data-name", "workspace-item");
    node.setAttribute("data-id", String(ws.id));

    var header = document.createElement("div");
    header.className = "workspace-header";
    header.setAttribute("data-name", "workspace-header");

    var label = document.createElement("span");
    label.className = "workspace-name-label";
    label.setAttribute("data-name", "workspace-name-label");
    label.textContent = ws.folder_name + (ws.folder_path ? "  (" + ws.folder_path + ")" : "");

    var delBtn = document.createElement("button");
    delBtn.className = "del-workspace-btn";
    delBtn.setAttribute("data-name", "del-workspace-btn");
    delBtn.textContent = "删除";

    var addBtn = document.createElement("button");
    addBtn.className = "add-session-btn";
    addBtn.setAttribute("data-name", "add-session-btn");
    addBtn.textContent = "+ 会话";

    header.appendChild(label);
    header.appendChild(delBtn);
    header.appendChild(addBtn);

    var sessionList = document.createElement("div");
    sessionList.className = "session-list";
    sessionList.setAttribute("data-name", "session-list");

    node.appendChild(header);
    node.appendChild(sessionList);
    treeList.appendChild(node);

    delBtn.addEventListener("click", function () { deleteWorkspace(ws.id, node); });
    addBtn.addEventListener("click", async function () { var name = await uiPrompt("新建会话"); if (name) addSession(ws.id, sessionList, name); });

    loadSessions(ws.id, sessionList);
    return node;
  }

  async function loadWorkspaces() {
    try {
      var list = await window.AgentClient.call("storage", { op: "workspace.list", payload: {} });
      treeList.innerHTML = "";
      (list || []).forEach(renderWorkspace);
    } catch (e) { /* 后端未就绪时静默 */ }
  }

  async function addWorkspace(folderPath) {
    if (!folderPath) return;
    var idx = folderPath.lastIndexOf("/"); if (idx === -1) idx = folderPath.lastIndexOf(String.fromCharCode(92)); var name = idx >= 0 ? folderPath.slice(idx + 1) : folderPath;
    try {
      var ws = await window.AgentClient.call("storage", {
        op: "workspace.create",
        payload: { folder_path: folderPath, folder_name: name },
      });
      renderWorkspace(ws);
    } catch (e) { console.error("add workspace failed:", e); }
  }

  if (addWsBtn) {
    addWsBtn.addEventListener("click", async function () {
      var folder = await window.AgentClient.selectFolder();
      if (folder) await addWorkspace(folder);
    });
  }

  // 侧栏顶部「+ 新建会话」：确保存在工作区后，按名称新建会话
  function findSessionList(wsId) {
    var items = document.querySelectorAll(".workspace-item");
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].getAttribute("data-id")) === String(wsId)) return items[i].querySelector(".session-list");
    }
    return null;
  }
  var newSessionBtn = document.querySelector(".new-session-button");
  async function ensureDefaultWorkspace() {
    var list = await window.AgentClient.call("storage", { op: "workspace.list", payload: {} });
    if (list && list.length) return list[0];
    var ws = await window.AgentClient.call("storage", { op: "workspace.create", payload: { folder_path: ".", folder_name: "默认工作区" } });
    renderWorkspace(ws);
    return ws;
  }
  if (newSessionBtn) {
    newSessionBtn.addEventListener("click", async function () {
      var name = await uiPrompt("新建会话");
      if (!name) return;
      // 选初始活动（建会话定预设，运行后可自然流转/强制切）
      await new Promise(function (resolve) {
        openActivityMenu(function (a) { selectedInitialActivity = a; resolve(); });
      });
      try {
        var ws = await ensureDefaultWorkspace();
        var container = findSessionList(ws.id);
        if (!container) { await loadWorkspaces(); container = findSessionList(ws.id); }
        await addSession(ws.id, container, name);
      } catch (e) { console.error("new session failed:", e); }
    });
  }

  function renderSession(sess, workspaceId, container) {
    var node = document.createElement("div");
    node.className = "session-item";
    node.setAttribute("data-name", "session-item");
    node.setAttribute("data-id", String(sess.id));

    var label = document.createElement("span");
    label.className = "session-name-label";
    label.setAttribute("data-name", "session-name-label");
    label.textContent = sess.name || ("会话 " + sess.id);

    var renameBtn = document.createElement("button");
    renameBtn.className = "rename-session-btn";
    renameBtn.setAttribute("data-name", "rename-session-btn");
    renameBtn.textContent = "改名";

    var delBtn = document.createElement("button");
    delBtn.className = "delete-session-btn";
    delBtn.setAttribute("data-name", "delete-session-btn");
    delBtn.textContent = "删除";

    node.appendChild(label);
    node.appendChild(renameBtn);
    node.appendChild(delBtn);
    if (container) container.appendChild(node);

    renameBtn.addEventListener("click", function () { renameSession(sess.id, label); });
    delBtn.addEventListener("click", function () { deleteSession(sess.id, node); });
    node.addEventListener("click", function (e) {
      if (e.target.closest("button")) return;
      selectSession(sess, node);
    });
    return node;
  }

  async function loadSessions(workspaceId, container) {
    try {
      var list = await window.AgentClient.call("storage", { op: "session.list", payload: { workspace_id: workspaceId } });
      container.innerHTML = "";
      (list || []).forEach(function (s) { renderSession(s, workspaceId, container); });
    } catch (e) { /* 静默 */ }
  }

  async function addSession(workspaceId, container, name) {
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("storage", { op: "session.create", payload: { workspace_id: workspaceId, name: name, activity: selectedInitialActivity } });
      var node = renderSession(sess, workspaceId, container);
      selectSession(sess, node);
    } catch (e) { console.error("add session failed:", e); }
  }

  async function renameSession(sessionId, label) {
    var name = await uiPrompt("重命名会话", label.textContent);
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("storage", { op: "session.update", payload: { id: sessionId, name: name } });
      label.textContent = (sess && sess.name) || name;
    } catch (e) { console.error("rename session failed:", e); }
  }

  async function deleteSession(sessionId, node) {
    if (!(await uiConfirm("删除该会话？"))) return;
    try {
      await window.AgentClient.call("storage", { op: "session.delete", payload: { id: sessionId } });
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (e) { console.error("delete session failed:", e); }
  }

  async function deleteWorkspace(workspaceId, node) {
    if (!(await uiConfirm("删除该工作区及其下所有会话？"))) return;
    try {
      await window.AgentClient.call("storage", { op: "workspace.delete", payload: { id: workspaceId } });
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (e) { console.error("delete workspace failed:", e); }
  }

  // 7) composer: 发送按钮 + 流式渲染（驱动 harness chat loop，并落库到当前会话）
  // 渲染层级严格对应 ui.md 布局树：
  // chat-tab > turn* > step* > (agent-request? + model-response(thought?/answer?/tool-call-card*(tool-call-desc/approval-request/tool-result)))
  var chatTab = document.getElementById("chatTab");
  var input = document.querySelector(".input-textarea");
  var sendBtn = document.querySelector(".send-or-stop-btn");
  var modelHttpStatus = document.querySelector(".model-http-status");
  var sessionNameLabel = document.querySelector(".session-name");
  var footerSessionStats = document.querySelector(".session-statistics");   // 左：turns · steps · tok/s
  var footerTokenUsage = document.querySelector(".token-usage");            // 中：tokens / cache hit
  var footerContextUsed = document.querySelector(".context-used");          // 右：上下文占用
  var currentSessionId = null;
  var currentActivity = "bare-chat";   // 当前会话的活动（来自会话存储，可被指示器切换）
  var selectedInitialActivity = "bare-chat";  // 新建会话时的初始活动
  var bareHistory = [];  // bare-chat 模式：纯内存对话历史，不落库
  var chatScroller = chatTab.closest(".tab-body");
  function scrollChatToBottom() {
    if (chatScroller) chatScroller.scrollTop = chatScroller.scrollHeight;
  }

  // bare-chat 扁平渲染所需的临时状态（turn-step 不使用）
  var currentAssistantBubble = null;
  var currentThoughtBubble = null;
  var toolCards = {};

  // 自动翻译：display-only 的中英对照块（不落库，重载后只剩英文）
  var flatUserWrap = null;
  var flatUserBubble = null;
  var flatUserOriginal = "";
  var flatUserTranslation = null;
  var flatAssistantTranslation = null;

  // turn-step 流式渲染所依赖的 DOM 锚点
  var liveTurn = null;     // 当前 .turn 节点
  var liveStep = null;     // 当前 .step 节点
  var liveResponse = null; // 当前 .model-response 节点
  var liveAnswer = null;   // 当前 .answer 节点
  var liveCards = {};      // call id -> .tool-call-card 节点
  var liveAgentRequest = null; // 当前 .agent-request 节点
  var liveUserInput = null;    // 当前 .user-input（英文译文主块）
  var liveUserOriginal = "";   // 用户输入原文（中文）
  var liveUserTranslation = null;   // 用户消息的中文原文副块
  var liveAssistantTranslation = null; // 助手回答的中文译文副块

  // 状态栏（chat-footer）聚合状态
  var usageState = { prompt: null, completion: null, total: null, cached: null }; // 最近一次 usage
  var turnStat = { steps: null, tools: null, durationMs: null };                    // 最近一次 turn 统计
  var sessionStat = { turns: 0, steps: 0 };                                       // 会话累计 turns / steps
  var CONTEXT_WINDOW = 128000;                                                    // 上下文窗口假设上限（用于占比估算）

  // plan-mode 由 activity=plan 驱动（见 docs/agent-mode.md）：选 plan 即进入计划态，
  // 切到其他 activity 即退出。UI 不再有独立按钮；core 的 plan-mode 状态以 activity 为准。
  var currentPlanMode = false;
  // activity 的单一真值：currentActivity（来自会话存储，可被指示器切换）。
  // localStorage 仅作跨会话默认初始值，不替代会话存储。
  function setActivityMode(v, opts) {
    currentActivity = v;
    selectedInitialActivity = v;
    try { localStorage.setItem("agent.activity", v); } catch (e) {}
    if (opts && opts.silent) return;
    // 会话内切换：落库到当前会话
    if (currentSessionId) {
      window.AgentClient.call("storage", { op: "session.update", payload: { id: currentSessionId, activity: v } })
        .catch(function () {});
    }
  }
  function getActivityMode() { return currentActivity; }
  function getPresenceMode() {
    var btn = document.getElementById("presenceSwitch");
    return (btn && btn.getAttribute("data-mode")) || "in";
  }
  function getAutonomyMode() {
    var btn = document.getElementById("autonomySwitch");
    return (btn && btn.getAttribute("data-mode")) || "supervised";
  }
  // 据当前 activity 同步 core 的 per-session plan-mode（即时，不依赖发消息）
  async function syncPlanModeFromActivity() {
    if (!currentSessionId) return;
    var active = getActivityMode() === "goal-plan";
    currentPlanMode = active;
    try {
      await window.AgentClient.call("planMode", { op: "set", session_id: currentSessionId, active: active });
    } catch (e) { /* 忽略同步失败 */ }
  }

  // ---------- 活动指示器（取代 composer 的 activity-mode-selector） ----------
  // 单一真值为 currentActivity（见 selectSession / setActivityMode）。
  // currentActivityCompleted：当前活动是否已由 model 上报完成（如 plan 经 exit_plan_mode 批准）。
  var ACTIVITIES = ["bare-chat", "goal-plan", "build-code", "discuss-doc", "research", "review-proj", "human-learn", "diagnose"];
  var currentActivityCompleted = false;
  var activityIndicatorEl = null;

  function renderActivityIndicator() {
    if (!activityIndicatorEl) activityIndicatorEl = document.getElementById("activityIndicator");
    if (!activityIndicatorEl) return;
    var mark = currentActivityCompleted ? " ✓" : "";
    activityIndicatorEl.textContent = "活动: " + currentActivity + mark;
    activityIndicatorEl.setAttribute("data-activity", currentActivity);
    renderStatusBar();   // 活动变化同步到状态栏左段
    activityIndicatorEl.setAttribute("data-completed", currentActivityCompleted ? "1" : "0");
  }

  function switchActivity(target) {
    if (target === currentActivity) { renderActivityIndicator(); return; }
    // 未完成 + supervised → 二次确认；completed 或 autonomous → 直接切
    var needConfirm = !currentActivityCompleted && getAutonomyMode() !== "autonomous";
    if (needConfirm) {
      uiConfirm("当前活动 " + currentActivity + " 尚未完成，切换将中断其进行中的工作；plan-mode 等策略即时失效。确认切换？")
        .then(function (ok) { if (ok) commitActivity(target); });
    } else {
      commitActivity(target);
    }
  }
  function commitActivity(target) {
    setActivityMode(target);
    currentActivityCompleted = false;
    renderActivityIndicator();
    syncPlanModeFromActivity();
  }

  function openActivityMenu(onPick) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("data-name", "activity-menu-overlay");
    var box = document.createElement("div");
    box.className = "modal-box activity-menu";
    box.setAttribute("data-name", "activity-menu");
    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = (onPick ? "选择初始活动" : "切换活动") + "（当前: " + currentActivity + (currentActivityCompleted ? " ✓已完成" : "") + "）";
    box.appendChild(title);
    ACTIVITIES.forEach(function (a) {
      var item = document.createElement("button");
      item.className = "activity-menu-item" + (a === currentActivity ? " active" : "");
      item.textContent = a + (a === currentActivity ? " （当前）" : "");
      item.addEventListener("click", function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (onPick) onPick(a); else switchActivity(a);
      });
      box.appendChild(item);
    });
    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.parentNode.removeChild(overlay); });
    document.body.appendChild(overlay);
  }

  // ---------- 轨迹面板（复用 store 的 turns/steps/messages/calls，纯前端可视化） ----------
  var trajectoryTab = document.getElementById("trajectoryTab");
  var trajectoryLoadedFor = null;  // 缓存：避免重复拉取

  async function loadTrajectory(sessionId) {
    if (!trajectoryTab) return;
    if (!sessionId) { trajectoryTab.innerHTML = '<div class="empty-hint">请先选择会话</div>'; return; }
    if (trajectoryLoadedFor === sessionId) return;
    trajectoryTab.innerHTML = '<div class="empty-hint">加载轨迹中…</div>';
    try {
      var tree = await window.AgentClient.call("storage", { op: "session.trajectory", payload: { session_id: sessionId } });
      trajectoryLoadedFor = sessionId;
      renderTrajectoryTree(tree || []);
    } catch (e) {
      trajectoryTab.innerHTML = '<div class="empty-hint">轨迹加载失败：' + (e && e.message ? e.message : e) + '</div>';
    }
  }

  function renderTrajectoryTree(turns) {
    if (!trajectoryTab) return;
    trajectoryTab.innerHTML = "";
    if (!turns.length) {
      trajectoryTab.innerHTML = '<div class="empty-hint">暂无轨迹</div>';
      return;
    }
    turns.forEach(function (turn) {
      var tEl = makeEl("traj-turn", "traj-turn");
      tEl.setAttribute("data-turn-id", String(turn.id));
      var tHead = makeEl("traj-turn-head", "traj-turn-head");
      tHead.textContent = "Turn " + (turn.seq != null ? turn.seq : turn.id) + " · " + (turn.status || "");
      tEl.appendChild(tHead);
      (turn.steps || []).forEach(function (step) {
        var sEl = makeEl("traj-step", "traj-step");
        sEl.setAttribute("data-step-id", String(step.id));
        var sHead = makeEl("traj-step-head", "traj-step-head");
        sHead.textContent = "Step " + (step.seq != null ? step.seq : step.id) + " · " + (step.status || "");
        sEl.appendChild(sHead);
        (step.messages || []).forEach(function (msg) {
          if (msg.thought) {
            var th = makeEl("traj-thought", "traj-thought");
            var thSummary = makeEl("traj-thought-summary", "traj-thought-summary");
            thSummary.textContent = "思考：" + String(msg.thought).slice(0, 120) + (String(msg.thought).length > 120 ? "…" : "");
            th.appendChild(thSummary);
            var thFull = makeEl("traj-thought-full", "traj-thought-full");
            if (typeof AgentMarkdown !== "undefined") AgentMarkdown.set(thFull, msg.thought); else thFull.textContent = msg.thought;
            thFull.hidden = true;
            thSummary.addEventListener("click", function () { thFull.hidden = !thFull.hidden; });
            th.appendChild(thFull);
            sEl.appendChild(th);
          }
          if (msg.content && msg.role === "assistant") {
            var ans = makeEl("traj-answer", "traj-answer");
            if (typeof AgentMarkdown !== "undefined") AgentMarkdown.set(ans, msg.content); else ans.textContent = msg.content;
            sEl.appendChild(ans);
          }
        });
        (step.calls || []).forEach(function (call) {
          var card = createToolCard({
            name: call.name, arguments: typeof call.arguments === "string" ? safeParse(call.arguments) : call.arguments,
            description: call.description, status: call.status,
          });
          if (card && call.result != null) {
            var resEvt = { content: call.result, isError: call.status === "failed" || !!call.error };
            if (typeof setToolResult === "function") setToolResult(card, resEvt);
          }
          if (card) {
            card.addEventListener("click", function () { showToolDetail(card); });
            sEl.appendChild(card);
          }
        });
        tEl.appendChild(sEl);
      });
      trajectoryTab.appendChild(tEl);
    });
  }

  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

  // ---------- presence 自动机（在场状态：in/out） ----------
  // 规则（见 docs/agent-mode.md）：
  //   in -> out：用户无操作且未主动挂起，持续 >=10 分钟（idle 检测）
  //   out -> in：用户插话（发送/输入）或手动切回 in
  //   out 自动触发 autonomy: supervised -> autonomous（永久提权，presence 回 in 不降）
  //   autonomous 下 ask 自动 deny 由 agent 行为层负责，此处只切状态
  var IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  var PRESENCE_TICK_MS = 30 * 1000;
  var lastUserActivity = Date.now();
  var presenceAuto = true; // 自动跟踪开启；用户手动改 presence 时关闭

  function setPresenceMode(v) {
    var btn = document.getElementById("presenceSwitch");
    if (btn) {
      btn.setAttribute("data-mode", v);
      btn.textContent = "在场: " + v;
      btn.classList.toggle("active", v === "out");
    }
    if (v === "in") lastUserActivity = Date.now();
  }
  function setAutonomyMode(v) {
    var btn = document.getElementById("autonomySwitch");
    if (btn) {
      btn.setAttribute("data-mode", v);
      btn.textContent = "自主: " + v;
      btn.classList.toggle("active", v === "autonomous");
    }
  }
  // 用户产生活动（插话）：恢复自动跟踪，回到 in，不触碰 autonomy
  function markUserActivity() {
    presenceAuto = true;
    if (getPresenceMode() !== "in") setPresenceMode("in");
    else lastUserActivity = Date.now();
  }
  // 定时检查：自动 in -> out，并提权 autonomy
  function tickPresence() {
    if (!presenceAuto) return;
    if (getPresenceMode() !== "in") return;
    if (Date.now() - lastUserActivity < IDLE_TIMEOUT_MS) return;
    setPresenceMode("out");
    // 被迫自治：supervised -> autonomous（永久提权）
    if (getAutonomyMode() === "supervised") setAutonomyMode("autonomous");
  }
  // presence selector 手动变更：用户接管；手动 out = 主动离开/挂起（抑制自动机），手动 in = 恢复跟踪
  function onPresenceManualChange() {
    var v = getPresenceMode();
    if (v === "out") {
      presenceAuto = false;
    } else {
      presenceAuto = true;
      lastUserActivity = Date.now();
    }
  }
  function hideEmptyHint() { var h = chatTab.querySelector(".empty-hint"); if (h) h.remove(); }
  function showEmptyHint() {
    if (chatTab.querySelector(".empty-hint")) return;
    var h = document.createElement("div");
    h.className = "empty-hint";
    h.textContent = "还没有对话，发送消息开始吧";
    chatTab.appendChild(h);
  }
  function makeEl(name, cls) {
    var n = document.createElement("div");
    n.setAttribute("data-name", name);
    if (cls) n.className = cls;
    return n;
  }

  // ---------- 自动翻译：中英对照块 ----------
  // English is the primary block for both roles (the model environment is
  // English); the Chinese side is a secondary block, open by default and
  // collapsible. Translations are display-only and never persisted.
  function makeTranslationBlock(label, text, markdown) {
    var details = document.createElement("details");
    details.className = "translation";
    details.setAttribute("data-name", "translation");
    details.open = true;
    var summary = document.createElement("summary");
    summary.textContent = label;
    details.appendChild(summary);
    var body = makeEl("translation-body", "translation-body textcard" + (markdown ? "" : " plain"));
    if (markdown) AgentMarkdown.set(body, text || "");
    else body.textContent = text || "";
    details.appendChild(body);
    return details;
  }
  function setTranslationText(block, text, markdown) {
    if (!block) return;
    var body = block.querySelector(".translation-body");
    if (!body) return;
    if (markdown) {
      body.classList.remove("plain");
      AgentMarkdown.set(body, text || "");
    } else {
      body.classList.add("plain");
      body.textContent = text || "";
    }
  }
  function appendTranslationErrorNotice(container, error) {
    if (!container) return;
    var note = makeEl("translation-error", "translation-error");
    note.textContent = "翻译失败，已显示英文原文：" + (error || "未知错误");
    container.appendChild(note);
    scrollChatToBottom();
  }

  function appendFlatUser(text) {
    hideEmptyHint();
    var wrap = document.createElement("div");
    wrap.className = "msg msg-user";
    var roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent = "你";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "";
    wrap.appendChild(roleLabel);
    wrap.appendChild(bubble);
    chatTab.appendChild(wrap);
    scrollChatToBottom();
    return { wrap: wrap, bubble: bubble };
  }

  function resetFlatTranslationState() {
    flatUserWrap = flatUserBubble = flatUserTranslation = flatAssistantTranslation = null;
    flatUserOriginal = "";
  }

  function ensureFlatUserTranslation(original) {
    if (!flatUserTranslation && flatUserWrap) {
      flatUserTranslation = makeTranslationBlock("中文原文", original || "", false);
      flatUserWrap.appendChild(flatUserTranslation);
      scrollChatToBottom();
    }
    return flatUserTranslation;
  }
  function ensureFlatAssistantTranslation() {
    if (!flatAssistantTranslation && currentAssistantBubble && currentAssistantBubble.parentNode) {
      flatAssistantTranslation = makeTranslationBlock("中文译文", "翻译中…", true);
      currentAssistantBubble.parentNode.appendChild(flatAssistantTranslation);
      scrollChatToBottom();
    }
    return flatAssistantTranslation;
  }
  function handleTranslationFlat(evt) {
    if (evt.role === "user") {
      if (evt.phase === "start") {
        flatUserOriginal = evt.source || flatUserOriginal || "";
        if (flatUserBubble) {
          flatUserBubble.textContent = "翻译中…";
          flatUserBubble.classList.add("translating");
        }
        ensureFlatUserTranslation(flatUserOriginal);
      } else if (evt.phase === "done") {
        if (flatUserBubble) {
          flatUserBubble.textContent = evt.text || "";
          flatUserBubble.classList.remove("translating");
        }
        if (evt.source) ensureFlatUserTranslation(evt.source);
        // bare-chat 的历史在内存里：下一轮必须把中文原文换成英文译文。
        var last = bareHistory[bareHistory.length - 1];
        if (last && last.role === "user") last.content = evt.text || last.content;
        scrollChatToBottom();
      } else if (evt.phase === "error") {
        if (input) { input.value = evt.source || flatUserOriginal || ""; input.focus(); }
        if (flatUserWrap && flatUserWrap.parentNode) flatUserWrap.parentNode.removeChild(flatUserWrap);
        if (bareHistory.length && bareHistory[bareHistory.length - 1].role === "user") bareHistory.pop();
        resetFlatTranslationState();
        if (!chatTab.querySelector(".msg")) showEmptyHint();
        if (window.uiAlert) uiAlert("输入翻译失败：" + (evt.error || "未知错误") + "\n请改用英文重新发送。");
      }
      return;
    }
    if (evt.role !== "assistant") return;
    if (evt.phase === "start") {
      ensureFlatAssistantTranslation();
    } else if (evt.phase === "done") {
      var block = ensureFlatAssistantTranslation();
      setTranslationText(block, evt.text || "", true);
      scrollChatToBottom();
    } else if (evt.phase === "error") {
      if (flatAssistantTranslation && flatAssistantTranslation.parentNode) {
        flatAssistantTranslation.parentNode.removeChild(flatAssistantTranslation);
      }
      flatAssistantTranslation = null;
      if (currentAssistantBubble && currentAssistantBubble.parentNode) {
        appendTranslationErrorNotice(currentAssistantBubble.parentNode, evt.error);
      }
    }
  }

  // ---------- bare-chat 扁平渲染（不落库、不支持工具调用） ----------
  function appendMessage(role, text) {
    hideEmptyHint();
    var wrap = document.createElement("div");
    wrap.className = "msg msg-" + role;
    var roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent = role === "user" ? "你" : (role === "assistant" ? "助手" : (role === "thought" ? "思考" : role));
    var bubble = document.createElement("div");
    var rich = role === "assistant" || role === "thought";
    bubble.className = "bubble" + (rich ? " textcard " + role : "");
    if (rich) AgentMarkdown.set(bubble, text || "");
    else bubble.textContent = text || "";
    wrap.appendChild(roleLabel);
    wrap.appendChild(bubble);
    chatTab.appendChild(wrap);
    scrollChatToBottom();
    return bubble;
  }
  function flushMessageBubbles() {
    if (currentAssistantBubble) AgentMarkdown.flush(currentAssistantBubble);
    if (currentThoughtBubble) AgentMarkdown.flush(currentThoughtBubble);
  }
  function createToolCard(evt) {
    var card = document.createElement("div");
    card.className = "tool-call";
    var head = document.createElement("div");
    head.className = "tool-head";
    var cat = document.createElement("span");
    cat.className = "tool-cat";
    cat.textContent = (evt.name || "tool").toUpperCase();
    var title = document.createElement("span");
    title.textContent = " " + (evt.name || "tool");
    head.appendChild(cat); head.appendChild(title);
    var args = document.createElement("div");
    args.className = "tool-args";
    args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
    card.appendChild(head); card.appendChild(args);
    return card;
  }
  function setToolResult(card, evt) {
    var text = evt && evt.content != null ? String(evt.content) : "";
    renderToolResult(card, text, !!(evt && evt.isError));
    if (evt && evt.name === "todo_write" && evt.meta && Array.isArray(evt.meta.todos)) {
      renderTodoList(card, evt.meta.todos);
    }
  }

  // todo_write: the model-facing text is only a count line; the checklist is
  // rendered from meta (live) or the tool-call arguments (replay).
  function renderTodoList(card, todos) {
    var old = card.querySelector(".todo-list");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!Array.isArray(todos) || !todos.length) return;
    var list = makeEl("todo-list", "todo-list");
    todos.forEach(function (todo) {
      var item = makeEl("todo-item", "todo-item todo-status-" + (todo.status || "pending"));
      var mark = makeEl("todo-mark", "todo-mark");
      mark.textContent = todo.status === "completed" ? "●" : todo.status === "in_progress" ? "◐" : "○";
      var label = makeEl("todo-label", "todo-label");
      label.textContent = todo.content || "";
      item.appendChild(mark);
      item.appendChild(label);
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  function parseToolArgs(call) {
    var value = call && call.arguments;
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch (e) { return {}; }
    }
    return value && typeof value === "object" ? value : {};
  }

  // ask_user_question: render one form per batch. Submission goes through the
  // same call channel as approvals; the model's tool call stays blocked until
  // this POST resolves.
  function renderAskUserQuestion(card, evt) {
    if (!card) return;
    var old = card.querySelector(".ask-user-question");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var form = makeEl("ask-user-question", "ask-user-question");
    form.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = makeEl("ask-title", "ask-title");
    title.textContent = "需要你的回答";
    form.appendChild(title);

    var state = {};
    var questions = Array.isArray(evt.questions) ? evt.questions : [];
    questions.forEach(function (q, index) {
      state[q.id] = { selected: [], custom: "" };
      var section = makeEl("ask-question", "ask-question");
      var header = makeEl("ask-header", "ask-header");
      header.textContent = q.header || ("问题 " + (index + 1));
      var text = makeEl("ask-text", "ask-text");
      text.textContent = q.question || "";
      section.appendChild(header);
      section.appendChild(text);

      if (Array.isArray(q.options) && q.options.length) {
        q.options.forEach(function (opt) {
          var label = document.createElement("label");
          label.className = "ask-option";
          var input = document.createElement("input");
          input.type = q.multi_select ? "checkbox" : "radio";
          input.name = "ask-" + evt.id + "-" + q.id;
          input.value = opt.label || "";
          input.addEventListener("change", function () {
            if (q.multi_select) {
              state[q.id].selected = Array.prototype.slice.call(
                section.querySelectorAll('input[type="checkbox"]:checked')
              ).map(function (node) { return node.value; });
            } else {
              state[q.id].selected = input.checked ? [input.value] : [];
            }
          });
          label.appendChild(input);
          var labelText = makeEl("ask-option-label", "ask-option-label");
          labelText.textContent = opt.label || "";
          label.appendChild(labelText);
          if (opt.description) {
            var desc = makeEl("ask-option-desc", "ask-option-desc");
            desc.textContent = opt.description;
            label.appendChild(desc);
          }
          section.appendChild(label);
        });
      }

      var custom = document.createElement("input");
      custom.type = "text";
      custom.className = "ask-custom";
      custom.placeholder = (q.options && q.options.length) ? "可选：补充回答" : "输入你的回答";
      custom.addEventListener("input", function () { state[q.id].custom = custom.value; });
      section.appendChild(custom);
      form.appendChild(section);
    });

    var actions = makeEl("ask-actions", "ask-actions");
    var error = makeEl("ask-error", "ask-error");
    error.hidden = true;
    var skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn-deny";
    skip.textContent = "全部跳过";
    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn-approve";
    submit.textContent = "提交回答";

    function collect() {
      return questions.map(function (q) {
        var value = state[q.id] || { selected: [], custom: "" };
        var customText = String(value.custom || "").trim();
        var answer = { id: q.id, selected: value.selected.slice() };
        if (customText) answer.custom = customText;
        return answer;
      });
    }

    function send(skipAll) {
      var answers = skipAll
        ? questions.map(function (q) { return { id: q.id, selected: [] }; })
        : collect();
      submit.disabled = true;
      skip.disabled = true;
      error.hidden = true;
      AgentClient.call("answerQuestions", { id: evt.id, answers: answers }).then(function (ok) {
        if (ok === false) throw new Error("该问题已失效或本轮已结束");
        if (ok && ok.error) throw new Error(ok.error);
        form.querySelectorAll("input,button").forEach(function (node) { node.disabled = true; });
        var done = makeEl("ask-submitted", "ask-submitted");
        done.textContent = "已提交回答";
        form.appendChild(done);
      }).catch(function (e) {
        submit.disabled = false;
        skip.disabled = false;
        error.hidden = false;
        error.textContent = "提交失败：" + (e && e.message ? e.message : e);
      });
    }

    submit.addEventListener("click", function () { send(false); });
    skip.addEventListener("click", function () { send(true); });
    actions.appendChild(error);
    actions.appendChild(skip);
    actions.appendChild(submit);
    form.appendChild(actions);
    card.appendChild(form);
    scrollChatToBottom();
  }

  // request_user_job: render a card describing the human task, with a textarea
  // for the user's free-text report and submit/cancel. Submission resolves the
  // suspended tool call through the same channel as answerQuestions.
  function renderUserJob(card, evt) {
    if (!card) return;
    var old = card.querySelector(".user-job");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var form = makeEl("user-job", "user-job");
    form.setAttribute("data-job-id", evt.id || "");
    form.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = makeEl("ask-title", "ask-title");
    title.textContent = evt.title || "需要你手动完成一项任务";
    form.appendChild(title);

    var desc = makeEl("ask-text", "ask-text");
    desc.textContent = evt.description || "";
    form.appendChild(desc);

    var hint = makeEl("ask-option-desc", "ask-option-desc");
    hint.textContent = "请在真实环境中完成上述任务，然后在此填写结果报告：";
    form.appendChild(hint);

    var textarea = document.createElement("textarea");
    textarea.className = "user-job-result";
    textarea.rows = 4;
    textarea.placeholder = "在此描述你完成的情况与结果……";
    form.appendChild(textarea);

    var actions = makeEl("ask-actions", "ask-actions");
    var error = makeEl("ask-error", "ask-error");
    error.hidden = true;
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-deny";
    cancel.textContent = "取消任务";
    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn-approve";
    submit.textContent = "提交结果";

    function send(cancelOnly) {
      var result = cancelOnly ? "" : String(textarea.value || "").trim();
      submit.disabled = true;
      cancel.disabled = true;
      error.hidden = true;
      AgentClient.call("answerUserJob", { id: evt.id, cancel: cancelOnly, result: result }).then(function (ok) {
        if (ok === false) throw new Error("该任务已失效或本轮已结束");
        if (ok && ok.error) throw new Error(ok.error);
        form.querySelectorAll("input,textarea,button").forEach(function (node) { node.disabled = true; });
        var done = makeEl("ask-submitted", "ask-submitted");
        done.textContent = cancelOnly ? "已取消任务" : "已提交结果";
        form.appendChild(done);
      }).catch(function (e) {
        submit.disabled = false;
        cancel.disabled = false;
        error.hidden = false;
        error.textContent = "提交失败：" + (e && e.message ? e.message : e);
      });
    }

    submit.addEventListener("click", function () { send(false); });
    cancel.addEventListener("click", function () { send(true); });
    actions.appendChild(error);
    actions.appendChild(cancel);
    actions.appendChild(submit);
    form.appendChild(actions);
    card.appendChild(form);
    scrollChatToBottom();
  }
  function createApprovalCard(evt) {
    var card = document.createElement("div");
    card.className = "tool-call approval";
    var head = document.createElement("div");
    head.className = "tool-head";
    // autonomous 模式下的自动拒绝：静态卡，无授权按钮（core 已 deny 且未挂起等待）
    if (evt.autoDenied) {
      head.textContent = "autonomous 自动拒绝：" + (evt.name || "tool");
      var args = document.createElement("div");
      args.className = "tool-args";
      args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
      card.appendChild(head); card.appendChild(args);
      chatTab.appendChild(card);
      scrollChatToBottom();
      return;
    }
    var auto = evt.permission === "allow" || evt.permission === "deny";
    head.textContent = auto
      ? (evt.permission === "allow" ? "已自动允许：" : "策略拒绝：") + (evt.name || "tool")
      : "工具授权请求：" + (evt.name || "tool");
    var args = document.createElement("div");
    args.className = "tool-args";
    args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
    card.appendChild(head); card.appendChild(args);
    if (!auto) {
      var bar = document.createElement("div");
      bar.className = "approval-bar";
      var allow = document.createElement("button");
      allow.textContent = "批准"; allow.className = "btn-approve";
      var deny = document.createElement("button");
      deny.textContent = "拒绝"; deny.className = "btn-deny";
      allow.addEventListener("click", function () {
        AgentClient.call("approval", { id: evt.id, decision: "approve" });
        allow.disabled = true; deny.disabled = true; allow.textContent = "已批准";
      });
      deny.addEventListener("click", function () {
        AgentClient.call("approval", { id: evt.id, decision: "deny" });
        allow.disabled = true; deny.disabled = true; deny.textContent = "已拒绝";
      });
      bar.appendChild(allow); bar.appendChild(deny);
      card.appendChild(bar);
    }
    chatTab.appendChild(card);
    scrollChatToBottom();
  }
  function onChatEventFlat(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "token") {
      if (!currentAssistantBubble) currentAssistantBubble = appendMessage("assistant", evt.delta || "");
      else AgentMarkdown.append(currentAssistantBubble, evt.delta || "");
      scrollChatToBottom();
    } else if (evt.type === "reasoning") {
      if (!currentThoughtBubble) currentThoughtBubble = appendMessage("thought", evt.delta || "");
      else AgentMarkdown.append(currentThoughtBubble, evt.delta || "");
      scrollChatToBottom();
    } else if (evt.type === "tool_call") {
      var card = createToolCard(evt);
      chatTab.appendChild(card);
      toolCards[evt.id] = card;
      scrollChatToBottom();
    } else if (evt.type === "tool_result") {
      var c = toolCards[evt.id];
      if (c) setToolResult(c, evt);
    } else if (evt.type === "done") {
      if (evt.message) bareHistory.push({ role: "assistant", content: evt.message.content || "" });
      flushMessageBubbles();
      currentAssistantBubble = null;
      currentThoughtBubble = null;
      resetFlatTranslationState();
    } else if (evt.type === "turn-end") {
      // 本轮终止原因由 core 统一给出；异常终止不会再发 done
      flushMessageBubbles();
      if (evt.reason === "translation-error") {
        currentAssistantBubble = null;
        currentThoughtBubble = null;
        resetFlatTranslationState();
        return;
      }
      if (evt.status !== "succeeded") {
        appendMessage("assistant", "[本轮终止] " + (evt.reason || "unknown") + (evt.error ? ": " + evt.error : ""));
      }
      currentAssistantBubble = null;
      currentThoughtBubble = null;
      resetFlatTranslationState();
    } else if (evt.type === "plan-mode") {
      currentPlanMode = evt.active === true;
      // exit_plan_mode 批准后 core 退出 plan-mode：UI 同步把 activity 切到 build（批准=同意实施）
      if (!evt.active) { currentActivityCompleted = true; setActivityMode("build-code"); renderActivityIndicator(); }
    } else if (evt.type === "approval-request") {
      createApprovalCard(evt);
    } else if (evt.type === "error") {
      flushMessageBubbles();
      appendMessage("assistant", "[出错] " + (evt.error || "未知错误"));
      currentAssistantBubble = null;
      currentThoughtBubble = null;
      resetFlatTranslationState();
    }
  }

  // ---------- turn-step 层级渲染 ----------
  function ensureLiveStep() {
    if (!liveTurn) { liveTurn = makeEl("turn", "turn"); chatTab.appendChild(liveTurn); }
    if (!liveStep) {
      liveStep = makeEl("step", "step");
      liveTurn.appendChild(liveStep);
      liveResponse = makeEl("model-response", "model-response");
      liveStep.appendChild(liveResponse);
      liveAnswer = null; liveCards = {};
    }
    return liveStep;
  }
  function ensureAnswer() {
    ensureLiveStep();
    if (!liveAnswer) { liveAnswer = makeEl("answer", "answer textcard"); liveResponse.appendChild(liveAnswer); }
    return liveAnswer;
  }
  function flushLiveMarkdown() {
    if (!liveResponse) return;
    var cards = liveResponse.querySelectorAll(".textcard");
    Array.prototype.forEach.call(cards, function (n) { AgentMarkdown.flush(n); });
  }
  // system-prompt：折叠展示本轮装配结果；data-name 与 ui.md 布局树一致。
  function makeSystemPrompt(content) {
    var details = document.createElement("details");
    details.className = "system-prompt";
    details.setAttribute("data-name", "system-prompt");
    var summary = document.createElement("summary");
    summary.textContent = "系统提示词";
    var pre = document.createElement("pre");
    pre.textContent = content || "";
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }
  function addSystemPrompt(req, content) {
    if (!req || !content) return;
    if (req.querySelector(".system-prompt")) return;
    req.insertBefore(makeSystemPrompt(content), req.firstChild);
  }
  function addAgentRequest(text) {
    ensureLiveStep();
    var req = makeEl("agent-request", "agent-request");
    var userInput = makeEl("user-input", "user-input");
    userInput.textContent = text || "";
    req.appendChild(userInput);
    liveStep.insertBefore(req, liveResponse); // agent-request 位于 model-response 之前
    liveAgentRequest = req;
    liveUserInput = userInput;
    liveUserOriginal = text || "";
    liveUserTranslation = null;
    liveAssistantTranslation = null;
    return req;
  }
  function getToolCard(id) {
    if (liveCards[id]) return liveCards[id];
    ensureLiveStep();
    var card = makeEl("tool-call-card", "tool-call-card tool-call");
    card.setAttribute("data-call-id", id);
    liveResponse.appendChild(card);
    card.addEventListener("click", function () { showToolDetail(card); });
    liveCards[id] = card;
    return card;
  }
  function setToolDesc(card, evt) {
    var argsText = JSON.stringify(evt.arguments || {});
    card.setAttribute("data-tool", evt.name || "tool");
    card.setAttribute("data-op", evt.name || "tool");
    card.setAttribute("data-args", JSON.stringify(evt.arguments || {}, null, 2));
    var desc = card.querySelector(".tool-call-desc");
    if (!desc) {
      desc = makeEl("tool-call-desc", "tool-call-desc");
      card.insertBefore(desc, card.firstChild);
    }
    desc.textContent = (evt.name || "tool") + " " + argsText;
    desc.title = desc.textContent;
    maybeAddPreviewBtn(card);
  }
  // 产物预览入口：仅对写文件类工具（write/edit）且在参数含 file_path 时显示「预览」按钮。
  var ARTIFACT_TOOLS = { write: 1, edit: 1 };
  function maybeAddPreviewBtn(card) {
    var tool = (card.getAttribute("data-tool") || "").toLowerCase();
    if (!ARTIFACT_TOOLS[tool]) return;
    var args;
    try { args = JSON.parse(card.getAttribute("data-args") || "{}"); } catch (e) { args = {}; }
    if (!args || !args.file_path) return;
    if (card.querySelector(".artifact-preview-btn")) return;
    var btn = document.createElement("button");
    btn.className = "artifact-preview-btn";
    btn.setAttribute("data-name", "artifact-preview-btn");
    btn.textContent = "预览";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();  // 不触发卡片整体的 showToolDetail
      previewArtifact(args.file_path);
    });
    card.appendChild(btn);
  }

  function truncateText(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  function approvalMeta(permission) {
    if (permission === "allow") return { cls: "allow", label: "已允许" };
    if (permission === "deny") return { cls: "deny", label: "已拒绝" };
    return { cls: "ask", label: "待授权" };
  }
  function approvalArgsText(args) {
    try {
      var text = JSON.stringify(args || {});
      return (!text || text === "{}") ? "" : truncateText(text, 60);
    } catch (e) { return ""; }
  }
  // approval-request 单行：状态 + 工具名（待授权时附参数摘要）+ 决策按钮。
  function renderApproval(ap, opts) {
    var meta = approvalMeta(opts.permission);
    ap.className = "approval-request " + meta.cls;
    ap.innerHTML = "";
    var status = document.createElement("span");
    status.className = "approval-status";
    status.textContent = opts.autoDenied ? "autonomous 自动拒绝" : meta.label;
    var tool = document.createElement("span");
    tool.className = "approval-tool";
    tool.textContent = opts.name || "tool";
    ap.appendChild(status);
    ap.appendChild(tool);
    // 已允许/已拒绝只保留状态 + 工具名：参数在上方 tool-call-desc 里，避免重复。
    // 待授权时才补参数摘要，帮助用户判断这次调用。
    if (meta.cls === "ask") {
      var argsText = approvalArgsText(opts.arguments);
      if (argsText) {
        var args = document.createElement("span");
        args.className = "approval-args";
        args.textContent = argsText;
        args.title = JSON.stringify(opts.arguments || {});
        ap.appendChild(args);
      }
    }
    if (meta.cls !== "ask" || !opts.onDecision) return;
    var bar = document.createElement("span");
    bar.className = "approval-bar";
    var allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "批准";
    allow.className = "btn-approve";
    var deny = document.createElement("button");
    deny.type = "button";
    deny.textContent = "拒绝";
    deny.className = "btn-deny";
    function decide(decision) {
      opts.onDecision(decision);
      renderApproval(ap, {
        permission: decision === "approve" ? "allow" : "deny",
        name: opts.name,
        arguments: opts.arguments
      });
    }
    allow.addEventListener("click", function (e) { e.stopPropagation(); decide("approve"); });
    deny.addEventListener("click", function (e) { e.stopPropagation(); decide("deny"); });
    bar.appendChild(allow);
    bar.appendChild(deny);
    ap.appendChild(bar);
  }
  function setApproval(card, evt) {
    setToolDesc(card, evt);
    var permission = evt.permission || "ask";
    card.setAttribute("data-permission", permission);
    var ap = card.querySelector(".approval-request");
    if (!ap) {
      ap = makeEl("approval-request", "approval-request");
      // ui.md 顺序：tool-call-desc -> approval-request -> tool-result
      var result = card.querySelector(".tool-result");
      card.insertBefore(ap, result || null);
    }
    renderApproval(ap, {
      permission: permission,
      name: evt.name,
      arguments: evt.arguments,
      autoDenied: evt.autoDenied === true,
      onDecision: (permission === "ask" && !evt.autoDenied) ? function (decision) {
        AgentClient.call("approval", { id: evt.id, decision: decision });
      } : null
    });
  }

  // Tool results are model-facing text. `isError` comes from the event (live)
  // or from calls.status (replay); meta is for future dedicated cards.
  function renderToolResult(card, text, isError) {
    text = String(text == null ? "" : text);
    var old = card.querySelector(".tool-result");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    card.setAttribute("data-result", text);
    var isRead = (card.getAttribute("data-tool") || "").toLowerCase() === "read";
    if (isError) {
      var err = makeEl("tool-result", "tool-result read-error");
      err.textContent = "→ " + text;
      card.appendChild(err);
      return;
    }
    if (!isRead) {
      var plain = makeEl("tool-result", "tool-result");
      plain.textContent = "→ " + text;
      card.appendChild(plain);
      return;
    }
    var details = document.createElement("details");
    details.className = "tool-result read-result";
    details.setAttribute("data-name", "tool-result");
    var lines = text.length ? text.split("\n").length : 0;
    var size = window.TextEncoder ? new TextEncoder().encode(text).length : text.length;
    var summary = document.createElement("summary");
    summary.textContent = "→ 读取结果 · " + lines + " 行 · " + formatBytes(size);
    try {
      var args = JSON.parse(card.getAttribute("data-args") || "{}");
      if (args && args.file_path) summary.title = args.file_path;
    } catch (e) {}
    var pre = document.createElement("pre");
    pre.textContent = text;
    details.appendChild(summary);
    details.appendChild(pre);
    details.addEventListener("click", function (e) { e.stopPropagation(); });
    card.appendChild(details);
  }
  // exit_plan_mode: show the complete plan as markdown, then approve or keep
  // planning with feedback. The tool call remains blocked until this resolves.
  function renderPlanReview(card, evt) {
    if (!card) return;
    var old = card.querySelector(".plan-review");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = makeEl("plan-review", "plan-review");
    box.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = makeEl("plan-review-title", "plan-review-title");
    title.textContent = "计划审批：" + (evt.title || "Plan");
    var body = makeEl("plan-review-body", "plan-review-body textcard");
    AgentMarkdown.set(body, evt.plan || "");
    var feedback = document.createElement("textarea");
    feedback.className = "plan-review-feedback";
    feedback.rows = 2;
    feedback.placeholder = "不批准时，写下修改意见（可选）";
    var actions = makeEl("plan-review-actions", "plan-review-actions");
    var error = makeEl("plan-review-error", "plan-review-error");
    error.hidden = true;
    var keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn-deny";
    keep.textContent = "继续计划";
    var approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn-approve";
    approve.textContent = "批准并退出计划模式";

    function send(approved) {
      approve.disabled = true;
      keep.disabled = true;
      error.hidden = true;
      window.AgentClient.call("answerPlanReview", {
        id: evt.id,
        approved: approved,
        feedback: feedback.value,
      }).then(function (ok) {
        if (ok === false) throw new Error("该计划审批已失效或本轮已结束");
        if (ok && ok.error) throw new Error(ok.error);
        feedback.disabled = true;
        var done = makeEl("plan-review-done", "plan-review-done");
        done.textContent = approved ? "已批准，计划模式已退出" : "已退回，继续计划";
        box.appendChild(done);
      }).catch(function (e) {
        approve.disabled = false;
        keep.disabled = false;
        error.hidden = false;
        error.textContent = "提交失败：" + (e && e.message ? e.message : e);
      });
    }

    approve.addEventListener("click", function () { send(true); });
    keep.addEventListener("click", function () { send(false); });
    actions.appendChild(error);
    actions.appendChild(keep);
    actions.appendChild(approve);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(feedback);
    box.appendChild(actions);
    card.appendChild(box);
    scrollChatToBottom();
  }

  function resetLive() {
    liveTurn = liveStep = liveResponse = liveAnswer = liveAgentRequest = null;
    liveCards = {};
    liveUserInput = null;
    liveUserOriginal = "";
    liveUserTranslation = null;
    liveAssistantTranslation = null;
  }

  // ---------- turn-step 的中英对照渲染 ----------
  function ensureUserTranslation(original) {
    if (!liveUserTranslation && liveAgentRequest) {
      liveUserTranslation = makeTranslationBlock("中文原文", original || "", false);
      liveAgentRequest.appendChild(liveUserTranslation);
      scrollChatToBottom();
    }
    return liveUserTranslation;
  }
  function ensureAssistantTranslation() {
    if (!liveAssistantTranslation) {
      ensureLiveStep();
      ensureAnswer();
      liveAssistantTranslation = makeTranslationBlock("中文译文", "翻译中…", true);
      liveResponse.appendChild(liveAssistantTranslation);
      scrollChatToBottom();
    }
    return liveAssistantTranslation;
  }
  function handleTranslationTurn(evt) {
    if (evt.role === "user") {
      if (evt.phase === "start") {
        if (!liveUserInput) return;
        liveUserOriginal = evt.source || liveUserOriginal || "";
        liveUserInput.textContent = "翻译中…";
        liveUserInput.classList.add("translating");
        ensureUserTranslation(liveUserOriginal);
      } else if (evt.phase === "done") {
        if (!liveUserInput) return;
        liveUserInput.textContent = evt.text || "";
        liveUserInput.classList.remove("translating");
        if (evt.source) ensureUserTranslation(evt.source);
        scrollChatToBottom();
      } else if (evt.phase === "error") {
        // 输入翻译失败：本轮不发送。恢复输入框并移除未发送的气泡。
        if (input) { input.value = evt.source || liveUserOriginal || ""; input.focus(); }
        if (liveTurn && liveTurn.parentNode) liveTurn.parentNode.removeChild(liveTurn);
        resetLive();
        if (!chatTab.querySelector(".turn")) showEmptyHint();
        if (window.uiAlert) uiAlert("输入翻译失败：" + (evt.error || "未知错误") + "\n请改用英文重新发送。");
      }
      return;
    }
    if (evt.role !== "assistant") return;
    if (evt.phase === "start") {
      ensureAssistantTranslation();
    } else if (evt.phase === "done") {
      var block = ensureAssistantTranslation();
      setTranslationText(block, evt.text || "", true);
      scrollChatToBottom();
    } else if (evt.phase === "error") {
      if (liveAssistantTranslation && liveAssistantTranslation.parentNode) {
        liveAssistantTranslation.parentNode.removeChild(liveAssistantTranslation);
      }
      liveAssistantTranslation = null;
      if (liveResponse) appendTranslationErrorNotice(liveResponse, evt.error);
    }
  }

  // composer 内 model-http-status 状态切换（on-wait / on-post / on-get）
  var HTTP_STATUS_LABEL = { "on-wait": "wait", "on-post": "post", "on-get": "get" };
  function setModelHttpStatus(state, status) {
    if (!modelHttpStatus || !state) return;
    var states = modelHttpStatus.querySelectorAll(".state");
    Array.prototype.forEach.call(states, function (s) { s.hidden = true; });
    var el = modelHttpStatus.querySelector(".state." + state);
    if (!el) return;
    el.textContent = (state === "on-get" && status) ? ("get " + status) : HTTP_STATUS_LABEL[state];
    el.hidden = false;
  }

  // 状态栏（chat-footer）渲染：DSH 风格三段。
  // 活动 / 权限档 / 自主度已有各自固定控件承载，不在状态栏重复。无数据项显示 "-"。
  function fmtNum(n) { return (n == null) ? "-" : String(n); }
  function fmtPct(num, den) {
    if (num == null || den == null || !den) return "-";
    return Math.round((num / den) * 100) + "%";
  }
  // token 数人类可读：>=1e6 -> X.XM，>=1e3 -> X.Xk，否则原值
  function fmtTok(n) {
    if (n == null) return "-";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }
  // 上下文占用环形图（DSH 同款 SVG donut）：track + 动态 fill 弧，按占用百分比更新。
  var CIRC_R = 5.5;
  var CIRC_C = 2 * Math.PI * CIRC_R; // ≈ 34.5575
  var ctxDonutFill = null;   // <circle class="ctx-donut-fill">
  var ctxDonutLabel = null;  // 百分比文本节点
  function ensureContextDonut() {
    if (!footerContextUsed || ctxDonutFill) return;
    footerContextUsed.innerHTML = "";
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("ctx-donut");
    var track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("class", "ctx-donut-track");
    track.setAttribute("cx", "7"); track.setAttribute("cy", "7"); track.setAttribute("r", String(CIRC_R));
    ctxDonutFill = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ctxDonutFill.setAttribute("class", "ctx-donut-fill");
    ctxDonutFill.setAttribute("cx", "7"); ctxDonutFill.setAttribute("cy", "7"); ctxDonutFill.setAttribute("r", String(CIRC_R));
    ctxDonutFill.setAttribute("transform", "rotate(-90 7 7)");
    ctxDonutFill.setAttribute("stroke-dasharray", "0 " + CIRC_C);
    svg.appendChild(track);
    svg.appendChild(ctxDonutFill);
    ctxDonutLabel = document.createElement("span");
    ctxDonutLabel.className = "ctx-donut-label";
    footerContextUsed.appendChild(svg);
    footerContextUsed.appendChild(ctxDonutLabel);
  }
  function setContextDonut(pct) {
    ensureContextDonut();
    if (!ctxDonutFill) return;
    var clamped = Math.max(0, Math.min(100, pct == null ? 0 : pct));
    var arc = (clamped / 100) * CIRC_C;
    ctxDonutFill.setAttribute("stroke-dasharray", arc.toFixed(3) + " " + (CIRC_C - arc).toFixed(3));
    if (ctxDonutLabel) ctxDonutLabel.textContent = (pct == null) ? "-" : Math.round(pct) + "%";
  }
  function renderStatusBar() {
    // 左：turns steps · tok/s（会话累计 turns/steps + 最近一轮 TPS；DSH 风格：turns/steps 间用空格）
    if (footerSessionStats) {
      var tps = "-";
      if (usageState.total != null && turnStat.durationMs != null && turnStat.durationMs > 0) {
        tps = (usageState.total / (turnStat.durationMs / 1000)).toFixed(0);
      }
      footerSessionStats.textContent =
        "⟳ " + fmtNum(sessionStat.turns) + " turns " + fmtNum(sessionStat.steps) + " steps · " + tps + " tok/s";
    }
    // 中：tokens · Cache hit %
    if (footerTokenUsage) {
      footerTokenUsage.textContent =
        "▤ " + fmtTok(usageState.total) + " tok · Cache hit " + fmtPct(usageState.cached, usageState.prompt);
    }
    // 右：上下文占用（SVG donut + 百分比标签）
    var ctxPct = (usageState.total != null) ? (usageState.total / CONTEXT_WINDOW) * 100 : null;
    setContextDonut(ctxPct);
  }
  function resetStatusBar() {
    usageState = { prompt: null, completion: null, total: null, cached: null };
    turnStat = { steps: null, tools: null, durationMs: null };
    sessionStat = { turns: 0, steps: 0 };
    renderStatusBar();
  }

  function onChatEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "model-http-status") { setModelHttpStatus(evt.state, evt.status); return; }
    if (evt.type === "usage") {
      usageState.prompt = evt.promptTokens != null ? evt.promptTokens : usageState.prompt;
      usageState.completion = evt.completionTokens != null ? evt.completionTokens : usageState.completion;
      usageState.total = evt.totalTokens != null ? evt.totalTokens : usageState.total;
      usageState.cached = evt.cachedTokens != null ? evt.cachedTokens : usageState.cached;
      renderStatusBar();
      return;
    }
    if (evt.type === "translation") {
      if (getActivityMode() === "bare-chat") handleTranslationFlat(evt);
      else handleTranslationTurn(evt);
      return;
    }
    if (getActivityMode() === "bare-chat") { onChatEventFlat(evt); return; }
    // turn-step：按层级渲染
    if (evt.type === "reasoning") {
      ensureLiveStep();
      var thEl = liveResponse.querySelector(".thought");
      if (!thEl) { thEl = makeEl("thought", "thought textcard"); liveResponse.appendChild(thEl); }
      AgentMarkdown.append(thEl, evt.delta || "");
      scrollChatToBottom();
    } else if (evt.type === "token") {
      AgentMarkdown.append(ensureAnswer(), evt.delta || "");
      scrollChatToBottom();
    } else if (evt.type === "tool_call") {
      setToolDesc(getToolCard(evt.id), evt);
      scrollChatToBottom();
    } else if (evt.type === "tool_result") {
      var hc = liveCards[evt.id];
      if (hc) {
        renderToolResult(hc, evt.content, evt.isError);
        if (evt.name === "todo_write" && evt.meta && Array.isArray(evt.meta.todos)) {
          renderTodoList(hc, evt.meta.todos);
        }
      }
    } else if (evt.type === "ask-user-question") {
      renderAskUserQuestion(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "user-job-request") {
      renderUserJob(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "user-job-update") {
      document.querySelectorAll(".user-job[data-job-id='" + (evt.id || "") + "']").forEach(function (node) {
        if (node.querySelector(".ask-submitted")) return;
        node.querySelectorAll("input,textarea,button").forEach(function (n) { n.disabled = true; });
        var note = makeEl("ask-submitted", "ask-submitted");
        note.textContent = evt.status === "killed" ? "任务已被取消" : "任务已结束";
        node.appendChild(note);
      });
    } else if (evt.type === "plan-review") {
      renderPlanReview(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "plan-mode") {
      currentPlanMode = evt.active === true;
      // exit_plan_mode 批准后 core 退出 plan-mode：UI 同步把 activity 切到 build（批准=同意实施）
      if (!evt.active) { currentActivityCompleted = true; setActivityMode("build-code"); renderActivityIndicator(); }
    } else if (evt.type === "approval-request") {
      setApproval(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "system-prompt") {
      ensureLiveStep();
      if (!liveAgentRequest) {
        liveAgentRequest = makeEl("agent-request", "agent-request");
        liveStep.insertBefore(liveAgentRequest, liveResponse);
      }
      addSystemPrompt(liveAgentRequest, evt.content);
    } else if (evt.type === "step-start") {
      // 上一轮 step 的 tool-call 已全部完成，模型将再次被请求（对应 behavior.md 的 request-time）
      flushLiveMarkdown();
      if (!liveTurn) { liveTurn = makeEl("turn", "turn"); chatTab.appendChild(liveTurn); }
      liveStep = makeEl("step", "step");
      liveTurn.appendChild(liveStep);
      liveResponse = makeEl("model-response", "model-response");
      liveStep.appendChild(liveResponse);
      liveAnswer = null; liveCards = {}; liveAgentRequest = null;
      liveUserInput = null; liveUserTranslation = null; liveAssistantTranslation = null;
      scrollChatToBottom();
    } else if (evt.type === "done") {
      flushLiveMarkdown();
      resetLive();
    } else if (evt.type === "turn-end") {
      // 输入翻译失败已经在 translation 事件里恢复输入框并移除气泡，这里只收尾。
      if (evt.reason === "translation-error") { flushLiveMarkdown(); resetLive(); return; }
      // 异常终止不经过 done：把原因写进本 step 的 answer 再收尾
      if (evt.status !== "succeeded") {
        AgentMarkdown.append(ensureAnswer(), "[本轮终止] " + (evt.reason || "unknown") + (evt.error ? ": " + evt.error : ""));
      }
      // 状态栏：记录本轮步数 / 工具数 / 耗时，累计会话 turns/steps，重算 tok/s
      turnStat.steps = (evt.steps != null) ? evt.steps : turnStat.steps;
      turnStat.tools = (evt.tools != null) ? evt.tools : turnStat.tools;
      turnStat.durationMs = (evt.durationMs != null) ? evt.durationMs : turnStat.durationMs;
      sessionStat.turns += 1;
      if (evt.steps != null) sessionStat.steps += evt.steps;
      renderStatusBar();
      flushLiveMarkdown();
      resetLive();
    } else if (evt.type === "error") {
      AgentMarkdown.append(ensureAnswer(), "[出错] " + (evt.error || "未知错误"));
      flushLiveMarkdown();
      resetLive();
    }
  }
  async function buildMessages(sessionId) {
    var pendingCallIds = [];
    var turns = await window.AgentClient.call("storage", { op: "turn.list", payload: { session_id: sessionId } });
    var msgs = [];
    for (var i = 0; i < (turns || []).length; i++) {
      var steps = await window.AgentClient.call("storage", { op: "step.list", payload: { turn_id: turns[i].id } });
      for (var j = 0; j < (steps || []).length; j++) {
        var list = await window.AgentClient.call("storage", { op: "message.list", payload: { step_id: steps[j].id } });
        for (var k = 0; k < (list || []).length; k++) {
          var m = list[k];
          if (m.role === "user") {
  msgs.push({ role: "user", content: m.content });
} else if (m.role === "assistant") {
  var am = { role: "assistant", content: m.content || "" };
  var calls = await window.AgentClient.call("storage", { op: "call.list", payload: { reply_id: m.id } });
  var callIds = [];
  if (calls && calls.length) {
    am.tool_calls = calls.map(function (c) { var cid = String(c.call_id != null ? c.call_id : c.id); callIds.push(cid); return { id: cid, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }; });
  }
  pendingCallIds = callIds;
  msgs.push(am);
} else if (m.role === "tool") {
  // 与同步骤内 assistant 的 tool_calls 按出现顺序配对（messages 表已无 tool_call_id 列）
  var tcid = (pendingCallIds && pendingCallIds.length) ? pendingCallIds.shift() : "";
  msgs.push({ role: "tool", tool_call_id: tcid, content: m.content });
}
        }
      }
    }
    return msgs;
  }
  async function renderSessionMessages(sessionId) {
    chatTab.innerHTML = "";
    resetLive();
    var turns = await window.AgentClient.call("storage", { op: "turn.list", payload: { session_id: sessionId } });
    if (!turns || !turns.length) { showEmptyHint(); return; }
    for (var t = 0; t < turns.length; t++) {
      var turnNode = makeEl("turn", "turn");
      chatTab.appendChild(turnNode);
      var steps = await window.AgentClient.call("storage", { op: "step.list", payload: { turn_id: turns[t].id } });
      for (var st = 0; st < (steps || []).length; st++) {
        var stepNode = makeEl("step", "step");
        turnNode.appendChild(stepNode);
        var respNode = makeEl("model-response", "model-response");
        stepNode.appendChild(respNode);
        var msgs = await window.AgentClient.call("storage", { op: "message.list", payload: { step_id: steps[st].id } });
        var systemMsg = null, userMsg = null, asstMsg = null, toolMsgs = [];
        for (var k = 0; k < (msgs || []).length; k++) {
          var m = msgs[k];
          if (m.role === "system") systemMsg = m;
          else if (m.role === "user") userMsg = m;
          else if (m.role === "assistant") asstMsg = m;
          else if (m.role === "tool") toolMsgs.push(m);
        }
        if (userMsg) {
          var req = makeEl("agent-request", "agent-request");
          if (systemMsg && systemMsg.content) req.appendChild(makeSystemPrompt(systemMsg.content));
          var uiInput = makeEl("user-input", "user-input");
          uiInput.textContent = userMsg.content || "";
          req.appendChild(uiInput);
          stepNode.insertBefore(req, respNode);
        }
        if (asstMsg) {
          if (asstMsg.thought) {
            var th = makeEl("thought", "thought textcard");
            AgentMarkdown.set(th, asstMsg.thought);
            respNode.appendChild(th);
          }
          if (asstMsg.content) {
            var ans = makeEl("answer", "answer textcard");
            AgentMarkdown.set(ans, asstMsg.content || "");
            respNode.appendChild(ans);
          }
          var calls = await window.AgentClient.call("storage", { op: "call.list", payload: { reply_id: asstMsg.id } });
          for (var c = 0; c < (calls || []).length; c++) {
            var call = calls[c];
            var card = makeEl("tool-call-card", "tool-call-card tool-call");
            card.setAttribute("data-call-id", String(call.id));
            card.setAttribute("data-tool", call.name);
            card.setAttribute("data-op", call.name);
            card.setAttribute("data-args", JSON.stringify(call.arguments || {}, null, 2));
            var desc = makeEl("tool-call-desc", "tool-call-desc");
            desc.textContent = call.name + " " + JSON.stringify(call.arguments || {});
            desc.title = desc.textContent;
            card.appendChild(desc);
            maybeAddPreviewBtn(card);
            // ui.md：每个 tool-call-card 都有 approval-request；回放时按 status 展示结果。
            var ap = makeEl("approval-request", "approval-request");
            var permission = call.status === "pending" ? "ask" : call.status === "denied" ? "deny" : "allow";
            renderApproval(ap, { permission: permission, name: call.name, arguments: call.arguments });
            card.appendChild(ap);
            var tm = toolMsgs[c] || null;
            if (tm) renderToolResult(card, tm.content || "", call.status === "failed" || call.status === "denied");
            if (call.name === "todo_write") {
              var todoArgs = parseToolArgs(call);
              renderTodoList(card, todoArgs.todos);
            }
            respNode.appendChild(card);
            (function (cc) { cc.addEventListener("click", function () { showToolDetail(cc); }); })(card);
          }
        }
      }
    }
    scrollChatToBottom();
  }

  function selectSession(sess, node) {
    currentSessionId = sess.id;
    currentActivity = (sess && sess.activity) || "bare-chat";
    trajectoryLoadedFor = null;  // 切换会话后轨迹需重新拉取
    if (sessionNameLabel) sessionNameLabel.textContent = sess.name || ("会话 " + sess.id);
    document.querySelectorAll(".session-item").forEach(function (n) { n.classList.remove("active"); });
    if (node) node.classList.add("active");
    renderSessionMessages(sess.id);
    currentActivityCompleted = false;
    renderActivityIndicator();
    syncPlanModeFromActivity();
    resetStatusBar();   // 切换会话清空上一轮 token / 耗时统计
    if (input) input.focus();
  }
  async function runBareChat(text) {
    input.value = "";
    var userNode = appendFlatUser(text);
    flatUserWrap = userNode.wrap;
    flatUserBubble = userNode.bubble;
    flatUserOriginal = text;
    flatUserTranslation = null;
    flatAssistantTranslation = null;
    bareHistory.push({ role: "user", content: text });
    currentAssistantBubble = null; toolCards = {};
    try {
      // bare-chat：不传 sessionId（core 不落库），toolNames 传空以禁用工具调用，历史仅存内存
      await window.AgentClient.call("chat", { messages: bareHistory.slice(), toolNames: [], references: pendingRefs.slice(), effort: computeEffort(), model: (modelSelector && modelSelector.value ? modelSelector.value : undefined) }, onChatEvent);
      pendingRefs = []; renderRefChips();
    } catch (e) {
      console.error("chat failed:", e);
      appendMessage("assistant", "[出错] " + (e && e.message ? e.message : e));
    }
  }
  async function onSend() {
    var text = input.value.trim();
    if (!text) return;
    markUserActivity();
    if (getActivityMode() === "bare-chat") { await runBareChat(text); return; }
    if (!currentSessionId) { await uiAlert("请先在左侧选择或新建一个会话"); return; }
    input.value = "";
    hideEmptyHint();
    resetLive();
    liveTurn = makeEl("turn", "turn");
    chatTab.appendChild(liveTurn);
    liveStep = makeEl("step", "step");
    liveTurn.appendChild(liveStep);
    liveResponse = makeEl("model-response", "model-response");
    liveStep.appendChild(liveResponse);
    liveAnswer = null; liveCards = {};
    addAgentRequest(text);
    try {
      var history = await buildMessages(currentSessionId);
      history.push({ role: "user", content: text });
      var refs = pendingRefs.slice();
      await window.AgentClient.call("chat", { messages: history, sessionId: currentSessionId, autonomy: getAutonomyMode(), activity: getActivityMode(), references: refs, effort: computeEffort(), model: (modelSelector && modelSelector.value ? modelSelector.value : undefined) }, onChatEvent);
      pendingRefs = []; renderRefChips();
    } catch (e) {
      console.error("chat failed:", e);
      AgentMarkdown.append(ensureAnswer(), "[出错] " + (e && e.message ? e.message : e));
      flushLiveMarkdown();
      resetLive();
    }
  }

  if (sendBtn) sendBtn.addEventListener("click", onSend);
  if (input) input.addEventListener("keydown", function (e) {
    markUserActivity();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });

  loadWorkspaces();

  // 状态栏：渲染初始空态（活动/权限/自主度已由各自控件承载，不在状态栏显示）
  renderStatusBar();

  // presence 自动机：定时 idle 检测 + 手动切换接管
  var presenceSwitch = document.getElementById("presenceSwitch");
  if (presenceSwitch) presenceSwitch.addEventListener("click", function () {
    setPresenceMode(getPresenceMode() === "in" ? "out" : "in");
    onPresenceManualChange();
  });
  var autonomySwitch = document.getElementById("autonomySwitch");
  if (autonomySwitch) autonomySwitch.addEventListener("click", function () {
    var next = getAutonomyMode() === "supervised" ? "autonomous" : "supervised";
    setAutonomyMode(next);
    localStorage.setItem("agent.autonomy", next);
    renderStatusBar();   // 自主度变化即时反映到状态栏
  });
  setInterval(tickPresence, PRESENCE_TICK_MS);

  // 活动指示器：点击打开切换菜单
  var activityIndicator = document.getElementById("activityIndicator");
  if (activityIndicator) activityIndicator.addEventListener("click", openActivityMenu);

  // ---------- composer 选择器：权限预设 / 模型 / 推理等级（DSH 风格） ----------
  // 读取/写入 user/settings.json（与 settings.js 同源）
  function getSettings() {
    try { return window.AgentClient.call("settings", { op: "get" }); } catch (e) { return Promise.resolve({}); }
  }
  function saveSettings(patch) {
    try { return window.AgentClient.call("settings", { op: "set", payload: patch }); } catch (e) { return Promise.resolve({}); }
  }

  // 权限预设映射（grill Q2）：
  //  read-only        : 只读工具全部 allow，其余 deny
  //  workspace-write  : 只读 + 工作区内写 allow，其余 deny（经 fs-policy 限制写路径）
  //  full-access      : 全部 allow
  //  fine-grained     : 不改写，打开侧栏 permissions modal 沿用 user/* 配置
  var READONLY_TOOLS = { read: 1, glob: 1, grep: 1, get_current_time: 1, get_goal: 1, calculator: 1,
    web_search: 1, web_fetch: 1, ask_user_question: 1, request_user_job: 1, job_list: 1, job_kill: 1, get_goal: 1 };
  var WRITE_TOOLS = { write: 1, edit: 1, bash: 1, create_goal: 1, update_goal: 1, todo_write: 1, delete_goal: 1 };
  function applyPermissionPreset(preset) {
    if (preset === "fine-grained") {
      // 不覆盖配置，引导用户打开权限 modal
      var pBtn = document.getElementById("permissionsBtn");
      if (pBtn) pBtn.click();
      return;
    }
    var tools = {};
    Object.keys(READONLY_TOOLS).forEach(function (t) { tools[t] = "allow"; });
    if (preset === "full-access") {
      // 全部放行
      Object.keys(WRITE_TOOLS).forEach(function (t) { tools[t] = "allow"; });
    } else if (preset === "workspace-write") {
      // 工作区内写允许；其余写工具 deny
      Object.keys(WRITE_TOOLS).forEach(function (t) { tools[t] = "allow"; });
    } else { // read-only
      Object.keys(WRITE_TOOLS).forEach(function (t) { tools[t] = "deny"; });
    }
    window.AgentClient.call("permissions", { op: "permissions.upsert", payload: { default: (preset === "full-access") ? "allow" : "deny", tools: tools } })
      .catch(function (e) { console.error("applyPermissionPreset failed:", e); });
    // workspace-write 额外收紧 fs-policy 到工作区（这里仅置默认 deny 之外的规则；实际路径限制由 fs-policy 承担）
  }

  var permissionSelector = document.getElementById("permissionSelector");
  if (permissionSelector) {
    permissionSelector.addEventListener("change", function () { applyPermissionPreset(permissionSelector.value); });
  }

  // 模型选择器：聚合 providers 的模型列表；选中持久化到 settings.model
  var modelSelector = document.getElementById("modelSelector");
  function refreshModelSelector() {
    if (!modelSelector) return;
    window.AgentClient.call("providers", { op: "get" }).then(function (list) {
      var models = [];
      modelSelector.innerHTML = "";
      (list || []).forEach(function (p) {
        if (!p.models || !p.models.length) return;
        var grp = document.createElement("optgroup");
        grp.label = p.name;  // 按 provider 标题分组
        p.models.forEach(function (m) {
          models.push(m.name);
          var o = document.createElement("option");
          o.value = m.name; o.textContent = m.name;
          o.setAttribute("data-provider", p.name);  // 记录所属 provider，供能力查询
          grp.appendChild(o);
        });
        modelSelector.appendChild(grp);
      });
      getSettings().then(function (st) {
        if (st && st.model && models.indexOf(st.model) >= 0) {
          modelSelector.value = st.model;
          refreshEffortLevels(st.model);  // 初始化时按当前模型拉取等级
        }
      });
    }).catch(function () {});
  }
  // 按模型获取推理等级列表：本地 providers.json 缓存优先，缺失时回退网络（DeepSeek effort.supported_levels / Venice ...），再兜底 low/medium/high。
  // 始终追加 "off" 选项（关闭推理）；若后端给出 default_level 则作为初始选择。
  function refreshEffortLevels(modelName) {
    if (!effortSelector) return;
    var opt = modelSelector ? modelSelector.querySelector('option[value="' + (modelName || "").replace(/"/g, '\\"') + '"]') : null;
    var provider = opt ? opt.getAttribute("data-provider") : null;
    // 两种不同来源、在不同 UI 渲染，必须区分：
    //   - providers.json 的 default_level = 模型提供商侧默认推理等级（静态元数据，在「编辑模型」页面显示）
    //   - settings.effort             = 用户实际选取的推理等级（用户偏好，在 composer 的 effort-selector 显示）
    // composer 这里只渲染「用户选择」；仅当用户尚无保存选择（首次）时，才用 default_level 作为兜底初值。
    getSettings().then(function (st) {
      var savedEffort = st && st.effort;  // 用户已选（可能为 "off"/"low"/...，也可能缺省）
      return window.AgentClient.call("modelCapabilities", { provider: provider, model: modelName }).then(function (res) {
        var levels = (res && res.effort && res.effort.length) ? res.effort.slice() : ["low", "medium", "high"];
        if (levels.indexOf("off") < 0) levels.unshift("off");  // 始终提供关闭推理选项，且置于列表首位
        effortSelector.innerHTML = "";
        levels.forEach(function (lv) {
          var o = document.createElement("option");
          o.value = lv; o.textContent = lv;
          effortSelector.appendChild(o);
        });
        // 用户已有明确选择 → 用它（最高优先级，不被 default_level 覆盖）
        // 用户无保存选择 → 用模型提供商的 default_level 作初次默认值，并落成新的用户选择
        // 二者皆无 → 列表首项
        var initial;
        if (savedEffort && levels.indexOf(savedEffort) >= 0) {
          initial = savedEffort;
        } else if (res && res.default_level && levels.indexOf(res.default_level) >= 0) {
          initial = res.default_level;
        } else {
          initial = levels[0];
        }
        effortSelector.value = initial;
        saveSettings({ effort: effortSelector.value });
      });
    }).catch(function () {
      // 网络失败：保持现有选项不变
    });
  }
  if (modelSelector) {
    modelSelector.addEventListener("change", function () {
      saveSettings({ model: modelSelector.value });
      refreshEffortLevels(modelSelector.value);
    });
    refreshModelSelector();
  }

  // 推理等级选择器：选项由 refreshEffortLevels 从网络动态填充（兜底 low/medium/high），选择持久化到 settings.effort
  var effortSelector = document.getElementById("effortSelector");
  if (effortSelector) {
    effortSelector.addEventListener("change", function () { saveSettings({ effort: effortSelector.value }); });
  }

  // think-switch 与 effort-selector 语义冲突（都向模型注入推理参数），由设置 reasoningControl 决定渲染哪一个。
  //  - "effort-selector"：显示推理等级下拉（off=关闭推理，其余=分级推理）
  //  - "think-switch"   ：显示思考开/关按钮（开=默认推理，关=thinking disabled）
  // 模型选择器（model-selector）两种模式都保留。
  var reasoningControl = "think-switch";

  function isThinkOn() {
    var ts = document.getElementById("thinkSwitch");
    return !!(ts && ts.classList.contains("active"));
  }
  // 按设置渲染：显示/隐藏对应推理控件
  function applyReasoningControlVisibility() {
    var ts = document.getElementById("thinkSwitch");
    if (ts) ts.style.display = (reasoningControl === "think-switch") ? "" : "none";
    var effortWrap = document.querySelector(".model-effort-selector");
    if (effortSelector) effortSelector.style.display = (reasoningControl === "effort-selector") ? "" : "none";
    if (effortWrap) effortWrap.style.display = (reasoningControl === "effort-selector" || reasoningControl === "think-switch") ? "" : "none";
  }
  // 读取设置中的 reasoningControl 并刷新可见性
  function loadReasoningControl() {
    return getSettings().then(function (st) {
      reasoningControl = (st && st.reasoningControl) || "think-switch";
      applyReasoningControlVisibility();
    }).catch(function () {});
  }
  // 计算发给 core 的 effort 参数：
  //  - think-switch 模式：开 → undefined（默认推理）；关 → "off"（thinking disabled）
  //  - effort-selector 模式：直接透传下拉值（off→thinking disabled；其余→reasoning_effort）
  function computeEffort() {
    if (reasoningControl === "think-switch") {
      return isThinkOn() ? undefined : "off";
    }
    if (effortSelector) return effortSelector.value || undefined;
    return undefined;
  }

  // 设置变更（来自 settings.js 弹窗）时重新渲染推理控件
  window.addEventListener("reasoning-control-changed", function (e) {
    reasoningControl = e.detail || "think-switch";
    applyReasoningControlVisibility();
  });

  // 7b) @ 引用：引用文件 / 会话，作为上下文随消息发送
  var refBtn = document.getElementById("refBtn");
  var refChips = document.querySelector(".ref-chips");
  var pendingRefs = [];

  function renderRefChips() {
    if (!refChips) return;
    refChips.innerHTML = "";
    if (!pendingRefs.length) { refChips.hidden = true; return; }
    refChips.hidden = false;
    pendingRefs.forEach(function (ref, idx) {
      var chip = document.createElement("span");
      chip.className = "ref-chip ref-" + ref.type;
      chip.setAttribute("data-name", "ref-chip");
      chip.textContent = (ref.type === "file" ? "📄 " : "💬 ") + ref.label;
      var x = document.createElement("button");
      x.className = "ref-chip-remove";
      x.setAttribute("data-name", "ref-chip-remove");
      x.textContent = "×";
      x.addEventListener("click", function () {
        pendingRefs.splice(idx, 1);
        renderRefChips();
      });
      chip.appendChild(x);
      refChips.appendChild(chip);
    });
  }

  function openRefMenu() {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("data-name", "ref-menu-overlay");
    var box = document.createElement("div");
    box.className = "modal-box ref-menu";
    box.setAttribute("data-name", "ref-menu");
    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "引用为上下文";
    box.appendChild(title);

    var sessionItem = document.createElement("button");
    sessionItem.className = "ref-menu-item";
    sessionItem.textContent = "💬 引用历史会话…";
    sessionItem.addEventListener("click", function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      pickSessionRef();
    });
    box.appendChild(sessionItem);

    var fileItem = document.createElement("button");
    fileItem.className = "ref-menu-item";
    fileItem.textContent = "📄 引用本地文件…";
    fileItem.addEventListener("click", function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      pickFileRef();
    });
    box.appendChild(fileItem);

    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.parentNode.removeChild(overlay); });
    document.body.appendChild(overlay);
  }

  async function pickSessionRef() {
    try {
      var list = await window.AgentClient.call("storage", { op: "session.list", payload: { includeDeleted: true } });
      if (!list || !list.length) { await uiAlert("没有可引用的会话"); return; }
      var options = list.map(function (s) { return (s.name || ("会话 " + s.id)) + (s.deleted_at ? " (已删)" : ""); }).join("\n");
      var pick = await uiPrompt("输入要引用的会话序号（0 取消）:\n" + options.split("\n").map(function (n, i) { return (i + 1) + ". " + n; }).join("\n"), "1");
      var i = parseInt(pick, 10);
      if (!i || i < 1 || i > list.length) return;
      var s = list[i - 1];
      pendingRefs.push({ type: "session", id: s.id, name: s.name || ("会话 " + s.id), label: s.name || ("会话 " + s.id) });
      renderRefChips();
    } catch (e) { console.error("pick session ref failed:", e); }
  }

  async function pickFileRef() {
    var p = await uiPrompt("输入要引用的本地文件路径", "");
    if (!p) return;
    pendingRefs.push({ type: "file", path: p, label: p.split("/").pop() || p });
    renderRefChips();
  }

  if (refBtn) refBtn.addEventListener("click", openRefMenu);
  if (input) {
    input.addEventListener("input", function () {
      // 输入 "@" 且当前无选中文本时打开引用菜单
      if (input.value.slice(-1) === "@" && window.getSelection && getSelection().isCollapsed) {
        openRefMenu();
      }
    });
  }

  // 8) composer: think-switch / search-switch 开关（切换高亮态）
  var thinkSwitch = document.getElementById("thinkSwitch");
  var searchSwitch = document.getElementById("searchSwitch");
  if (thinkSwitch) thinkSwitch.addEventListener("click", function () { thinkSwitch.classList.toggle("active"); });
  loadReasoningControl();  // 按设置渲染推理控件（think-switch / effort-selector 二选一）
  if (searchSwitch) searchSwitch.addEventListener("click", function () { searchSwitch.classList.toggle("active"); });
});
