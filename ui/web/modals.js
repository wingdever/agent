"use strict";
// M0 重构：原 app.js 闭包内「标签切换 / 折叠按钮 / 工具检视 / 产物预览」区块。
// 按「主闭包 + 域函数（最稳）」方案抽为独立 <script>，向 window.App 挂载。
//
// 原闭包在 DOMContentLoaded 顶部直接 var x = document.getElementById(...) 缓存 DOM，
// 这些脚本在 DOMContentLoaded 之前以 <script> 加载，故改为：
//   - initTabSwitch / initCollapseButtons 在 app.js 装配器于 DOMContentLoaded 内调用，
//     负责一次性绑定事件（此时 DOM 已就绪）
//   - syncCollapseButtons / showToolDetail / renderArtifactBody / previewArtifact
//     在调用时才取 DOM（用 App.viewport/sidebar/contextPanel 等已填好的根，或重新 query）
//
// 约定：原闭包 `var x` -> App.xxx；跨域调用走 App.fn(...)；纯逻辑不变。

(function () {
  var App = (window.App = window.App || {});

  // 折叠按钮引用在 init 阶段缓存（DOMContentLoaded 内调用一次）。
  var leftCollapseBtn = null;
  var rightCollapseBtn = null;
  var ctxDefault = null;
  var ctxDetail = null;
  var ctxTitle = null;
  var ctxArgs = null;
  var ctxResult = null;
  var ctxRefs = null;
  var artifactPreview = null;
  var artifactPreviewTitle = null;
  var artifactPreviewBody = null;
  var artifactPreviewOpen = null;
  var IMG_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, svg: 1, bmp: 1 };

  // 1) + 2) + 3) 主视图切换、左栏折叠、右栏折叠：一次性绑定（DOMContentLoaded 内调用）。
  // 左栏是唯一导航：点左栏任一入口 -> App.showView(name)，右侧「顶栏内容 + 内容区」整体切页。
  App.initTabSwitch = function initTabSwitch() {
    Array.prototype.forEach.call(document.querySelectorAll(".thread-sidebar [data-view]"), function (b) {
      b.addEventListener("click", function () { App.showView(b.getAttribute("data-view")); });
    });

    leftCollapseBtn = document.getElementById("leftCollapse");
    rightCollapseBtn = document.getElementById("rightCollapse");
    if (leftCollapseBtn) leftCollapseBtn.addEventListener("click", function () {
      App.sidebar.classList.toggle("collapsed");
      App.syncCollapseButtons();
    });
    if (rightCollapseBtn) rightCollapseBtn.addEventListener("click", function () {
      if (App.contextPanel.hasAttribute("hidden")) App.contextPanel.removeAttribute("hidden");
      else App.contextPanel.setAttribute("hidden", "");
      App.syncCollapseButtons();
    });
    App.showView("chat");
  };

  // 主视图注册表。视图名与 index.html 左栏按钮的 data-view 对应：
  //   title  写进表头左槽的页面标题
  //   mount  第一次进入该页时建页（参数是 main-view 容器）
  //   header 该页的右槽内容：DOM 节点或返回节点的函数（懒建，每页只建一次）
  //   sessionHeader 为 true 时右槽用表头里常驻的会话控制组（模式/活动/在场/自主）
  var views = Object.create(null);

  // 注册一个主视图。name 与 index.html 左栏按钮的 data-view 一致。
  App.registerView = function registerView(name, spec) {
    spec = spec || {};
    // 聊天页的 DOM 写在 index.html 里，不需要 mount；其余页首次进入时再建。
    views[name] = {
      name: name,
      title: spec.title || "",
      mount: spec.mount || null,
      header: spec.header || null,
      sessionHeader: !!spec.sessionHeader,
      headerNode: null,
    };
    // 会话控制组是常驻节点，切页时会真正移出右槽；回聊天页时需要能重新取回。
    if (spec.sessionHeader && !App.sessionHeaderControls) {
      App.sessionHeaderControls = document.querySelector(".chat-header .session-header-controls");
    }
  };

  // 把右槽换成该页自己的内容：会话控制组 或 该页声明的 header 节点。
  function applyHeaderSlot(view) {
    var slot = App.viewHeaderSlot;
    if (!slot) return;
    if (view.sessionHeader) {
      slot.innerHTML = "";
      if (App.sessionHeaderControls) slot.appendChild(App.sessionHeaderControls);
      App.sessionHeaderControls.hidden = false;
      return;
    }
    // header 可能是工厂函数：每次切页都求值一次，页面内部的节点（搜索框等）
    // 在页面建好前还是 null，不能缓存第一次的结果。
    var node = null;
    if (view.header) node = typeof view.header === "function" ? view.header(App) : view.header;
    if (node === null || node === undefined) node = view.headerNode;
    else view.headerNode = node;
    slot.innerHTML = "";
    if (node) slot.appendChild(node);
  }

  // 进入主视图：左栏高亮、表头换成该页的标题/控制组、内容区只显示该页。
  App.showView = function showView(name) {
    var view = views[name];
    if (!view || !App.mainView) return;
    // 离开有未保存改动的页面时问一次（确认后放弃改动）。
    var leaving = views[App.currentView];
    if (leaving && leaving.name !== name && leaving.dirty) {
      var tip = "「" + (leaving.title || leaving.name) + "」有未保存的改动。\n点「确定」离开并放弃改动，点「取消」留在当前页继续编辑。";
      if (typeof App.uiConfirm === "function") {
        // showView 是同步入口：先挂起确认，选「确定」后再继续切页（同一时刻只弹一个）。
        if (!leaving.confirming) {
          leaving.confirming = true;
          App.uiConfirm(tip).then(function (ok) {
            leaving.confirming = false;
            if (!ok) return;
            leaving.dirty = false; // 用户确认放弃
            if (App.viewDirtyBadge) App.viewDirtyBadge.hidden = true;
            showViewNow(name);
          });
        }
        return;
      }
      if (!window.confirm(tip)) return;
    }
    showViewNow(name);
  };

  function showViewNow(name) {
    var view = views[name];
    if (!view || !App.mainView) return;
    App.currentView = name;
    App.currentView = name;
    App.mainView.setAttribute("data-view", name);
    App.viewport.setAttribute("data-view", name);

    Array.prototype.forEach.call(document.querySelectorAll(".thread-sidebar [data-view]"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === name);
    });

    // 表头：结构不变。左槽 = 折叠钮 + 页面标题（聊天/轨迹页显示会话名），
    // 右槽 = 该页自己声明的内容（见 applyHeaderSlot）。
    if (App.sessionNameLabel) App.sessionNameLabel.hidden = !view.sessionHeader;
    if (App.viewTitleLabel) {
      App.viewTitleLabel.hidden = view.sessionHeader;
      App.viewTitleLabel.textContent = view.title;
    }
    applyHeaderSlot(view);
    if (App.viewDirtyBadge) App.viewDirtyBadge.hidden = !view.dirty;

    if (App.chatView) App.chatView.hidden = !(name === "chat" || name === "trajectory");

    // 右栏（上下文面板）只在支持会话详情的页出现（聊天 / 轨迹）。
    if (!view.sessionHeader) {
      App.contextPanel.setAttribute("hidden", "");
    }
    App.syncCollapseButtons();

    // 懒挂载：第一次进入该页时才建 DOM。mount 可能先异步拉数据再建页，
    // 因此只有挂载成功（页节点已进 main-view）才清空 mount，否则下次进入重试。
    if (view.mount) {
      var before = App.mainView.children.length;
      view.mount(App.mainView);
      if (App.mainView.children.length > before) view.mount = null;
    }
    // 页面刚建出来时也要按最新视图同步一次显隐（mount 里新建的节点默认 hidden 或未设）。
    App.syncViewVisibility();
    if (App.terminalPanel && App.terminalPanel.onViewChange) App.terminalPanel.onViewChange(name);
    App.scheduleHeaderEval(); // 表头内容随视图变化，重新评估紧凑态
    if (name === "trajectory" && App.loadTrajectory) App.loadTrajectory(App.currentSessionId);
    if (App.refreshViewLayout) App.refreshViewLayout(name);
  };

  // 内容区里的一页：把面板根节点挂进 main-view 并打上 data-view（showView 按它显隐）。
  // 面板自己的 open/close 用内联 display 控制可见性，这里只负责把节点安放到位。
  App.mountViewPage = function mountViewPage(node, name) {
    node.setAttribute("data-view", name);
    node.hidden = true;
    App.mainView.appendChild(node);
    return node;
  };

  // 页面的可见性只用一个信号：hidden 属性（各页不再用内联 display 控制显隐，
  // 面板的 open/close 改为切换 hidden）。非当前页一律 hidden。
  App.syncViewVisibility = function syncViewVisibility() {
    Array.prototype.forEach.call(App.mainView.children, function (node) {
      node.hidden = node.getAttribute("data-view") !== App.currentView;
    });
  };

  // 页面工具条：各主视图页的页内操作入口（导入/导出/清空/恢复默认…）。
  // 返回一个 <div class="view-actions">，内含按钮与「更多」下拉；页内自己决定放哪。
  // items: [{ label, className?, danger?, onClick }]
  App.buildViewActions = function buildViewActions(items) {
    var wrap = document.createElement("div");
    wrap.className = "view-actions";
    wrap.setAttribute("data-name", "view-actions");
    var menu = null;
    function closeMenu() {
      if (!menu) return;
      menu.remove();
      menu = null;
      document.removeEventListener("click", onDocClick, true);
    }
    function onDocClick(ev) {
      if (menu && !menu.contains(ev.target) && !toggle.contains(ev.target)) closeMenu();
    }
    var toggle = document.createElement("button");
    toggle.className = "view-actions-toggle";
    toggle.setAttribute("data-name", "view-actions-toggle");
    toggle.textContent = "更多 ▾";
    toggle.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (menu) { closeMenu(); return; }
      menu = document.createElement("div");
      menu.className = "view-actions-menu";
      menu.setAttribute("data-name", "view-actions-menu");
      items.forEach(function (item) {
        var b = document.createElement("button");
        b.className = "view-actions-item" + (item.danger ? " danger" : "") + (item.className ? " " + item.className : "");
        b.textContent = item.label;
        if (item.ref && item.ref.getAttribute("data-name")) {
          b.setAttribute("data-name", item.ref.getAttribute("data-name"));
        }
        b.addEventListener("click", function () { closeMenu(); item.onClick(); });
        // 菜单每次打开都重建，把菜单项的文本节点暴露给调用方（如架构规则状态）。
        if (item.ref) item.onRendered && item.onRendered(b);
        menu.appendChild(b);
      });
      wrap.appendChild(menu);
      document.addEventListener("click", onDocClick, true);
    });
    wrap.appendChild(toggle);
    return wrap;
  };

  // 表单级脏检查：记录容器内全部表单控件的初始值，每次输入/变更后与初始值比较。
  // opts: { view: 视图名, container: 根节点, onChange?(dirty) }
  // 返回 { refresh(): 把当前值记为新的基线, isDirty(): 布尔 }
  App.watchFormDirty = function watchFormDirty(opts) {
    var container = opts.container;
    var viewName = opts.view;
    var baseline = null;
    function snapshot() {
      var out = [];
      Array.prototype.forEach.call(container.querySelectorAll("input, textarea, select"), function (c) {
        if (c.type === "button" || c.type === "submit") return;
        out.push(c.type === "checkbox" || c.type === "radio" ? (c.checked ? "1" : "0") : String(c.value));
      });
      return out;
    }
    function compute() {
      if (!baseline) baseline = snapshot();
      var now = snapshot();
      var dirty = now.length !== baseline.length || now.some(function (v, i) { return v !== baseline[i]; });
      if (window.App && window.App.setViewDirty) window.App.setViewDirty(viewName, dirty);
      if (opts.onChange) opts.onChange(dirty);
      return dirty;
    }
    container.addEventListener("input", compute, true);
    container.addEventListener("change", compute, true);
    // 结构变化（增删一行规则等）不触发 input 事件，交给调用方显式 reprobe
    compute();
    return {
      refresh: function () { baseline = snapshot(); compute(); },
      isDirty: function () { return compute(); },
      reprobe: compute,
    };
  };

  // 页级「未保存」标记：由当前页在改动 / 保存 / 重新载入时调用。
  // 记录在每个视图上，切回该页时恢复显示；切换页面前若有未保存改动，问一次再离开。
  App.setViewDirty = function setViewDirty(name, dirty) {
    var view = views[name];
    if (!view) return;
    view.dirty = !!dirty;
    if (name !== App.currentView) return;
    if (App.viewDirtyBadge) App.viewDirtyBadge.hidden = !view.dirty;
  };

  App.isViewDirty = function isViewDirty(name) {
    var view = views[name || App.currentView];
    return !!(view && view.dirty);
  };

  // 折叠按钮的箭头/标题/语义属性由真实状态派生（D4）。
  App.syncCollapseButtons = function syncCollapseButtons() {
    var leftCollapsed = App.sidebar.classList.contains("collapsed");
    var rightCollapsed = App.contextPanel.hasAttribute("hidden");
    document.body.setAttribute("data-sidebar-collapsed", leftCollapsed ? "1" : "0");
    if (leftCollapseBtn) {
      leftCollapseBtn.textContent = leftCollapsed ? "»" : "«";
      leftCollapseBtn.setAttribute("title", leftCollapsed ? "展开" : "折叠");
      leftCollapseBtn.setAttribute("data-collapsed", leftCollapsed ? "1" : "0");
      leftCollapseBtn.setAttribute("aria-expanded", leftCollapsed ? "false" : "true");
    }
    if (rightCollapseBtn) {
      rightCollapseBtn.textContent = rightCollapsed ? "«" : "»";
      rightCollapseBtn.setAttribute("title", rightCollapsed ? "展开右栏" : "折叠右栏");
      rightCollapseBtn.setAttribute("data-collapsed", rightCollapsed ? "1" : "0");
      rightCollapseBtn.setAttribute("aria-expanded", rightCollapsed ? "false" : "true");
    }
  };

  // 4) 点击 tool-call -> 填充并显示 context-panel
  App.initToolDetail = function initToolDetail() {
    ctxDefault = document.querySelector(".context-default");
    ctxDetail = document.getElementById("contextDetail");
    ctxTitle = document.getElementById("ctxTitle");
    ctxArgs = document.getElementById("ctxArgs");
    ctxResult = document.getElementById("ctxResult");
    ctxRefs = document.getElementById("ctxRefs");
  };

  App.showToolDetail = function showToolDetail(card) {
    var tool = card.getAttribute("data-tool");
    var op = card.getAttribute("data-op");
    var args = card.getAttribute("data-args");
    var result = card.getAttribute("data-result");
    ctxTitle.textContent = tool + " / " + op;
    try { ctxArgs.textContent = JSON.stringify(JSON.parse(args), null, 2); } catch (e) { ctxArgs.textContent = args || ""; }
    try { ctxResult.textContent = JSON.stringify(JSON.parse(result), null, 2); } catch (e) { ctxResult.textContent = result || ""; }
    var ref = tool;
    try { var a = JSON.parse(args); if (a && a.path) ref = a.path; } catch (e) {}
    ctxRefs.textContent = "（静态示例）引用自 " + ref;
    if (ctxDefault) ctxDefault.hidden = true;
    ctxDetail.hidden = false;
    App.contextPanel.removeAttribute("hidden");
    App.syncCollapseButtons(); // 右栏被工具检视器重开，同步折叠按钮状态（D4）
  };

  // 产物预览：读取写文件类工具生成的文件，按扩展名渲染到右侧面板（与现有检视器合一）。
  App.initArtifactPreview = function initArtifactPreview() {
    artifactPreview = document.getElementById("artifactPreview");
    artifactPreviewTitle = document.getElementById("artifactPreviewTitle");
    artifactPreviewBody = document.getElementById("artifactPreviewBody");
    artifactPreviewOpen = document.getElementById("artifactPreviewOpen");
  };

  App.renderArtifactBody = function renderArtifactBody(filePath, text) {
    if (!artifactPreviewBody) return;
    artifactPreviewBody.innerHTML = "";
    var lower = filePath.toLowerCase();
    var ext = (lower.split(".").pop() || "").split("?")[0];
    if (IMG_EXT[ext]) {
      var img = document.createElement("img");
      img.className = "artifact-img";
      img.src = "file://" + filePath; // 本地文件直接预览
      img.alt = filePath;
      artifactPreviewBody.appendChild(img);
      return;
    }
    if (ext === "md" || ext === "markdown") {
      try {
        var html = (window.marked ? window.marked.parse(text) : text);
        artifactPreviewBody.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
      } catch (e) { artifactPreviewBody.textContent = text; }
      return;
    }
    if (ext === "html" || ext === "htm") {
      try {
        artifactPreviewBody.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(text) : text;
      } catch (e) { artifactPreviewBody.textContent = text; }
      return;
    }
    // 其余：纯文本 / 代码（前置 4 空格缩进 + 等宽）
    var pre = document.createElement("pre");
    pre.className = "artifact-code";
    pre.textContent = text;
    artifactPreviewBody.appendChild(pre);
  };

  App.previewArtifact = async function previewArtifact(filePath) {
    if (!artifactPreview || !App.contextPanel) return;
    artifactPreview.hidden = false;
    if (ctxDetail) ctxDetail.hidden = true;
    if (ctxDefault) ctxDefault.hidden = true;
    App.contextPanel.removeAttribute("hidden");
    App.syncCollapseButtons(); // 右栏被产物预览重开，同步折叠按钮状态（D4）
    artifactPreviewTitle.textContent = "预览: " + filePath;
    artifactPreviewBody.innerHTML = "<div class='artifact-loading'>读取中…</div>";
    artifactPreviewOpen.hidden = true;
    try {
      var res = await window.AgentClient.call("fs.read", { path: filePath });
      if (res && res.isDirectory) { artifactPreviewBody.innerHTML = "<div class='artifact-loading'>目录，无法预览</div>"; return; }
      var text = (res && res.content) || "";
      if (res && res.truncated) {
        var note = document.createElement("div");
        note.className = "artifact-note";
        note.textContent = "（文件过大，已截断预览）";
        artifactPreviewBody.appendChild(note);
      }
      App.renderArtifactBody(filePath, text);
      if (artifactPreviewOpen) {
        artifactPreviewOpen.hidden = false;
        artifactPreviewOpen.onclick = function () { window.open("file://" + filePath, "_blank"); };
      }
    } catch (e) {
      artifactPreviewBody.innerHTML = "<div class='artifact-error'>读取失败: " + (e && e.message ? e.message : e) + "</div>";
    }
  };
})();
