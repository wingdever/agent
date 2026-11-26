"use strict";

// 终端主视图页：xterm 直接接收 PTY 的原始字节，不做行缓冲、不做文本中间层。
// 每个终端一条 WebSocket；重连时服务端发 serialized screen 快照，客户端先
// reset 再写快照，因此全屏 TUI 也能恢复到同一屏。页面隐藏时连接保持。
(function () {
  var App = (window.App = window.App || {});

  App.initTerminalPanel = function initTerminalPanel() {
    var panel = document.getElementById("terminalPanel");
    var navBtn = document.querySelector(".terminal-view-btn");
    var tabsEl = document.getElementById("terminalTabs");
    var stage = document.getElementById("terminalStage");
    var empty = document.getElementById("terminalEmpty");
    var emptyText = document.getElementById("terminalEmptyText");
    var statusEl = document.getElementById("terminalStatus");
    var newBtn = document.getElementById("terminalNew");
    var emptyNew = document.getElementById("terminalEmptyNew");

    var stub = {
      setSession: function () {},
      refresh: function () {},
      isVisible: function () { return false; },
      onViewChange: function () {},
    };
    if (!panel || !tabsEl || !stage) {
      App.terminalPanel = stub;
      return;
    }

    var state = {
      sessionId: null,
      items: {},
      activeId: null,
      visible: false,
      initialized: false,
      pollTimer: null,
      busy: false,
    };
    var encoder = new TextEncoder();

    function baseUrl() {
      return window.AgentClient && window.AgentClient.baseUrl;
    }

    if (!baseUrl()) {
      // IPC transport has no WebSocket upgrade endpoint yet. Hide the page and
      // its navigation entry rather than offering a control that can only fail.
      panel.hidden = true;
      if (navBtn) navBtn.hidden = true;
      App.terminalPanel = stub;
      return;
    }

    function socketUrl(id, cols, rows) {
      var base = baseUrl();
      if (!base) return null;
      var proto = base.indexOf("https://") === 0 ? "wss://" : "ws://";
      var host = base.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return proto + host + "/terminal?sessionId=" + encodeURIComponent(state.sessionId) +
        "&terminalId=" + encodeURIComponent(id) +
        "&cols=" + encodeURIComponent(cols) +
        "&rows=" + encodeURIComponent(rows);
    }

    function call(fn, params) {
      return window.AgentClient.call(fn, params).catch(function (error) {
        App.reportError("终端", error);
        throw error;
      });
    }

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || "";
    }

    function itemLabel(row) {
      return (row && row.name) || "terminal";
    }

    function syncVisible() {
      state.visible = !panel.hidden;
    }

    function renderTabs() {
      tabsEl.textContent = "";
      var ids = Object.keys(state.items);
      for (var i = 0; i < ids.length; i += 1) {
        var item = state.items[ids[i]];
        var tab = document.createElement("div");
        tab.className = "terminal-tab" + (ids[i] === state.activeId ? " active" : "");
        tab.setAttribute("data-name", "terminal-tab");
        tab.setAttribute("data-id", ids[i]);
        tab.addEventListener("click", (function (id) {
          return function () { selectTerminal(id); };
        })(ids[i]));

        var name = document.createElement("span");
        name.className = "terminal-tab-name";
        name.textContent = itemLabel(item.row);
        tab.appendChild(name);

        var mark = document.createElement("span");
        mark.className = "terminal-tab-mark";
        mark.textContent = item.row && item.row.control === "user" ? "user" : "agent";
        tab.appendChild(mark);

        var close = document.createElement("button");
        close.className = "terminal-tab-close";
        close.type = "button";
        close.textContent = "×";
        close.title = "关闭终端（结束进程）";
        close.addEventListener("click", (function (id) {
          return function (event) {
            event.stopPropagation();
            closeTerminal(id);
          };
        })(ids[i]));
        tab.appendChild(close);
        tabsEl.appendChild(tab);
      }
    }

    function syncEmpty() {
      var has = Object.keys(state.items).length > 0;
      if (empty) empty.hidden = has;
      if (emptyText) emptyText.textContent = state.sessionId ? "暂无终端，点「新建终端」开一个" : "选择会话后可新建终端";
      if (stage) stage.setAttribute("data-has-terminal", has ? "1" : "0");
    }

    function render() {
      renderTabs();
      syncEmpty();
      var item = state.activeId && state.items[state.activeId];
      if (!item) {
        setStatus(state.sessionId ? "无活动终端" : "选择一个会话后可新建终端");
        return;
      }
      var row = item.row || {};
      var control = row.control === "user" ? "user" : "agent";
      var alive = row.alive !== false;
      var running = !alive ? "exited" : (row.running === "yes" ? "command running" : "prompt");
      setStatus(row.id + " · " + (row.cwd || "") + " · " + running + " · control=" + control);
    }

    function fitItem(item) {
      if (!item || !item.fit) return;
      try { item.fit.fit(); } catch (_) {}
    }

    function sendResize(item) {
      if (!item || !item.socket || item.socket.readyState !== WebSocket.OPEN || !item.term) return;
      try {
        item.socket.send(JSON.stringify({ type: "resize", cols: item.term.cols, rows: item.term.rows }));
      } catch (_) {}
    }

    function disconnect(item, silent) {
      if (!item) return;
      item.exiting = item.exiting || silent === true;
      if (item.retryTimer) {
        clearTimeout(item.retryTimer);
        item.retryTimer = null;
      }
      if (item.socket) {
        var socket = item.socket;
        item.socket = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try { socket.close(); } catch (_) {}
      }
    }

    function scheduleReconnect(item) {
      if (!item || item.exiting || item.retryTimer) return;
      if (state.activeId !== item.row.id) return;
      if (item.retries >= 5) {
        setStatus("终端连接已断开（重连 5 次失败）");
        return;
      }
      var delay = Math.min(8000, 400 * Math.pow(2, item.retries));
      item.retries += 1;
      item.retryTimer = setTimeout(function () {
        item.retryTimer = null;
        if (state.items[item.row.id] && state.activeId === item.row.id) {
          connect(item);
        }
      }, delay);
    }

    function connect(item) {
      if (!item || !item.term || item.socket) return;
      if (item.row && item.row.alive === false) {
        setStatus("终端已退出：" + (item.row.exitCode == null ? "unknown" : item.row.exitCode));
        return;
      }
      var url = socketUrl(item.row.id, item.term.cols || 80, item.term.rows || 24);
      if (!url) {
        setStatus("HTTP transport 不可用，终端面板需要 AGENT_TRANSPORT=http");
        return;
      }

      var socket;
      try { socket = new WebSocket(url); } catch (_) {
        setStatus("无法创建终端连接");
        return;
      }
      socket.binaryType = "arraybuffer";
      item.socket = socket;

      socket.onopen = function () {
        item.connected = true;
        sendResize(item);
        render();
        syncVisible();
        if (state.visible) { try { item.term.focus(); } catch (_) {} }
      };

      socket.onmessage = function (event) {
        if (typeof event.data === "string") {
          var message;
          try { message = JSON.parse(event.data); } catch (_) { return; }
          if (message.type === "hello") {
            item.exiting = false;
            item.retries = 0;
            item.connected = true;
            item.row.alive = message.alive !== false;
            item.row.running = message.running || "unknown";
            item.row.control = message.control || item.row.control;
            item.row.createdBy = message.createdBy || item.row.createdBy;
            try { item.term.reset(); } catch (_) {}
            if (message.snapshot) item.term.write(message.snapshot);
            if (message.cols && message.rows) {
              try { item.term.resize(message.cols, message.rows); } catch (_) {}
            }
            render();
            return;
          }
          if (message.type === "exit") {
            item.exiting = true;
            item.row.alive = false;
            item.row.running = "no";
            item.row.exitCode = message.exitCode;
            render();
            return;
          }
          if (message.type === "error") {
            setStatus("终端错误：" + (message.error || "unknown"));
            return;
          }
          return;
        }

        var bytes = new Uint8Array(event.data);
        try { item.term.write(bytes); } catch (_) {}
      };

      socket.onerror = function () {
        item.connected = false;
        setStatus("终端连接错误");
      };

      socket.onclose = function () {
        item.connected = false;
        item.socket = null;
        if (!item.exiting) scheduleReconnect(item);
        render();
      };
    }

    function createItem(row) {
      if (state.items[row.id]) return state.items[row.id];
      var slot = document.createElement("div");
      slot.className = "terminal-slot";
      slot.setAttribute("data-name", "terminal-slot");
      slot.setAttribute("data-id", row.id);
      var host = document.createElement("div");
      host.className = "terminal-host";
      host.setAttribute("data-name", "terminal-host");
      slot.appendChild(host);
      stage.appendChild(slot);

      var term = new window.Terminal({
        cols: 80,
        rows: 24,
        cursorBlink: true,
        scrollback: 2000,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.15,
        theme: {
          background: "#0b1020",
          foreground: "#dbeafe",
          cursor: "#93c5fd",
          selectionBackground: "#334155",
          black: "#0f172a",
          red: "#f87171",
          green: "#86efac",
          yellow: "#fde68a",
          blue: "#93c5fd",
          magenta: "#d8b4fe",
          cyan: "#67e8f9",
          white: "#e5e7eb",
          brightBlack: "#64748b",
          brightRed: "#fca5a5",
          brightGreen: "#bbf7d0",
          brightYellow: "#fef08a",
          brightBlue: "#bfdbfe",
          brightMagenta: "#e9d5ff",
          brightCyan: "#a5f3fc",
          brightWhite: "#ffffff",
        },
      });
      var fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(host);

      var item = {
        row: row,
        term: term,
        fit: fit,
        socket: null,
        slot: slot,
        host: host,
        connected: false,
        exiting: false,
        retries: 0,
        retryTimer: null,
      };
      state.items[row.id] = item;

      term.onData(function (data) {
        if (!state.items[row.id]) return;
        // The first byte is the ownership handoff. Keep this path raw: no
        // submit/newline wrapping, so Ctrl-C, arrows, paste and TUI keys all
        // reach the PTY exactly as xterm produced them.
        if (item.row.alive === false) return;
        if (!item.socket || item.socket.readyState !== WebSocket.OPEN) return;
        try { item.socket.send(encoder.encode(data)); } catch (_) {}
        if (item.row.control !== "user") {
          item.row.control = "user";
          render();
        }
      });
      term.onResize(function () { sendResize(item); });
      // Mouse reporting and other binary xterm protocols arrive here rather
      // than through onData; keep them byte-exact for full-screen TUIs.
      term.onBinary(function (data) {
        if (!item.socket || item.socket.readyState !== WebSocket.OPEN) return;
        var bytes = new Uint8Array(data.length);
        for (var i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
        try { item.socket.send(bytes); } catch (_) {}
      });
      slot.addEventListener("mousedown", function () { try { term.focus(); } catch (_) {} });

      return item;
    }

    function selectTerminal(id) {
      if (!state.items[id]) return;
      state.activeId = id;
      Object.keys(state.items).forEach(function (key) {
        var item = state.items[key];
        if (item.slot) item.slot.classList.toggle("active", key === id);
      });
      render();
      var item = state.items[id];
      syncVisible();
      requestAnimationFrame(function () {
        if (state.visible) fitItem(item);
        connect(item);
        if (state.visible) { try { item.term.focus(); } catch (_) {} }
      });
    }

    function disposeItem(id) {
      var item = state.items[id];
      if (!item) return;
      disconnect(item, true);
      try { item.term.dispose(); } catch (_) {}
      if (item.slot && item.slot.parentNode) item.slot.parentNode.removeChild(item.slot);
      delete state.items[id];
      if (state.activeId === id) state.activeId = null;
    }

    function closeTerminal(id) {
      var item = state.items[id];
      if (!item) return;
      App.showModal({
        kind: "confirm",
        title: "关闭终端",
        message: "关闭终端会结束其中的进程，确定吗？",
        okText: "关闭",
        cancelText: "取消",
      }).then(function (ok) {
        if (!ok) return;
        return call("terminal.panel.close", { session_id: state.sessionId, id: id }).then(function () {
          disposeItem(id);
          var ids = Object.keys(state.items);
          if (ids.length) selectTerminal(ids[0]);
          else render();
        });
      }).catch(function () {});
    }

    function newTerminal() {
      if (state.busy) return;
      if (!state.sessionId) {
        App.toast && App.toast("请先选择一个会话", { kind: "warn" });
        return;
      }
      if (!baseUrl()) {
        App.toast && App.toast("终端面板需要 HTTP transport（当前是 IPC）", { kind: "warn" });
        return;
      }
      state.busy = true;
      call("terminal.panel.open", { session_id: state.sessionId }).then(function (handle) {
        state.busy = false;
        return refresh().then(function () { if (handle && handle.id) selectTerminal(handle.id); });
      }).catch(function () { state.busy = false; });
    }

    function updateRow(item, row) {
      var previous = item.row || {};
      item.row = row;
      if (previous.alive !== false && row.alive === false) item.exiting = true;
      item.row.createdBy = row.createdBy;
      // A server-side takeover or resurrection is reflected in the tab mark.
    }

    function refresh() {
      syncVisible();
      if (!state.sessionId) {
        Object.keys(state.items).forEach(disposeItem);
        state.activeId = null;
        render();
        return Promise.resolve();
      }
      return call("terminal.panel.list", { session_id: state.sessionId }).then(function (rows) {
        rows = Array.isArray(rows) ? rows : [];
        var seen = {};
        var beforeIds = {};
        Object.keys(state.items).forEach(function (id) { beforeIds[id] = true; });
        rows.forEach(function (row) {
          seen[row.id] = true;
          var item = state.items[row.id];
          if (item) updateRow(item, row);
          else createItem(row);
        });
        Object.keys(state.items).forEach(function (id) {
          if (!seen[id]) disposeItem(id);
        });
        var ids = Object.keys(state.items);
        var firstLoad = !state.initialized;
        var hasNewAgent = rows.some(function (row) {
          return row.createdBy === "agent" && row.id && !beforeIds[row.id];
        });
        if (!state.activeId && ids.length) state.activeId = ids[0];
        if (state.activeId && !state.items[state.activeId]) state.activeId = ids[0] || null;
        // An agent-created terminal is announced, never pulled into view: the
        // terminal page stays an explicit destination chosen from the sidebar.
        if (!firstLoad && hasNewAgent && App.toast) {
          App.toast("Agent 打开了新终端，可在「💻 终端」查看");
        }
        state.initialized = true;
        Object.keys(state.items).forEach(function (key) {
          state.items[key].slot && state.items[key].slot.classList.toggle("active", key === state.activeId);
        });
        if (state.activeId) {
          var item = state.items[state.activeId];
          requestAnimationFrame(function () {
            if (state.visible) fitItem(item);
            connect(item);
            if (state.visible) { try { item.term.focus(); } catch (_) {} }
          });
        } else {
          render();
        }
      }).catch(function () {});
    }

    // 页面显隐由 App.showView 统一控制；隐藏时只停布局测量，不断 socket。
    function onViewChange(name) {
      state.visible = name === "terminal";
      if (state.visible) refresh();
      else render();
    }

    function setSession(sessionId) {
      var next = sessionId == null ? null : String(sessionId);
      if (next === state.sessionId) return;
      Object.keys(state.items).forEach(disposeItem);
      state.activeId = null;
      state.sessionId = next;
      state.initialized = false;
      render();
      refresh();
      updatePolling();
    }

    function updatePolling() {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = null;
      if (!state.sessionId) return;
      state.pollTimer = setInterval(function () {
        if (state.sessionId) refresh();
      }, 2500);
    }

    if (newBtn) newBtn.addEventListener("click", newTerminal);
    if (emptyNew) emptyNew.addEventListener("click", newTerminal);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        syncVisible();
        if (!state.visible || !state.activeId) return;
        var item = state.items[state.activeId];
        if (!item) return;
        fitItem(item);
        sendResize(item);
      }, 80);
    });
    window.addEventListener("beforeunload", function () {
      Object.keys(state.items).forEach(function (id) { disconnect(state.items[id], true); });
    });

    syncVisible();
    render();

    App.terminalPanel = {
      setSession: setSession,
      refresh: refresh,
      isVisible: function () { syncVisible(); return state.visible; },
      onViewChange: onViewChange,
      newTerminal: newTerminal,
    };
  };
})();
