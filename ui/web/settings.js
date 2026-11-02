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

  var overlay = null, streamSwitchEl = null, translateSwitchEl = null, providerSelEl = null, modelSelEl = null;
  var state = { stream: false, provider: "", model: "", translate: { enabled: true } };
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
      state = Object.assign({ stream: false, provider: "", model: "", translate: { enabled: true } }, st || {});
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

  function modelsOf(providerName) {
    var p = providers.filter(function (x) { return x.name === providerName; })[0];
    var ms = p && p.models ? p.models : [];
    return ms.map(function (m) { return m.name || m; });
  }

  function populateModels() {
    modelSelEl.innerHTML = "";
    var ms = modelsOf(state.provider);
    ms.forEach(function (m) { modelSelEl.appendChild(el("option", { value: m }, m)); });
    if (state.model && ms.indexOf(state.model) !== -1) {
      modelSelEl.value = state.model;
    } else if (ms.length) {
      state.model = ms[0];
      modelSelEl.value = state.model;
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

    providerSelEl = el("select", { className: "settings-provider-select", dataset: { name: "provider-selector" } });
    providerSelEl.addEventListener("change", function () {
      state.provider = providerSelEl.value;
      state.model = "";
      populateModels();
      save();
    });

    modelSelEl = el("select", { className: "settings-model-select", dataset: { name: "model-selector" } });
    modelSelEl.addEventListener("change", function () { state.model = modelSelEl.value; save(); });

    var card = el("div", { className: "settings-card" }, [
      el("h3", null, "设置"),
      el("div", { className: "settings-row" }, [el("span", null, "流式输出"), streamSwitchEl]),
      el("div", { className: "settings-row" }, [el("span", null, "自动翻译"), translateSwitchEl]),
      el("div", { className: "settings-note" },
        "开启后：中文输入先翻译成英文再发给模型，英文回答再翻译成中文显示；" +
        "对话正文会发送至 index-translate.bilibili.com。翻译不落库，重新打开会话后只保留英文。"),
      el("div", { className: "settings-row" }, [el("span", null, "Provider"), providerSelEl]),
      el("div", { className: "settings-row" }, [el("span", null, "模型"), modelSelEl]),
      el("div", { className: "settings-actions" }, [
        el("button", { className: "close-settings-btn", dataset: { name: "close-settings-btn" }, onclick: closeSettings }, "关闭"),
      ]),
    ]);

    overlay = el("div", { className: "settings-modal", dataset: { name: "settings-modal" } }, [card]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeSettings(); });
    document.body.appendChild(overlay);
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
  }
  function closeSettings() { if (overlay) overlay.style.display = "none"; }

  function composerModeSelect() {
    var wrap = document.querySelector(".mode-selector");
    return wrap ? wrap.querySelector("select") : null;
  }
  function getMode() { return localStorage.getItem("agent.mode") || "turn-step"; }
  function setMode(v) { if (v) localStorage.setItem("agent.mode", v); }
  function initComposerMode() {
    var sel = composerModeSelect();
    if (!sel) return;
    sel.value = getMode();
    sel.addEventListener("change", function () { setMode(sel.value); });
  }

  ready(function () {
    initComposerMode();
    loadSettings().catch(function () {});
    var btn = document.getElementById("settingsBtn");
    if (btn) btn.addEventListener("click", openSettings);
  });
})();
