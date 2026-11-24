"use strict";
// skills-modal: 只读技能浏览弹窗（按 ui.md 的 skills-modal 布局树实现）。
//   - Left (skills-sidebar): provider-skill-tree-list，按 provider 分组列出技能，
//     点击 skill-name-label 在右侧视口查看其 meta + skill-content。
//   - Right (skills-viewport): skill-tab 展示 skill-meta（只读）+ skill-content
//     （经 AgentMarkdown 渲染的完整技能正文）。
//   - Panel (skills-panel): close-skills-btn 关闭。
// 仅浏览，无编辑/保存：与后端 skills.list / skills.get（只读）一致。
// 布局树见 docs/ui/ui.md skills-modal；模块在 DOMContentLoaded 自绑定 skillsBtn。
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

  function api(op, payload) {
    if (op === "list") return window.AgentClient.call("skills.list", {});
    if (op === "get") return window.AgentClient.call("skills.get", payload || {});
    return Promise.reject(new Error("unknown skills op: " + op));
  }

  // ---- Module state ----
  var overlay = null, treeEl = null, searchEl = null;
  var tabTitleEl = null, metaEl = null, contentEl = null;
  var list = [];                // 最近一次 skills.list 结果
  var currentName = null;       // 当前视口选中的技能名

  // ---- Data helpers ----
  // dsh 有 6 个发现根（source: project-dsh / project-agents / custom / user-dsh /
  // user-agents / bundled），但本项目只注册了 1 个 filesystem provider，故 provider
  // 字段恒为 "filesystem"。按 source 分组才能还原 dsh 的 6 根语义（runtime 技能
  // 回退到 provider）。见 docs/skills/skills.md 3.1 / 5.7。
  function groupSkills(items) {
    var map = new Map();
    items.forEach(function (s) {
      var key = s.source != null ? s.source : (s.provider != null ? s.provider : "unknown");
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    });
    var out = [];
    Array.from(map.keys()).sort().forEach(function (key) {
      var skills = map.get(key).slice().sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      out.push({ key: key, skills: skills });
    });
    return out;
  }

  // ---- Sidebar: provider → skill tree ----
  function renderTree(filter) {
    if (!treeEl) return;
    treeEl.innerHTML = "";
    filter = (filter || "").trim().toLowerCase();
    var groups = groupSkills(list);
    var anyVisible = false;

    groups.forEach(function (g) {
      var skills = g.skills.filter(function (s) {
        if (!filter) return true;
        return (s.name + " " + (s.description || "")).toLowerCase().indexOf(filter) !== -1;
      });
      if (!skills.length) return;
      anyVisible = true;

      var skillsWrap = el("div", { className: "provider-skills" });
      skills.forEach(function (s) {
        var label = el("div", {
          className: "skill-name-label" + (s.name === currentName ? " selected" : ""),
          dataset: { name: "skill-name-label", skill: s.name },
          onclick: function () { selectSkill(s.name); },
        }, s.name);
        skillsWrap.appendChild(label);
      });

      var header = el("div", { className: "provider-header", dataset: { name: "provider-header" } }, [
        el("button", {
          className: "provider-collapse-toggle", dataset: { name: "provider-collapse-toggle" },
          onclick: function () {
            var collapsed = skillsWrap.style.display === "none";
            skillsWrap.style.display = collapsed ? "" : "none";
            toggle.textContent = collapsed ? "▾" : "▸";
          },
        }, "▾"),
        el("span", { className: "provider-name-label", dataset: { name: "provider-name-label" } }, g.key),
      ]);
      var toggle = header.querySelector(".provider-collapse-toggle");

      treeEl.appendChild(el("div", { className: "provider", dataset: { name: "provider" } }, [header, skillsWrap]));
    });

    if (!anyVisible) {
      treeEl.appendChild(el("div", { className: "empty-hint" }, filter ? "无匹配技能" : "没有可用户调用的技能"));
    }
  }

  // ---- Viewport: read-only meta + rendered content ----
  function renderMeta(skill) {
    if (!metaEl) return;
    metaEl.innerHTML = "";

    metaEl.appendChild(el("div", { className: "meta-row", dataset: { name: "provider-display" } }, [
      el("span", { className: "meta-key" }, "来源"),
      el("span", { className: "meta-val" }, (skill.source != null ? skill.source : skill.provider) || "unknown"),
    ]));

    metaEl.appendChild(el("div", { className: "meta-row" }, [
      el("label", { className: "meta-key", for: "skillNameInput" }, "名称"),
      el("input", { id: "skillNameInput", className: "name-input", dataset: { name: "name-input" }, value: skill.name || "", readonly: "readonly" }),
    ]));

    metaEl.appendChild(el("div", { className: "meta-row" }, [
      el("label", { className: "meta-key", for: "skillDescInput" }, "描述"),
      el("textarea", { id: "skillDescInput", className: "description-input", dataset: { name: "description-input" }, readonly: "readonly", rows: "2" }, skill.description || ""),
    ]));

    if (skill.modelInvocable) {
      metaEl.appendChild(el("div", { className: "meta-row" }, [
        el("span", { className: "skill-badge", dataset: { name: "skill-badge" } }, "模型可调"),
      ]));
    } else {
      metaEl.appendChild(el("div", { className: "meta-row" }, [
        el("span", { className: "skill-badge skill-badge-useronly", dataset: { name: "skill-badge" } }, "仅用户可调"),
      ]));
    }
  }

  function renderContent(skill) {
    if (!contentEl) return;
    contentEl.innerHTML = "";
    var raw = (skill && skill.content) || "";
    var body = el("div", { className: "skill-content-body textcard" });
    contentEl.appendChild(body);
    if (window.AgentMarkdown && window.marked && window.DOMPurify) {
      window.AgentMarkdown.set(body, raw);
    } else {
      body.textContent = raw;
    }
  }

  async function selectSkill(name) {
    currentName = name;
    renderTree(searchEl ? searchEl.value : "");
    if (tabTitleEl) tabTitleEl.textContent = name;
    try {
      var skill = await api("get", { name: name });
      renderMeta(skill);
      renderContent(skill);
    } catch (e) {
      renderMeta({ name: name, provider: "—" });
      if (contentEl) contentEl.innerHTML = "";
      if (window.uiAlert) window.uiAlert("加载技能内容失败：" + (e.message || e));
    }
  }

  async function loadAndRender() {
    try {
      list = await api("list", {});
    } catch (e) {
      list = [];
      if (window.uiAlert) window.uiAlert("加载技能列表失败：" + (e.message || e));
    }
    currentName = null;
    if (tabTitleEl) tabTitleEl.textContent = "技能";
    renderTree("");
    if (metaEl) metaEl.innerHTML = "";
    if (contentEl) contentEl.innerHTML = "";
    if (list.length) selectSkill(list[0].name);
  }

  // ---- Shell ----
  function buildShell() {
    treeEl = el("div", { className: "provider-skill-tree-list", dataset: { name: "provider-skill-tree-list" } });
    // 搜索框放在表头右槽（本页的页级筛选），左栏只留分组列表。
    // 搜索框归表头右槽所有；这里只确保它存在并接上过滤逻辑（表头工厂可能已建过）。
    if (!searchEl) {
      searchEl = el("input", {
        className: "tree-search-input header-search", dataset: { name: "tree-search-input" }, type: "text",
        placeholder: "过滤技能名…",
      });
    }
    searchEl.addEventListener("input", function () { renderTree(searchEl.value); });
    var sidebar = el("div", { className: "skills-sidebar", dataset: { name: "skills-sidebar" } }, [
      el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [
        el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "技能目录"),
      ]),
      treeEl,
    ]);

    tabTitleEl = el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "技能");
    metaEl = el("div", { className: "skill-meta", dataset: { name: "skill-meta" } });
    contentEl = el("div", { className: "skill-content", dataset: { name: "skill-content" } });
    var viewport = el("div", { className: "skills-viewport", dataset: { name: "skills-viewport" } }, [
      el("div", { className: "skill-tab", dataset: { name: "skill-tab" } }, [
        el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [tabTitleEl]),
        metaEl,
        contentEl,
      ]),
    ]);

    // 第三列已取消：本页只有浏览用途，回聊天走左栏，不再保留「关闭」列。
    var win = el("div", { className: "skills-window", dataset: { name: "skills-window" } }, [sidebar, viewport]);
    overlay = el("div", { className: "skills-modal", dataset: { name: "skills-page" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeSkills(); });
    window.App.mountViewPage(overlay, "skills");
  }

  async function openSkills() {
    if (!overlay) buildShell();
    overlay.hidden = false;
    await loadAndRender();
  }
  function closeSkills() { if (overlay) overlay.hidden = true; window.App.showView("chat"); }

  ready(function () {
    if (window.App && window.App.registerView) {
      // 本页进表头右槽的内容：技能名过滤框。
      window.App.registerView("skills", {
        title: "技能",
        header: function () {
          // 页面建好前 searchEl 还是 null：此时先给一个占位输入框；
          // 页面建好后每次切页都换成页面里那一个，保证输入框只有一份。
          if (!searchEl) {
            searchEl = el("input", {
              className: "tree-search-input header-search", dataset: { name: "tree-search-input" }, type: "text",
              placeholder: "过滤技能名…",
            });
          }
          return searchEl;
        },
      });
    }
    var btn = document.getElementById("skillsBtn");
    if (btn) btn.addEventListener("click", openSkills);
  });
})();
