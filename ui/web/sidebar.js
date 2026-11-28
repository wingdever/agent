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

  // 过滤范围：会话名 + 所在工作区名（输工作区名时能看到该工作区下全部会话）。
  // 过滤后整棵树没有任何可见会话时，显示一条空态，而不是留一片空白。
  function applySessionFilter(q) {
    var query = (q || "").toLowerCase();
    var anyShown = false;
    document.querySelectorAll(".workspace-item").forEach(function (wsNode) {
      var wsLabel = wsNode.querySelector(".workspace-name-label");
      var wsName = wsLabel ? wsLabel.textContent.toLowerCase() : "";
      var wsMatch = !!query && wsName.indexOf(query) !== -1;
      var shownInWs = 0;
      wsNode.querySelectorAll(".session-item").forEach(function (n) {
        if (n.classList.contains("deleted")) return;
        var label = n.querySelector(".session-name-label");
        var name = label ? label.textContent.toLowerCase() : "";
        var match = !query || wsMatch || name.indexOf(query) !== -1;
        n.style.display = match ? "" : "none";
        if (match) shownInWs += 1;
      });
      // 工作区下没有可见会话时整块收起（原本就没有会话的工作区在过滤时同样收起）
      var hasSessions = wsNode.querySelectorAll(".session-item:not(.deleted)").length > 0;
      var hideWs = !!query && shownInWs === 0 && (hasSessions || !wsMatch);
      wsNode.style.display = hideWs ? "none" : "";
      if (shownInWs > 0) anyShown = true;
    });

    var treeList = document.querySelector(".workspace-session-tree-list");
    if (!treeList) return;
    var emptyEl = treeList.querySelector("[data-name='session-filter-empty']");
    var needEmpty = !!query && !anyShown;
    if (needEmpty && !emptyEl) {
      emptyEl = document.createElement("div");
      emptyEl.className = "empty-hint";
      emptyEl.setAttribute("data-name", "session-filter-empty");
      treeList.appendChild(emptyEl);
    }
    if (emptyEl) {
      if (needEmpty) emptyEl.textContent = "没有匹配「" + q + "」的会话或工作区";
      else if (emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
    }
  }
  App.applySessionFilter = applySessionFilter;

  App.loadDeletedSessions = async function loadDeletedSessions(container) {
    container.innerHTML = "";
    try {
      var list = await window.AgentClient.call("session.list", { includeDeleted: true });
      var deleted = (list || []).filter(function (s) { return s.deleted_at != null; });
      if (!deleted.length) { container.innerHTML = '<div class="empty-hint">回收站为空</div>'; return; }
      deleted.forEach(function (s) { renderDeletedSession(s, container); });
    } catch (e) {
      container.innerHTML = '<div class="empty-hint">回收站加载失败</div>';
      if (App.reportError) App.reportError("加载回收站失败", e);
    }
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
      try {
        await window.AgentClient.call("session.restore", { payload: { id: sess.id } });
        if (node.parentNode) node.parentNode.removeChild(node);
        await App.loadWorkspaces(); // 恢复后回到所属工作区的会话列表
        if (App.toast) App.toast("会话已恢复");
      } catch (e) { if (App.reportError) App.reportError("恢复会话失败", e); }
    });
    purgeBtn.addEventListener("click", async function () {
      if (!(await App.uiConfirm("彻底删除该会话？不可恢复"))) return;
      try {
        await window.AgentClient.call("session.delete", { payload: { id: sess.id, hard: true } });
        if (node.parentNode) node.parentNode.removeChild(node);
      } catch (e) { if (App.reportError) App.reportError("彻底删除失败", e); }
    });
    container.appendChild(node);
  }

  // 行内「⋯」菜单由 state.js 的 App.buildRowMenu 提供（模型页等共用）。
  function buildRowMenu(items) { return App.buildRowMenu(items); }

  // 工作区的完整位置：后端 workspace.list 给出 absolute_path（folder_path 可能是相对路径，
  // 如 "Downloads"）；老数据没有该字段时退回 folder_path。
  function workspacePath(ws) {
    return ws.absolute_path || ws.folder_path || "";
  }

  // 展示用路径：家目录前缀简写成 ~（/home/<user>/x -> ~/x），其余部分原样。
  function humanizePath(p) {
    var text = String(p || "");
    var m = text.match(/^\/(?:home|Users)\/[^/]+(?=\/|$)/);
    if (m) return "~" + text.slice(m[0].length);
    if (/^\/root(?=\/|$)/.test(text)) return "~" + text.slice(5);
    return text;
  }

  // 目录末段名：优先从完整路径取最后一段，取不到再退回 folder_name。
  function workspaceBaseName(ws) {
    function base(p) {
      var parts = String(p || "").split("/").filter(function (x) { return x && x !== "."; });
      return parts.length ? parts[parts.length - 1] : "";
    }
    return base(workspacePath(ws)) || ws.folder_name || "（未命名）";
  }

  function renderWorkspace(ws, treeList) {
    var node = document.createElement("div");
    node.className = "workspace-item";
    node.setAttribute("data-name", "workspace-item");
    node.setAttribute("data-id", String(ws.id));

    var header = document.createElement("div");
    header.className = "workspace-header";
    header.setAttribute("data-name", "workspace-header");

    // 名称与提示条拆成两层：外层截断长名称，内层承载悬停路径条。
    // （不能把提示条放进一个 overflow:hidden 的节点里，否则溢出部分会被裁掉。）
    var label = document.createElement("span");
    label.className = "workspace-name-label";
    label.setAttribute("data-name", "workspace-name-label");
    var labelText = document.createElement("span");
    labelText.className = "workspace-name-text";
    labelText.setAttribute("data-name", "workspace-name-text");
    labelText.textContent = workspaceBaseName(ws);
    var pathTip = document.createElement("span");
    pathTip.className = "workspace-path-tip";
    pathTip.setAttribute("data-name", "workspace-path-tip");
    pathTip.textContent = humanizePath(workspacePath(ws)) || workspaceBaseName(ws);
    label.appendChild(labelText);
    label.appendChild(pathTip);

    var addBtn = document.createElement("button");
    addBtn.className = "add-session-btn";
    addBtn.setAttribute("data-name", "add-session-btn");
    addBtn.textContent = "+ 会话";

    var delBtn = buildRowMenu([
      { label: "删除工作区…", danger: true, onClick: function () { App.deleteWorkspace(ws.id, node); } },
    ]);
    delBtn.setAttribute("data-name", "workspace-menu-btn");

    header.appendChild(label);
    header.appendChild(addBtn);
    header.appendChild(delBtn);

    var sessionList = document.createElement("div");
    sessionList.className = "session-list";
    sessionList.setAttribute("data-name", "session-list");

    node.appendChild(header);
    node.appendChild(sessionList);
    treeList.appendChild(node);

    addBtn.addEventListener("click", async function () {
      var name = await App.uiPrompt("新建会话");
      if (!name) return;
      var preset = await new Promise(function (resolve) { App.openAgentPicker(resolve); });
      await App.addSession(ws.id, sessionList, name, preset);
    });

    App.loadSessions(ws.id, sessionList);
    return node;
  }
  App.renderWorkspace = renderWorkspace;

  App.loadWorkspaces = async function loadWorkspaces() {
    try {
      var list = await window.AgentClient.call("workspace.list", {});
      var treeList = document.querySelector(".workspace-session-tree-list");
      if (treeList) treeList.innerHTML = "";
      (list || []).forEach(function (ws) { renderWorkspace(ws, treeList); });
    } catch (e) {
      console.error("load workspaces failed:", e);
      if (App.reportError) App.reportError("加载工作区失败", e);
    }
  };

  App.addWorkspace = async function addWorkspace(folderPath) {
    if (!folderPath) return;
    var idx = folderPath.lastIndexOf("/"); if (idx === -1) idx = folderPath.lastIndexOf(String.fromCharCode(92)); var name = idx >= 0 ? folderPath.slice(idx + 1) : folderPath;
    try {
      var ws = await window.AgentClient.call("workspace.create", {
        payload: { folder_path: folderPath, folder_name: name },
      });
      var treeList = document.querySelector(".workspace-session-tree-list");
      renderWorkspace(ws, treeList);
    } catch (e) {
      console.error("add workspace failed:", e);
      if (App.reportError) App.reportError("添加工作区失败", e);
    }
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
    var list = await window.AgentClient.call("workspace.list", {});
    if (list && list.length) return list[0];
    var ws = await window.AgentClient.call("workspace.create", { payload: { folder_path: ".", folder_name: "默认工作区" } });
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

    var menuBtn = buildRowMenu([
      { label: "重命名…", onClick: function () { App.renameSession(sess.id, label); } },
      { label: "删除会话…", danger: true, onClick: function () { App.deleteSession(sess.id, node); } },
    ]);
    menuBtn.setAttribute("data-name", "session-menu-btn");

    node.appendChild(label);
    node.appendChild(menuBtn);
    if (container) container.appendChild(node);
    node.addEventListener("click", function (e) {
      if (e.target.closest("button")) return;
      App.selectSession(sess, node);
    });
    return node;
  }
  App.renderSession = renderSession;

  App.loadSessions = async function loadSessions(workspaceId, container) {
    try {
      var list = await window.AgentClient.call("session.list", { workspace_id: workspaceId });
      container.innerHTML = "";
      (list || []).forEach(function (s) { renderSession(s, workspaceId, container); });
    } catch (e) {
      console.error("load sessions failed:", e);
      if (App.reportError) App.reportError("加载会话失败", e);
    }
  };

  App.addSession = async function addSession(workspaceId, container, name, preset) {
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("session.create", { payload: { workspace_id: workspaceId, name: name, activity: App.selectedInitialActivity } });
      if (preset && preset.id) App.setSessionAgent(sess.id, preset.id, preset.name);
      var node = renderSession(sess, workspaceId, container);
      App.selectSession(sess, node);
    } catch (e) {
      console.error("add session failed:", e);
      if (App.reportError) App.reportError("新建会话失败", e);
    }
  };

  App.renameSession = async function renameSession(sessionId, label) {
    var name = await App.uiPrompt("重命名会话", label.textContent);
    if (!name) return;
    try {
      var sess = await window.AgentClient.call("session.update", { payload: { id: sessionId, name: name } });
      label.textContent = (sess && sess.name) || name;
    } catch (e) {
      console.error("rename session failed:", e);
      if (App.reportError) App.reportError("重命名失败", e);
    }
  };

  App.deleteSession = async function deleteSession(sessionId, node) {
    if (!(await App.uiConfirm("删除该会话？"))) return;
    try {
      await window.AgentClient.call("session.delete", { payload: { id: sessionId } });
      if (node && node.parentNode) node.parentNode.removeChild(node);
      // 软删除：可到回收站恢复，告诉用户一句，避免以为丢数据
      if (App.toast) App.toast("会话已移入回收站（🗑 可恢复）");
    } catch (e) {
      console.error("delete session failed:", e);
      if (App.reportError) App.reportError("删除会话失败", e);
    }
  };

  App.deleteWorkspace = async function deleteWorkspace(workspaceId, node) {
    if (!(await App.uiConfirm("删除该工作区及其下所有会话？"))) return;
    try {
      await window.AgentClient.call("workspace.delete", { payload: { id: workspaceId } });
      if (node && node.parentNode) node.parentNode.removeChild(node);
      if (App.toast) App.toast("工作区已删除");
    } catch (e) {
      console.error("delete workspace failed:", e);
      if (App.reportError) App.reportError("删除工作区失败", e);
    }
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
        var preset = await new Promise(function (resolve) { App.openAgentPicker(resolve); });
        try {
          var ws = await App.ensureDefaultWorkspace();
          var container = findSessionList(ws.id);
          if (!container) { await App.loadWorkspaces(); container = findSessionList(ws.id); }
          await App.addSession(ws.id, container, name, preset);
          App.showView("chat"); // 新建会话是聊天页的动作，右栏其它页面切回聊天
        } catch (e) { console.error("new session failed:", e); }
      });
    }
  };
})();
