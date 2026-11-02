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
      if (c) setToolResult(c, evt.result);
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
    status.textContent = meta.label;
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
      onDecision: permission === "ask" ? function (decision) {
        AgentClient.call("approval", { id: evt.id, decision: decision });
      } : null
    });
  }

  function resultToText(result) {
    if (typeof result === "string") return result;
    if (result === undefined || result === null) return "";
    try { return JSON.stringify(result, null, 2); } catch (e) { return String(result); }
  }
  // read 失败的 error 对象不能藏在折叠面板里。
  function resultError(result) {
    var obj = result;
    if (typeof obj === "string") {
      try { obj = JSON.parse(obj); } catch (e) { return ""; }
    }
    if (obj && typeof obj === "object" && obj.error) return String(obj.error);
    return "";
  }
  function formatBytes(n) {
    if (n < 1024) return n + " B";
    var kb = n / 1024;
    return (kb >= 10 ? Math.round(kb) : kb.toFixed(1)) + " KB";
  }
  // read 结果默认折叠；其他工具保持展开。
  function renderToolResult(card, result) {
    var text = resultToText(result);
    var old = card.querySelector(".tool-result");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    card.setAttribute("data-result", text);
    var isRead = (card.getAttribute("data-tool") || "").toLowerCase() === "read";
    if (!isRead) {
      var plain = makeEl("tool-result", "tool-result");
      plain.textContent = "→ " + text;
      card.appendChild(plain);
      return;
    }
    var error = resultError(result);
    if (error) {
      var err = makeEl("tool-result", "tool-result read-error");
      err.textContent = "→ 读取失败：" + error;
      card.appendChild(err);
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

  function onChatEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "model-http-status") { setModelHttpStatus(evt.state, evt.status); return; }
    if (evt.type === "translation") {
      if (getComposerMode() === "bare-chat") handleTranslationFlat(evt);
      else handleTranslationTurn(evt);
      return;
    }
    if (getComposerMode() === "bare-chat") { onChatEventFlat(evt); return; }
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
      if (hc) renderToolResult(hc, evt.result);
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
            // ui.md：每个 tool-call-card 都有 approval-request；回放时按 status 展示结果。
            var ap = makeEl("approval-request", "approval-request");
            var permission = call.status === "pending" ? "ask" : call.status === "denied" ? "deny" : "allow";
            renderApproval(ap, { permission: permission, name: call.name, arguments: call.arguments });
            card.appendChild(ap);
            var tm = toolMsgs[c] || null;
            if (tm) renderToolResult(card, tm.content || "");
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
    if (sessionNameLabel) sessionNameLabel.textContent = sess.name || ("会话 " + sess.id);
    document.querySelectorAll(".session-item").forEach(function (n) { n.classList.remove("active"); });
    if (node) node.classList.add("active");
    renderSessionMessages(sess.id);
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
      AgentMarkdown.append(ensureAnswer(), "[出错] " + (e && e.message ? e.message : e));
      flushLiveMarkdown();
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
