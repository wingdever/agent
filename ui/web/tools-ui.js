"use strict";
// tools-modal: 只读工具浏览弹窗（按 ui.md 的 tools-modal 布局树实现）。
//   - Left (tools-sidebar): tool-type-tree-list，按 type 分组列出 listFunctions 返回的
//     工具（tree-search-input 过滤名/描述），点击 tool-name-label 在右侧视口查看。
//   - Right (tools-viewport): tool-tab 展示 tool-meta（type / 名称 / 描述 / parameters
//     只读）+ tool-content（prompt 经 AgentMarkdown 渲染）。
//   - Panel (tools-panel): close-tools-btn 关闭。
// 仅浏览，无编辑/保存，与后端 listFunctions（只读）一致。listFunctions 已包含
// parameters / type / prompt，故无需单独的 get op。
// 布局树见 docs/ui.md tools-modal；模块在 DOMContentLoaded 自绑定 toolsBtn。
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
      else if (k === "html") e.innerHTML = v;
      else if (k === "onclick") e.addEventListener("click", v);
      else if (k === "oninput") e.addEventListener("input", v);
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

  function apiList() {
    return window.AgentClient.call("listFunctions", {});
  }

  // ---- Module state ----
  var overlay = null, treeEl = null, searchEl = null;
  var tabTitleEl = null, metaEl = null, contentEl = null;
  var list = [];                // 最近一次 listFunctions 结果
  var currentName = null;       // 当前视口选中的工具名

  // ---- Data helpers ----
  // 按 type 分组（对应 registry 的 type 字段：fs / web / goal / plan / interaction / todo …）；
  // 与 skills-modal 按 source 分组同理，但技能无 fee，工具无 provider，换成 type。
  function groupTools(items) {
    var map = new Map();
    items.forEach(function (s) {
      var key = s.type != null && s.type ? s.type : "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    });
    var out = [];
    Array.from(map.keys()).sort().forEach(function (key) {
      var tools = map.get(key).slice().sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      out.push({ key: key, tools: tools });
    });
    return out;
  }

  // ---- Sidebar: type → tool tree ----
  function renderTree(filter) {
    if (!treeEl) return;
    treeEl.innerHTML = "";
    filter = (filter || "").trim().toLowerCase();
    var groups = groupTools(list);
    var anyVisible = false;

    groups.forEach(function (g) {
      var tools = g.tools.filter(function (s) {
        if (!filter) return true;
        return (s.name + " " + (s.description || "")).toLowerCase().indexOf(filter) !== -1;
      });
      if (!tools.length) return;
      anyVisible = true;

      var listWrap = el("div", { className: "tool-type-list" });
      tools.forEach(function (s) {
        var label = el("div", {
          className: "tool-name-label" + (s.name === currentName ? " selected" : ""),
          dataset: { name: "tool-name-label", tool: s.name },
          onclick: function () { selectTool(s); },
        }, s.name);
        listWrap.appendChild(label);
      });

      var header = el("div", { className: "tool-type-header", dataset: { name: "tool-type-header" } }, [
        el("button", {
          className: "tool-type-collapse-toggle", dataset: { name: "tool-type-collapse-toggle" },
          onclick: function () {
            var collapsed = listWrap.style.display === "none";
            listWrap.style.display = collapsed ? "" : "none";
            toggle.textContent = collapsed ? "▾" : "▸";
          },
        }, "▾"),
        el("span", { className: "tool-type-label", dataset: { name: "tool-type-label" } }, g.key),
      ]);
      var toggle = header.querySelector(".tool-type-collapse-toggle");

      treeEl.appendChild(el("div", { className: "tool-type", dataset: { name: "tool-type" } }, [header, listWrap]));
    });

    if (!anyVisible) {
      treeEl.appendChild(el("div", { className: "empty-hint" }, filter ? "无匹配工具" : "没有可用工具"));
    }
  }

  // ---- Viewport: read-only meta + rendered prompt ----
  function renderMeta(tool) {
    if (!metaEl) return;
    metaEl.innerHTML = "";

    metaEl.appendChild(el("div", { className: "meta-row", dataset: { name: "type-display" } }, [
      el("span", { className: "meta-key" }, "类型"),
      el("span", { className: "meta-val" }, tool.type || "other"),
    ]));

    metaEl.appendChild(el("div", { className: "meta-row" }, [
      el("label", { className: "meta-key", for: "toolNameInput" }, "名称"),
      el("input", { id: "toolNameInput", className: "name-input", dataset: { name: "name-input" }, value: tool.name || "", readonly: "readonly" }),
    ]));

    metaEl.appendChild(el("div", { className: "meta-row" }, [
      el("label", { className: "meta-key", for: "toolDescInput" }, "描述"),
      el("textarea", { id: "toolDescInput", className: "description-input", dataset: { name: "description-input" }, readonly: "readonly", rows: "3" }, tool.description || ""),
    ]));

    var paramsJson = "";
    try { paramsJson = JSON.stringify(tool.parameters, null, 2); } catch (e) { paramsJson = String(tool.parameters); }
    metaEl.appendChild(el("div", { className: "meta-row" }, [
      el("label", { className: "meta-key" }, "参数"),
      el("pre", { className: "parameters-view", dataset: { name: "parameters-view" } }, paramsJson),
    ]));

    var visible = tool.defaultVisible !== false;
    metaEl.appendChild(el("div", { className: "meta-row" }, [
      el("span", {
        className: "skill-badge " + (visible ? "skill-badge-visible" : "skill-badge-hidden"),
        dataset: { name: "tool-visibility" },
      }, visible ? "默认可见" : "默认隐藏"),
    ]));
  }

  function renderContent(tool) {
    if (!contentEl) return;
    contentEl.innerHTML = "";
    if (!tool.prompt) {
      contentEl.appendChild(el("div", { className: "empty-hint" }, "该工具没有可展示的 prompt 片段。"));
      return;
    }
    var body = el("div", { className: "tool-content-body textcard" });
    contentEl.appendChild(body);
    if (window.AgentMarkdown && window.marked && window.DOMPurify) {
      window.AgentMarkdown.set(body, tool.prompt);
    } else {
      body.textContent = tool.prompt;
    }
  }

  function selectTool(tool) {
    currentName = tool.name;
    renderTree(searchEl ? searchEl.value : "");
    if (tabTitleEl) tabTitleEl.textContent = tool.name;
    renderMeta(tool);
    renderContent(tool);
  }

  async function loadAndRender() {
    try {
      list = await apiList();
    } catch (e) {
      list = [];
      if (window.uiAlert) window.uiAlert("加载工具列表失败：" + (e.message || e));
    }
    currentName = null;
    if (tabTitleEl) tabTitleEl.textContent = "工具";
    renderTree("");
    if (metaEl) metaEl.innerHTML = "";
    if (contentEl) contentEl.innerHTML = "";
    if (list.length) selectTool(list[0]);
  }

  // ---- Shell ----
  function buildShell() {
    treeEl = el("div", { className: "tool-type-tree-list", dataset: { name: "tool-type-tree-list" } });
    searchEl = el("input", {
      className: "tree-search-input", dataset: { name: "tree-search-input" }, type: "text",
      placeholder: "过滤工具名 / 描述…",
      oninput: function () { renderTree(searchEl.value); },
    });
    var sidebar = el("div", { className: "tools-sidebar", dataset: { name: "tools-sidebar" } }, [
      el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [
        el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "工具目录"),
      ]),
      searchEl,
      treeEl,
    ]);

    tabTitleEl = el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "工具");
    metaEl = el("div", { className: "tool-meta", dataset: { name: "tool-meta" } });
    contentEl = el("div", { className: "tool-content", dataset: { name: "tool-content" } });
    var viewport = el("div", { className: "tools-viewport", dataset: { name: "tools-viewport" } }, [
      el("div", { className: "tool-tab", dataset: { name: "tool-tab" } }, [
        el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [tabTitleEl]),
        metaEl,
        contentEl,
      ]),
    ]);

    var panel = el("div", { className: "tools-panel", dataset: { name: "tools-panel" } }, [
      el("button", { className: "close-tools-btn", dataset: { name: "close-tools-btn" }, onclick: closeTools }, "关闭"),
    ]);

    var win = el("div", { className: "tools-window", dataset: { name: "tools-window" } }, [sidebar, viewport, panel]);
    overlay = el("div", { className: "tools-modal", dataset: { name: "tools-modal" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeTools(); });
    document.body.appendChild(overlay);
  }

  async function openTools() {
    if (!overlay) buildShell();
    overlay.style.display = "flex";
    await loadAndRender();
  }
  function closeTools() { if (overlay) overlay.style.display = "none"; }

  ready(function () {
    var btn = document.getElementById("toolsBtn");
    if (btn) btn.addEventListener("click", openTools);
  });
})();
