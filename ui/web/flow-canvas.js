"use strict";
// flow-canvas: 节点图编排画布（docs/flow/flow.md）。
//
// 与 agent 层的会话、轨迹、工具卡片完全无关：本文件只通过 flow.* RPC 读写
// 图定义与执行，界面由一个覆盖层（列表 + 画布 + 属性面板）组成。
//
// 画布自己实现，不依赖 React：节点是绝对定位的 div，边是一条 SVG path，
// 拖节点改 position，从输出口拖到输入口建边，中键或空格拖平移、滚轮缩放。
(function () {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ---- small DOM helper (same shape as tools-ui.js) ----
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
      else if (k === "style") { for (var s in v) e.style[s] = v[s]; }
      else if (k === "checked" || k === "disabled") e[k] = !!v;
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

  function api(name, params) {
    return window.AgentClient.call(name, params || {});
  }

  // Streaming call: the transport routes every server event to `onEvent` and
  // resolves with the final `result` event.
  function apiStream(name, params, onEvent) {
    return window.AgentClient.call(name, params || {}, onEvent);
  }

  // ---- module state ----
  var state = {
    open: false,
    types: {},          // flow.nodeTypes()
    flows: [],          // flow.list()
    flow: null,         // { id, name, description, definition } 当前编辑
    selected: null,     // 选中节点 id
    run: null,          // { runId, nodeStatus: { nodeId: status } }
    view: { x: 0, y: 0, scale: 1 },
    sidebarWasCollapsed: false,
  };

  var dom = {};          // overlay / list / canvas / svg / panel / status

  // ---- 图模型辅助 ----

  function newId(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 9);
  }

  function emptyDefinition() {
    return {
      nodes: [
        { id: "start_1", type: "start", position: { x: 60, y: 120 }, data: {} },
        { id: "end_1", type: "end", position: { x: 560, y: 120 }, data: {} },
      ],
      edges: [],
    };
  }

  function definition() {
    if (!state.flow.definition) state.flow.definition = emptyDefinition();
    return state.flow.definition;
  }

  function nodeById(id) {
    return definition().nodes.filter(function (n) { return n.id === id; })[0] || null;
  }

  // 每个节点的端口坐标（画布坐标系，未乘缩放）
  var NODE_W = 180;
  var HEADER_H = 30;
  var PORT_ROW_H = 22;

  function portPoint(node, port, kind) {
    var ports = state.types[node.type] ? state.types[node.type][kind === "in" ? "inputs" : "outputs"] : [];
    var index = Math.max(0, ports.indexOf(port));
    return {
      x: node.position.x + (kind === "in" ? 0 : NODE_W),
      y: node.position.y + HEADER_H + PORT_ROW_H * index + PORT_ROW_H / 2,
    };
  }

  // ---- 渲染：画布 ----

  function applyView() {
    if (!dom.world) return;
    dom.world.style.transform =
      "translate(" + state.view.x + "px," + state.view.y + "px) scale(" + state.view.scale + ")";
  }

  function renderCanvas() {
    if (!dom.world) return;
    dom.world.innerHTML = "";
    var def = definition();

    // edges first (so nodes paint above)
    def.edges.forEach(function (edge) {
      var from = nodeById(edge.source);
      var to = nodeById(edge.target);
      if (!from || !to) return;
      var a = portPoint(from, edge.sourcePort, "out");
      var b = portPoint(to, edge.targetPort, "in");
      var dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      var d = "M" + a.x + "," + a.y + " C" + (a.x + dx) + "," + a.y + " " + (b.x - dx) + "," + b.y + " " + b.x + "," + b.y;
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "flow-edge" + (state.selected && state.selected === edge.id ? " selected" : ""));
      path.addEventListener("click", function (ev) {
        ev.stopPropagation();
        state.selected = edge.id;
        renderAll();
      });
      dom.edges.appendChild(path);
    });

    def.nodes.forEach(function (node) { dom.world.appendChild(renderNode(node)); });
  }

  function renderNode(node) {
    var type = state.types[node.type] || { label: node.type, inputs: [], outputs: [] };
    var status = state.run && state.run.nodeStatus[node.id];
    var box = el("div", {
      className: "flow-node" + (state.selected === node.id ? " selected" : "") + (status ? " " + status : ""),
      dataset: { nodeId: node.id },
      style: { left: node.position.x + "px", top: node.position.y + "px", width: NODE_W + "px" },
    });
    box.appendChild(el("div", { className: "flow-node-header" }, [
      el("span", { className: "flow-node-type" }, type.label || node.type),
      el("span", { className: "flow-node-id" }, node.id),
    ]));

    var body = el("div", { className: "flow-node-ports" });
    var rows = Math.max(type.inputs.length, type.outputs.length);
    for (var i = 0; i < rows; i += 1) {
      var row = el("div", { className: "flow-port-row" });
      var inName = type.inputs[i];
      var outName = type.outputs[i];
      row.appendChild(inName
        ? el("span", { className: "flow-port flow-port-in", dataset: { port: inName, node: node.id } }, "● " + inName)
        : el("span", { className: "flow-port" }));
      row.appendChild(outName
        ? el("span", { className: "flow-port flow-port-out", dataset: { port: outName, node: node.id } }, outName + " ●")
        : el("span", { className: "flow-port" }));
      body.appendChild(row);
    }
    box.appendChild(body);

    box.addEventListener("mousedown", function (ev) {
      if (ev.target.closest && ev.target.closest(".flow-port")) return;
      startDragNode(ev, node);
    });
    box.addEventListener("click", function (ev) {
      ev.stopPropagation();
      state.selected = node.id;
      renderAll();
    });
    box.querySelectorAll(".flow-port-out").forEach(function (port) {
      port.addEventListener("mousedown", function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        startDragEdge(ev, node, port.getAttribute("data-port"));
      });
    });
    return box;
  }

  // ---- 拖拽：节点 ----

  function startDragNode(ev, node) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    var startX = ev.clientX;
    var startY = ev.clientY;
    var originX = node.position.x;
    var originY = node.position.y;
    function move(e) {
      node.position.x = Math.round(originX + (e.clientX - startX) / state.view.scale);
      node.position.y = Math.round(originY + (e.clientY - startY) / state.view.scale);
      renderCanvas();
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---- 拖拽：连线 ----

  function startDragEdge(ev, node, portName) {
    var ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ghost.setAttribute("class", "flow-edge ghost");
    dom.edges.appendChild(ghost);
    var a = portPoint(node, portName, "out");
    var rect = dom.canvas.getBoundingClientRect();
    function movePoint(e) {
      var b = {
        x: (e.clientX - rect.left - state.view.x) / state.view.scale,
        y: (e.clientY - rect.top - state.view.y) / state.view.scale,
      };
      var dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      ghost.setAttribute("d", "M" + a.x + "," + a.y + " C" + (a.x + dx) + "," + a.y + " " + (b.x - dx) + "," + b.y + " " + b.x + "," + b.y);
    }
    function move(e) {
      movePoint(e);
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var inputPort = target && target.closest ? target.closest(".flow-port-in") : null;
      dom.world.querySelectorAll(".flow-port-in.drop").forEach(function (p) { p.classList.remove("drop"); });
      if (inputPort) inputPort.classList.add("drop");
    }
    function up(e) {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      ghost.remove();
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var inputPort = target && target.closest ? target.closest(".flow-port-in") : null;
      if (!inputPort) return;
      var targetId = inputPort.getAttribute("data-node");
      var targetPort = inputPort.getAttribute("data-port");
      if (!targetId || targetId === node.id) return;
      definition().edges.push({
        id: newId("edge"),
        source: node.id,
        sourcePort: portName,
        target: targetId,
        targetPort: targetPort,
      });
      renderAll();
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---- 平移 / 缩放 ----

  function bindCanvasNavigation() {
    dom.canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var rect = dom.canvas.getBoundingClientRect();
      var factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      var next = Math.min(2.5, Math.max(0.3, state.view.scale * factor));
      var mx = ev.clientX - rect.left;
      var my = ev.clientY - rect.top;
      state.view.x = mx - (mx - state.view.x) * (next / state.view.scale);
      state.view.y = my - (my - state.view.y) * (next / state.view.scale);
      state.view.scale = next;
      applyView();
    }, { passive: false });

    dom.canvas.addEventListener("mousedown", function (ev) {
      if (ev.button === 1 || (ev.button === 0 && ev.target === dom.world)) {
        ev.preventDefault();
        var startX = ev.clientX;
        var startY = ev.clientY;
        var ox = state.view.x;
        var oy = state.view.y;
        function move(e) {
          state.view.x = ox + (e.clientX - startX);
          state.view.y = oy + (e.clientY - startY);
          applyView();
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }
    });
    dom.canvas.addEventListener("click", function () {
      state.selected = null;
      renderAll();
    });
  }

  // ---- 属性面板 ----

  function renderPanel() {
    dom.panel.innerHTML = "";
    if (!state.selected) {
      dom.panel.appendChild(el("div", { className: "flow-panel-hint" }, "选中节点或连线查看属性"));
      return;
    }
    var node = nodeById(state.selected);
    if (!node) {
      var edge = definition().edges.filter(function (e) { return e.id === state.selected; })[0];
      if (!edge) { dom.panel.appendChild(el("div", { className: "flow-panel-hint" }, "已选中对象已不存在")); return; }
      dom.panel.appendChild(el("h3", null, "连线"));
      dom.panel.appendChild(el("div", { className: "flow-kv" }, edge.source + "." + edge.sourcePort + " → " + edge.target + "." + edge.targetPort));
      dom.panel.appendChild(el("button", {
        className: "flow-btn danger",
        onclick: function () {
          var def = definition();
          def.edges = def.edges.filter(function (e) { return e.id !== edge.id; });
          state.selected = null;
          renderAll();
        },
      }, "删除连线"));
      return;
    }

    var type = state.types[node.type] || { fields: {} };
    dom.panel.appendChild(el("h3", null, type.label || node.type));
    dom.panel.appendChild(el("div", { className: "flow-kv" }, "id: " + node.id));

    Object.keys(type.fields || {}).forEach(function (fieldName) {
      var field = type.fields[fieldName];
      var value = node.data && node.data[fieldName];
      var label = el("label", { className: "flow-field" }, fieldName);
      var input;
      if (field.enum) {
        input = el("select", { className: "flow-input" });
        field.enum.forEach(function (option) {
          var opt = el("option", { value: option }, option);
          if (option === value) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (field.type === "object" || field.type === "array") {
        input = el("textarea", { className: "flow-input mono", rows: 4 });
        input.value = value === undefined ? "" : JSON.stringify(value, null, 2);
      } else if (field.type === "number") {
        input = el("input", { className: "flow-input", type: "number" });
        input.value = value === undefined ? "" : String(value);
      } else {
        input = el("textarea", { className: "flow-input", rows: fieldName === "prompt" ? 5 : 2 });
        input.value = value === undefined ? "" : String(value);
      }
      input.addEventListener("change", function () {
        node.data = node.data || {};
        var raw = input.value;
        if (field.type === "object" || field.type === "array") {
          if (!raw.trim()) { delete node.data[fieldName]; return; }
          try { node.data[fieldName] = JSON.parse(raw); }
          catch (error) { dom.status.textContent = "JSON 无效：" + error.message; return; }
        } else if (field.type === "number") {
          if (raw === "") delete node.data[fieldName];
          else node.data[fieldName] = Number(raw);
        } else if (raw === "") {
          delete node.data[fieldName];
        } else {
          node.data[fieldName] = raw;
        }
        dom.status.textContent = "";
        renderAll();
      });
      label.appendChild(input);
      dom.panel.appendChild(label);
    });

    dom.panel.appendChild(el("button", {
      className: "flow-btn danger",
      onclick: function () {
        var def = definition();
        def.nodes = def.nodes.filter(function (n) { return n.id !== node.id; });
        def.edges = def.edges.filter(function (e) { return e.source !== node.id && e.target !== node.id; });
        state.selected = null;
        renderAll();
      },
    }, "删除节点"));
  }

  // ---- 顶部工具条与左栏 ----

  function renderToolbar() {
    dom.tools.innerHTML = "";
    dom.tools.appendChild(el("span", { className: "flow-tool-label" }, "添加节点："));
    Object.keys(state.types).forEach(function (type) {
      dom.tools.appendChild(el("button", {
        className: "flow-btn small",
        onclick: function () {
          var def = definition();
          var count = def.nodes.filter(function (n) { return n.type === type; }).length + 1;
          var node = {
            id: type + "_" + count,
            type: type,
            position: { x: 120 + count * 30, y: 60 + count * 40 },
            data: {},
          };
          def.nodes.push(node);
          state.selected = node.id;
          renderAll();
        },
      }, state.types[type].label || type));
    });
    dom.tools.appendChild(el("span", { className: "flow-tool-spacer" }));
    dom.tools.appendChild(el("button", { className: "flow-btn", onclick: saveFlow }, "保存"));
    dom.tools.appendChild(el("button", { className: "flow-btn primary", onclick: runFlow }, "运行"));
  }

  function renderList() {
    dom.list.innerHTML = "";
    dom.list.appendChild(el("button", {
      className: "flow-btn small primary",
      onclick: function () { createFlow(); },
    }, "+ 新建流程图"));
    state.flows.forEach(function (flow) {
      var item = el("div", {
        className: "flow-list-item" + (state.flow && state.flow.id === flow.id ? " active" : ""),
        onclick: function () { openFlow(flow.id); },
      }, [
        el("div", { className: "flow-list-name" }, flow.name || ("流程图 " + flow.id)),
        el("div", { className: "flow-list-desc" }, flow.description || ""),
      ]);
      dom.list.appendChild(item);
    });
  }

  function renderStatus() {
    dom.status.textContent = state.statusText || "";
  }

  function renderAll() {
    renderToolbar();
    renderList();
    renderCanvas();
    renderPanel();
    renderStatus();
    applyView();
  }

  // ---- 数据操作 ----

  function createFlow() {
    state.flow = { id: null, name: "新流程图", description: "", definition: emptyDefinition() };
    state.selected = null;
    state.run = null;
    renderAll();
  }

  async function openFlow(id) {
    var row = await api("flow.get", { id: id });
    if (!row) return;
    state.flow = {
      id: row.id,
      name: row.name,
      description: row.description || "",
      definition: row.definition || emptyDefinition(),
    };
    state.selected = null;
    state.run = null;
    state.statusText = "";
    renderAll();
  }

  async function saveFlow() {
    if (!state.flow) return;
    var result = await api("flow.save", {
      id: state.flow.id == null ? undefined : state.flow.id,
      name: state.flow.name,
      description: state.flow.description,
      definition: definition(),
    });
    if (!result || !result.ok) {
      state.statusText = "校验未通过：" + ((result && result.violations) || []).join("；");
      renderStatus();
      return;
    }
    state.flow.id = result.flow.id;
    state.statusText = "已保存";
    await refreshFlows();
    renderAll();
  }

  async function refreshFlows() {
    try { state.flows = await api("flow.list", {}); } catch (_) { state.flows = []; }
  }

  // 运行为流式 RPC：节点事件通过 onEvent 到达，用它给节点上色。
  function runFlow() {
    if (!state.flow || state.flow.id == null) {
      state.statusText = "请先保存再运行";
      renderStatus();
      return;
    }
    state.run = { nodeStatus: {} };
    state.statusText = "运行中…";
    renderAll();
    var inputText = window.prompt("运行输入（JSON，可留空）：", "");
    if (inputText === null) return;
    var input = null;
    if (inputText.trim()) {
      try { input = JSON.parse(inputText); }
      catch (error) { state.statusText = "输入不是合法 JSON：" + error.message; renderStatus(); return; }
    }
    apiStream("flow.run", { flowId: state.flow.id, input: input }, function (evt) {
      if (!evt || !evt.type) return;
      if (evt.type === "flow-node-start") {
        state.run.nodeStatus[evt.nodeId] = "running";
      } else if (evt.type === "flow-node-end") {
        state.run.nodeStatus[evt.nodeId] = evt.status || "succeeded";
      } else if (evt.type === "flow-run-end") {
        state.statusText = evt.status === "succeeded"
          ? "运行成功：" + JSON.stringify(evt.output)
          : "运行失败：" + (evt.error || "未知错误");
      }
      renderCanvas();
      renderStatus();
    }).catch(function (error) {
      state.statusText = "运行失败：" + ((error && error.message) || error);
      renderStatus();
    });
  }

  // ---- 覆盖层 ----

  function buildOverlay() {
    dom.list = el("div", { className: "flow-list" });
    dom.tools = el("div", { className: "flow-toolbar" });
    dom.panel = el("div", { className: "flow-panel" });
    dom.status = el("div", { className: "flow-status" });
    dom.edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dom.edges.setAttribute("class", "flow-edges");
    dom.world = el("div", { className: "flow-world" }, [dom.edges]);
    dom.canvas = el("div", { className: "flow-canvas" }, [dom.world]);

    var titleInput = el("input", { className: "flow-title", value: state.flow ? state.flow.name : "" });
    titleInput.addEventListener("change", function () {
      if (state.flow) state.flow.name = titleInput.value;
      renderList();
    });

    var head = el("div", { className: "flow-head" }, [
      el("span", { className: "flow-head-title" }, "流程图"),
      titleInput,
      el("button", {
        className: "flow-btn small",
        onclick: function () { closeOverlay(); },
      }, "关闭"),
    ]);

    var body = el("div", { className: "flow-body" }, [
      dom.list,
      el("div", { className: "flow-main" }, [dom.tools, dom.canvas, dom.status]),
      dom.panel,
    ]);

    var overlay = el("div", { className: "flow-overlay" }, [head, body]);
    overlay.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeOverlay();
    });
    return overlay;
  }

  // 画布占满「除左侧会话栏外」的全部空间：打开时自动折叠侧栏，关闭时恢复
  // 它原来的折叠状态（用户自己折叠过的不会在关闭后被误展开）。
  function setSidebarCollapsed(collapsed) {
    var sidebar = window.App && window.App.sidebar;
    if (!sidebar) return;
    sidebar.classList.toggle("collapsed", collapsed);
    if (window.App.syncCollapseButtons) window.App.syncCollapseButtons();
  }

  function openOverlay() {
    if (state.open) return;
    state.open = true;
    state.sidebarWasCollapsed = !!(window.App && window.App.sidebar && window.App.sidebar.classList.contains("collapsed"));
    setSidebarCollapsed(true);
    dom.overlay.hidden = false;
    refreshFlows().then(function () {
      if (!state.flow && state.flows.length) return openFlow(state.flows[0].id);
      if (!state.flow) createFlow();
      renderAll();
    });
  }

  function closeOverlay() {
    state.open = false;
    if (dom.overlay) dom.overlay.hidden = true;
    if (!state.sidebarWasCollapsed) setSidebarCollapsed(false);
  }

  async function init() {
    var btn = document.getElementById("flowBtn");
    if (!btn) return;
    try { state.types = await api("flow.nodeTypes", {}); } catch (_) { state.types = {}; }
    state.flow = { id: null, name: "新流程图", description: "", definition: emptyDefinition() };
    dom.overlay = buildOverlay();
    dom.overlay.hidden = true;
    document.body.appendChild(dom.overlay);
    bindCanvasNavigation();
    btn.addEventListener("click", openOverlay);
    renderAll();
  }

  window.FlowCanvas = { init: init, open: openOverlay };
  ready(function () { init().catch(function (error) { console.warn("[flow] init failed:", error); }); });
})();
