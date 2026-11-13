"use strict";
// M0 重构：原 app.js 闭包内「composer：发送 / 模型与推理选择器 / @引用 / 推理开关 / 表头紧凑」区块。
// 抽为独立 <script>，向 window.App 挂载。原闭包内 var 提升为 App.xxx，跨域调用走 App.fn(...)。
// DOM 根（input/sendBtn/modelSelector/effortSelector 等）由 app.js 装配器填入 App，init 阶段取用。

(function () {
  var App = (window.App = window.App || {});

  // ---------- 设置读写（与 settings.js 同源） ----------
  function getSettings() {
    try { return window.AgentClient.call("settings", { op: "get" }); } catch (e) { return Promise.resolve({}); }
  }
  function saveSettings(patch) {
    try { return window.AgentClient.call("settings", { op: "set", payload: patch }); } catch (e) { return Promise.resolve({}); }
  }
  App.getSettings = getSettings;
  App.saveSettings = saveSettings;

  // ---------- 权限预设映射（grill Q2） ----------
  //  read-only        : 只读工具全部 allow，其余 deny
  //  workspace-write  : 只读 + 工作区内写 allow，其余 deny（经 fs-policy 限制写路径）
  //  full-access      : 全部 allow
  //  fine-grained     : 不改写，打开侧栏 permissions modal 沿用 user/* 配置
  App.applyPermissionPreset = function applyPermissionPreset(preset) {
    if (preset === "fine-grained") {
      var pBtn = document.getElementById("permissionsBtn");
      if (pBtn) pBtn.click();
      return;
    }
    var tools = {};
    Object.keys(App.READONLY_TOOLS).forEach(function (t) { tools[t] = "allow"; });
    if (preset === "full-access") {
      Object.keys(App.WRITE_TOOLS).forEach(function (t) { tools[t] = "allow"; });
    } else if (preset === "workspace-write") {
      Object.keys(App.WRITE_TOOLS).forEach(function (t) { tools[t] = "allow"; });
    } else { // read-only
      Object.keys(App.WRITE_TOOLS).forEach(function (t) { tools[t] = "deny"; });
    }
    window.AgentClient.call("permissions", { op: "permissions.upsert", payload: { default: (preset === "full-access") ? "allow" : "deny", tools: tools } })
      .catch(function (e) { console.error("applyPermissionPreset failed:", e); });
  };

  App.initPermissionSelector = function initPermissionSelector() {
    var permissionSelector = document.getElementById("permissionSelector");
    if (permissionSelector) {
      permissionSelector.addEventListener("change", function () { App.applyPermissionPreset(permissionSelector.value); });
    }
  };

  // ---------- 模型选择器 ----------
  App.initModelSelector = function initModelSelector() {
    App.modelSelector = document.getElementById("modelSelector");
    function refreshModelSelector() {
      if (!App.modelSelector) return;
      window.AgentClient.call("providers", { op: "get" }).then(function (list) {
        var models = [];
        App.modelSelector.innerHTML = "";
        (list || []).forEach(function (p) {
          if (!p.models || !p.models.length) return;
          var grp = document.createElement("optgroup");
          grp.label = p.name;
          p.models.forEach(function (m) {
            if (m.enabled !== true) return;
            models.push(m.name);
            var o = document.createElement("option");
            o.value = m.name; o.textContent = m.name;
            o.setAttribute("data-provider", p.name);
            grp.appendChild(o);
          });
          App.modelSelector.appendChild(grp);
        });
        getSettings().then(function (st) {
          if (st && st.model && models.indexOf(st.model) >= 0) {
            App.modelSelector.value = st.model;
            refreshEffortLevels(st.model);
          }
        });
      }).catch(function () {});
    }
    function refreshEffortLevels(modelName) {
      if (!App.effortSelector) return;
      var opt = App.modelSelector ? App.modelSelector.querySelector('option[value="' + (modelName || "").replace(/"/g, '\\"') + '"]') : null;
      var provider = opt ? opt.getAttribute("data-provider") : null;
      getSettings().then(function (st) {
        var savedEffort = st && st.effort;
        return window.AgentClient.call("modelCapabilities", { provider: provider, model: modelName }).then(function (res) {
          var levels = (res && res.effort && res.effort.length) ? res.effort.slice() : ["low", "medium", "high"];
          if (levels.indexOf("none") < 0) levels.unshift("none");
          App.effortSelector.innerHTML = "";
          levels.forEach(function (lv) {
            var o = document.createElement("option");
            o.value = lv; o.textContent = lv;
            App.effortSelector.appendChild(o);
          });
          var initial;
          if (savedEffort && levels.indexOf(savedEffort) >= 0) {
            initial = savedEffort;
          } else if (res && res.default_level && levels.indexOf(res.default_level) >= 0) {
            initial = res.default_level;
          } else {
            initial = levels[0];
          }
          App.effortSelector.value = initial;
          saveSettings({ effort: App.effortSelector.value });
        });
      }).catch(function () {});
    }
    App.refreshEffortLevels = refreshEffortLevels;

    if (App.modelSelector) {
      App.modelSelector.addEventListener("change", function () {
        var opt = App.modelSelector.querySelector('option[value="' + (App.modelSelector.value || "").replace(/"/g, '\\"') + '"]');
        var provider = opt ? opt.getAttribute("data-provider") : null;
        var patch = { model: App.modelSelector.value };
        if (provider) patch.provider = provider;
        saveSettings(patch);
        refreshEffortLevels(App.modelSelector.value);
        if (App.refreshContextWindow) App.refreshContextWindow();
      });
      refreshModelSelector();
      if (App.refreshContextWindow) App.refreshContextWindow();
      window.addEventListener("providers-changed", function () { refreshModelSelector(); });
    }
  };

  // ---------- 推理等级选择器 ----------
  App.initEffortSelector = function initEffortSelector() {
    App.effortSelector = document.getElementById("effortSelector");
    if (App.effortSelector) {
      App.effortSelector.addEventListener("change", function () { saveSettings({ effort: App.effortSelector.value }); });
    }
  };

  // think-switch 与 effort-selector 语义冲突，由设置 reasoningControl 决定渲染哪一个。
  function isThinkOn() {
    var ts = document.getElementById("thinkSwitch");
    return !!(ts && ts.classList.contains("active"));
  }
  function applyReasoningControlVisibility() {
    var ts = document.getElementById("thinkSwitch");
    if (ts) ts.style.display = (App.reasoningControl === "think-switch") ? "" : "none";
    var effortWrap = document.querySelector(".model-effort-selector");
    if (App.effortSelector) App.effortSelector.style.display = (App.reasoningControl === "effort-selector") ? "" : "none";
    if (effortWrap) effortWrap.style.display = (App.reasoningControl === "effort-selector" || App.reasoningControl === "think-switch") ? "" : "none";
  }
  function loadReasoningControl() {
    return getSettings().then(function (st) {
      App.reasoningControl = (st && st.reasoningControl) || "think-switch";
      applyReasoningControlVisibility();
    }).catch(function () {});
  }
  App.computeEffort = function computeEffort() {
    if (App.reasoningControl === "think-switch") {
      return isThinkOn() ? undefined : "none";
    }
    if (App.effortSelector) return App.effortSelector.value || undefined;
    return undefined;
  };
  App.initReasoningControl = function initReasoningControl() {
    loadReasoningControl();
    window.addEventListener("reasoning-control-changed", function (e) {
      App.reasoningControl = e.detail || "think-switch";
      applyReasoningControlVisibility();
    });
  };

  // ---------- @ 引用：文件 / 会话 ----------
  App.initRefs = function initRefs() {
    var refBtn = document.getElementById("refBtn");
    var refChips = document.querySelector(".ref-chips");

    function el(tag, attrs, children) {
      var e = document.createElement(tag);
      attrs = attrs || {};
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null) continue;
        if (k === "className") e.className = v;
        else if (k === "dataset") { for (var d in v) e.setAttribute("data-" + d, v[d]); }
        else if (k === "onclick") e.addEventListener("click", v);
        else if (k === "value") e.value = v;
        else e.setAttribute(k, v);
      }
      if (children != null) {
        if (!Array.isArray(children)) children = [children];
        children.forEach(function (c) {
          if (c == null) return;
          e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
        });
      }
      return e;
    }

    App.renderRefChips = function renderRefChips() {
      if (!refChips) return;
      refChips.innerHTML = "";
      if (!App.pendingRefs.length) { refChips.hidden = true; return; }
      refChips.hidden = false;
      App.pendingRefs.forEach(function (ref, idx) {
        var chip = document.createElement("span");
        chip.className = "ref-chip ref-" + ref.type;
        chip.setAttribute("data-name", "ref-chip");
        chip.textContent = (ref.type === "file" ? "📄 " : ref.type === "skill" ? "📖 " : "💬 ") + ref.label;
        var x = document.createElement("button");
        x.className = "ref-chip-remove";
        x.setAttribute("data-name", "ref-chip-remove");
        x.textContent = "×";
        x.addEventListener("click", function () {
          App.pendingRefs.splice(idx, 1);
          App.renderRefChips();
        });
        chip.appendChild(x);
        refChips.appendChild(chip);
      });
    };

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

      var skillItem = document.createElement("button");
      skillItem.className = "ref-menu-item";
      skillItem.textContent = "📖 引用技能…";
      skillItem.addEventListener("click", function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        openSkillRefSelector();
      });
      box.appendChild(skillItem);

      overlay.appendChild(box);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.parentNode.removeChild(overlay); });
      document.body.appendChild(overlay);
    }

    async function pickSessionRef() {
      try {
        var list = await window.AgentClient.call("storage", { op: "session.list", payload: { includeDeleted: true } });
        if (!list || !list.length) { await App.uiAlert("没有可引用的会话"); return; }
        var options = list.map(function (s) { return (s.name || ("会话 " + s.id)) + (s.deleted_at ? " (已删)" : ""); }).join("\n");
        var pick = await App.uiPrompt("输入要引用的会话序号（0 取消）:\n" + options.split("\n").map(function (n, i) { return (i + 1) + ". " + n; }).join("\n"), "1");
        var i = parseInt(pick, 10);
        if (!i || i < 1 || i > list.length) return;
        var s = list[i - 1];
        App.pendingRefs.push({ type: "session", id: s.id, name: s.name || ("会话 " + s.id), label: s.name || ("会话 " + s.id) });
        App.renderRefChips();
      } catch (e) { console.error("pick session ref failed:", e); }
    }

    async function pickFileRef() {
      var p = await App.uiPrompt("输入要引用的本地文件路径", "");
      if (!p) return;
      App.pendingRefs.push({ type: "file", path: p, label: p.split("/").pop() || p });
      App.renderRefChips();
    }

    // @菜单的技能引用块：skills.list 已按 isUserInvocable 过滤，故选择器只出现
    // 用户可调用技能；选中后推 {type:"skill", name} 引用 chip，随 chat 的
    // references 参数发出（后端 resolveReferences 渲染为 <skill_content> 块）。
    // 选择器 UI 对应 docs/ui.md 的 skill-ref-selector（skill-search-input + skill-list）。
    async function openSkillRefSelector() {
      var list;
      try {
        list = await window.AgentClient.call("skills", { op: "list" });
      } catch (e) {
        console.error("load skills failed:", e);
        list = [];
      }
      if (!list || !list.length) { await App.uiAlert("没有可引用的技能"); return; }

      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.setAttribute("data-name", "skill-ref-selector-overlay");
      var box = document.createElement("div");
      box.className = "modal-box skill-ref-selector";
      box.setAttribute("data-name", "skill-ref-selector");
      var title = document.createElement("div");
      title.className = "modal-title";
      title.textContent = "引用技能";
      box.appendChild(title);

      var search = document.createElement("input");
      search.className = "skill-search-input";
      search.setAttribute("data-name", "skill-search-input");
      search.type = "text";
      search.placeholder = "过滤技能名 / 描述…";
      box.appendChild(search);

      var listEl = document.createElement("div");
      listEl.className = "skill-list";
      listEl.setAttribute("data-name", "skill-list");
      box.appendChild(listEl);

      function render(filter) {
        filter = (filter || "").trim().toLowerCase();
        listEl.innerHTML = "";
        var shown = list.filter(function (s) {
          if (!filter) return true;
          return (s.name + " " + (s.description || "")).toLowerCase().indexOf(filter) !== -1;
        });
        if (!shown.length) {
          listEl.appendChild(el("div", { className: "empty-hint" }, filter ? "无匹配技能" : "没有可引用的技能"));
          return;
        }
        shown.forEach(function (s) {
          var name = el("div", { className: "skill-element-name" }, s.name);
          var desc = el("div", { className: "skill-element-desc" }, s.description || "");
          var item = el("div", {
            className: "skill-element",
            dataset: { name: "skill-element", skill: s.name },
            onclick: function () {
              if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
              App.pendingRefs.push({ type: "skill", name: s.name, label: "@" + s.name });
              App.renderRefChips();
            },
          }, [name, desc]);
          listEl.appendChild(item);
        });
      }
      render("");

      search.addEventListener("input", function () { render(search.value); });
      overlay.appendChild(box);
      overlay.addEventListener("click", function (e) { if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); });
      document.body.appendChild(overlay);
      search.focus();
    }

    if (refBtn) refBtn.addEventListener("click", openRefMenu);
    if (App.input) {
      App.input.addEventListener("input", function () {
        if (App.input.value.slice(-1) === "@" && window.getSelection && getSelection().isCollapsed) {
          openRefMenu();
        }
      });
    }
  };

  // ---------- think / search 开关 ----------
  App.initSwitches = function initSwitches() {
    var thinkSwitch = document.getElementById("thinkSwitch");
    var searchSwitch = document.getElementById("searchSwitch");
    if (thinkSwitch) thinkSwitch.addEventListener("click", function () { thinkSwitch.classList.toggle("active"); });
    loadReasoningControl();
    if (searchSwitch) searchSwitch.addEventListener("click", function () { searchSwitch.classList.toggle("active"); });
  };

  // ---------- bare-chat 发送 ----------
  App.runBareChat = async function runBareChat(text) {
    App.input.value = "";
    var userNode = App.appendFlatUser(text);
    App.flatUserWrap = userNode.wrap;
    App.flatUserBubble = userNode.bubble;
    App.flatUserOriginal = text;
    App.flatUserTranslation = null;
    App.flatAssistantTranslation = null;
    App.bareHistory.push({ role: "user", content: text });
    App.currentAssistantBubble = null; App.toolCards = {};
    try {
      await window.AgentClient.call("chat", { mode: "bare", messages: App.bareHistory.slice(), references: App.pendingRefs.slice(), effort: App.computeEffort(), model: (App.modelSelector && App.modelSelector.value ? App.modelSelector.value : undefined) }, App.onChatEvent);
      App.pendingRefs = []; App.renderRefChips();
    } catch (e) {
      console.error("chat failed:", e);
      App.appendMessage("assistant", "[出错] " + (e && e.message ? e.message : e));
    }
  };

  // ---------- 主发送 ----------
  App.onSend = async function onSend() {
    var text = App.input.value.trim();
    if (!text) return;
    App.markUserActivity();
    if (text.charAt(0) === "/") { await App.runSlashCommand(text); return; }
    if (App.isBare()) { await App.runBareChat(text); return; }
    if (!App.currentSessionId) { await App.uiAlert("请先在左侧选择或新建一个会话"); return; }
    App.input.value = "";
    App.hideEmptyHint();
    App.resetLive();
    App.liveTurn = App.makeEl("turn", "turn");
    App.chatTab.appendChild(App.liveTurn);
    App.liveStep = App.makeEl("step", "step");
    App.liveTurn.appendChild(App.liveStep);
    App.liveResponse = App.makeEl("model-response", "model-response");
    App.liveStep.appendChild(App.liveResponse);
    App.liveAnswer = null; App.liveCards = {};
    App.addAgentRequest(text);
    try {
      var refs = App.pendingRefs.slice();
      await window.AgentClient.call("chat", { messages: [{ role: "user", content: text }], sessionId: App.currentSessionId, autonomy: App.getAutonomyMode(), activity: App.getActivityMode(), references: refs, effort: App.computeEffort(), model: (App.modelSelector && App.modelSelector.value ? App.modelSelector.value : undefined) }, App.onChatEvent);
      App.pendingRefs = []; App.renderRefChips();
    } catch (e) {
      console.error("chat failed:", e);
      (window.AgentMarkdown ? AgentMarkdown.append(App.ensureAnswer(), "[出错] " + (e && e.message ? e.message : e)) : App.appendMessage("assistant", "[出错] " + (e && e.message ? e.message : e)));
      App.flushLiveMarkdown();
      App.resetLive();
    }
  };

  App.initComposer = function initComposer() {
    if (App.sendBtn) App.sendBtn.addEventListener("click", App.onSend);
    if (App.input) App.input.addEventListener("keydown", function (e) {
      App.markUserActivity();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); App.onSend(); }
    });
  };

  // ---------- 表头紧凑模式：ResizeObserver + 内容自然宽度测量（D6） ----------
  App.initHeaderCompact = function initHeaderCompact() {
    App.renderActivityIndicator();
    var p = document.getElementById("presenceSwitch");
    if (p) App.setPresenceMode(p.getAttribute("data-mode") || "in");
    var a = document.getElementById("autonomySwitch");
    if (a) App.setAutonomyMode(a.getAttribute("data-mode") || "supervised");

    var header = document.querySelector(".chat-header");
    if (!header || typeof ResizeObserver === "undefined") return;

    var leftGroup = header.querySelector(".header-left-group");
    var rightGroup = header.querySelector(".header-controls-group");
    var labelEls = ["sessionModeIndicator", "activityIndicator", "presenceSwitch", "autonomySwitch"]
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);

    function measureNaturalWidth() {
      var wasCompact = header.hasAttribute("data-compact");
      if (wasCompact) header.removeAttribute("data-compact");
      labelEls.forEach(function (el) {
        if (el.dataset.labelFull != null) el.textContent = el.dataset.labelFull;
      });
      var cs = getComputedStyle(header);
      var padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      var gap = parseFloat(cs.columnGap || cs.gap) || 0;
      var leftW = leftGroup ? leftGroup.scrollWidth : 0;
      var rightW = rightGroup ? rightGroup.scrollWidth : 0;
      var natural = padX + leftW + gap + rightW;
      labelEls.forEach(function (el) { App.applyLabel(el); });
      if (wasCompact) header.setAttribute("data-compact", "1");
      return natural;
    }

    var HYSTERESIS = 20;
    var scheduled = false;
    function evaluate() {
      scheduled = false;
      var natural = measureNaturalWidth();
      var avail = header.clientWidth;
      if (!natural || !avail) return;
      if (!App.headerCompact) {
        if (avail < natural - HYSTERESIS) App.applyCompact(true);
      } else {
        if (avail >= natural + HYSTERESIS) App.applyCompact(false);
      }
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(evaluate);
    }
    App.scheduleHeaderEval = schedule;

    var ro = new ResizeObserver(schedule);
    ro.observe(header);
    schedule();
  };
})();
