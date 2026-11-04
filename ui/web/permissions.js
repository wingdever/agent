"use strict";
// permissions-modal：本机权限门控配置（三个配置文件，均不入 git）。
//   - 工具级档位        user/permissions.json
//   - bash 命令级策略   user/bash-policy.json
//   - 文件写精细策略    user/fs-policy.json
// 依赖 window.AgentClient（api.js）与 window.uiConfirm/uiAlert（app.js）。
// 布局树见 docs/ui.md 的 permissions-modal。
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ---- 极简 DOM 构造器（与 models.js 同款） ----
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
      else if (k === "onchange") e.addEventListener("change", v);
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
  function field(label, control) {
    return el("label", { className: "form-field" }, [el("span", { className: "form-label" }, label), control]);
  }
  function option(value, text) { return el("option", { value: value }, text); }

  // ---- 模块状态 ----
  var state = {
    activeTab: "tool",          // "tool" | "bash" | "fs"
    toolNames: [],              // 从 listFunctions 取到的工具名
    permissions: { default: "ask", tools: [] },
    bashPolicy: { default: "ask", rules: [], env: {} },
    fsPolicy: { rules: [] },
  };

  var overlay = null, tabBtnsEl = null, summaryEl = null, viewport = null;

  // 后端封装：permissions.fn 一组 op
  function api(op, payload) {
    return window.AgentClient.call("permissions", { op: op, payload: payload || {} });
  }

  // 工具档位映射：name -> permission（仅显式设置的）
  function toolTierMap() {
    var m = {};
    (state.permissions.tools || []).forEach(function (t) { if (t && t.name) m[t.name] = t.permission; });
    return m;
  }

  // ---- 加载 ----
  async function loadData() {
    try {
      var cfg = await api("get");
      state.permissions = cfg.permissions || { default: "ask", tools: [] };
      state.bashPolicy = cfg.bashPolicy || { default: "ask", rules: [], env: {} };
      state.fsPolicy = cfg.fsPolicy || { rules: [] };
    } catch (e) { console.error("load permissions failed:", e); }
    try {
      var fns = await window.AgentClient.call("listFunctions");
      state.toolNames = (fns || []).map(function (f) { return f.name || (f.function && f.function.name); }).filter(Boolean);
    } catch (e) { /* 后端未就绪：降级为空，用户仍可手动添加档位行 */ }
  }

  // ---- 侧栏：配置切换标签 + 概要 ----
  function renderSidebar() {
    if (!tabBtnsEl) return;
    tabBtnsEl.innerHTML = "";
    var tabs = [
      { key: "tool", label: "工具权限" },
      { key: "bash", label: "Bash 命令策略" },
      { key: "fs", label: "文件写策略" },
    ];
    tabs.forEach(function (t) {
      var b = el("button", {
        className: "config-file-tab-btn" + (state.activeTab === t.key ? " active" : ""),
        dataset: { name: "config-file-tab-btn", tab: t.key },
        onclick: function () { state.activeTab = t.key; refresh(); },
      }, t.label);
      tabBtnsEl.appendChild(b);
    });
    renderSummary();
  }
  function renderSummary() {
    if (!summaryEl) return;
    summaryEl.innerHTML = "";
    var tiers = toolTierMap();
    var explicit = Object.keys(tiers).length;
    summaryEl.appendChild(el("div", { className: "default-tier-label", dataset: { name: "default-tier-label" } },
      "default: " + (state.permissions.default || "ask")));
    summaryEl.appendChild(el("div", { className: "bash-rule-count-label", dataset: { name: "bash-rule-count-label" } },
      "bash 规则: " + (state.bashPolicy.rules || []).length));
    summaryEl.appendChild(el("div", { className: "rule-count-label", dataset: { name: "rule-count-label" } },
      "fs 规则: " + (state.fsPolicy.rules || []).length + " · 显式档位: " + explicit));
  }

  // ---- 视口：三个 tab ----
  function refresh() { renderSidebar(); renderViewport(); }

  function renderViewport() {
    if (!viewport) return;
    viewport.innerHTML = "";
    if (state.activeTab === "tool") viewport.appendChild(buildToolTab());
    else if (state.activeTab === "bash") viewport.appendChild(buildBashTab());
    else viewport.appendChild(buildFsTab());
  }

  // ===== 工具权限 tab =====
  function buildToolTab() {
    var tiers = toolTierMap();
    // 合并：已有显式档位的工具 + 后端列出的全部工具（无显式档位则显示 inherit）
    var rows = [];
    var seen = {};
    Object.keys(tiers).forEach(function (n) { rows.push(n); seen[n] = true; });
    state.toolNames.forEach(function (n) { if (!seen[n]) { rows.push(n); seen[n] = true; } });

    var defaultSel = el("select", { className: "default-tier-select", dataset: { name: "default-tier-select" } },
      [option("ask", "ask"), option("allow", "allow"), option("deny", "deny")]);
    defaultSel.value = state.permissions.default || "ask";

    var table = el("div", { className: "tool-permissions-table", dataset: { name: "tool-permissions-table" } });
    function addRow(name) {
      var cur = tiers[name] || "inherit";
      var sel = el("select", { className: "tier-select", dataset: { name: "tier-select" } },
        [option("inherit", "inherit (default)"), option("allow", "allow"), option("ask", "ask"), option("deny", "deny")]);
      sel.value = cur;
      var nameLabel = el("span", { className: "tool-name-label", dataset: { name: "tool-name-label" } }, name);
      var delBtn = el("button", {
        className: "clear-tier-btn", dataset: { name: "clear-tier-btn" },
        onclick: function () { sel.value = "inherit"; },
      }, "继承");
      table.appendChild(el("div", { className: "tool-permission-row", dataset: { name: "tool-permission-row" } }, [nameLabel, sel, delBtn]));
    }
    rows.forEach(addRow);

    var addBtn = el("button", {
      className: "add-tool-permission-btn", dataset: { name: "add-tool-permission-btn" },
      onclick: async function () {
        var n = (window.uiPrompt ? await window.uiPrompt("工具名（如 read）") : prompt("工具名"));
        if (n) { tiers[n] = "ask"; refresh(); }
      },
    }, "+ 新增工具档位");

    var body = el("div", null, [
      el("div", { className: "default-tier-row", dataset: { name: "default-tier-row" } }, [
        el("span", { className: "default-tier-label", dataset: { name: "default-tier-label" } }, "default"),
        defaultSel,
      ]),
      el("div", { className: "section-header", dataset: { name: "section-header" } }, [el("span", null, "工具档位 (" + rows.length + ")"), addBtn]),
      table,
    ]);

    var err = el("div", { className: "form-error", hidden: "hidden" });
    function save() {
      var tools = [];
      Array.prototype.forEach.call(table.querySelectorAll(".tool-permission-row"), function (row) {
        var name = row.querySelector(".tool-name-label").textContent;
        var perm = row.querySelector(".tier-select").value;
        if (perm && perm !== "inherit") tools.push({ name: name, permission: perm });
      });
      api("permissions.upsert", { default: defaultSel.value, tools: tools })
        .then(function () { state.permissions = { default: defaultSel.value, tools: tools }; renderSummary(); showErr(err, ""); })
        .catch(function (e) { showErr(err, "保存失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "config-footer", dataset: { name: "config-footer" } }, [
      el("button", { className: "reset-btn", onclick: function () { refresh(); } }, "重置"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("工具权限", el("div", { className: "tool-permissions-tab", dataset: { name: "tool-permissions-tab" } }, [el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "工具权限")]), el("div", { className: "tab-body-inner" }, [err, body]), footer]));
  }

  // ===== Bash 命令策略 tab =====
  function buildBashTab() {
    var bp = state.bashPolicy;
    var defaultSel = el("select", { className: "bash-default-select", dataset: { name: "bash-default-select" } },
      [option("ask", "ask"), option("allow", "allow"), option("deny", "deny")]);
    defaultSel.value = bp.default || "ask";

    var globalEnv = el("textarea", { className: "bash-global-env", dataset: { name: "bash-global-env" }, rows: 2, placeholder: "SCRIPT_DIR=/repo/scripts/*" });
    globalEnv.value = envToText(bp.env || {});

    var table = el("div", { className: "bash-rules-table", dataset: { name: "bash-rules-table" } });
    function addRuleRow(rule) {
      rule = rule || {};
      var program = el("input", { className: "program-input", dataset: { name: "program-input" }, type: "text", placeholder: "cat", value: (rule.match && rule.match.program) || "" });
      var args = el("input", { className: "args-input", dataset: { name: "args-input" }, type: "text", placeholder: "$URL（可空）", value: (rule.match && Array.isArray(rule.match.args)) ? rule.match.args.join(" ") : "" });
      var dec = el("select", { className: "decision-select", dataset: { name: "decision-select" } }, [option("allow", "allow"), option("ask", "ask"), option("deny", "deny")]);
      dec.value = rule.decision || "ask";
      var reason = el("input", { className: "reason-input", dataset: { name: "reason-input" }, type: "text", placeholder: "可解释理由（可选）", value: rule.reason || "" });
      var env = el("input", { className: "env-input", dataset: { name: "env-input" }, type: "text", placeholder: "URL=https://*.example.com/*（可选）", value: envToText(rule.env || {}) });
      var del = el("button", { className: "remove-rule-btn", dataset: { name: "remove-rule-btn" }, onclick: function () { row.remove(); } }, "删除");
      var row = el("div", { className: "bash-rule-row", dataset: { name: "bash-rule-row" } }, [program, args, dec, reason, env, del]);
      table.appendChild(row);
    }
    (bp.rules || []).forEach(addRuleRow);

    var addBtn = el("button", { className: "add-bash-rule-btn", dataset: { name: "add-bash-rule-btn" }, onclick: function () { addRuleRow(); } }, "+ 新增规则");

    var body = el("div", null, [
      el("div", { className: "bash-default-row", dataset: { name: "bash-default-row" } }, [
        el("span", { className: "bash-default-label", dataset: { name: "bash-default-label" } }, "default"),
        defaultSel,
      ]),
      field("全局 env（可选）", globalEnv),
      el("div", { className: "section-header", dataset: { name: "section-header" } }, [el("span", null, "规则 (" + (bp.rules || []).length + ")"), addBtn]),
      table,
    ]);

    var err = el("div", { className: "form-error", hidden: "hidden" });
    function save() {
      var rules = [];
      Array.prototype.forEach.call(table.querySelectorAll(".bash-rule-row"), function (row) {
        var program = row.querySelector(".program-input").value.trim();
        if (!program) return;
        var argsRaw = row.querySelector(".args-input").value.trim();
        var match = { program: program };
        if (argsRaw) match.args = argsRaw.split(/\s+/);
        var r = { match: match, decision: row.querySelector(".decision-select").value };
        var reason = row.querySelector(".reason-input").value.trim();
        if (reason) r.reason = reason;
        var env = textToEnv(row.querySelector(".env-input").value.trim());
        if (env) r.env = env;
        rules.push(r);
      });
      var payload = { default: defaultSel.value, rules: rules, env: textToEnv(globalEnv.value.trim()) || {} };
      api("bashpolicy.upsert", payload)
        .then(function () { state.bashPolicy = payload; renderSummary(); showErr(err, ""); })
        .catch(function (e) { showErr(err, "保存失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "config-footer", dataset: { name: "config-footer" } }, [
      el("button", { className: "reset-btn", onclick: function () { refresh(); } }, "重置"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("Bash 命令策略", el("div", { className: "bash-policy-tab", dataset: { name: "bash-policy-tab" } }, [el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "Bash 命令策略")]), el("div", { className: "tab-body-inner" }, [err, body]), footer]));
  }

  // ===== 文件写策略 tab =====
  function buildFsTab() {
    var fp = state.fsPolicy;
    var table = el("div", { className: "fs-rules-table", dataset: { name: "fs-rules-table" } });
    function addRuleRow(rule) {
      rule = rule || {};
      var path = el("input", { className: "path-input", dataset: { name: "path-input" }, type: "text", placeholder: "docs/**", value: rule.path || "" });
      var perm = el("select", { className: "permission-select", dataset: { name: "permission-select" } }, [option("allow", "allow"), option("deny", "deny")]);
      perm.value = rule.permission || "allow";
      var del = el("button", { className: "remove-rule-btn", dataset: { name: "remove-rule-btn" }, onclick: function () { row.remove(); } }, "删除");
      var row = el("div", { className: "fs-rule-row", dataset: { name: "fs-rule-row" } }, [path, perm, del]);
      table.appendChild(row);
    }
    (fp.rules || []).forEach(addRuleRow);

    var addBtn = el("button", { className: "add-fs-rule-btn", dataset: { name: "add-fs-rule-btn" }, onclick: function () { addRuleRow(); } }, "+ 新增规则");

    var body = el("div", null, [
      el("div", { className: "fs-scope-note", dataset: { name: "fs-scope-note" } }, "仅作用于 write / edit（deny 优先，命中即拒）"),
      el("div", { className: "section-header", dataset: { name: "section-header" } }, [el("span", null, "规则 (" + (fp.rules || []).length + ")"), addBtn]),
      table,
    ]);

    var err = el("div", { className: "form-error", hidden: "hidden" });
    function save() {
      var rules = [];
      Array.prototype.forEach.call(table.querySelectorAll(".fs-rule-row"), function (row) {
        var p = row.querySelector(".path-input").value.trim();
        if (!p) return;
        rules.push({ path: p, permission: row.querySelector(".permission-select").value });
      });
      api("fspolicy.upsert", { rules: rules })
        .then(function () { state.fsPolicy = { rules: rules }; renderSummary(); showErr(err, ""); })
        .catch(function (e) { showErr(err, "保存失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "config-footer", dataset: { name: "config-footer" } }, [
      el("button", { className: "reset-btn", onclick: function () { refresh(); } }, "重置"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("文件写策略", el("div", { className: "fs-policy-tab", dataset: { name: "fs-policy-tab" } }, [el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "文件写策略")]), el("div", { className: "tab-body-inner" }, [err, body]), footer]));
  }

  // ---- env 文本 <-> 对象 ----
  function envToText(env) {
    if (!env || typeof env !== "object") return "";
    return Object.keys(env).map(function (k) { return k + "=" + env[k]; }).join("\n");
  }
  function textToEnv(text) {
    if (!text) return null;
    var obj = {};
    text.split(/\n+/).forEach(function (line) {
      var i = line.indexOf("=");
      if (i === -1) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim();
      if (k) obj[k] = v;
    });
    return Object.keys(obj).length ? obj : null;
  }

  function tabShell(title, inner) { return el("div", { className: "permissions-tab" }, [inner]); }
  function showErr(errEl, msg) { if (!errEl) return; errEl.textContent = msg || ""; errEl.hidden = !msg; }

  // ---- 打开 / 关闭 ----
  function buildShell() {
    tabBtnsEl = el("div", { className: "config-file-tabs", dataset: { name: "config-file-tabs" } });
    summaryEl = el("div", { className: "permission-summary", dataset: { name: "permission-summary" } });

    var sidebar = el("div", { className: "permissions-sidebar", dataset: { name: "permissions-sidebar" } }, [tabBtnsEl, summaryEl]);

    viewport = el("div", { className: "permissions-viewport", dataset: { name: "permissions-viewport" } });

    var panel = el("div", { className: "permissions-panel", dataset: { name: "permissions-panel" } }, [
      el("div", { className: "danger-zone", dataset: { name: "danger-zone" } },
        el("button", { className: "reset-defaults-btn", onclick: resetDefaults }, "恢复默认（default=ask，清空规则）")
      ),
      el("button", { className: "close-permissions-btn", dataset: { name: "close-permissions-btn" }, onclick: closePermissions }, "关闭"),
    ]);

    var win = el("div", { className: "permissions-window" }, [sidebar, viewport, panel]);
    overlay = el("div", { className: "permissions-modal", dataset: { name: "permissions-modal" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closePermissions(); });
    document.body.appendChild(overlay);
  }

  async function resetDefaults() {
    if (!(window.uiConfirm && await window.uiConfirm("恢复默认：default=ask，并清空所有显式档位与规则？"))) return;
    try {
      await api("permissions.upsert", { default: "ask", tools: [] });
      await api("bashpolicy.upsert", { default: "ask", rules: [], env: {} });
      await api("fspolicy.upsert", { rules: [] });
      await loadData();
      refresh();
    } catch (e) { if (window.uiAlert) uiAlert("恢复默认失败：" + (e.message || e)); }
  }

  async function openPermissions() {
    if (!overlay) buildShell();
    overlay.style.display = "flex";
    await loadData();
    refresh();
  }
  function closePermissions() { if (overlay) overlay.style.display = "none"; }

  ready(function () {
    var btn = document.getElementById("permissionsBtn");
    if (btn) btn.addEventListener("click", openPermissions);
  });
})();
