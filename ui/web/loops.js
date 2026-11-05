"use strict";
// loops-modal: node-graph loop topology + hook overlay editor.
//   - Left: read-only static next chain + live hooks overlay (dashed edges).
//   - Right: editable hook table (id/type/next are read-only; next is a label, not a select).
// Depends on window.AgentClient (api.js) and window.uiConfirm/uiAlert (app.js).
// Layout tree: see docs/ui.md loops-modal.
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ---- Minimal DOM builder (same as models.js / permissions.js) ----
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
  function option(value, text) { return el("option", { value: value }, text); }

  // Repo default hook entries (REAL prefixed builtin ids). Used by reset-defaults.
  var DEFAULT_HOOKS = [
    { on: "resolve-input", slot: "before", target: "builtin.translate-input" },
    { on: "model-request", slot: "after", target: "builtin.translate-output" },
  ];
  var SLOTS = ["before", "after", "onError"];

  // Static next chain (decide-next loops back to auto-compact).
  var CHAIN = [
    "resolve-input",
    "resolve-model",
    "assemble-system",
    "build-context",
    "auto-compact",
    "model-request",
    "tool-approve",
    "tool-run",
    "plan-review",
    "decide-next",
  ];
  var LOOP_BACK = { from: "decide-next", to: "auto-compact" };

  // ---- Module state ----
  var state = {
    data: null,   // loops.list result
    hooks: [],    // flat editable overlay array (deep copy of data.hooks)
    dirty: false,
  };

  var overlay = null, summaryEl = null, topologyEl = null, tableEl = null;

  // Backend wrapper: loops.fn with op.
  function api(op, payload) {
    return window.AgentClient.call("loops", { op: op, payload: payload || {} });
  }

  function clone(arr) {
    return (arr || []).map(function (h) { return { on: h.on, slot: h.slot, target: h.target }; });
  }

  // All selectable node ids: CORE nodes + builtins (main nodes allowed as hook targets).
  function allNodeIds() {
    var ids = [];
    (state.data.nodes || []).forEach(function (n) { ids.push(n.id); });
    (state.data.builtins || []).forEach(function (b) {
      var id = (b && typeof b === "object" && b.id) ? b.id : b;
      if (id && ids.indexOf(id) === -1) ids.push(id);
    });
    return ids;
  }

  function nodeRows() {
    // Right table shows ALL nodes: core + builtin. Builtins get a "builtin" type + empty next.
    var rows = (state.data.nodes || []).map(function (n) {
      return { id: n.id, type: n.type || "core", next: n.next || "" };
    });
    (state.data.builtins || []).forEach(function (b) {
      var id = (b && typeof b === "object" && b.id) ? b.id : b;
      if (!id) return;
      if (!rows.some(function (r) { return r.id === id; })) {
        rows.push({ id: id, type: (b && b.type) || "builtin", next: "" });
      }
    });
    return rows;
  }

  async function loadData() {
    var res = await api("get", {});
    state.data = res || { nodes: [], builtins: [], hooks: [], currentEngine: "", defaultEngine: "", engines: [] };
    state.hooks = clone(state.data.hooks);
    state.dirty = false;
  }

  // ---- Summary (left sidebar) ----
  function renderSummary() {
    if (!summaryEl) return;
    summaryEl.innerHTML = "";
    var nodeCount = (state.data.nodes || []).length;
    var builtinCount = (state.data.builtins || []).length;
    // Loop edges = next chain edges (each core node with a next) + the decide-next loop-back.
    var loopEdges = (state.data.nodes || []).filter(function (n) { return n.next; }).length + 1;
    summaryEl.appendChild(el("div", { className: "current-engine-label", dataset: { name: "current-engine-label" } },
      "当前引擎: " + (state.data.currentEngine || "—")));
    summaryEl.appendChild(el("div", { className: "engine-note", dataset: { name: "engine-note" } },
      "由 AGENT_LOOP_ENGINE 决定，重启生效（只读）"));
    summaryEl.appendChild(el("div", { className: "loop-node-count-label", dataset: { name: "loop-node-count-label" } },
      "节点数: " + nodeCount + " (含 builtin " + builtinCount + ")"));
    summaryEl.appendChild(el("div", { className: "loop-edge-count-label", dataset: { name: "loop-edge-count-label" } },
      "循环边数: " + loopEdges));
  }

  // ---- Left: read-only topology ----
  function renderTopology() {
    if (!topologyEl) return;
    topologyEl.innerHTML = "";

    var chainWrap = el("div", { className: "loop-topology-chain", dataset: { name: "loop-topology-chain" } });
    CHAIN.forEach(function (id, i) {
      chainWrap.appendChild(el("div", {
        className: "loop-topology-node", dataset: { name: "loop-topology-node" },
      }, id));
      if (i < CHAIN.length - 1) {
        chainWrap.appendChild(el("div", { className: "loop-topology-arrow" }, "↓"));
      }
    });
    // loop back edge
    chainWrap.appendChild(el("div", {
      className: "loop-topology-loopback", dataset: { name: "loop-topology-loopback" },
    }, "↺ step 循环: " + LOOP_BACK.from + " → " + LOOP_BACK.to));
    topologyEl.appendChild(chainWrap);

    // Live hooks overlay (dashed edges: on --slot--> target)
    var hooksWrap = el("div", { className: "loop-topology-hooks", dataset: { name: "loop-topology-hooks" } }, [
      el("div", { className: "section-header", dataset: { name: "section-header" } }, "Live hooks (" + state.hooks.length + ")"),
    ]);
    if (!state.hooks.length) {
      hooksWrap.appendChild(el("div", { className: "tree-empty" }, "无 hook 覆盖"));
    } else {
      state.hooks.forEach(function (h) {
        hooksWrap.appendChild(el("div", {
          className: "loop-hook-edge", dataset: { name: "loop-hook-edge" },
        }, [
          el("span", { className: "loop-hook-edge-on" }, h.on),
          el("span", { className: "loop-hook-edge-slot" }, "—[" + h.slot + "]→"),
          el("span", { className: "loop-hook-edge-target" }, h.target),
        ]));
      });
    }
    // Builtin target cluster
    hooksWrap.appendChild(el("div", { className: "loop-builtin-cluster", dataset: { name: "loop-builtin-cluster" } },
      "builtin: " + ((state.data.builtins || []).map(function (b) {
        return (b && typeof b === "object" && b.id) ? b.id : b;
      }).join(" · ") || "—")));
    topologyEl.appendChild(hooksWrap);
  }

  // ---- Right: editable hook table ----
  function setDirty() {
    state.dirty = true;
    renderTopology(); // live overlay refresh
  }

  // Find the flat-array index of a hook entry by identity (on+slot+target) — used on edit/remove.
  function findHookIndex(on, slot, target) {
    for (var i = 0; i < state.hooks.length; i++) {
      var h = state.hooks[i];
      if (h.on === on && h.slot === slot && h.target === target) return i;
    }
    return -1;
  }

  function buildTargetSelect(currentTarget, onChange) {
    var sel = el("select", { className: "hook-target-select", dataset: { name: "hook-target-select" } });
    allNodeIds().forEach(function (id) { sel.appendChild(option(id, id)); });
    sel.value = currentTarget;
    if (onChange) sel.addEventListener("change", function () { onChange(sel.value); });
    return sel;
  }

  function renderTable() {
    if (!tableEl) return;
    tableEl.innerHTML = "";
    var ids = allNodeIds();
    var rows = nodeRows();

    rows.forEach(function (node) {
      var editor = el("div", { className: "loop-hooks-editor", dataset: { name: "loop-hooks-editor" } });

      SLOTS.forEach(function (slot) {
        var group = el("div", { className: "hook-slot", dataset: { name: "hook-slot" } });
        group.appendChild(el("span", { className: "hook-slot-label" }, slot + ":"));

        // Hooks of THIS node in THIS slot (preserve flat-array order for display).
        var mine = [];
        state.hooks.forEach(function (h, idx) {
          if (h.on === node.id && h.slot === slot) mine.push({ hook: h, idx: idx });
        });

        mine.forEach(function (entry) {
          var hook = entry.hook;
          var rowEl = el("div", { className: "hook-entry", dataset: { name: "hook-entry" } });
          var sel = buildTargetSelect(hook.target, function (newTarget) {
            // Replace target at the flat-array index, preserving position (= exec order).
            state.hooks[entry.idx] = { on: hook.on, slot: hook.slot, target: newTarget };
            setDirty();
            renderTable();
          });
          var removeBtn = el("button", {
            className: "hook-remove-btn", dataset: { name: "hook-remove-btn" },
            onclick: function () {
              var i = findHookIndex(hook.on, hook.slot, hook.target);
              if (i >= 0) state.hooks.splice(i, 1);
              else state.hooks.splice(entry.idx, 1);
              setDirty();
              renderTable();
            },
          }, "删除");
          rowEl.appendChild(sel);
          rowEl.appendChild(removeBtn);
          group.appendChild(rowEl);
        });

        var addBtn = el("button", {
          className: "hook-add-btn", dataset: { name: "hook-add-btn" },
          onclick: function () {
            // Append at the end of the flat array = append to exec order for this (on, slot).
            var target = ids[0] || "";
            state.hooks.push({ on: node.id, slot: slot, target: target });
            setDirty();
            renderTable();
          },
        }, "+ " + slot);
        group.appendChild(addBtn);
        editor.appendChild(group);
      });

      tableEl.appendChild(el("div", { className: "loop-node-row", dataset: { name: "loop-node-row" } }, [
        el("span", { className: "loop-node-id-label", dataset: { name: "loop-node-id-label" } }, node.id),
        el("span", { className: "loop-node-type-label", dataset: { name: "loop-node-type-label" } }, node.type),
        // next is READ-ONLY text, NOT a select.
        el("span", { className: "loop-next-label", dataset: { name: "loop-next-label" } }, node.next || "—"),
        editor,
      ]));
    });
  }

  // ---- Save / reset ----
  async function saveHooks() {
    if (!state.dirty) return;
    try {
      await api("upsert", { hooks: clone(state.hooks) });
      await loadData();
      refresh();
      if (window.uiAlert) window.uiAlert("保存成功");
    } catch (e) {
      if (window.uiAlert) window.uiAlert("保存失败：" + (e.message || e));
    }
  }

  async function resetEdits() {
    await loadData(); // discard unsaved edits, reload list
    refresh();
  }

  async function resetDefaults() {
    if (!(window.uiConfirm && await window.uiConfirm("恢复仓库默认的两个翻译 hook 覆盖？当前编辑将被替换。"))) return;
    try {
      await api("upsert", { hooks: clone(DEFAULT_HOOKS) });
      await loadData();
      refresh();
    } catch (e) {
      if (window.uiAlert) window.uiAlert("恢复默认失败：" + (e.message || e));
    }
  }

  function refresh() {
    renderSummary();
    renderTopology();
    renderTable();
  }

  // ---- Shell ----
  function buildShell() {
    summaryEl = el("div", { className: "loops-summary", dataset: { name: "loops-summary" } });
    var sidebar = el("div", { className: "loops-sidebar", dataset: { name: "loops-sidebar" } }, [
      el("div", { className: "tab-header", dataset: { name: "tab-header" } }, [
        el("span", { className: "tab-title", dataset: { name: "tab-title" } }, "循环拓扑"),
      ]),
      summaryEl,
    ]);

    topologyEl = el("div", { className: "loop-topology", dataset: { name: "loop-topology" } });
    tableEl = el("div", { className: "loop-nodes-table", dataset: { name: "loop-nodes-table" } });

    var configFooter = el("div", { className: "config-footer", dataset: { name: "config-footer" } }, [
      el("button", { className: "reset-btn", dataset: { name: "reset-btn" }, onclick: resetEdits }, "重置"),
      el("button", { className: "save-btn", dataset: { name: "save-btn" }, onclick: saveHooks }, "保存"),
    ]);

    var viewport = el("div", { className: "loops-viewport", dataset: { name: "loops-viewport" } }, [
      el("div", { className: "loops-viewport-split" }, [topologyEl, tableEl]),
      configFooter,
    ]);

    var panel = el("div", { className: "loops-panel", dataset: { name: "loops-panel" } }, [
      el("div", { className: "danger-zone", dataset: { name: "danger-zone" } },
        el("button", { className: "reset-defaults-btn", dataset: { name: "reset-defaults-btn" }, onclick: resetDefaults }, "恢复默认 hooks")
      ),
      el("button", { className: "close-loops-btn", dataset: { name: "close-loops-btn" }, onclick: closeLoops }, "关闭"),
    ]);

    var win = el("div", { className: "loops-window", dataset: { name: "loops-window" } }, [sidebar, viewport, panel]);
    overlay = el("div", { className: "loops-modal", dataset: { name: "loops-modal" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeLoops(); });
    document.body.appendChild(overlay);
  }

  // ---- Open / close ----
  async function openLoops() {
    if (!overlay) buildShell();
    overlay.style.display = "flex";
    try {
      await loadData();
      refresh();
    } catch (e) {
      if (window.uiAlert) window.uiAlert("加载循环配置失败：" + (e.message || e));
    }
  }
  function closeLoops() { if (overlay) overlay.style.display = "none"; }

  ready(function () {
    var btn = document.getElementById("loopsBtn");
    if (btn) btn.addEventListener("click", openLoops);
  });
})();
