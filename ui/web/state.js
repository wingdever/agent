"use strict";
// M0 重构：app.js 拆分的状态与共享契约根。
//
// 原 app.js 是一个巨大的 DOMContentLoaded 闭包，内部数十个变量与函数互相耦合。
// 按「主闭包 + 域函数（最稳）」方案：保留 app.js 的 DOMContentLoaded 闭包作为
// 装配器，把各 // ---------- 区块抽成独立 <script> 文件，各文件向全局 window.App
// 挂载自己的函数。本文件定义 window.App 这个「伪闭包」：集中持有所有共享状态
// 变量与跨域通用工具，供各域文件与 app.js 装配器读写。
//
// 约定：
//   - 原闭包里的 `var x` 提升为 `App.xxx`（状态变量）
//   - 原闭包里的 `function f(){}` 提升为 `App.f = function(){}`（跨域可调用）
//   - 域文件内部如需调用其它域函数，一律走 `App.fn(...)` 或闭包内 `ctx.fn(...)`
//   - 纯逻辑不变，只改定义位置与访问前缀
//   - DOM 根引用由 app.js 在 DOMContentLoaded 内填入 App，本文件不在加载时获取 DOM

(function () {
  var App = (window.App = window.App || {});

  // ---------- DOM 根引用（DOMContentLoaded 内由 app.js 填充） ----------
  App.viewport = null;
  App.sidebar = null;
  App.contextPanel = null;
  App.chatTab = null;
  App.input = null;
  App.sendBtn = null;
  App.modelHttpStatus = null;
  App.sessionNameLabel = null;
  App.footerSessionStats = null;
  App.footerTokenUsage = null;
  App.footerContextUsed = null;
  App.trajectoryTab = null;
  App.chatScroller = null;

  // ---------- 会话 / 模式状态 ----------
  App.currentSessionId = null;
  App.currentActivity = "research";        // 当前会话活动（来自会话存储，可切换）
  App.selectedInitialActivity = "research"; // 新建会话初始活动
  App.bareHistory = [];                    // bare 模式的纯内存对话历史
  App.currentPlanMode = false;             // 由 activity=plan-mode 驱动

  // ---------- bare-chat 扁平渲染临时状态 ----------
  App.currentAssistantBubble = null;
  App.currentThoughtBubble = null;
  App.toolCards = {};

  // ---------- 自动翻译临时状态（中英对照，display-only） ----------
  App.flatUserWrap = null;
  App.flatUserBubble = null;
  App.flatUserOriginal = "";
  App.flatUserTranslation = null;
  App.flatAssistantTranslation = null;

  // ---------- turn-step 流式渲染 DOM 锚点 ----------
  App.liveTurn = null;
  App.liveStep = null;
  App.liveResponse = null;
  App.liveAnswer = null;
  App.liveCards = {};
  App.liveAgentRequest = null;
  App.liveUserInput = null;
  App.liveUserOriginal = "";
  App.liveUserTranslation = null;
  App.liveAssistantTranslation = null;

  // ---------- 状态栏聚合状态 ----------
  App.usageState = { prompt: null, completion: null, total: null, cached: null };
  App.turnStat = { steps: null, tools: null, durationMs: null };
  App.sessionStat = { turns: 0, steps: 0 };
  App.CONTEXT_WINDOW = 128000;

  // ---------- 活动指示器 / presence 自动机 ----------
  App.ACTIVITIES = ["plan-mode", "intent-recog", "goal-mode", "build-code", "discuss-doc", "research", "review-proj", "human-learn", "diagnose"];
  App.currentActivityCompleted = false;
  App.activityIndicatorEl = null;
  App.headerCompact = false;
  App.IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  App.PRESENCE_TICK_MS = 30 * 1000;
  App.lastUserActivity = Date.now();
  App.presenceAuto = true;

  // ---------- 上下文占用环形图 ----------
  App.CIRC_R = 5.5;
  App.CIRC_C = 2 * Math.PI * 5.5;
  App.ctxDonutFill = null;
  App.ctxDonutLabel = null;

  // ---------- 压缩状态 ----------
  App.compactionHappenedInTurn = false;

  // ---------- composer：引用 / 推理控件 ----------
  App.pendingRefs = [];
  App.reasoningControl = "think-switch";
  App.modelSelector = null;
  App.effortSelector = null;
  App.READONLY_TOOLS = {
    read: 1, glob: 1, grep: 1, get_current_time: 1, get_goal: 1, calculator: 1,
    web_search: 1, web_fetch: 1, ask_user_question: 1, request_user_job: 1, job_list: 1, job_kill: 1,
  };
  App.WRITE_TOOLS = { write: 1, edit: 1, bash: 1, create_goal: 1, update_goal: 1, todo_write: 1, delete_goal: 1 };
  App.ARTIFACT_TOOLS = { write: 1, edit: 1 };
  App.HTTP_STATUS_LABEL = { "on-wait": "wait", "on-post": "post", "on-get": "get" };

  // ---------- 头部紧凑评估调度器（initHeaderCompact 内赋值真实实现） ----------
  App.scheduleHeaderEval = function () {};

  // ---------- 通用工具函数（原闭包内助手，跨域共用） ----------

  // 替代原生 prompt/confirm/alert（Electron 环境不支持）
  App.showModal = function showModal(opts) {
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
  };
  App.uiPrompt = function uiPrompt(title, defaultValue, extra) {
    return App.showModal(Object.assign({ kind: "prompt", title: title, defaultValue: defaultValue || "" }, extra || {}));
  };
  App.uiConfirm = function uiConfirm(message) {
    return App.showModal({ kind: "confirm", title: "请确认", message: message, okText: "确定", cancelText: "取消" });
  };
  App.uiAlert = function uiAlert(message) {
    return App.showModal({ kind: "alert", title: "提示", message: message, okText: "确定" });
  };
  // 暴露给 settings.js 等后续模块复用（替代原生 prompt/confirm/alert）。
  window.uiPrompt = App.uiPrompt;
  window.uiConfirm = App.uiConfirm;
  window.uiAlert = App.uiAlert;

  // 创建带 data-name 的 div
  App.makeEl = function makeEl(name, cls) {
    var n = document.createElement("div");
    n.setAttribute("data-name", name);
    if (cls) n.className = cls;
    return n;
  };
  App.safeParse = function safeParse(s) {
    try { return JSON.parse(s); } catch (e) { return {}; }
  };
  App.scrollChatToBottom = function scrollChatToBottom() {
    if (App.chatScroller) App.chatScroller.scrollTop = App.chatScroller.scrollHeight;
  };

  // 字节数人类可读（renderToolResult 的 read 结果概要用到）。
  // 注：原 app.js 调用了 formatBytes 但从未定义，此处补全。
  App.formatBytes = function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  };

  // 短标签/长标签切换（头部紧凑用），仅改 textContent，不触碰其它。
  App.applyLabel = function applyLabel(el) {
    if (!el) return;
    var d = el.dataset;
    var full = d.labelFull;
    var short = d.labelShort;
    if (full == null || short == null) return;
    el.textContent = App.headerCompact ? short : full;
  };
  App.setLabels = function setLabels(el, full, short) {
    if (!el) return;
    el.dataset.labelFull = full;
    el.dataset.labelShort = short;
    App.applyLabel(el);
    App.scheduleHeaderEval();
  };
  App.applyCompact = function applyCompact(compact) {
    compact = !!compact;
    if (compact === App.headerCompact) return;
    App.headerCompact = compact;
    var header = document.querySelector(".chat-header");
    if (header) {
      if (compact) header.setAttribute("data-compact", "1");
      else header.removeAttribute("data-compact");
    }
    App.applyLabel(document.getElementById("sessionModeIndicator"));
    App.applyLabel(document.getElementById("activityIndicator"));
    App.applyLabel(document.getElementById("presenceSwitch"));
    App.applyLabel(document.getElementById("autonomySwitch"));
  };

  // 状态栏渲染与重置（原 app.js 行 1727–1802，抽为跨域共享，因活动/权限/自主度变化都会触发）
  App.fmtNum = function fmtNum(n) { return (n == null) ? "-" : String(n); };
  App.fmtPct = function fmtPct(num, den) {
    if (num == null || den == null || !den) return "-";
    return Math.round((num / den) * 100) + "%";
  };
  App.fmtTok = function fmtTok(n) {
    if (n == null) return "-";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  };
  App.ensureContextDonut = function ensureContextDonut() {
    if (!App.footerContextUsed || App.ctxDonutFill) return;
    App.footerContextUsed.innerHTML = "";
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("ctx-donut");
    var track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("class", "ctx-donut-track");
    track.setAttribute("cx", "7"); track.setAttribute("cy", "7"); track.setAttribute("r", String(App.CIRC_R));
    App.ctxDonutFill = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    App.ctxDonutFill.setAttribute("class", "ctx-donut-fill");
    App.ctxDonutFill.setAttribute("cx", "7"); App.ctxDonutFill.setAttribute("cy", "7"); App.ctxDonutFill.setAttribute("r", String(App.CIRC_R));
    App.ctxDonutFill.setAttribute("transform", "rotate(-90 7 7)");
    App.ctxDonutFill.setAttribute("stroke-dasharray", "0 " + App.CIRC_C);
    svg.appendChild(track);
    svg.appendChild(App.ctxDonutFill);
    App.ctxDonutLabel = document.createElement("span");
    App.ctxDonutLabel.className = "ctx-donut-label";
    App.footerContextUsed.appendChild(svg);
    App.footerContextUsed.appendChild(App.ctxDonutLabel);
  };
  App.setContextDonut = function setContextDonut(pct) {
    App.ensureContextDonut();
    if (!App.ctxDonutFill) return;
    var clamped = Math.max(0, Math.min(100, pct == null ? 0 : pct));
    var arc = (clamped / 100) * App.CIRC_C;
    App.ctxDonutFill.setAttribute("stroke-dasharray", arc.toFixed(3) + " " + (App.CIRC_C - arc).toFixed(3));
    if (App.ctxDonutLabel) App.ctxDonutLabel.textContent = (pct == null) ? "-" : Math.round(pct) + "%";
  };
  App.renderStatusBar = function renderStatusBar() {
    if (App.footerSessionStats) {
      var tps = "-";
      if (App.usageState.total != null && App.turnStat.durationMs != null && App.turnStat.durationMs > 0) {
        tps = (App.usageState.total / (App.turnStat.durationMs / 1000)).toFixed(0);
      }
      App.footerSessionStats.textContent =
        "⟳ " + App.fmtNum(App.sessionStat.turns) + " turns " + App.fmtNum(App.sessionStat.steps) + " steps · " + tps + " tok/s";
    }
    if (App.footerTokenUsage) {
      App.footerTokenUsage.textContent =
        "▤ " + App.fmtTok(App.usageState.total) + " tok · Cache hit " + App.fmtPct(App.usageState.cached, App.usageState.prompt);
    }
    var ctxPct = (App.usageState.total != null) ? (App.usageState.total / App.CONTEXT_WINDOW) * 100 : null;
    App.setContextDonut(ctxPct);
  };
  App.resetStatusBar = function resetStatusBar() {
    App.usageState = { prompt: null, completion: null, total: null, cached: null };
    App.turnStat = { steps: null, tools: null, durationMs: null };
    App.sessionStat = { turns: 0, steps: 0 };
    App.renderStatusBar();
  };
})();
