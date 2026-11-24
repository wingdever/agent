"use strict";
// loops-modal: node-graph loop topology + hook overlay editor.
//   - Left: read-only static next chain + live hooks overlay (dashed edges).
//   - Right: editable hook table (id/type/next are read-only; next is a label, not a select).
// Depends on window.AgentClient (api.js) and window.uiConfirm/uiAlert (app.js).
// Layout tree: see docs/ui/ui.md loops-modal.
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
    { on: "assemble-input", slot: "before", target: "builtin.translate-input" },
    { on: "model-call", slot: "after", target: "builtin.translate-output" },
  ];
  var SLOTS = ["before", "after", "onError"];

  // Static next chain (decide-next loops back to pre-step).
  var CHAIN = [
    "turn-start",
    "resolve-target",
    "assemble-system",
    "assemble-input",
    "pre-step",
    "model-call",
    "tool-execute",
    "decide-next",
  ];
  var LOOP_BACK = { from: "decide-next", to: "pre-step" };

  // ---- Module state ----
  var state = {
    data: null,   // loops.list result
    hooks: [],    // flat editable overlay array (deep copy of data.hooks)
    dirty: false,
  };

  var overlay = null, topologyEl = null, tableEl = null;
  var engineIndicatorEl = null; // 表头右槽里的「当前引擎」指示器
  var saveBtnEl = null;         // 表头右槽的「保存」
  var undoBtnEl = null;         // 表头右槽的「撤销修改」

  // Backend wrapper: loops.fn with op.
  function api(op, payload) {
    if (op === "get") return window.AgentClient.call("loops.get", {});
    if (op === "list") return window.AgentClient.call("loops.list", {});
    if (op === "upsert") return window.AgentClient.call("loops.upsert", { payload: payload || {} });
    return Promise.reject(new Error("unknown loops op: " + op));
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

  // ---- Header indicator: current engine ----
  // 引擎由环境变量决定、重启生效，界面不可改，所以只做只读指示器；点击弹说明。
  function buildEngineIndicator() {
    engineIndicatorEl = el("button", {
      className: "engine-indicator",
      dataset: { name: "engine-indicator" },
      title: "点击查看引擎与拓扑统计",
      onclick: function () {
        var data = state.data || {};
        var nodeCount = (data.nodes || []).length;
        var builtinCount = (data.builtins || []).length;
        // 循环边数 = next 链边数 + decide-next 的回边
        var loopEdges = (data.nodes || []).filter(function (n) { return n.next; }).length + 1;
        if (window.uiAlert) {
          window.uiAlert("当前引擎: " + (data.currentEngine || "—") +
            "\n由 AGENT_LOOP_ENGINE 决定，重启生效（只读）" +
            "\n节点数: " + nodeCount + " (含 builtin " + builtinCount + ")" +
            "\n循环边数: " + loopEdges);
        }
      },
    }, "当前引擎: —");
    return engineIndicatorEl;
  }

  function renderEngineIndicator() {
    if (!engineIndicatorEl) return;
    var data = state.data || {};
    var name = data.currentEngine || "—";
    engineIndicatorEl.textContent = "当前引擎: " + name;
    engineIndicatorEl.setAttribute("data-engine", name);
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
    syncEditButtons(); // 每次重绘表格都按 dirty 刷新「保存 / 撤销修改」可用态
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
    renderEngineIndicator();
    renderTopology();
    renderTable();
    syncEditButtons();
  }

  // 「保存 / 撤销修改」只在有未保存改动时可用。
  function syncEditButtons() {
    if (saveBtnEl) saveBtnEl.disabled = !state.dirty;
    if (undoBtnEl) undoBtnEl.disabled = !state.dirty;
    if (window.App && window.App.setViewDirty) window.App.setViewDirty("loops", state.dirty);
  }

  // ---- Shell ----
  // 左栏（循环拓扑标题 + 统计）已取消：统计并入表头「当前引擎」提示，拓扑与节点表占满整页。
  function buildShell() {
    topologyEl = el("div", { className: "loop-topology", dataset: { name: "loop-topology" } });
    tableEl = el("div", { className: "loop-nodes-table", dataset: { name: "loop-nodes-table" } });

    // 表尾操作条：撤销修改 / 保存（当前配置这层对象的常用操作）。
    undoBtnEl = el("button", {
      className: "reset-btn", dataset: { name: "undo-btn" },
      title: "丢弃页面上尚未保存的改动，重新载入当前配置",
      onclick: resetEdits,
    }, "撤销修改");
    saveBtnEl = el("button", {
      className: "save-btn", dataset: { name: "save-btn" },
      title: "把当前修改写入配置",
      onclick: saveHooks,
    }, "保存");
    var foot = el("div", { className: "config-footer", dataset: { name: "config-footer" } }, [
      el("span", { className: "config-footer-spacer" }),
      undoBtnEl,
      saveBtnEl,
    ]);

    var viewport = el("div", { className: "loops-viewport", dataset: { name: "loops-viewport" } }, [
      el("div", { className: "loops-viewport-split", dataset: { name: "loops-viewport-split" } }, [topologyEl, tableEl]),
      foot,
    ]);

    var win = el("div", { className: "loops-window", dataset: { name: "loops-window" } }, [viewport]);
    overlay = el("div", { className: "loops-modal", dataset: { name: "loops-page" } }, [win]);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeLoops(); });
    window.App.mountViewPage(overlay, "loops");
  }

  // ---- Open / close ----
  async function openLoops() {
    if (!overlay) buildShell();
    overlay.hidden = false;
    try {
      await loadData();
      refresh();
    } catch (e) {
      if (window.uiAlert) window.uiAlert("加载循环配置失败：" + (e.message || e));
    }
  }
  function closeLoops() { if (overlay) overlay.hidden = true; window.App.showView("chat"); }

  ready(function () {
    if (window.App && window.App.registerView) {
      // 表头右槽只放：当前引擎指示器 + 「更多」里的恢复默认 hooks（危险操作）。
      window.App.registerView("loops", {
        title: "循环",
        header: function () {
          var flat = window.document.createElement("div");
          flat.className = "view-actions";
          // 表头只放指示器与低频/危险操作的入口：保存 / 撤销修改在表尾。
          flat.appendChild(window.App.buildViewActions([
            // 与「撤销修改」区别：这会写后端，把配置整体替换成仓库默认值。
            { label: "恢复默认 hooks（丢弃当前配置）", className: "reset-defaults-btn", danger: true, onClick: resetDefaults },
          ]));
          // 当前引擎只读指示器（点击看说明），与聊天页的「模式」同类。
          flat.insertBefore(buildEngineIndicator(), flat.firstChild);
          renderEngineIndicator();
          syncEditButtons();
          return flat;
        },
      });
    }
    var btn = document.getElementById("loopsBtn");
    if (btn) btn.addEventListener("click", openLoops);
  });
})();
