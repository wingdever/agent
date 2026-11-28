"use strict";
// Shared node-graph topology renderer for the agents page.
//   - Top: static next chain + loop-back edge.
//   - Bottom: hooks overlay shown as `on --slot--> target` edges.
// Hooks for the main profile and for each bot preset are managed in the 智能
// page; this file only provides the read-only topology used there.

(function () {
  var App = (window.App = window.App || {});

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value == null) return;
      if (key === "className") node.className = value;
      else if (key === "dataset") {
        Object.keys(value).forEach(function (name) { node.setAttribute("data-" + name, value[name]); });
      } else if (key === "onclick") node.addEventListener("click", value);
      else node.setAttribute(key, value);
    });
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child == null) return;
        node.appendChild(typeof child === "string" || typeof child === "number"
          ? document.createTextNode(String(child)) : child);
      });
    }
    return node;
  }

  // Static main chain (decide-next loops back to pre-step).
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

  function builtinIds(list) {
    return (list || []).map(function (item) {
      return (item && typeof item === "object" && item.id) ? item.id : item;
    }).filter(Boolean);
  }

  // Render a read-only topology into `host`. `hooks` is the flat overlay for
  // the selected profile (main or bot preset); `options.builtins` and
  // `options.engine` come from loops.get.
  App.renderLoopTopology = function renderLoopTopology(host, hooks, options) {
    if (!host) return;
    options = options || {};
    host.textContent = "";
    host.classList.add("loop-topology");

    var chainWrap = el("div", { className: "loop-topology-chain", dataset: { name: "loop-topology-chain" } });
    CHAIN.forEach(function (id, index) {
      chainWrap.appendChild(el("div", {
        className: "loop-topology-node", dataset: { name: "loop-topology-node" },
      }, id));
      if (index < CHAIN.length - 1) chainWrap.appendChild(el("div", { className: "loop-topology-arrow" }, "↓"));
    });
    chainWrap.appendChild(el("div", {
      className: "loop-topology-loopback", dataset: { name: "loop-topology-loopback" },
    }, "↺ step 循环: " + LOOP_BACK.from + " → " + LOOP_BACK.to));
    host.appendChild(chainWrap);

    var overlayHooks = Array.isArray(hooks) ? hooks : [];
    var hooksWrap = el("div", { className: "loop-topology-hooks", dataset: { name: "loop-topology-hooks" } }, [
      el("div", { className: "section-header", dataset: { name: "section-header" } }, "Hooks (" + overlayHooks.length + ")"),
    ]);
    if (!overlayHooks.length) {
      hooksWrap.appendChild(el("div", { className: "tree-empty" }, "无 hook 覆盖（使用默认节点链）"));
    } else {
      overlayHooks.forEach(function (hook) {
        hooksWrap.appendChild(el("div", {
          className: "loop-hook-edge", dataset: { name: "loop-hook-edge" },
        }, [
          el("span", { className: "loop-hook-edge-on" }, hook.on),
          el("span", { className: "loop-hook-edge-slot" }, "—[" + hook.slot + "]→"),
          el("span", { className: "loop-hook-edge-target" }, hook.target),
        ]));
      });
    }
    hooksWrap.appendChild(el("div", {
      className: "loop-builtin-cluster", dataset: { name: "loop-builtin-cluster" },
    }, "builtin: " + (builtinIds(options.builtins).join(" · ") || "—")));
    if (options.engine) {
      hooksWrap.appendChild(el("div", { className: "loop-builtin-cluster" },
        "当前引擎: " + (options.engine.currentEngine || "—") +
        "（默认 " + (options.engine.defaultEngine || "—") + "）"));
    }
    host.appendChild(hooksWrap);
  };

})();
