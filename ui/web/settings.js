"use strict";
// settings-modal：运行时设置弹窗（流式开关 + 模型选择）。
// 依赖 window.AgentClient（api.js）与 window.uiConfirm/uiAlert（app.js）。
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // 极简 DOM 构造器
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

  function api(op, payload) {
    return window.AgentClient.call("storage", { op: op, payload: payload || {} });
  }

  var overlay = null, streamSwitchEl = null, modelSelEl = null, saveBtn = null;
  var LS_STREAM = "agent.stream";
  var LS_MODEL = "agent.model";
  var LS_MODE = "agent.mode";

  function getStream() { return localStorage.getItem(LS_STREAM) !== "false"; }
  function setStream(on) { localStorage.setItem(LS_STREAM, on ? "true" : "false"); }
  function getModel() { return localStorage.getItem(LS_MODEL) || ""; }
  function setModel(v) { if (v) localStorage.setItem(LS_MODEL, v); }
  function getMode() { return localStorage.getItem(LS_MODE) || "turn-step"; }
  function setMode(v) { if (v) localStorage.setItem(LS_MODE, v); }

  function renderStreamSwitch() {
    var on = getStream();
    streamSwitchEl.textContent = on ? "流式输出：开" : "流式输出：关";
    streamSwitchEl.classList.toggle("active", on);
  }

  function composerModeSelect() {
    var wrap = document.querySelector(".mode-selector");
    return wrap ? wrap.querySelector("select") : null;
  }

  // 用存储中的模型列表填充选择器；失败时回退到 composer 的静态选项
  async function populateModels() {
    modelSelEl.innerHTML = "";
    try {
      var ps = await api("provider.list", {});
      var ms = await api("model.list", {});
      (ms || []).forEach(function (m) {
        var p = (ps || []).filter(function (x) { return String(x.id) === String(m.provider_id); })[0];
        var label = (p ? p.name : "?") + "/" + (m.name || ("模型 " + m.id));
        modelSelEl.appendChild(el("option", { value: String(m.id) }, label));
      });
    } catch (e) { /* 后端未就绪时留空，模型选择在 settings-modal 内完成 */ }
    var saved = getModel();
    if (saved) modelSelEl.value = saved;
  }

  function buildShell() {
    streamSwitchEl = el("button", {
      className: "stream-switch", dataset: { name: "stream-switch" },
      onclick: function () { setStream(!getStream()); renderStreamSwitch(); },
    });
    renderStreamSwitch();

    modelSelEl = el("select", { className: "settings-model-select", dataset: { name: "model-selector" } });
    modelSelEl.addEventListener("change", function () { setModel(modelSelEl.value); });

    var card = el("div", { className: "settings-card" }, [
      el("h3", null, "设置"),
      el("div", { className: "settings-row" }, [el("span", null, "流式输出"), streamSwitchEl]),
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
    renderStreamSwitch();
    await populateModels();
  }
  function closeSettings() { if (overlay) overlay.style.display = "none"; }

  function initComposerMode() {
    var sel = composerModeSelect();
    if (!sel) return;
    sel.value = getMode();
    sel.addEventListener("change", function () { setMode(sel.value); });
  }

  ready(function () {
    initComposerMode();
    var btn = document.getElementById("settingsBtn");
    if (btn) btn.addEventListener("click", openSettings);
  });
})();
