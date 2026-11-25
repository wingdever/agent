"use strict";
// M0 重构：原 app.js 的 DOMContentLoaded 闭包已拆为多个独立 <script>（见 index.html）。
// 本文件仅作「装配器」：在 DOMContentLoaded 内：
//   1. 把 DOM 根引用填入 window.App（各域文件在调用时才取，避免脚本加载期取 DOM）
//   2. 按依赖顺序调用各域文件的 init* 绑定
//   3. 定义跨域胶水函数 selectSession（会话切换：渲染消息 + 同步各指示器）
// 各域函数的实现见 modals.js / sidebar.js / chat-tab.js / trajectory.js /
// translation-ui.js / composer.js / context-panel.js / compaction-ui.js / state.js。

document.addEventListener("DOMContentLoaded", function () {
  var App = (window.App = window.App || {});

  // ---------- 1) 填充 DOM 根引用 ----------
  App.viewport = document.getElementById("viewport");
  App.sidebar = document.getElementById("sidebar");
  App.contextPanel = document.getElementById("contextPanel");
  App.chatTab = document.getElementById("chatTab");
  App.input = document.querySelector(".input-textarea");
  App.sendBtn = document.querySelector(".send-or-stop-btn");
  App.modelHttpStatus = document.querySelector(".model-http-status");
  App.sessionNameLabel = document.querySelector(".session-name");
  App.footerSessionStats = document.querySelector(".session-statistics");
  App.footerTokenUsage = document.querySelector(".token-usage");
  App.footerContextUsed = document.querySelector(".context-used");
  App.trajectoryTab = document.getElementById("trajectoryTab");
  App.chatScroller = App.chatTab ? App.chatTab.closest(".tab-body") : null;
  // 主视图容器与表头中随视图切换的两个槽位（modals.js App.showView）。
  App.mainView = document.getElementById("mainView");
  App.chatView = document.querySelector(".chat-view");
  App.viewTitleLabel = document.querySelector(".chat-header .view-title");
  App.viewDirtyBadge = document.querySelector(".chat-header .view-dirty-badge");
  App.viewHeaderSlot = document.querySelector(".chat-header .view-header-slot");
  App.sessionHeaderControls = document.querySelector(".chat-header .session-header-controls");

  // ---------- 2) 主视图注册（视图名 = index.html 左栏按钮的 data-view） ----------
  // 会话类页（聊天/轨迹）右槽用常驻的会话控制组，其余页的 header 由各域文件自注册时补上。
  App.registerView("chat", { title: "聊天", sessionHeader: true });
  App.registerView("trajectory", { title: "轨迹", sessionHeader: true });
  App.registerView("flow", { title: "流程" });
  App.registerView("models", { title: "模型" });
  App.registerView("tools", { title: "工具" });
  App.registerView("skills", { title: "技能" });
  App.registerView("permissions", { title: "权限" });
  App.registerView("loops", { title: "循环" });
  App.registerView("meta", { title: "本体" });
  App.registerView("settings", { title: "设置" });

  // ---------- 2) 各域 init（DOMContentLoaded 内，DOM 已就绪） ----------
  App.initTabSwitch();      // modals.js：左栏主视图切换 + 折叠按钮
  App.initToolDetail();     // modals.js：tool-call 检视器 DOM 缓存
  App.initArtifactPreview();// modals.js：产物预览 DOM 缓存
  App.initSidebar();        // sidebar.js：工作区/会话树/回收站/搜索 绑定
  App.initTerminalPanel();  // terminal-panel.js：右侧 xterm 终端侧栏
  App.initTrajectory();     // trajectory.js：轨迹面板 DOM 缓存
  App.initGraph();          // graph-ui.js：本体模态框入口（meta-btn）与代码图页
  App.initPresence();       // context-panel.js：presence/autonomy/activity 绑定
  App.initRefs();           // composer.js：@ 引用
  App.initPermissionSelector();
  App.initModelSelector();
  App.initEffortSelector();
  App.initReasoningControl();
  App.initSwitches();
  App.initComposer();       // composer.js：发送按钮 / 输入框

  // ---------- 3) 跨域胶水：选择会话 ----------
  // 原闭包内 selectSession（行 2145）：切换 currentSessionId/currentActivity，
  // 重置轨迹缓存，渲染消息与各指示器，同步 plan-mode，清空状态栏。
  App.selectSession = function selectSession(sess, node) {
    App.currentSessionId = sess.id;
    App.currentActivity = (sess && sess.activity) || "research";
    if (App.terminalPanel) App.terminalPanel.setSession(sess.id);
    if (App.resetTrajectory) App.resetTrajectory(); // 切换会话后轨迹需重新拉取
    if (App.sessionNameLabel) App.sessionNameLabel.textContent = sess.name || ("会话 " + sess.id);
    App.scheduleHeaderEval(); // 会话名变了（D2 可能撑大左组）→ 重新评估紧凑（D6）
    App.showView("chat");     // 点会话即回到聊天页（主视图由左栏切换，选会话是聊天页的动作）
    document.querySelectorAll(".session-item").forEach(function (n) { n.classList.remove("active"); });
    if (node) node.classList.add("active");
    App.renderSessionMessages(sess.id);
    App.currentActivityCompleted = false;
    App.renderActivityIndicator();
    App.renderSessionModeIndicator(); // currentSessionId 刚变化，同步模式指示器
    App.syncPlanModeFromActivity();
    App.resetStatusBar(); // 切换会话清空上一轮 token / 耗时统计
    if (App.input) App.input.focus();
  };

  // ---------- 4) 启动渲染 ----------
  App.loadWorkspaces();              // sidebar.js：拉取工作区/会话树
  App.renderStatusBar();             // state.js：初始空态
  App.renderSessionModeIndicator();  // context-panel.js：启动时按当前模式渲染
  App.initHeaderCompact();           // composer.js：表头紧凑（覆盖 scheduleHeaderEval 真实实现）
});
