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

  // 1) + 2) + 3) 标签切换、左栏折叠、右栏折叠：一次性绑定（DOMContentLoaded 内调用）。
  App.initTabSwitch = function initTabSwitch() {
    var tabBtns = document.querySelectorAll(".tab-icons [data-target]");
    Array.prototype.forEach.call(tabBtns, function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(tabBtns, function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        if (b.getAttribute("data-target") === "trajectory-tab") {
          App.viewport.classList.add("show-trajectory");
          App.loadTrajectory(App.currentSessionId);
        } else {
          App.viewport.classList.remove("show-trajectory");
        }
      });
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
    App.syncCollapseButtons(); // 启动同步一次初始态
  };

  // 折叠按钮的箭头/标题/语义属性由真实状态派生（D4）。
  App.syncCollapseButtons = function syncCollapseButtons() {
    var leftCollapsed = App.sidebar.classList.contains("collapsed");
    var rightCollapsed = App.contextPanel.hasAttribute("hidden");
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
      var res = await window.AgentClient.call("fs", { op: "read", path: filePath });
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
