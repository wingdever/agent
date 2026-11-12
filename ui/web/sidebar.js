"use strict";
// M0 重构：原 app.js 闭包内「工作区 / 会话树 / 回收站 / 搜索」区块（行 250–496）。
// 抽为独立 <script>，向 window.App 挂载。原闭包内 var 提升为 App.xxx，跨域调用走 App.fn(...)。
// DOM 根引用（treeList/deletedList 等）在 initSidebar() 内取（DOMContentLoaded 阶段）。
//
// 归属：工作区列表渲染、会话项渲染、新建/改名/删除、回收站、会话名搜索过滤。

(function () {
  var App = (window.App = window.App || {});

  // 会话模式由 currentSessionId 派生：无选中 -> bare（不落库），选中 -> persisted。
  App.getSessionMode = function getSessionMode() { return App.currentSessionId ? "persisted" : "bare"; };
  App.isBare = function isBare() { return App.getSessionMode() === "bare"; };

  function applySessionFilter(q) {
    document.querySelectorAll(".session-item").forEach(function (n) {
      var label = n.querySelector(".session-name-label");
      var name = label ? label.textContent.toLowerCase() : "";
      n.style.display = (!q || name.indexOf(q) !== -1) ? "" : "none";
    });
  }
  App.applySessionFilter = applySessionFilter;

  App.loadDeletedSessions = async function loadDeletedSessions(container) {
    container.innerHTML = "";
    try {
      var list = await window.AgentClient.call("storage", { op: "session.list", payload: { includeDeleted: true } });
      var deleted = (list || []).filter(function (s) { return s.deleted_at != null; });
      if (!deleted.length) { container.innerHTML = '<div class="empty-hint">回收站为空</div>'; return; }
      deleted.forEach(function (s) { renderDeletedSession(s, container); });
    } catch (e) { container.innerHTML = '<div class="empty-hint">回收站加载失败</div>'; }
  };

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
      if (!(await App.uiConfirm("彻底删除该会话？不可恢复"))) return;
      try { await window.AgentClient.call("storage", { op: "session.delete", payload: { id: sess.id, hard: true } }); if (node.parentNode) node.parentNode.removeChild(node); } catch (e) {}
    });
    container.appendChild(node);
  }

  function renderWorkspace(ws, treeList) {
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
    addBtn.addEventListener("click", async function () { var name = await App.uiPrompt("新建会话"); if (name) addSession(ws.id, sessionList, name); });

    loadSessions(ws.id, sessionList);
    return node;
  }
  App.renderWorkspace = renderWorkspace;

  App.loadWorkspaces = async function loadWorkspaces() {
    try {
      var list = await window.AgentClient.call("storage", { op: "workspace.list", payload: {} });
      var treeList = document.querySelector(".workspace-session-tree-list");
      if (treeList) treeList.innerHTML = "";
      (list || []).forEach(function (ws) { renderWorkspace(ws, treeList); });
    } catch (e) { /* 后端未就绪时静默 */ }
  };

  App.addWorkspace = async function addWorkspace(folderPath) {
    if (!folderPath) return;
    var idx = folderPath.lastIndexOf("/"); if (idx === -1) idx = folderPath.lastIndexOf(String.fromCharCode(92)); var name = idx >= 0 ? folderPath.slice(idx + 1) : folderPath;
    try {
      var ws = await window.AgentClient.call("storage", {
        op: "workspace.create",
        payload: { folder_path: folderPath, folder_name: name },
      });
      var treeList = document.querySelector(".workspace-session-tree-list");
      renderWorkspace(ws, treeList);
    } catch (e) { console.error("add workspace failed:", e); }
  };

  function findSessionList(wsId) {
    var items = document.querySelectorAll(".workspace-item");
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].getAttribute("data-id")) === String(wsId)) return items[i].querySelector(".session-list");
    }
    return null;
  }
  App.findSessionList = findSessionList;

  App.ensureDefaultWorkspace = async function ensureDefaultWorkspace() {
    var list = await window.AgentClient.call("storage", { op: "workspace.list", payload: {} });
    if (list && list.length) return list[0];
    var ws = await window.AgentClient.call("storage", { op: "workspace.create", payload: { folder_path: ".", folder_name: "默认工作区" } });
    var treeList = document.querySelector(".workspace-session-tree-list");
    renderWorkspace(ws, treeList);
    return ws;
  };

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
      App.selectSession(sess, node);
    });
    return node;
  }
  App.renderSession = renderSession;

  App.loadSessions = async function loadSessions(workspaceId, container) {
    try {
      var list = await window.AgentClient.call("storage", { op: "session.list", payload: { workspace_id: workspaceId } });
      container.innerHTML = "";
      (list || []).forEach(function (s) { renderSession(s, workspaceId, container); });
    } catch (e) { /* 静默 */ }
  };

  App.addSession = async function addSession(workspaceId, container, name) {
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("storage", { op: "session.create", payload: { workspace_id: workspaceId, name: name, activity: App.selectedInitialActivity } });
      var node = renderSession(sess, workspaceId, container);
      App.selectSession(sess, node);
    } catch (e) { console.error("add session failed:", e); }
  };

  App.renameSession = async function renameSession(sessionId, label) {
    var name = await App.uiPrompt("重命名会话", label.textContent);
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("storage", { op: "session.update", payload: { id: sessionId, name: name } });
      label.textContent = (sess && sess.name) || name;
    } catch (e) { console.error("rename session failed:", e); }
  };

  App.deleteSession = async function deleteSession(sessionId, node) {
    if (!(await App.uiConfirm("删除该会话？"))) return;
    try {
      await window.AgentClient.call("storage", { op: "session.delete", payload: { id: sessionId } });
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (e) { console.error("delete session failed:", e); }
  };

  App.deleteWorkspace = async function deleteWorkspace(workspaceId, node) {
    if (!(await App.uiConfirm("删除该工作区及其下所有会话？"))) return;
    try {
      await window.AgentClient.call("storage", { op: "workspace.delete", payload: { id: workspaceId } });
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (e) { console.error("delete workspace failed:", e); }
  };

  // ---------- 绑定（DOMContentLoaded 内调用） ----------
  App.initSidebar = function initSidebar() {
    var addWsBtn = document.querySelector(".add-workspace-btn");
    var searchBtn = document.querySelector(".search-btn");
    var searchInput = document.querySelector(".search-input");
    var trashBtn = document.querySelector(".trash-btn");
    var deletedList = document.querySelector(".deleted-sessions-list");

    if (searchBtn && searchInput) {
      searchBtn.addEventListener("click", function () {
        searchInput.hidden = !searchInput.hidden;
        if (!searchInput.hidden) searchInput.focus();
        else { searchInput.value = ""; applySessionFilter(""); }
      });
      searchInput.addEventListener("input", function () { applySessionFilter(searchInput.value.trim().toLowerCase()); });
    }

    if (trashBtn && deletedList) {
      trashBtn.addEventListener("click", function () {
        var showing = !deletedList.hidden;
        deletedList.hidden = showing;
        if (!showing) App.loadDeletedSessions(deletedList);
      });
    }

    if (addWsBtn) {
      addWsBtn.addEventListener("click", async function () {
        var folder = await window.AgentClient.selectFolder();
        if (folder) await App.addWorkspace(folder);
      });
    }

    var newSessionBtn = document.querySelector(".new-session-button");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", async function () {
        var name = await App.uiPrompt("新建会话");
        if (!name) return;
        await new Promise(function (resolve) {
          App.openActivityMenu(function (a) { App.selectedInitialActivity = a; resolve(); });
        });
        try {
          var ws = await App.ensureDefaultWorkspace();
          var container = findSessionList(ws.id);
          if (!container) { await App.loadWorkspaces(); container = findSessionList(ws.id); }
          await App.addSession(ws.id, container, name);
        } catch (e) { console.error("new session failed:", e); }
      });
    }
  };
})();
