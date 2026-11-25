"use strict";
// tools-modal: 只读工具浏览弹窗（按 ui.md 的 tools-modal 布局树实现）。
//   - Left (tools-sidebar): tool-type-tree-list，按 registry 的 group 分组列出 listFunctions 返回的
//     工具（tree-search-input 过滤名/描述），点击 tool-name-label 在右侧视口查看。
//   - Tabs (tool-source-tabs): 内置工具 / MCP 工具，切换目录来源。
//   - Right (tools-viewport): tool-tab 展示 tool-meta（读写特性 mode / 分组 group / 名称 /
//     描述 / parameters 只读）+ tool-content（prompt 经 AgentMarkdown 渲染）。
// 仅浏览，无编辑/保存，与后端 listFunctions（只读）一致。listFunctions 已包含
// parameters / mode / group / prompt，故无需单独的 get op。
// 布局树见 docs/ui/ui.md tools-modal；模块在 DOMContentLoaded 自绑定 toolsBtn。
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
    return window.AgentClient.call("tools.list", {});
  }

  // ---- Module state ----
  var overlay = null, treeEl = null, searchEl = null;
  var tabTitleEl = null, metaEl = null, contentEl = null;
  var list = [];                // 最近一次 listFunctions 结果
  var currentName = null;       // 当前视口选中的工具名
  // 目录来源子标签：builtin = 内置工具（按 type 分组），mcp = MCP 服务器提供的工具（按服务器分组）
  var activeSource = "builtin";
  var sourceTabBarEl = null;

  // ---- Data helpers ----
  // MCP 服务器工具名约定 mcp__<server>__<tool>；拆出服务器名与服务器内工具名。
  // 只看名字前缀，不看 type：list_mcp_resources / list_mcp_resource_templates /
  // read_mcp_resource 的 type 也是 "mcp"，但它们是共享注册的内置工具（服务名是参数），
  // 不属于任何单个服务器提供的一批工具，应留在「内置工具」里。
  var MCP_PREFIX = "mcp__";
  function isMcpTool(tool) { return String(tool.name || "").indexOf(MCP_PREFIX) === 0; }
  function mcpServerOf(name) {
    var rest = String(name || "").slice(MCP_PREFIX.length);
    var i = rest.indexOf("__");
    return i === -1 ? rest : rest.slice(0, i);
  }
  function mcpToolNameOf(name) {
    var rest = String(name || "").slice(MCP_PREFIX.length);
    var i = rest.indexOf("__");
    return i === -1 ? rest : rest.slice(i + 2);
  }
  function toolsOfSource(source) {
    return list.filter(function (t) { return source === "mcp" ? isMcpTool(t) : !isMcpTool(t); });
  }

  // 按 registry 的 group 字段分组（能力分组，与读写特性 mode 无关）。
  // 分组顺序按 GROUP_ORDER，未列出的组排在后面；组内按工具名排序。
  var GROUP_ORDER = ["fs", "shell", "terminal", "code", "web", "browser", "job", "agent", "team", "schedule", "goal", "interaction", "deliverable", "channel", "skill", "mcp", "utility"];
  // 组名一律一个词，直接作为标题显示，不做「X / Y」这类复合名。
  var GROUP_LABEL = {
    fs: "文件", shell: "命令", terminal: "终端", code: "代码", web: "网络", browser: "浏览器", job: "任务",
    agent: "Agent", team: "团队", schedule: "定时", goal: "目标",
    interaction: "交互", deliverable: "交付", channel: "渠道", skill: "技能", mcp: "MCP", utility: "通用",
  };
  function groupLabel(key) { return GROUP_LABEL[key] || key; }
  function groupTools(items) {
    var map = new Map();
    items.forEach(function (s) {
      var key = s.group != null && s.group ? s.group : "utility";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    });
    var keys = Array.from(map.keys()).sort(function (a, b) {
      var ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      if (ia === -1) ia = GROUP_ORDER.length;
      if (ib === -1) ib = GROUP_ORDER.length;
      return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
    });
    return keys.map(function (key) {
      var tools = map.get(key).slice().sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      return { key: key, label: groupLabel(key), tools: tools };
    });
  }

  // 按 MCP 服务器名分组；组内按工具名排序，显示时用去掉前缀的短名。
  function groupMcpTools(items) {
    var map = new Map();
    items.forEach(function (t) {
      var server = mcpServerOf(t.name) || "unknown";
      if (!map.has(server)) map.set(server, []);
      map.get(server).push({ tool: t, shortName: mcpToolNameOf(t.name) });
    });
    var out = [];
    Array.from(map.keys()).sort().forEach(function (server) {
      var entries = map.get(server).sort(function (a, b) {
        return a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0;
      });
      out.push({ key: server, tools: entries });
    });
    return out;
  }

  // 来源子标签：内置工具 / MCP 工具。切换只影响左栏目录，右侧详情不变。
  function buildSourceTabs() {
    sourceTabBarEl = el("div", { className: "tool-source-tabs", dataset: { name: "tool-source-tabs" } });
    [["builtin", "内置工具"], ["mcp", "MCP 工具"]].forEach(function (pair) {
      var btn = el("button", {
        className: "tool-source-tab" + (activeSource === pair[0] ? " active" : ""),
        dataset: { name: "tool-source-tab" },
        "data-source": pair[0],
        onclick: function () {
          if (activeSource === pair[0]) return;
          activeSource = pair[0];
          Array.prototype.forEach.call(sourceTabBarEl.children, function (b) {
            b.classList.toggle("active", b.getAttribute("data-source") === activeSource);
          });
          renderTree(searchEl ? searchEl.value : "");
          var first = toolsOfSource(activeSource)[0];
          if (first) selectTool(first);
          else clearDetail();
        },
      }, pair[1]);
      sourceTabBarEl.appendChild(btn);
    });
    return sourceTabBarEl;
  }

  function clearDetail() {
    if (tabTitleEl) tabTitleEl.textContent = activeSource === "mcp" ? "MCP 工具" : "内置工具";
    if (metaEl) metaEl.innerHTML = "";
    if (contentEl) contentEl.innerHTML = '<div class="empty-hint">' + (activeSource === "mcp" ? "没有可用的 MCP 工具" : "没有可用的内置工具") + "</div>";
  }

  // ---- Sidebar: type / MCP server → tool tree ----
  function renderTree(filter) {
    if (!treeEl) return;
    treeEl.innerHTML = "";
    filter = (filter || "").trim().toLowerCase();
    var groups = activeSource === "mcp" ? groupMcpTools(toolsOfSource("mcp")) : groupTools(toolsOfSource("builtin"));
    var anyVisible = false;

    groups.forEach(function (g) {
      var tools = g.tools.filter(function (entry) {
        if (!filter) return true;
        var s = entry.tool || entry;
        var hay = (s.name + " " + (entry.shortName || "") + " " + (s.description || "")).toLowerCase();
        return hay.indexOf(filter) !== -1;
      });
      if (!tools.length) return;
      anyVisible = true;

      var listWrap = el("div", { className: "tool-type-list" });
      tools.forEach(function (entry) {
        var s = entry.tool || entry;                 // MCP 组内是 { tool, shortName }
        var labelText = entry.shortName || s.name;
        var label = el("div", {
          className: "tool-name-label" + (s.name === currentName ? " selected" : ""),
          dataset: { name: "tool-name-label", tool: s.name },
          onclick: function () { selectTool(s); },
        }, labelText);
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
        el("span", { className: "tool-type-label", dataset: { name: "tool-type-label", group: g.key } }, g.label),
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

    var MODE_LABEL = { read: "只读", write: "可写", both: "视情况可写" };
    metaEl.appendChild(el("div", { className: "meta-row", dataset: { name: "mode-display" } }, [
      el("span", { className: "meta-key" }, "读写"),
      el("span", { className: "mode-badge mode-" + (tool.mode || "write"), dataset: { name: "mode-badge" } }, MODE_LABEL[tool.mode] || "可写"),
    ]));
    metaEl.appendChild(el("div", { className: "meta-row", dataset: { name: "group-display" } }, [
      el("span", { className: "meta-key" }, "分组"),
      el("span", { className: "meta-val" }, groupLabel(tool.group || "utility")),
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
    activeSource = isMcpTool(tool) ? "mcp" : "builtin";
    if (sourceTabBarEl) {
      Array.prototype.forEach.call(sourceTabBarEl.children, function (b) {
        b.classList.toggle("active", b.getAttribute("data-source") === activeSource);
      });
    }
    renderTree(searchEl ? searchEl.value : "");
    if (tabTitleEl) tabTitleEl.textContent = tool.name; // 详情标题保留完整名（mcp__server__tool）
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
    renderTree(searchEl ? searchEl.value : "");
    if (metaEl) metaEl.innerHTML = "";
    if (contentEl) contentEl.innerHTML = "";
    // MCP tab 有服务器时才切过去；否则停在有内容的那一侧。
    if (activeSource === "mcp" && !toolsOfSource("mcp").length) activeSource = "builtin";
    var first = toolsOfSource(activeSource)[0];
    if (first) selectTool(first);
    else clearDetail();
  }

  // ---- Shell ----
  function buildShell() {
    treeEl = el("div", { className: "tool-type-tree-list", dataset: { name: "tool-type-tree-list" } });
    // 搜索框放在表头右槽（本页的页级筛选），左栏只留分组列表。
    // 搜索框归表头右槽所有；这里只确保它存在并接上过滤逻辑（表头工厂可能已建过）。
    if (!searchEl) {
      searchEl = el("input", {
        className: "tree-search-input header-search", dataset: { name: "tree-search-input" }, type: "text",
        placeholder: "过滤工具名 / 描述…",
      });
    }
    searchEl.addEventListener("input", function () { renderTree(searchEl.value); });
    var sidebar = el("div", { className: "tools-sidebar", dataset: { name: "tools-sidebar" } }, [
      el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [
        el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "工具目录"),
      ]),
      buildSourceTabs(),
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

    // 第三列已取消：本页只有浏览用途，回聊天走左栏，不再保留「关闭」列。
    var win = el("div", { className: "tools-window", dataset: { name: "tools-window" } }, [sidebar, viewport]);
    overlay = el("div", { className: "tools-modal", dataset: { name: "tools-page" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeTools(); });
    window.App.mountViewPage(overlay, "tools");
  }

  async function openTools() {
    if (!overlay) buildShell();
    overlay.hidden = false;
    await loadAndRender();
  }
  function closeTools() { if (overlay) overlay.hidden = true; window.App.showView("chat"); }

  ready(function () {
    if (window.App && window.App.registerView) {
      // 本页进表头右槽的内容：工具名 / 描述过滤框。
      window.App.registerView("tools", {
        title: "工具",
        header: function () {
          // 页面建好前 searchEl 还是 null：此时先给一个占位输入框；
          // 页面建好后每次切页都换成页面里那一个，保证输入框只有一份。
          if (!searchEl) {
            searchEl = el("input", {
              className: "tree-search-input header-search", dataset: { name: "tree-search-input" }, type: "text",
              placeholder: "过滤工具名 / 描述…",
            });
          }
          return searchEl;
        },
      });
    }
    var btn = document.getElementById("toolsBtn");
    if (btn) btn.addEventListener("click", openTools);
  });
})();
