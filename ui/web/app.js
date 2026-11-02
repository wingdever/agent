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

  async function addSession(workspaceId, container, name) {
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("storage", { op: "session.create", payload: { workspace_id: workspaceId, name: name } });
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
  var currentSessionId = null;
  var bareHistory = [];  // bare-chat 模式：纯内存对话历史，不落库

  // bare-chat 扁平渲染所需的临时状态（turn-step 不使用）
  var currentAssistantBubble = null;
  var currentThoughtBubble = null;
  var toolCards = {};

  // turn-step 流式渲染所依赖的 DOM 锚点
  var liveTurn = null;     // 当前 .turn 节点
  var liveStep = null;     // 当前 .step 节点
  var liveResponse = null; // 当前 .model-response 节点
  var liveAnswer = null;   // 当前 .answer 节点
  var liveCards = {};      // call id -> .tool-call-card 节点

  function getComposerMode() {
    var sel = document.querySelector(".mode-selector select");
    return sel ? sel.value : "turn-step";
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

  // ---------- bare-chat 扁平渲染（不落库、不支持工具调用） ----------
  function appendMessage(role, text) {
    hideEmptyHint();
    var wrap = document.createElement("div");
    wrap.className = "msg msg-" + role;
    var roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent = role === "user" ? "你" : (role === "assistant" ? "助手" : (role === "thought" ? "思考" : role));
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
  function createApprovalCard(evt) {
    var card = document.createElement("div");
    card.className = "tool-call approval";
    var head = document.createElement("div");
    head.className = "tool-head";
    head.textContent = "工具授权请求：" + (evt.name || "tool");
    var args = document.createElement("div");
    args.className = "tool-args";
    args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
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
    card.appendChild(head); card.appendChild(args); card.appendChild(bar);
    chatTab.appendChild(card);
    chatTab.scrollTop = chatTab.scrollHeight;
  }
  function onChatEventFlat(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "token") {
      if (!currentAssistantBubble) currentAssistantBubble = appendMessage("assistant", evt.delta || "");
      else currentAssistantBubble.textContent += (evt.delta || "");
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "reasoning") {
      if (!currentThoughtBubble) currentThoughtBubble = appendMessage("thought", evt.delta || "");
      else currentThoughtBubble.textContent += (evt.delta || "");
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
      if (evt.message) bareHistory.push({ role: "assistant", content: evt.message.content || "" });
      currentAssistantBubble = null;
      currentThoughtBubble = null;
    } else if (evt.type === "approval-request") {
      createApprovalCard(evt);
    } else if (evt.type === "error") {
      appendMessage("assistant", "[出错] " + (evt.error || "未知错误"));
      currentAssistantBubble = null;
      currentThoughtBubble = null;
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
    if (!liveAnswer) { liveAnswer = makeEl("answer", "answer"); liveResponse.appendChild(liveAnswer); }
    return liveAnswer;
  }
  function addAgentRequest(text) {
    ensureLiveStep();
    var req = makeEl("agent-request", "agent-request");
    req.textContent = text || "";
    liveStep.insertBefore(req, liveResponse); // agent-request 位于 model-response 之前
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
    card.setAttribute("data-tool", evt.name || "tool");
    card.setAttribute("data-op", evt.name || "tool");
    card.setAttribute("data-args", JSON.stringify(evt.arguments || {}, null, 2));
    var desc = card.querySelector(".tool-call-desc");
    if (!desc) { desc = makeEl("tool-call-desc", "tool-call-desc"); card.appendChild(desc); }
    desc.textContent = (evt.name || "tool") + " " + JSON.stringify(evt.arguments || {});
  }
  function setHierToolResult(card, result) {
    var r = card.querySelector(".tool-result");
    if (!r) { r = makeEl("tool-result", "tool-result"); card.appendChild(r); }
    r.textContent = "→ " + JSON.stringify(result, null, 2);
    card.setAttribute("data-result", JSON.stringify(result, null, 2));
  }
  function setApproval(card, evt) {
    var ap = card.querySelector(".approval-request");
    if (!ap) { ap = makeEl("approval-request", "approval-request"); card.appendChild(ap); }
    ap.innerHTML = "";
    var head = document.createElement("div");
    head.textContent = "工具授权请求：" + (evt.name || "tool");
    var args = document.createElement("div");
    args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
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
    ap.appendChild(head); ap.appendChild(args); ap.appendChild(bar);
  }
  function resetLive() { liveTurn = liveStep = liveResponse = liveAnswer = null; liveCards = {}; }

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

  function onChatEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "model-http-status") { setModelHttpStatus(evt.state, evt.status); return; }
    if (getComposerMode() === "bare-chat") { onChatEventFlat(evt); return; }
    // turn-step：按层级渲染
    if (evt.type === "reasoning") {
      ensureLiveStep();
      var thEl = liveResponse.querySelector(".thought");
      if (!thEl) { thEl = makeEl("thought", "thought"); liveResponse.appendChild(thEl); }
      thEl.textContent += (evt.delta || "");
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "token") {
      ensureAnswer().textContent += (evt.delta || "");
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "tool_call") {
      setToolDesc(getToolCard(evt.id), evt);
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "tool_result") {
      var hc = liveCards[evt.id];
      if (hc) setHierToolResult(hc, evt.result);
    } else if (evt.type === "approval-request") {
      setApproval(getToolCard(evt.id), evt);
    } else if (evt.type === "step-start") {
      // 上一轮 step 的 tool-call 已全部完成，模型将再次被请求（对应 behavior.md 的 request-time）
      if (!liveTurn) { liveTurn = makeEl("turn", "turn"); chatTab.appendChild(liveTurn); }
      liveStep = makeEl("step", "step");
      liveTurn.appendChild(liveStep);
      liveResponse = makeEl("model-response", "model-response");
      liveStep.appendChild(liveResponse);
      liveAnswer = null; liveCards = {};
      chatTab.scrollTop = chatTab.scrollHeight;
    } else if (evt.type === "done") {
      resetLive();
    } else if (evt.type === "error") {
      ensureAnswer().textContent += "[出错] " + (evt.error || "未知错误");
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
        var userMsg = null, asstMsg = null, toolMsgs = [];
        for (var k = 0; k < (msgs || []).length; k++) {
          var m = msgs[k];
          if (m.role === "user") userMsg = m;
          else if (m.role === "assistant") asstMsg = m;
          else if (m.role === "tool") toolMsgs.push(m);
        }
        if (userMsg) {
          var req = makeEl("agent-request", "agent-request");
          req.textContent = userMsg.content || "";
          stepNode.insertBefore(req, respNode);
        }
        if (asstMsg) {
          if (asstMsg.thought) {
            var th = makeEl("thought", "thought");
            th.textContent = asstMsg.thought;
            respNode.appendChild(th);
          }
          if (asstMsg.content) {
            var ans = makeEl("answer", "answer");
            ans.textContent = asstMsg.content || "";
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
            card.appendChild(desc);
            if (call.status === "pending" || call.status === "denied") {
              var ap = makeEl("approval-request", "approval-request");
              ap.textContent = "工具授权：" + call.name + "（" + call.status + "）";
              card.appendChild(ap);
            }
            var tm = toolMsgs[c] || null;
            if (tm) {
              var rr = makeEl("tool-result", "tool-result");
              rr.textContent = "→ " + (tm.content || "");
              card.setAttribute("data-result", tm.content || "");
              card.appendChild(rr);
            }
            respNode.appendChild(card);
            (function (cc) { cc.addEventListener("click", function () { showToolDetail(cc); }); })(card);
          }
        }
      }
    }
    chatTab.scrollTop = chatTab.scrollHeight;
  }

  function selectSession(sess, node) {
    currentSessionId = sess.id;
    if (sessionNameLabel) sessionNameLabel.textContent = sess.name || ("会话 " + sess.id);
    document.querySelectorAll(".session-item").forEach(function (n) { n.classList.remove("active"); });
    if (node) node.classList.add("active");
    renderSessionMessages(sess.id);
    if (input) input.focus();
  }
  async function runBareChat(text) {
    input.value = "";
    appendMessage("user", text);
    bareHistory.push({ role: "user", content: text });
    currentAssistantBubble = null; toolCards = {};
    try {
      // bare-chat：不传 sessionId（core 不落库），toolNames 传空以禁用工具调用，历史仅存内存
      await window.AgentClient.call("chat", { messages: bareHistory.slice(), toolNames: [] }, onChatEvent);
    } catch (e) {
      console.error("chat failed:", e);
      appendMessage("assistant", "[出错] " + (e && e.message ? e.message : e));
    }
  }
  async function onSend() {
    var text = input.value.trim();
    if (!text) return;
    if (getComposerMode() === "bare-chat") { await runBareChat(text); return; }
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
      await window.AgentClient.call("chat", { messages: history, sessionId: currentSessionId }, onChatEvent);
    } catch (e) {
      console.error("chat failed:", e);
      ensureAnswer().textContent += "[出错] " + (e && e.message ? e.message : e);
      resetLive();
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
