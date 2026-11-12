"use strict";
// M0 重构：原 app.js 闭包内「活动 / presence / 自主度 / 状态栏指示器 / 会话模式」区块。
// 抽为独立 <script>，向 window.App 挂载。所有原闭包内 var 提升为 App.xxx，
// 跨域调用走 App.fn(...)。DOM 在调用时取（context-panel 的开关由 init 阶段绑定）。
//
// 归属：
//   - 活动指示器：currentActivity / renderActivityIndicator / switchActivity / openActivityMenu
//   - presence 自动机：setPresenceMode / tickPresence / markUserActivity / onPresenceManualChange
//   - 自主度：setAutonomyMode / getAutonomyMode / getPresenceMode
//   - 会话模式只读指示器：renderSessionModeIndicator（依赖 App.getSessionMode / App.isBare）
// 注：renderStatusBar / setLabels / applyCompact 已在 state.js 提供。

(function () {
  var App = (window.App = window.App || {});

  // ---------- 活动 ----------
  App.ACTIVITIES = ["plan-mode", "intent-recog", "goal-mode", "build-code", "discuss-doc", "research", "review-proj", "human-learn", "diagnose"];
  App.currentActivityCompleted = false;
  App.activityIndicatorEl = null;

  App.getActivityMode = function getActivityMode() { return App.currentActivity; };
  App.setActivityMode = function setActivityMode(v, opts) {
    App.currentActivity = v;
    App.selectedInitialActivity = v;
    try { localStorage.setItem("agent.activity", v); } catch (e) {}
    if (opts && opts.silent) return;
    if (App.currentSessionId) {
      window.AgentClient.call("storage", { op: "session.update", payload: { id: App.currentSessionId, activity: v } })
        .catch(function () {});
    }
  };

  // 据当前 activity 同步 core 的 per-session plan-mode（即时，不依赖发消息）。
  App.syncPlanModeFromActivity = async function syncPlanModeFromActivity() {
    if (!App.currentSessionId) return;
    var active = App.getActivityMode() === "plan-mode";
    App.currentPlanMode = active;
    try {
      await window.AgentClient.call("planMode", { op: "set", session_id: App.currentSessionId, active: active });
    } catch (e) { /* 忽略同步失败 */ }
  };

  App.renderActivityIndicator = function renderActivityIndicator() {
    if (!App.activityIndicatorEl) App.activityIndicatorEl = document.getElementById("activityIndicator");
    if (!App.activityIndicatorEl) return;
    var mark = App.currentActivityCompleted ? " ✓" : "";
    App.setLabels(App.activityIndicatorEl, "活动: " + App.currentActivity + mark, App.currentActivity + mark);
    App.activityIndicatorEl.setAttribute("data-activity", App.currentActivity);
    App.renderStatusBar(); // 活动变化同步到状态栏左段
    App.activityIndicatorEl.setAttribute("data-completed", App.currentActivityCompleted ? "1" : "0");
  };

  App.renderSessionModeIndicator = function renderSessionModeIndicator() {
    var el = document.getElementById("sessionModeIndicator");
    if (!el) return;
    var mode = App.getSessionMode();
    App.setLabels(el, App.isBare() ? "模式: bare-chat" : "模式: turn-step", App.isBare() ? "bare" : "step");
    el.setAttribute("data-mode", mode);
    el.setAttribute("title", "bare-chat：不落库、无工具、纯内存历史、每轮仅 1 step；turn-step：选会话、落库、支持工具调用与多 step 循环。");
  };

  App.switchActivity = function switchActivity(target) {
    if (target === App.currentActivity) { App.renderActivityIndicator(); return; }
    var needConfirm = !App.currentActivityCompleted && App.getAutonomyMode() !== "autonomous";
    if (needConfirm) {
      App.uiConfirm("当前活动 " + App.currentActivity + " 尚未完成，切换将中断其进行中的工作；plan-mode 等策略即时失效。确认切换？")
        .then(function (ok) { if (ok) App.commitActivity(target); });
    } else {
      App.commitActivity(target);
    }
  };
  App.commitActivity = function commitActivity(target) {
    App.setActivityMode(target);
    App.currentActivityCompleted = false;
    App.renderActivityIndicator();
    App.syncPlanModeFromActivity();
  };

  App.openActivityMenu = function openActivityMenu(onPick) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("data-name", "activity-menu-overlay");
    var box = document.createElement("div");
    box.className = "modal-box activity-menu";
    box.setAttribute("data-name", "activity-menu");
    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = (onPick ? "选择初始活动" : "切换活动") + "（当前: " + App.currentActivity + (App.currentActivityCompleted ? " ✓已完成" : "") + "）";
    box.appendChild(title);
    App.ACTIVITIES.forEach(function (a) {
      var item = document.createElement("button");
      item.className = "activity-menu-item" + (a === App.currentActivity ? " active" : "");
      item.textContent = a + (a === App.currentActivity ? " （当前）" : "");
      item.addEventListener("click", function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (onPick) onPick(a); else App.switchActivity(a);
      });
      box.appendChild(item);
    });
    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.parentNode.removeChild(overlay); });
    document.body.appendChild(overlay);
  };

  // ---------- presence 自动机 + 自主度 ----------
  App.IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  App.PRESENCE_TICK_MS = 30 * 1000;
  App.lastUserActivity = Date.now();
  App.presenceAuto = true; // 自动跟踪开启；用户手动改 presence 时关闭

  App.getPresenceMode = function getPresenceMode() {
    var btn = document.getElementById("presenceSwitch");
    return (btn && btn.getAttribute("data-mode")) || "in";
  };
  App.getAutonomyMode = function getAutonomyMode() {
    var btn = document.getElementById("autonomySwitch");
    return (btn && btn.getAttribute("data-mode")) || "supervised";
  };
  App.setPresenceMode = function setPresenceMode(v) {
    var btn = document.getElementById("presenceSwitch");
    if (btn) {
      btn.setAttribute("data-mode", v);
      App.setLabels(btn, "在场: " + v, v);
      btn.classList.toggle("active", v === "out");
    }
    if (v === "in") App.lastUserActivity = Date.now();
  };
  App.setAutonomyMode = function setAutonomyMode(v) {
    var btn = document.getElementById("autonomySwitch");
    if (btn) {
      btn.setAttribute("data-mode", v);
      App.setLabels(btn, "自主: " + v, v === "supervised" ? "super" : "auto");
      btn.classList.toggle("active", v === "autonomous");
    }
  };
  // 用户产生活动（插话）：恢复自动跟踪，回到 in，不触碰 autonomy。
  App.markUserActivity = function markUserActivity() {
    App.presenceAuto = true;
    if (App.getPresenceMode() !== "in") App.setPresenceMode("in");
    else App.lastUserActivity = Date.now();
  };
  // 定时检查：自动 in -> out，并提权 autonomy。
  App.tickPresence = function tickPresence() {
    if (!App.presenceAuto) return;
    if (App.getPresenceMode() !== "in") return;
    if (Date.now() - App.lastUserActivity < App.IDLE_TIMEOUT_MS) return;
    App.setPresenceMode("out");
    if (App.getAutonomyMode() === "supervised") App.setAutonomyMode("autonomous");
  };
  // presence selector 手动变更：用户接管；手动 out = 主动离开/挂起（抑制自动机），手动 in = 恢复跟踪。
  App.onPresenceManualChange = function onPresenceManualChange() {
    var v = App.getPresenceMode();
    if (v === "out") {
      App.presenceAuto = false;
    } else {
      App.presenceAuto = true;
      App.lastUserActivity = Date.now();
    }
  };

  // ---------- 绑定（DOMContentLoaded 内调用） ----------
  App.initPresence = function initPresence() {
    var presenceSwitch = document.getElementById("presenceSwitch");
    if (presenceSwitch) presenceSwitch.addEventListener("click", function () {
      App.setPresenceMode(App.getPresenceMode() === "in" ? "out" : "in");
      App.onPresenceManualChange();
    });
    var autonomySwitch = document.getElementById("autonomySwitch");
    if (autonomySwitch) autonomySwitch.addEventListener("click", function () {
      var next = App.getAutonomyMode() === "supervised" ? "autonomous" : "supervised";
      App.setAutonomyMode(next);
      try { localStorage.setItem("agent.autonomy", next); } catch (e) {}
      App.renderStatusBar(); // 自主度变化即时反映到状态栏
    });
    setInterval(App.tickPresence, App.PRESENCE_TICK_MS);

    var activityIndicator = document.getElementById("activityIndicator");
    if (activityIndicator) activityIndicator.addEventListener("click", function () { App.openActivityMenu(); });
  };
})();
