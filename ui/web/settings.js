"use strict";
// settings-modal：运行时设置弹窗（流式开关 + provider + 模型）。
// 持久化到 user/settings.json：通过后端 settings op 读写，前端不依赖 localStorage。
// 依赖 window.AgentClient（api.js）与 window.uiConfirm/uiAlert（app.js）。
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

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

  var overlay = null, streamSwitchEl = null, translateSwitchEl = null, autoCompactSwitchEl = null, providerSelEl = null, modelSelEl = null, reasoningControlSel = null;
  var state = { stream: false, provider: "", model: "", translate: { enabled: true }, reasoningControl: "think-switch", autoCompact: true };
  var providers = [];

  function getSettings() { return state; }
  window.getSettings = getSettings;

  function normalizeTranslate() {
    if (!state.translate || typeof state.translate !== "object") state.translate = { enabled: true };
    state.translate.enabled = state.translate.enabled !== false;
  }

  async function loadSettings() {
    try {
      var st = await window.AgentClient.call("settings", { op: "get" });
      state = Object.assign({ stream: false, provider: "", model: "", translate: { enabled: true }, reasoningControl: "think-switch", autoCompact: true }, st || {});
    } catch (e) { /* 后端未就绪时用默认 */ }
    normalizeTranslate();
  }

  async function loadProviders() {
    try { providers = await window.AgentClient.call("settings", { op: "providers" }); }
    catch (e) { providers = []; }
    if (!Array.isArray(providers)) providers = [];
  }

  function save() {
    window.AgentClient.call("settings", { op: "set", payload: state }).catch(function () {});
  }

  function renderStreamSwitch() {
    var on = !!state.stream;
    streamSwitchEl.textContent = on ? "流式输出：开" : "流式输出：关";
    streamSwitchEl.classList.toggle("active", on);
  }

  function renderTranslateSwitch() {
    var on = !!(state.translate && state.translate.enabled !== false);
    translateSwitchEl.textContent = on ? "自动翻译：开" : "自动翻译：关";
    translateSwitchEl.classList.toggle("active", on);
  }

  // 自动压缩开关（settings.autoCompact，默认开）。关掉后只剩手动 /compact。
  function renderAutoCompactSwitch() {
    var on = state.autoCompact !== false;
    autoCompactSwitchEl.textContent = on ? "自动压缩：开" : "自动压缩：关";
    autoCompactSwitchEl.classList.toggle("active", on);
  }

  function populateProviders() {
    providerSelEl.innerHTML = "";
    providers.forEach(function (p) {
      providerSelEl.appendChild(el("option", { value: p.name }, p.name));
    });
    if (state.provider && providers.some(function (p) { return p.name === state.provider; })) {
      providerSelEl.value = state.provider;
    } else if (providers.length) {
      state.provider = providers[0].name;
      providerSelEl.value = state.provider;
    }
  }

  function allModelsGrouped() {
    var groups = [];
    providers.forEach(function (p) {
      // 仅纳入启用（enabled===true）的模型
      var ms = (p.models || []).filter(function (m) { return m && m.enabled === true; }).map(function (m) { return m.name || m; });
      if (ms.length) groups.push({ provider: p.name, models: ms });
    });
    return groups;
  }

  // 按 provider 用 optgroup 分组渲染全部模型（跨 provider 可选），并记录每个模型归属的 provider
  function populateModels() {
    modelSelEl.innerHTML = "";
    var groups = allModelsGrouped();
    groups.forEach(function (g) {
      var grp = el("optgroup", { label: g.provider });
      g.models.forEach(function (m) {
        var o = el("option", { value: m }, m);
        o.setAttribute("data-provider", g.provider);
        grp.appendChild(o);
      });
      modelSelEl.appendChild(grp);
    });
    if (state.model) {
      var hit = null;
      groups.forEach(function (g) { if (g.models.indexOf(state.model) !== -1) hit = g.provider; });
      if (hit) {
        modelSelEl.value = state.model;
        // 当前模型归属的 provider 与设置里的 provider 不一致时，按模型对齐
        if (state.provider !== hit) { state.provider = hit; if (providerSelEl) providerSelEl.value = hit; }
        return;
      }
    }
    // 无有效模型时，回退到当前 provider 的首个模型
    if (groups.length) {
      var first = groups[0];
      state.provider = first.provider;
      state.model = first.models[0];
      if (providerSelEl) providerSelEl.value = first.provider;
      modelSelEl.value = first.models[0];
    }
  }

  function buildShell() {
    streamSwitchEl = el("button", {
      className: "stream-switch", dataset: { name: "stream-switch" },
      onclick: function () { state.stream = !state.stream; renderStreamSwitch(); save(); },
    });
    renderStreamSwitch();

    translateSwitchEl = el("button", {
      className: "stream-switch", dataset: { name: "translate-switch" },
      onclick: function () {
        state.translate.enabled = !(state.translate.enabled !== false);
        renderTranslateSwitch();
        save();
      },
    });
    renderTranslateSwitch();

    autoCompactSwitchEl = el("button", {
      className: "stream-switch", dataset: { name: "auto-compact-switch" },
      onclick: function () {
        state.autoCompact = state.autoCompact === false;
        renderAutoCompactSwitch();
        save();
      },
    });
    renderAutoCompactSwitch();

    providerSelEl = el("select", { className: "settings-provider-select", dataset: { name: "provider-selector" } });
    providerSelEl.addEventListener("change", function () {
      state.provider = providerSelEl.value;
      // 跟随 provider 切换到该 provider 的首个模型
      var g = allModelsGrouped().filter(function (x) { return x.provider === state.provider; })[0];
      state.model = g && g.models.length ? g.models[0] : "";
      populateModels();
      if (state.model) modelSelEl.value = state.model;
      save();
    });

    modelSelEl = el("select", { className: "settings-model-select", dataset: { name: "model-selector" } });
    modelSelEl.addEventListener("change", function () {
      state.model = modelSelEl.value;
      // 选取不同 provider 下的模型后，同步切换 provider（凭据由 provider 决定）
      var opt = modelSelEl.querySelector('option[value="' + (state.model || "").replace(/"/g, '\\"') + '"]');
      var prov = opt ? opt.getAttribute("data-provider") : null;
      if (prov && prov !== state.provider) {
        state.provider = prov;
        if (providerSelEl) providerSelEl.value = prov;
      }
      save();
    });

    // 推理参数控件：决定 composer 中渲染 think-switch 还是 effort-selector（二者语义冲突，只能二选一）。
    reasoningControlSel = el("select", {
      className: "settings-reasoning-control-select", dataset: { name: "reasoning-control-selector" },
    }, [
      el("option", { value: "effort-selector" }, "推理等级 (effort-selector)"),
      el("option", { value: "think-switch" }, "思考开关 (think-switch)"),
    ]);
    reasoningControlSel.addEventListener("change", function () {
      state.reasoningControl = reasoningControlSel.value;
      save();
      // 通知 composer 重新按设置渲染推理控件
      window.dispatchEvent(new CustomEvent("reasoning-control-changed", { detail: state.reasoningControl }));
    });

    var card = el("div", { className: "settings-card" }, [
      el("h3", null, "设置"),
      el("div", { className: "settings-row" }, [el("span", null, "流式输出"), streamSwitchEl]),
      el("div", { className: "settings-row" }, [el("span", null, "自动翻译"), translateSwitchEl]),
      el("div", { className: "settings-note" },
        "开启后：中文输入先翻译成英文再发给模型，英文回答再翻译成中文显示；" +
        "对话正文会发送至 index-translate.bilibili.com。翻译不落库，重新打开会话后只保留英文。"),
      el("div", { className: "settings-row" }, [el("span", null, "自动压缩"), autoCompactSwitchEl]),
      el("div", { className: "settings-note" },
        "开启后：每次模型请求前按上下文窗口（80%）检查压力，先裁剪超长工具结果，仍超限则把较老历史压成一份 checkpoint；" +
        "原始消息保留在存储里，聊天区仍展示全部历史。关闭后只剩手动 /compact。"),
      el("div", { className: "settings-row" }, [el("span", null, "Provider"), providerSelEl]),
      el("div", { className: "settings-row" }, [el("span", null, "模型"), modelSelEl]),
      el("div", { className: "settings-row" }, [el("span", null, "推理参数控件"), reasoningControlSel]),
      el("div", { className: "settings-note" },
        "思考开关与推理等级都向模型注入推理参数，二者冲突，只能显示一个。" +
        "选择“推理等级”则在 composer 显示分级下拉（none/low/high…）；选择“思考开关”则显示开/关按钮。"),
      el("div", { className: "settings-actions" }, [
        el("button", { className: "close-settings-btn", dataset: { name: "close-settings-btn" }, onclick: closeSettings }, "关闭"),
      ]),
    ]);

    overlay = el("div", { className: "settings-modal", dataset: { name: "settings-modal" } }, [card]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeSettings(); });
    document.body.appendChild(overlay);
    // 模型配置（增删 provider / model）变更后，重新同步下拉列表
    window.addEventListener("providers-changed", function () {
      if (overlay && overlay.style.display === "flex") {
        loadProviders().then(function () { populateProviders(); populateModels(); });
      }
    });
  }

  async function openSettings() {
    if (!overlay) buildShell();
    overlay.style.display = "flex";
    await loadSettings();
    await loadProviders();
    populateProviders();
    populateModels();
    renderStreamSwitch();
    renderTranslateSwitch();
    renderAutoCompactSwitch();
    if (reasoningControlSel) {
      reasoningControlSel.value = state.reasoningControl || "think-switch";
    }
  }
  function closeSettings() { if (overlay) overlay.style.display = "none"; }

  function modeSelect(dataName) {
    var wrap = document.querySelector("." + dataName);
    return wrap ? wrap.querySelector("select") : null;
  }
  function initModeSelect(dataName, storageKey, fallback) {
    var sel = modeSelect(dataName);
    if (!sel) return;
    var saved = localStorage.getItem(storageKey);
    sel.value = saved || fallback;
    sel.addEventListener("change", function () { localStorage.setItem(storageKey, sel.value); });
  }
  // 按钮开关：恢复持久化值并渲染（data-mode + 文字 + active 高亮）
  function initModeSwitch(btnId, storageKey, fallback, label) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    var v = localStorage.getItem(storageKey) || fallback;
    btn.setAttribute("data-mode", v);
    btn.textContent = label + ": " + v;
    btn.classList.toggle("active", v === "out" || v === "autonomous");
  }
  function initComposerMode() {
    // autonomy：supervised/autonomous，用户显式提权/降权，跨会话保留
    initModeSwitch("autonomySwitch", "agent.autonomy", "supervised", "自主");
    // presence：运行时自动态（idle 检测/插话），默认 in，不持久化
    var pBtn = document.getElementById("presenceSwitch");
    if (pBtn) { pBtn.setAttribute("data-mode", "in"); pBtn.textContent = "在场: in"; pBtn.classList.remove("active"); }
  }

  ready(function () {
    initComposerMode();
    loadSettings().catch(function () {});
    var btn = document.getElementById("settingsBtn");
    if (btn) btn.addEventListener("click", openSettings);
  });
})();
