"use strict";
// models-modal：供应者 / 模型 配置面板。依赖 window.AgentClient（api.js）与 window.uiConfirm/uiAlert（app.js）。
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ---- 极简 DOM 构造器 ----
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

  // 后端封装：providers.op 一组（读写 user/providers.json，见 core/index.js）
  var api = function (op, payload) {
    return window.AgentClient.call("providers", { op: op, payload: payload || {} });
  };
  function fmtDate(v) {
    if (!v) return "—";
    var s = String(v);
    if (s.indexOf("T") !== -1) return s.slice(0, 19).replace("T", " ");
    return s.slice(0, 19);
  }
  function isValidUrl(s) {
    try { var u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; }
    catch (e) { return false; }
  }
  function maskKey(k) {
    if (!k) return "";
    return k.length > 4 ? k.slice(0, 4) + "****" : "****";
  }

  // ---- 模块状态 ----
  var state = {
    providers: [],
    models: [],
    expanded: {},     // providerId -> bool
    search: "",
    view: null,       // {kind:'provider-add'} | {kind:'provider-edit',id} | {kind:'model-add',providerId} | {kind:'model-edit',id}
  };

  var overlay = null, treeList = null, viewport = null, providerListEl = null, searchInputEl = null;

  async function loadData() {
    try {
      // 后端返回 user/providers.json（含嵌套 models）。为兼容既有 id 逻辑，合成 id / provider_id。
      var ps = await api("get");
      state.providers = (ps || []).map(function (p) {
        return {
          id: p.name,
          name: p.name,
          base_url: p.base_url || null,
          api_key: p.api_key || null,
          description: p.description || null,
          models: (p.models || []).map(function (m) {
            return { id: p.name + "#" + m.name, name: m.name, fee: m.fee || "unknown", provider_id: p.name, effort: m.effort || null };
          }),
        };
      });
      // 扁平模型列表（仅用于 modelsOf 查找）
      state.models = [];
      state.providers.forEach(function (p) { (p.models || []).forEach(function (m) { state.models.push(m); }); });
    } catch (e) { console.error("load providers failed:", e); }
  }
  // 把内存中的 providers 结构序列化为 user/providers.json 格式后整体写回
  function serializeProviders() {
    return state.providers.map(function (p) {
      var out = { name: p.name };
      if (p.base_url != null) out.base_url = p.base_url;
      if (p.api_key != null) out.api_key = p.api_key;
      if (p.description != null) out.description = p.description;
      out.models = (p.models || []).map(function (m) {
        var mo = { name: m.name, fee: m.fee || "unknown" };
        if (m.effort) mo.effort = m.effort;  // 推理等级缓存（supported_levels / default_level）
        return mo;
      });
      return out;
    });
  }
  function persistProviders() { return api("upsert", serializeProviders()); }
  function providerById(id) {
    return state.providers.find(function (p) { return String(p.id) === String(id); });
  }
  function modelsOf(providerId) {
    return state.models.filter(function (m) { return String(m.provider_id) === String(providerId); });
  }

  // ---- 侧栏树（仅 providerListEl 重渲染，搜索框/新增按钮常驻不丢焦点）----
  function renderTree() {
    if (!providerListEl) return;
    providerListEl.innerHTML = "";
    var term = state.search.trim().toLowerCase();
    state.providers.forEach(function (p) {
      var itsModels = modelsOf(p.id);
      var pMatch = !term || (p.name || "").toLowerCase().indexOf(term) !== -1;
      var mMatch = !term || itsModels.some(function (m) { return (m.name || "").toLowerCase().indexOf(term) !== -1; });
      if (term && !pMatch && !mMatch) return;
      providerListEl.appendChild(renderProviderNode(p, itsModels, term, pMatch));
    });
    if (!state.providers.length) {
      providerListEl.appendChild(el("div", { className: "tree-empty" }, "暂无供应者，点击上方按钮新增"));
    }
  }

  function renderProviderNode(p, itsModels, term, pMatch) {
    // 默认展开（state.expanded 未显式设为 false 即视为展开）；仅当用户主动折叠时存 false
    var expanded = state.expanded[p.id] !== false;
    var selected = state.view && state.view.kind === "provider-edit" && String(state.view.id) === String(p.id);

    var toggle = el("button", {
      className: "provider-collapse-toggle", dataset: { name: "provider-collapse-toggle" },
      onclick: function (e) { e.stopPropagation(); state.expanded[p.id] = !expanded; renderTree(); },
    }, expanded ? "▾" : "▸");

    var nameLabel = el("span", { className: "provider-name-label", dataset: { name: "provider-name-label" } }, p.name || ("供应者 " + p.id));

    var renameBtn = el("button", {
      className: "provider-rename-btn", dataset: { name: "provider-rename-btn" },
      onclick: function (e) { e.stopPropagation(); startInlineRename(nameLabel, p.name, function (v) { doUpdateProvider(p.id, { name: v }); }); },
    }, "改名");

    var delBtn = el("button", {
      className: "provider-delete-btn", dataset: { name: "provider-delete-btn" },
      onclick: function (e) { e.stopPropagation(); deleteProvider(p.id); },
    }, "删除");

    var addModelBtn = el("button", {
      className: "add-model-btn", dataset: { name: "add-model-btn" },
      onclick: function (e) { e.stopPropagation(); state.view = { kind: "model-add", providerId: p.id }; state.expanded[p.id] = true; refresh(); },
    }, "+ 模型");

    var header = el("div", {
      className: "provider-header" + (selected ? " selected" : ""), dataset: { name: "provider-header" },
      onclick: function () { state.view = { kind: "provider-edit", id: p.id }; refresh(); },
    }, [toggle, nameLabel, renameBtn, addModelBtn, delBtn]);

    var node = el("div", { className: "provider" + (selected ? " selected" : ""), dataset: { name: "provider" } }, [header]);

    if (expanded) {
      var modelWrap = el("div", { className: "model-list", dataset: { name: "model-list" } });
      itsModels.forEach(function (m) {
        var mSel = state.view && state.view.kind === "model-edit" && String(state.view.id) === String(m.id);
        var mName = el("span", { className: "model-name-label", dataset: { name: "model-name-label" } }, m.name || ("模型 " + m.id));
        var fee = el("span", { className: "model-fee-badge fee-" + (m.fee || "free"), dataset: { name: "model-fee-badge" } }, m.fee || "free");
        var mRename = el("button", {
          className: "model-rename-btn", dataset: { name: "model-rename-btn" },
          onclick: function (e) { e.stopPropagation(); startInlineRename(mName, m.name, function (v) { doUpdateModel(m.id, { name: v }); }); },
        }, "改名");
        var mDel = el("button", {
          className: "model-delete-btn", dataset: { name: "model-delete-btn" },
          onclick: function (e) { e.stopPropagation(); deleteModel(m.id); },
        }, "删除");
        var mNode = el("div", {
          className: "model" + (mSel ? " selected" : ""), dataset: { name: "model" },
          onclick: function () { state.view = { kind: "model-edit", id: m.id }; refresh(); },
        }, [mName, fee, mRename, mDel]);
        modelWrap.appendChild(mNode);
      });
      if (!itsModels.length) modelWrap.appendChild(el("div", { className: "model-empty" }, "暂无模型"));
      node.appendChild(modelWrap);
    }
    return node;
  }

  function startInlineRename(labelEl, current, commit) {
    var input = el("input", { className: "inline-rename-input", value: current });
    labelEl.replaceWith(input);
    input.focus(); input.select();
    var done = false;
    function finish(save) {
      if (done) return; done = true;
      if (save) { var v = input.value.trim(); if (v) commit(v); }
      else renderTree();
    }
    input.addEventListener("blur", function () { finish(true); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
  }

  // ---- 视口（tab）----
  function refresh() { renderTree(); renderViewport(); }

  function renderViewport() {
    if (!viewport) return;
    viewport.innerHTML = "";
    var v = state.view;
    if (!v) { viewport.appendChild(el("div", { className: "viewport-empty" }, "从左侧选择供应者或模型，或新增一个。")); return; }
    if (v.kind === "provider-add") return viewport.appendChild(buildProviderAddTab());
    if (v.kind === "provider-edit") {
      var p = providerById(v.id);
      if (!p) { viewport.appendChild(el("div", { className: "viewport-empty" }, "供应者不存在")); return; }
      return viewport.appendChild(buildProviderEditTab(p));
    }
    if (v.kind === "model-add") return viewport.appendChild(buildModelAddTab(v.providerId));
    if (v.kind === "model-edit") {
      var m = state.models.find(function (x) { return String(x.id) === String(v.id); });
      if (!m) { viewport.appendChild(el("div", { className: "viewport-empty" }, "模型不存在")); return; }
      return viewport.appendChild(buildModelEditTab(m));
    }
  }

  function feeSelector(val) {
    var sel = el("select", { className: "fee-select", dataset: { name: "fee-select" } }, [
      el("option", { value: "free" }, "free"),
      el("option", { value: "paid" }, "paid"),
      el("option", { value: "__custom__" }, "自定义"),
    ]);
    var custom = el("input", { className: "fee-custom", type: "text", placeholder: "自定义费用", hidden: "hidden" });
    var known = ["free", "paid"];
    if (val && known.indexOf(val) === -1) { sel.value = "__custom__"; custom.value = val; custom.hidden = false; }
    else if (val) sel.value = val;
    sel.addEventListener("change", function () { custom.hidden = sel.value !== "__custom__"; if (sel.value === "__custom__") custom.focus(); });
    function get() { return sel.value === "__custom__" ? (custom.value.trim() || "free") : sel.value; }
    return { node: el("div", { className: "fee-selector", dataset: { name: "fee-selector" } }, [sel, custom]), get: get };
  }

  function effortEditor(value) {
    var levels = (value && Array.isArray(value.supported_levels)) ? value.supported_levels.slice() : [];
    var defaultLevel = (value && value.default_level) || "";
    var levelsInput = el("input", { className: "effort-levels-input", type: "text", placeholder: "low, high, max" });
    levelsInput.value = levels.join(", ");
    var defaultSel = el("select", { className: "effort-default-select", dataset: { name: "effort-default-select" } }, [
      el("option", { value: "" }, "（无）"),
    ]);
    // 当前选中的 default_level：首次初始化用传入的 defaultLevel 种子，之后随用户操作更新
    var curDefault = defaultLevel;
    function syncDefaultOptions() {
      defaultSel.innerHTML = "";
      defaultSel.appendChild(el("option", { value: "" }, "（无）"));
      levels.forEach(function (lv) { defaultSel.appendChild(el("option", { value: lv }, lv)); });
      // 保留之前选中的 default（仍在列表内时），否则回退到（无）
      defaultSel.value = levels.indexOf(curDefault) >= 0 ? curDefault : "";
    }
    syncDefaultOptions();
    levelsInput.addEventListener("input", function () {
      levels = levelsInput.value.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      syncDefaultOptions();
    });
    defaultSel.addEventListener("change", function () { curDefault = defaultSel.value; });
    function get() {
      var lv = levelsInput.value.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      var dl = defaultSel.value || null;
      if (!lv.length) return null;  // 留空表示不缓存 effort（退化为网络拉取）
      return { supported_levels: lv, default_level: dl };
    }
    var node = el("div", { className: "effort-editor", dataset: { name: "effort-editor" } }, [
      field("推理等级 supported_levels（逗号分隔）", levelsInput),
      field("提供商默认等级 default_level", defaultSel),
      el("div", { className: "form-note" }, "此处设定的是模型提供商的默认推理等级（静态元数据），供 composer 在无用户选择时兜底；与用户在对话界面自行选取的推理等级相互独立。"),
    ]);
    return { node: node, get: get };
  }

  function buildProviderAddTab() {
    var nameInput = el("input", { className: "name-input", type: "text", placeholder: "qiniu", value: "qiniu" });
    var descInput = el("textarea", { className: "description-input", placeholder: "选填" });
    var urlInput = el("input", { className: "baseurl-input", type: "text", placeholder: "https://api.example.com/v1" });
    var apiInput = el("input", { className: "apikey-input", type: "password", placeholder: "sk-..." });
    var toggle = el("button", { className: "apikey-toggle", type: "button" }, "显示");
    toggle.addEventListener("click", function () {
      if (apiInput.type === "password") { apiInput.type = "text"; toggle.textContent = "隐藏"; }
      else { apiInput.type = "password"; toggle.textContent = "显示"; }
    });

    var err = el("div", { className: "form-error", hidden: "hidden" });
    var form = el("div", { className: "provider-form", dataset: { name: "provider-form" } }, [
      field("名称", nameInput),
      field("描述", descInput),
      field("Base URL", urlInput),
      field("API Key", el("div", { className: "apikey-row" }, [apiInput, toggle])),
    ]);

    function save() {
      var name = nameInput.value.trim();
      var baseurl = urlInput.value.trim();
      if (!name) { return showErr(err, "名称必填"); }
      if (baseurl && !isValidUrl(baseurl)) return showErr(err, "Base URL 不是合法的 http(s) 地址");
      if (state.providers.some(function (p) { return p.name === name; })) return showErr(err, "供应者名称已存在");
      var np = { id: name, name: name, base_url: baseurl || null, api_key: apiInput.value || null, description: descInput.value.trim() || null, models: [] };
      state.providers.push(np);
      persistProviders().then(function () {
        state.view = { kind: "provider-edit", id: name }; refresh();
      }).catch(function (e) { showErr(err, "创建失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "form-footer" }, [
      el("button", { className: "cancel-btn", onclick: function () { state.view = null; refresh(); } }, "取消"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("新增供应者", form, footer, err);
  }

  function buildProviderEditTab(p) {
    var nameInput = el("input", { className: "name-input", type: "text", value: p.name });
    var descInput = el("textarea", { className: "description-input" }); descInput.value = p.description || "";
    var urlInput = el("input", { className: "baseurl-input", type: "text" }); urlInput.value = p.base_url || "";
    var apiInput = el("input", { className: "apikey-input", type: "password" }); apiInput.value = p.api_key || "";
    var toggle = el("button", { className: "apikey-toggle", type: "button" }, "显示");
    toggle.addEventListener("click", function () {
      if (apiInput.type === "password") { apiInput.type = "text"; toggle.textContent = "隐藏"; }
      else { apiInput.type = "password"; toggle.textContent = "显示"; }
    });

    var err = el("div", { className: "form-error", hidden: "hidden" });

    // 拉取远端模型（兼作连通性测试）：走后端 fetchModels，避免渲染层 CORS
    var fetchBtn = el("button", { className: "fetch-models-btn", type: "button", dataset: { name: "fetch-models-btn" } }, "拉取远端模型");
    var remoteStatus = el("span", { className: "conn-status", dataset: { name: "remote-status" } });
    var remoteModelsEl = el("div", { className: "remote-models", dataset: { name: "remote-models" } });

    var rows = [];
    function addOne(id, fee, btn) {
      if (modelsOf(p.id).some(function (m) { return m.name === id; })) {
        if (btn) { btn.textContent = "已添加"; btn.disabled = true; btn.className = (btn.className || "") + " added"; }
        return;
      }
      var m = { id: p.id + "#" + id, name: id, fee: fee || "unknown", provider_id: p.id };
      p.models.push(m); state.models.push(m);
      persistProviders().then(function () {
        renderTree();
        modelCountLabel.textContent = "模型 (" + modelsOf(p.id).length + ")";
        if (btn) { btn.textContent = "已添加"; btn.disabled = true; btn.className = (btn.className || "") + " added"; }
      }).catch(function (e) { if (window.uiAlert) uiAlert("添加失败：" + (e.message || e)); });
    }
    function renderRemoteList(list) {
      remoteModelsEl.innerHTML = ""; rows = [];
      if (!list.length) { remoteModelsEl.appendChild(el("div", { className: "model-empty" }, "远端未返回模型")); return; }
      var existing = modelsOf(p.id).map(function (m) { return m.name; });
      var addAll = el("button", { className: "add-all-btn", dataset: { name: "add-all-btn" }, onclick: function () {
        rows.forEach(function (r) { if (!r.added) addOne(r.id, r.feeSel.value, r.btn); });
      } }, "全部添加");
      remoteModelsEl.appendChild(el("div", { className: "remote-toolbar", dataset: { name: "remote-toolbar" } }, [addAll]));
      list.forEach(function (item) {
        var id = item.id;
        var added = existing.indexOf(id) >= 0;
        var feeSel = el("select", { className: "fee-select" }, [el("option", { value: "free" }, "free"), el("option", { value: "paid" }, "paid")]);
        var btn = el("button", { className: "remote-add-btn", dataset: { name: "remote-add-btn" } }, added ? "已添加" : "添加");
        if (added) { btn.disabled = true; btn.className += " added"; }
        btn.addEventListener("click", function () { addOne(id, feeSel.value, btn); });
        rows.push({ id: id, feeSel: feeSel, btn: btn, added: added });
        remoteModelsEl.appendChild(el("div", { className: "remote-model-item", dataset: { name: "remote-model-item" } }, [
          el("span", { className: "remote-model-id", dataset: { name: "remote-model-id" } }, id),
          feeSel,
          btn,
        ]));
      });
    }
    function loadRemoteModels() {
      var baseurl = urlInput.value.trim();
      var apikey = apiInput.value;
      remoteModelsEl.innerHTML = ""; remoteStatus.textContent = "拉取中…"; remoteStatus.className = "conn-status";
      if (!isValidUrl(baseurl)) { remoteStatus.textContent = "Base URL 不合法"; remoteStatus.className = "conn-status bad"; return; }
      window.AgentClient.call("fetchModels", { baseurl: baseurl, apikey: apikey }).then(function (list) {
        remoteStatus.textContent = "获取到 " + list.length + " 个模型"; remoteStatus.className = "conn-status ok";
        renderRemoteList(list);
      }).catch(function (e) { remoteStatus.textContent = "失败：" + (e.message || e); remoteStatus.className = "conn-status bad"; });
    }
    fetchBtn.addEventListener("click", loadRemoteModels);

    var form = el("div", { className: "provider-form", dataset: { name: "provider-form" } }, [
      field("名称", nameInput),
      field("描述", descInput),
      field("Base URL", urlInput),
      field("API Key", el("div", { className: "apikey-row" }, [apiInput, toggle])),
      el("div", { className: "fetch-row" }, [fetchBtn, remoteStatus]),
      remoteModelsEl,
    ]);

    var modelCountLabel = el("span", null, "模型 (" + modelsOf(p.id).length + ")");
    var itsModels = modelsOf(p.id);
    var modelSection = el("div", { className: "model-list-section", dataset: { name: "model-list-section" } }, [
      el("div", { className: "section-header", dataset: { name: "section-header" } }, [
        modelCountLabel,
        el("button", { className: "add-model-btn", dataset: { name: "add-model-btn" }, onclick: function () { state.view = { kind: "model-add", providerId: p.id }; state.expanded[p.id] = true; refresh(); } }, "+ 模型"),
      ]),
    ]);
    itsModels.forEach(function (m) {
      modelSection.appendChild(el("div", { className: "model-item", dataset: { name: "model-item" } }, [
        el("span", { className: "model-name-label", dataset: { name: "model-name-label" } }, m.name || ("模型 " + m.id)),
        el("span", { className: "model-fee-badge fee-" + (m.fee || "free"), dataset: { name: "model-fee-badge" } }, m.fee || "free"),
        el("button", { className: "model-edit-btn", dataset: { name: "model-edit-btn" }, onclick: function () { state.view = { kind: "model-edit", id: m.id }; refresh(); } }, "编辑"),
      ]));
    });

    var meta = el("div", { className: "provider-meta", dataset: { name: "provider-meta" } }, [
      el("span", { className: "created-at-label", dataset: { name: "created-at-label" } }, "创建：" + fmtDate(p.created_at)),
      el("span", { className: "updated-at-label", dataset: { name: "updated-at-label" } }, "更新：" + fmtDate(p.updated_at)),
    ]);

    function save() {
      var name = nameInput.value.trim();
      var baseurl = urlInput.value.trim();
      if (!name) return showErr(err, "名称必填");
      if (baseurl && !isValidUrl(baseurl)) return showErr(err, "Base URL 不是合法的 http(s) 地址");
      if (name !== p.name && state.providers.some(function (x) { return x.name === name; })) return showErr(err, "供应者名称已存在");
      // 改名：同步 id / 其下 model 的 provider_id
      if (name !== p.name) {
        var oldId = p.id;
        p.id = name; p.name = name;
        p.models.forEach(function (m) { m.provider_id = name; m.id = name + "#" + m.name; });
        state.models.forEach(function (m) { if (m.provider_id === oldId) { m.provider_id = name; m.id = name + "#" + m.name; } });
      }
      p.base_url = baseurl || null;
      p.api_key = apiInput.value || null;
      p.description = descInput.value.trim() || null;
      persistProviders().then(function () { refresh(); }).catch(function (e) { showErr(err, "保存失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "form-footer" }, [
      el("button", { className: "reset-btn", onclick: function () { refresh(); } }, "重置"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("编辑供应者", el("div", null, [form, modelSection, meta]), footer, err);
  }

  function buildModelAddTab(providerId) {
    var provider = providerById(providerId) || state.providers[0];
    var nameInput = el("input", { className: "name-input", type: "text", placeholder: "conatus-free", value: "conatus-free" });
    var descInput = el("textarea", { className: "description-input", placeholder: "选填" });
    var fee = feeSelector("free");
    var effort = effortEditor(null);
    var err = el("div", { className: "form-error", hidden: "hidden" });
    var form = el("div", { className: "model-form", dataset: { name: "model-form" } }, [
      el("div", { className: "provider-display", dataset: { name: "provider-display" } }, "所属供应者：" + (provider ? provider.name : "（无）")),
      field("名称", nameInput),
      field("描述", descInput),
      field("费用", fee.node),
      effort.node,
    ]);
    function save() {
      if (!provider) return showErr(err, "没有可用的供应者，请先新增供应者");
      var name = nameInput.value.trim();
      if (!name) return showErr(err, "名称必填");
      if (modelsOf(provider.id).some(function (m) { return m.name === name; })) return showErr(err, "该供应者下模型名已存在");
      var m = { id: provider.id + "#" + name, name: name, fee: fee.get() || "unknown", provider_id: provider.id, effort: effort.get() };
      provider.models.push(m); state.models.push(m);
      persistProviders().then(function () {
        state.view = { kind: "model-edit", id: m.id }; state.expanded[provider.id] = true; refresh();
      }).catch(function (e) { showErr(err, "创建失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "form-footer" }, [
      el("button", { className: "cancel-btn", onclick: function () { state.view = provider ? { kind: "provider-edit", id: provider.id } : null; refresh(); } }, "取消"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("新增模型", form, footer, err);
  }

  function buildModelEditTab(m) {
    var provider = providerById(m.provider_id);
    var nameInput = el("input", { className: "name-input", type: "text" }); nameInput.value = m.name || "";
    var descInput = el("textarea", { className: "description-input" }); descInput.value = m.description || "";
    var fee = feeSelector(m.fee);
    var effort = effortEditor(m.effort);
    var err = el("div", { className: "form-error", hidden: "hidden" });
    var form = el("div", { className: "model-form", dataset: { name: "model-form" } }, [
      el("div", { className: "provider-display", dataset: { name: "provider-display" }, onclick: function () { if (provider) { state.view = { kind: "provider-edit", id: provider.id }; refresh(); } } }, "所属供应者：" + (provider ? provider.name + "（点击跳转）" : "（无）")),
      field("名称", nameInput),
      field("描述", descInput),
      field("费用", fee.node),
      effort.node,
    ]);
    var meta = el("div", { className: "model-meta", dataset: { name: "model-meta" } }, [
      el("span", { className: "created-at-label", dataset: { name: "created-at-label" } }, "创建：" + fmtDate(m.created_at)),
      el("span", { className: "updated-at-label", dataset: { name: "updated-at-label" } }, "更新：" + fmtDate(m.updated_at)),
    ]);
    function save() {
      var name = nameInput.value.trim();
      if (!name) return showErr(err, "名称必填");
      if (name !== m.name && modelsOf(m.provider_id).some(function (x) { return x.name === name; })) return showErr(err, "该供应者下模型名已存在");
      m.name = name;
      m.fee = fee.get() || "unknown";
      m.effort = effort.get();
      persistProviders().then(function () { refresh(); }).catch(function (e) { showErr(err, "保存失败：" + (e.message || e)); });
    }
    var footer = el("div", { className: "form-footer" }, [
      el("button", { className: "reset-btn", onclick: function () { refresh(); } }, "重置"),
      el("button", { className: "save-btn", onclick: save }, "保存"),
    ]);
    return tabShell("编辑模型", el("div", null, [form, meta]), footer, err);
  }

  function tabShell(title, body, footer, err) {
    return el("div", { className: "models-tab" }, [
      el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [el("span", { className: "tab-title", dataset: { name: "tab-title" } }, title)]),
      el("div", { className: "tab-body-inner" }, [err, body]),
      footer,
    ]);
  }
  function showErr(errEl, msg) { errEl.textContent = msg; errEl.hidden = false; }

  // ---- 写操作（统一：改内存 -> 整体 upsert user/providers.json）----
  function findProvider(id) { return state.providers.find(function (p) { return String(p.id) === String(id); }); }
  function findModel(id) { return state.models.find(function (m) { return String(m.id) === String(id); }); }
  function doUpdateProvider(id, patch) {
    var p = findProvider(id);
    if (!p) return;
    Object.assign(p, patch);
    persistProviders().then(function () { refresh(); })
      .catch(function (e) { if (window.uiAlert) uiAlert("更新失败：" + (e.message || e)); });
  }
  function doUpdateModel(id, patch) {
    var m = findModel(id);
    if (!m) return;
    Object.assign(m, patch);
    persistProviders().then(function () { renderTree(); })
      .catch(function (e) { if (window.uiAlert) uiAlert("更新失败：" + (e.message || e)); });
  }
  async function deleteProvider(id) {
    if (!(window.uiConfirm && await window.uiConfirm("删除该供应者及其下所有模型？此操作不可撤销。"))) return;
    try {
      state.providers = state.providers.filter(function (p) { return String(p.id) !== String(id); });
      await persistProviders();
      if (state.view && state.view.kind === "provider-edit" && String(state.view.id) === String(id)) state.view = null;
      refresh();
    } catch (e) { if (window.uiAlert) uiAlert("删除失败：" + (e.message || e)); }
  }
  async function deleteModel(id) {
    if (!(window.uiConfirm && await window.uiConfirm("删除该模型？"))) return;
    try {
      var m = findModel(id); if (!m) return;
      var p = findProvider(m.provider_id);
      if (p) p.models = p.models.filter(function (x) { return String(x.id) !== String(id); });
      await persistProviders();
      if (state.view && state.view.kind === "model-edit" && String(state.view.id) === String(id)) state.view = null;
      refresh();
    } catch (e) { if (window.uiAlert) uiAlert("删除失败：" + (e.message || e)); }
  }

  // ---- 导入 / 导出 ----
  function exportConfig() {
    // 直接基于 user/providers.json 的序列化结果（已含嵌套 models 与 fee）
    var data = { version: 1, providers: serializeProviders().map(function (p) {
      var c = { name: p.name };
      if (p.base_url != null) c.base_url = p.base_url;
      if (p.api_key != null) c.api_key = maskKey(p.api_key);
      if (p.description != null) c.description = p.description;
      c.models = (p.models || []).map(function (m) {
        var mo = { name: m.name, fee: m.fee || "unknown" };
        if (m.effort) mo.effort = m.effort;
        return mo;
      });
      return c;
    }) };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "agent-config.json";
    document.body.appendChild(a); a.click(); a.remove();
  }
  function importConfig() {
    var input = el("input", { type: "file", accept: "application/json,.json" });
    input.style.display = "none";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          var imported = (data.providers || []).map(function (p) {
            var models = (Array.isArray(p.models) ? p.models : []).map(function (m) {
              var mn = (typeof m === "string") ? m : (m && m.name);
              var mo = { name: mn, fee: (m && m.fee) || "unknown" };
              if (m && m.effort) mo.effort = m.effort;
              return mo;
            });
            return { name: p.name, base_url: p.base_url || null, api_key: p.api_key || null, description: p.description || null, models: models };
          });
          state.providers = imported.map(function (p) {
            var id = p.name;
            return {
              id: id, name: p.name, base_url: p.base_url || null, api_key: p.api_key || null, description: p.description || null,
              models: (p.models || []).map(function (m) { return { id: id + "#" + m.name, name: m.name, fee: m.fee || "unknown", provider_id: id }; }),
            };
          });
          state.models = [];
          state.providers.forEach(function (p) { p.models.forEach(function (m) { state.models.push(m); }); });
          persistProviders().then(function () { state.view = null; refresh(); })
            .catch(function (e) { if (window.uiAlert) uiAlert("导入失败：" + (e.message || e)); });
        } catch (e) { if (window.uiAlert) uiAlert("导入失败：文件格式错误"); }
      };
      reader.readAsText(f);
    });
    document.body.appendChild(input); input.click(); input.remove();
  }

  // ---- 打开 / 关闭 ----
  function buildShell() {
    searchInputEl = el("input", {
      className: "tree-search-input", type: "text", placeholder: "过滤供应者 / 模型",
      dataset: { name: "tree-search-input" },
      oninput: function (e) { state.search = e.target.value; renderTree(); },
    });
    var addBtn = el("button", {
      className: "add-provider-btn", dataset: { name: "add-provider-btn" },
      onclick: function () { state.view = { kind: "provider-add" }; refresh(); },
    }, "+ 新增供应者");
    providerListEl = el("div", { className: "provider-list" });

    treeList = el("div", { className: "provider-model-tree-list", dataset: { name: "provider-model-tree-list" } }, [
      el("div", { className: "tree-search-wrap" }, [searchInputEl]),
      addBtn,
      providerListEl,
    ]);

    viewport = el("div", { className: "models-viewport", dataset: { name: "models-viewport" } });

    var panel = el("div", { className: "models-panel", dataset: { name: "models-panel" } }, [
      el("button", { className: "import-config-btn", dataset: { name: "import-config-btn" }, onclick: importConfig }, "导入配置"),
      el("button", { className: "export-config-btn", dataset: { name: "export-config-btn" }, onclick: exportConfig }, "导出配置"),
      el("div", { className: "danger-zone", dataset: { name: "danger-zone" } },
        el("button", { className: "clear-all-btn", onclick: clearAll }, "清空所有配置")
      ),
      el("button", { className: "close-models-btn", dataset: { name: "close-models-btn" }, onclick: closeModels }, "关闭"),
    ]);

    var win = el("div", { className: "models-window" }, [
      el("div", { className: "models-sidebar", dataset: { name: "models-sidebar" } }, [treeList]),
      viewport,
      panel,
    ]);
    overlay = el("div", { className: "models-modal", dataset: { name: "models-modal" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModels(); });
    document.body.appendChild(overlay);
  }

  async function clearAll() {
    if (!(window.uiConfirm && await window.uiConfirm("清空所有供应者与模型？此操作不可撤销。"))) return;
    try {
      state.providers = []; state.models = []; state.view = null;
      await persistProviders();
      refresh();
    } catch (e) { if (window.uiAlert) uiAlert("清空失败：" + (e.message || e)); }
  }

  async function openModels() {
    if (!overlay) buildShell();
    state.view = null; state.search = "";
    overlay.style.display = "flex";
    await loadData();
    refresh();
  }
  function closeModels() { if (overlay) overlay.style.display = "none"; }

  ready(function () {
    var btn = document.getElementById("modelsBtn");
    if (btn) btn.addEventListener("click", openModels);
  });
})();
