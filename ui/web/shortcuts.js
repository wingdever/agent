"use strict";
// shortcuts：全局键盘快捷键（docs/ui/ui.md「快捷键」）。
//
// 统一在一个 document 级 keydown 里分发，各域不各自监听，避免互相抢按键。
// 规则：
//   - 有弹层（.modal-overlay / 行内菜单）打开时，Esc 只关最上层，不触发其它快捷键；
//   - 焦点在输入控件里时，Esc 仍可关弹层，但 Ctrl+N / Ctrl+K 之外的单键快捷键不生效；
//   - Ctrl/Cmd 组合键在输入框内也生效（和浏览器习惯一致）。
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // 当前最上层的弹层：模态框（后插入的在上）/ 行内菜单 / toast 不参与。
  function topLayer() {
    var overlays = document.querySelectorAll(".modal-overlay");
    if (overlays.length) return overlays[overlays.length - 1];
    var menus = document.querySelectorAll(".row-menu");
    if (menus.length) return menus[menus.length - 1];
    var actions = document.querySelectorAll(".view-actions-menu");
    if (actions.length) return actions[actions.length - 1];
    return null;
  }

  function closeTopLayer(layer) {
    if (!layer) return false;
    if (layer.classList.contains("modal-overlay")) {
      // 走弹层自己的取消路径：有 .modal-cancel 就点它，否则点遮罩空白处
      var cancel = layer.querySelector(".modal-cancel");
      if (cancel) { cancel.click(); return true; }
      layer.click();
      return true;
    }
    // 行内菜单 / 表头菜单：点一下 document 会被它们的 outside-click 逻辑关掉
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }

  function focusSearch() {
    var input = document.querySelector(".search-input");
    var btn = document.querySelector(".search-btn");
    if (!input) return;
    if (input.hidden && btn) btn.click();
    input.focus();
    input.select();
  }

  function newSession() {
    var btn = document.querySelector(".new-session-button");
    if (btn) btn.click();
  }

  function handle(e) {
    var mod = e.ctrlKey || e.metaKey;
    var layer = topLayer();

    // Esc：永远优先关闭最上层弹层
    if (e.key === "Escape") {
      if (layer) {
        e.preventDefault();
        closeTopLayer(layer);
      }
      return;
    }

    if (mod && !e.altKey) {
      var key = (e.key || "").toLowerCase();
      if (key === "n") { e.preventDefault(); if (!layer) newSession(); return; }
      if (key === "k") { e.preventDefault(); if (!layer) focusSearch(); return; }
      return;
    }

    if (layer) return;              // 弹层打开时其余单键快捷键不生效
    if (isEditable(e.target)) return; // 输入框内不抢按键
    if (e.altKey) return;
    if (e.key === "?") { e.preventDefault(); showHelp(); return; }
  }

  // 「?」显示快捷键说明
  function showHelp() {
    if (window.App && window.App.uiAlert) {
      window.App.uiAlert([
        "Ctrl/⌘ + N   新建会话",
        "Ctrl/⌘ + K   聚焦搜索（按会话名 / 工作区名过滤）",
        "Esc          关闭当前弹层 / 菜单",
        "?            显示本说明",
      ].join("\n"));
    }
  }

  function init() {
    document.addEventListener("keydown", handle, true);
  }

  window.App = window.App || {};
  window.App.shortcutsInit = init;
  window.App.showShortcutHelp = showHelp;
  ready(init);
})();
