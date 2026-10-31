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
      if (b.getAttribute("data-target") === "trajectory-tab") viewport.classList.add("show-trajectory");
      else viewport.classList.remove("show-trajectory");
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

  var calls = document.querySelectorAll(".tool-call");
  Array.prototype.forEach.call(calls, function (card) {
    card.addEventListener("click", function () { showToolDetail(card); });
  });

  // 6) add-workspace-btn -> folder-selector -> add-workspace(folder)
  var addWsBtn = document.querySelector(".add-workspace-btn");
  var treeList = document.querySelector(".workspace-session-tree-list");

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

  async function ensureConf() {
    try {
      var confs = await window.AgentClient.call("storage", { op: "conf.list", payload: {} });
      if (confs && confs.length) return confs[0].id;
      var prov = await window.AgentClient.call("storage", { op: "provider.create", payload: { name: "qiniu" } });
      var model = await window.AgentClient.call("storage", { op: "model.create", payload: { provider_id: prov.id, name: "conatus-free" } });
      var conf = await window.AgentClient.call("storage", { op: "conf.create", payload: { model_id: model.id, name: "default" } });
      return conf.id;
    } catch (e) { console.error("ensureConf failed:", e); throw e; }
  }

  async function addSession(workspaceId, container, name) {
    if (!name) return;
    try {
      var confId = await ensureConf();
      var sess = await window.AgentClient.call("storage", { op: "session.create", payload: { workspace_id: workspaceId, conf_id: confId, name: name } });
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
  var chatTab = document.getElementById("chatTab");
  var input = document.querySelector(".input-textarea");
  var sendBtn = document.querySelector(".send-or-stop-btn");
  var sessionNameLabel = document.querySelector(".session-name");
  var currentSessionId = null;
  var currentAssistantBubble = null;
  var toolCards = {};

  function hideEmptyHint() { var h = chatTab.querySelector(".empty-hint"); if (h) h.remove(); }
  function showEmptyHint() {
    var h = document.createElement("div");
    h.className = "empty-hint";
    h.textContent = "还没有对话，发送消息开始吧";
    chatTab.appendChild(h);
  }
  function appendMessage(role, text) {
    hideEmptyHint();
    var wrap = document.createElement("div");
    wrap.className = "msg msg-" + role;
    var roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent = role === "user" ? "你" : (role === "assistant" ? "助手" : role);
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "";
    wrap.appendChild(roleLabel);
    wrap.appendChild(bubble);
    chatTab.appendChild(wrap);
    chatTab.scrollTop = chatTab.scrollHeight;
    return bubble;
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
  function setToolResult(card, result) {
    var r = document.createElement("div");
    r.className = "tool-args";
    r.style.marginTop = "4px";
    r.textContent = "→ " + JSON.stringify(result, null, 2);
    card.appendChild(r);
  }
  function onChatEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "token") {
      if (!currentAssistantBubble) currentAssistantBubble = appendMessage("assistant", evt.delta || "");
      else currentAssistantBubble.textContent += (evt.delta || "");
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "tool_call") {
      var card = createToolCard(evt);
      chatTab.appendChild(card);
      toolCards[evt.id] = card;
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "tool_result") {
      var c = toolCards[evt.id];
      if (c) setToolResult(c, evt.result);
    } else if (evt.type === "done") {
      currentAssistantBubble = null;
    } else if (evt.type === "error") {
      appendMessage("assistant", "[出错] " + (evt.error || "未知错误"));
      currentAssistantBubble = null;
    }
  }
  async function buildMessages(sessionId) {
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
  var calls = await window.AgentClient.call("storage", { op: "call.list", payload: { reply_id: m.content_id } });
  if (calls && calls.length) {
    am.tool_calls = calls.map(function (c) { return { id: String(c.id), type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }; });
  }
  msgs.push(am);
} else if (m.role === "tool") {
  msgs.push({ role: "tool", tool_call_id: String(m.tool_call_id), content: m.content });
}
        }
      }
    }
    return msgs;
  }
  async function renderSessionMessages(sessionId) {
    chatTab.innerHTML = "";
    var msgs = await buildMessages(sessionId);
    if (!msgs.length) { showEmptyHint(); return; }
    for (var i = 0; i < msgs.length; i++) appendMessage(msgs[i].role, msgs[i].content);
  }
  function selectSession(sess, node) {
    currentSessionId = sess.id;
    if (sessionNameLabel) sessionNameLabel.textContent = sess.name || ("会话 " + sess.id);
    document.querySelectorAll(".session-item").forEach(function (n) { n.classList.remove("active"); });
    if (node) node.classList.add("active");
    renderSessionMessages(sess.id);
    if (input) input.focus();
  }
  async function onSend() {
    var text = input.value.trim();
    if (!text) return;
    if (!currentSessionId) { await uiAlert("请先在左侧选择或新建一个会话"); return; }
    input.value = "";
    appendMessage("user", text);
    currentAssistantBubble = null; toolCards = {};
    try {
      var history = await buildMessages(currentSessionId);
      history.push({ role: "user", content: text });
      await window.AgentClient.call("chat", { messages: history, sessionId: currentSessionId }, onChatEvent);
    } catch (e) {
      console.error("chat failed:", e);
      appendMessage("assistant", "[出错] " + (e && e.message ? e.message : e));
    }
  }
  if (sendBtn) sendBtn.addEventListener("click", onSend);
  if (input) input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });

  loadWorkspaces();

  // 5) add-files-btn -> 演示 attachment-tray 状态变化（ready/extracting/fallback）
  var addFilesBtn = document.getElementById("addFilesBtn");
  var tray = document.querySelector(".attachment-tray");
  if (addFilesBtn && tray) {
    addFilesBtn.addEventListener("click", function () {
      var states = tray.querySelectorAll(".state");
      var visible = Array.prototype.find.call(states, function (s) { return !s.hidden; });
      Array.prototype.forEach.call(states, function (s) { s.hidden = true; });
      var order = ["ready", "extracting", "fallback"];
      var idx = visible ? order.indexOf(visible.className.replace("state ", "")) : 0;
      var next = order[(idx + 1) % order.length];
      var el = tray.querySelector(".state." + next);
      if (el) el.hidden = false;
    });
  }

  // 8) composer: think-switch / search-switch 开关（切换高亮态）
  var thinkSwitch = document.getElementById("thinkSwitch");
  var searchSwitch = document.getElementById("searchSwitch");
  if (thinkSwitch) thinkSwitch.addEventListener("click", function () { thinkSwitch.classList.toggle("active"); });
  if (searchSwitch) searchSwitch.addEventListener("click", function () { searchSwitch.classList.toggle("active"); });
});
