"use strict";

// channels-page: 左列表选实例，右详情看状态并启停。
// 状态只由 channel.subscribe 的全量快照驱动；推送断开后不重连、不轮询，
// 顶部提示条 + 手动刷新负责恢复视图。本页面不读写 user/channels.json。
(function () {
  var App = (window.App = window.App || {});

  App.initChannelsUI = function initChannelsUI() {
    var page = document.getElementById("channelsPage");
    var banner = document.getElementById("channelsBanner");
    var refreshBtn = document.getElementById("channelsRefresh");
    var listEl = document.getElementById("channelsList");
    var detailEl = document.getElementById("channelsDetail");

    if (!page || !listEl || !detailEl) {
      App.channelsUI = { onViewChange: function () {}, refresh: function () {} };
      return;
    }

    var state = {
      channels: [],
      expanded: {},
      selectedId: null,
      errors: {},
      busy: {},
      connected: false,
      attempted: false,
      subscribed: false,
      subscription: null,
      agent: null,
      agents: [],
      agentLoaded: false,
    };

    function el(tag, cls, text, name) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      if (name) node.setAttribute("data-name", name);
      return node;
    }

    function selected() {
      for (var i = 0; i < state.channels.length; i += 1) {
        if (String(state.channels[i].instanceId) === String(state.selectedId)) return state.channels[i];
      }
      return null;
    }

    function applySnapshot(rows) {
      state.channels = Array.isArray(rows) ? rows.slice() : [];
      var found = state.channels.some(function (row) { return String(row.instanceId) === String(state.selectedId); });
      if (!found) state.selectedId = state.channels.length ? state.channels[0].instanceId : null;
      render();
    }

    function upsert(row) {
      for (var i = 0; i < state.channels.length; i += 1) {
        if (String(state.channels[i].instanceId) === String(row.instanceId)) { state.channels[i] = row; render(); return; }
      }
      state.channels.push(row);
      render();
    }

    function formatTime(ms) {
      if (!ms) return "—";
      try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); }
    }

    function renderBanner() {
      if (banner) banner.hidden = !(state.attempted && !state.connected);
    }

    // The bot runs on the same core agent as the UI: global model/persona,
    // workspace and permission preset. Read them through existing RPCs rather
    // than inventing a channel-specific agent surface.
    function loadAgentInfo() {
      if (state.agentLoaded) return;
      state.agentLoaded = true;
      Promise.all([
        window.AgentClient.call("config.get", {}).catch(function () { return {}; }),
        window.AgentClient.call("config.permissions.get", {}).catch(function () { return {}; }),
        window.AgentClient.call("workspace.list", {}).catch(function () { return []; }),
        window.AgentClient.call("agent.list", {}).catch(function () { return { agents: [] }; }),
      ]).then(function (results) {
        var settings = results[0] || {};
        var permissions = results[1] || {};
        var workspaces = results[2] || [];
        state.agents = (results[3] && results[3].agents) || [];
        var tools = permissions.tools || {};
        var askCount = 0;
        Object.keys(tools).forEach(function (name) { if (tools[name] === "ask") askCount += 1; });
        state.agent = {
          model: settings.model || "—",
          provider: settings.provider || "—",
          workspace: (workspaces[0] && (workspaces[0].absolute_path || workspaces[0].folder_path)) || "—",
          permissionDefault: permissions.default || "—",
          askCount: askCount,
        };
        render();
      });
    }

    // 平台分组：channels.json 的 type 作为第一级（类似模型页 provider），
    // 该平台下的实例作为第二级（类似 model）。快照本身不改。
    function groupedChannels() {
      var groups = [];
      var byType = {};
      state.channels.forEach(function (row) {
        var type = row.type || "unknown";
        if (!byType[type]) { byType[type] = { type: type, rows: [] }; groups.push(byType[type]); }
        byType[type].rows.push(row);
      });
      return groups;
    }

    function renderList() {
      listEl.textContent = "";
      if (!state.channels.length) {
        var empty = el("div", "channels-empty", null, "channels-empty");
        empty.appendChild(el("div", "channels-empty-title", "未配置通道实例"));
        empty.appendChild(el("div", "channels-empty-hint", "在 user/channels.json 中添加实例；模板见 channels/channels.example.json"));
        listEl.appendChild(empty);
        return;
      }
      groupedChannels().forEach(function (group) {
        var open = state.expanded[group.type] !== false;
        var platform = el("div", "channels-platform", null, "channels-platform");
        var header = el("div", "channels-platform-header", null, "channels-platform-header");
        var toggle = el("button", "channels-platform-collapse-toggle", open ? "▾" : "▸", "channels-platform-collapse-toggle");
        toggle.type = "button";
        toggle.addEventListener("click", function () {
          state.expanded[group.type] = !open;
          renderList();
        });
        header.appendChild(toggle);
        header.appendChild(el("span", "channels-platform-name-label", group.type, "channels-platform-name-label"));
        header.appendChild(el("span", "channels-platform-count", String(group.rows.length), "channels-platform-count"));
        platform.appendChild(header);
        if (!open) { listEl.appendChild(platform); return; }
        group.rows.forEach(function (row) {
          var item = el("button", "channels-list-item", null, "channels-list-item");
          item.type = "button";
          item.setAttribute("data-id", String(row.instanceId));
          if (String(row.instanceId) === String(state.selectedId)) item.classList.add("active");
          item.appendChild(el("span", "channels-list-name", row.instanceId || String(row.instanceId), "channels-list-name"));
          item.appendChild(el("span", "channels-list-status " + (row.status || "stopped"), row.status || "stopped", "channels-list-status"));
          if (row.error || state.errors[row.instanceId]) item.appendChild(el("span", "channels-list-error-mark", "!", "channels-list-error-mark"));
          item.addEventListener("click", function () {
            state.selectedId = row.instanceId;
            render();
          });
          platform.appendChild(item);
        });
        listEl.appendChild(platform);
      });
    }

    function renderDetail() {
      detailEl.textContent = "";
      var row = selected();
      if (!row) {
        detailEl.appendChild(el("div", "channels-detail-empty", state.channels.length ? "选择一个实例查看详情" : "正在等待通道状态快照…", "channels-detail-empty"));
        return;
      }

      var head = el("div", "channels-detail-head", null, "channels-detail-head");
      head.appendChild(el("span", "channels-detail-title", row.instanceId || String(row.instanceId), "channels-detail-title"));
      head.appendChild(el("span", "channels-detail-type", row.type || "—", "channels-detail-type"));
      head.appendChild(el("span", "channels-detail-status " + (row.status || "stopped"), row.status || "stopped", "channels-detail-status"));
      detailEl.appendChild(head);

      var message = state.errors[row.instanceId] || row.error;
      if (message) {
        detailEl.appendChild(el("div", "channels-error", "启动/停止失败：" + message, "channels-error"));
      }

      var fields = el("div", "channels-fields", null, "channels-fields");
      [
        ["实例 id", row.instanceId],
        ["驱动类型", row.type],
        ["状态", row.status],
        ["事件模式", row.eventMode],
        ["流式投影", row.streaming === true ? "是" : "否"],
        ["启动者", row.startedBy || "—"],
        ["启动时间", formatTime(row.startedAt)],
        ["投递数", row.deliveries == null ? "—" : String(row.deliveries)],
      ].forEach(function (pair) {
        var line = el("div", "channels-field", null, "channels-field");
        line.appendChild(el("span", "channels-field-label", pair[0], "channels-field-label"));
        line.appendChild(el("span", "channels-field-value", pair[1] == null ? "—" : String(pair[1]), "channels-field-value"));
        fields.appendChild(line);
      });
      detailEl.appendChild(fields);

      var agent = state.agent || {};
      var info = el("div", "channels-agent-info", null, "channels-agent-info");
      info.appendChild(el("div", "channels-agent-title", "背后 agent", "channels-agent-title"));
      [
        ["模型", agent.model || "加载中…"],
        ["provider", agent.provider || "—"],
        ["工作区", agent.workspace || "—"],
        ["权限默认", agent.permissionDefault || "—"],
        ["ask 工具数", agent.askCount == null ? "—" : String(agent.askCount)],
        ["活动", "chat"],
        ["来源标记", "channel:" + (row.type || "?") + ":" + row.instanceId],
        ["会话映射", "平台会话键 → 本地 session，见 data/channels/sessions.json"],
      ].forEach(function (pair) {
        var line = el("div", "channels-field", null, "channels-agent-field");
        line.appendChild(el("span", "channels-field-label", pair[0], "channels-field-label"));
        line.appendChild(el("span", "channels-field-value", pair[1], "channels-field-value"));
        info.appendChild(line);
      });
      var bindRow = el("div", "channels-field", null, "channels-agent-field");
      bindRow.appendChild(el("span", "channels-field-label", "agent 配置档", "channels-field-label"));
      var select = el("select", "channels-agent-select", null, "channels-agent-select");
      var globalOption = el("option", null, "主智能（默认）", null);
      globalOption.value = "";
      if (!row.agent) globalOption.selected = true;
      select.appendChild(globalOption);
      state.agents.forEach(function (profile) {
        var option = el("option", null, profile.name + " (" + profile.id + ")", null);
        option.value = profile.id;
        if (row.agent === profile.id) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener("change", function () {
        window.AgentClient.call("channel.setAgent", { id: row.instanceId, agent: select.value || null }).then(function (updated) {
          if (updated) upsert(updated);
          else render();
          if (App.toast) App.toast("已更新 agent 绑定");
        }).catch(function (err) {
          if (App.reportError) App.reportError("更新 agent 绑定失败", err);
          render();
        });
      });
      bindRow.appendChild(select);
      info.appendChild(bindRow);
      detailEl.appendChild(info);

      var actions = el("div", "channels-actions", null, "channels-actions");
      var status = row.status || "stopped";
      var busy = state.busy[row.instanceId] === true;
      var action = (status === "running" || status === "starting") ? "stop" : "start";
      var button = el("button", action === "stop" ? "channels-stop-btn" : "channels-start-btn",
        action === "stop" ? "停止通道" : "启动通道", "channels-action-btn");
      button.type = "button";
      button.disabled = busy || status === "stopping";
      button.addEventListener("click", function () { act(row, action); });
      actions.appendChild(button);
      if (busy) actions.appendChild(el("span", "channels-busy", "操作中…", "channels-busy"));
      detailEl.appendChild(actions);
    }

    function render() {
      renderBanner();
      renderList();
      renderDetail();
    }

    function onEvent(evt) {
      if (!evt || evt.type !== "snapshot") return;
      state.connected = true;
      applySnapshot(evt.channels);
    }

    function connect() {
      if (state.subscribed) return;
      state.subscribed = true;
      state.attempted = true;
      loadAgentInfo();
      render();
      var promise;
      try {
        promise = window.AgentClient.call("channel.subscribe", {}, onEvent);
      } catch (_) {
        state.connected = false;
        render();
        return;
      }
      state.subscription = promise;
      promise.then(function () {
        state.connected = false;
        render();
      }, function () {
        state.connected = false;
        render();
      });
    }

    function refresh() {
      window.AgentClient.call("channel.list", {}).then(function (rows) {
        applySnapshot(rows);
      }).catch(function (err) {
        if (App.reportError) App.reportError("刷新通道状态", err);
      });
    }

    function act(row, action) {
      if (state.busy[row.instanceId]) return;
      var isStart = action === "start";
      var tip = isStart
        ? "启动通道「" + row.instanceId + "」会在外部平台标记机器人在线并开始接收消息，确定启动？"
        : "停止通道「" + row.instanceId + "」会断开长连接并停止接收消息，确定停止？";
      App.uiConfirm(tip).then(function (ok) {
        if (!ok) return;
        state.busy[row.instanceId] = true;
        delete state.errors[row.instanceId];
        render();
        var fn = isStart ? "channel.start" : "channel.stop";
        return window.AgentClient.call(fn, { id: row.instanceId }).then(function (snapshot) {
          state.busy[row.instanceId] = false;
          if (snapshot) upsert(snapshot);
          else render();
        }).catch(function (err) {
          state.busy[row.instanceId] = false;
          state.errors[row.instanceId] = (err && err.message) || String(err);
          if (App.toast) App.toast(state.errors[row.instanceId]);
          render();
        });
      });
    }

    if (refreshBtn) refreshBtn.addEventListener("click", refresh);
    window.addEventListener("beforeunload", function () {
      if (state.subscription && window.AgentClient.cancel && state.subscription.callId) {
        window.AgentClient.cancel(state.subscription.callId);
      }
    });

    App.channelsUI = {
      onViewChange: function (name) { if (name === "channels") connect(); },
      refresh: refresh,
    };
    render();
  };
})();
