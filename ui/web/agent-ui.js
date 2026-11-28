"use strict";

// agents-page: persistent agent profiles ("智能"). A profile is configuration
// only; the runtime agent stays session-scoped. Channel instances bind a
// profile id in user/channels.json and the sink passes its persona / model /
// effort / tool whitelist into each turn.

(function () {
  var App = (window.App = window.App || {});

  App.initAgentsUI = function initAgentsUI() {
    var page = document.getElementById("agentsPage");
    var listEl = document.getElementById("agentsList");
    var editorEl = document.getElementById("agentsEditor");

    if (!page || !listEl || !editorEl) {
      App.agentsUI = { onViewChange: function () {}, reload: function () {} };
      return;
    }

    var state = {
      main: {}, agents: [], providers: [], toolNames: [], coreNodes: [], allNodes: [],
      mainHooks: [], builtins: [], engine: {},
      selectedId: "main", tab: "config", loaded: false,
    };
    var DEFAULT_HOOKS = [
      { on: "assemble-input", slot: "before", target: "builtin.translate-input" },
      { on: "model-call", slot: "after", target: "builtin.translate-output" },
    ];

    function el(tag, cls, text, name) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      if (name) node.setAttribute("data-name", name);
      return node;
    }

    function input(tag, name, cls, value) {
      var node = el(tag, cls || null, null, name);
      if (node.tagName === "TEXTAREA") node.value = value || "";
      else node.value = value || "";
      return node;
    }

    function selected() {
      if (state.selectedId === "main") return Object.assign({ id: "main", name: "主智能", isMain: true }, state.main);
      if (state.selectedId === "__new__") return null;
      for (var i = 0; i < state.agents.length; i += 1) {
        if (state.agents[i].id === state.selectedId) return state.agents[i];
      }
      return null;
    }

    function load() {
      Promise.all([
        window.AgentClient.call("agent.list", {}).catch(function () { return { main: {}, agents: [] }; }),
        window.AgentClient.call("config.providers.get", {}).catch(function () { return []; }),
        window.AgentClient.call("tools.list", {}).catch(function () { return []; }),
        window.AgentClient.call("loops.get", {}).catch(function () { return { nodes: [] }; }),
      ]).then(function (results) {
        state.main = (results[0] && results[0].main) || {};
        state.agents = (results[0] && results[0].agents) || [];
        state.providers = results[1] || [];
        state.toolNames = (results[2] || []).map(function (tool) { return tool.name; }).filter(Boolean);
        var loopsData = results[3] || {};
        var nodes = loopsData.nodes || [];
        state.coreNodes = nodes.filter(function (node) { return node.type !== "builtin"; }).map(function (node) { return node.id; });
        state.allNodes = nodes.map(function (node) { return node.id; });
        state.builtins = loopsData.builtins || [];
        state.engine = loopsData;
        state.mainHooks = (Array.isArray(loopsData.hooks) ? loopsData.hooks : []).map(function (hook) {
          return { on: hook.on, slot: hook.slot, target: hook.target };
        });
        state.loaded = true;
        var found = state.selectedId === "main" || state.agents.some(function (a) { return a.id === state.selectedId; });
        if (!found) state.selectedId = "main";
        render();
      }).catch(function (err) {
        if (App.reportError) App.reportError("加载智能配置档失败", err);
      });
    }

    function renderList() {
      listEl.textContent = "";
      var head = el("div", "agents-list-head", "智能配置档", "agents-list-head");
      listEl.appendChild(head);
      var add = el("button", "agents-new-btn", "+ 新建", "agents-new-btn");
      add.type = "button";
      add.addEventListener("click", function () {
        state.selectedId = "__new__";
        render();
      });
      listEl.appendChild(add);
      var mainItem = el("button", "agents-list-item agents-main-item", null, "agents-main-item");
      mainItem.type = "button";
      if (state.selectedId === "main") mainItem.classList.add("active");
      mainItem.appendChild(el("span", "agents-list-name", "主智能（默认）", "agents-list-name"));
      mainItem.appendChild(el("span", "agents-list-id", "agent/config.json", "agents-list-id"));
      mainItem.addEventListener("click", function () {
        state.selectedId = "main";
        render();
      });
      listEl.appendChild(mainItem);
      if (!state.agents.length) {
        listEl.appendChild(el("div", "agents-empty", "agents/ 下还没有其它代理，点「新建」创建", "agents-empty"));
        return;
      }
      state.agents.forEach(function (agent) {
        var item = el("button", "agents-list-item", null, "agents-list-item");
        item.type = "button";
        if (agent.id === state.selectedId) item.classList.add("active");
        item.appendChild(el("span", "agents-list-name", agent.name || agent.id, "agents-list-name"));
        item.appendChild(el("span", "agents-list-id", agent.id, "agents-list-id"));
        item.addEventListener("click", function () {
          state.selectedId = agent.id;
          render();
        });
        listEl.appendChild(item);
      });
    }

    function renderEditor() {
      editorEl.textContent = "";
      var agent = selected();
      var isNew = !agent;
      var isMain = !!(agent && agent.isMain);
      var title = el("div", "agents-editor-title", isNew ? "新建代理" : (isMain ? "主智能（默认）" : "编辑代理"), "agents-editor-title");
      editorEl.appendChild(title);

      var tabBar = el("div", "agents-tabs", null, "agents-tabs");
      var configTabBtn = el("button", "agents-tab", "配置", "agents-tab-config");
      var promptTabBtn = el("button", "agents-tab", "提示词", "agents-tab-prompt");
      var graphTabBtn = el("button", "agents-tab", "流程图", "agents-tab-graph");
      configTabBtn.type = "button";
      promptTabBtn.type = "button";
      graphTabBtn.type = "button";
      var configPanel = el("div", "agents-panel", null, "agents-config-panel");
      var promptPanel = el("div", "agents-panel", null, "agents-prompt-panel");
      var graphPanel = el("div", "agents-panel", null, "agents-graph-panel");
      function switchTab(tab) {
        state.tab = tab;
        configTabBtn.classList.toggle("active", tab === "config");
        promptTabBtn.classList.toggle("active", tab === "prompt");
        graphTabBtn.classList.toggle("active", tab === "flow");
        configPanel.hidden = tab !== "config";
        promptPanel.hidden = tab !== "prompt";
        graphPanel.hidden = tab !== "flow";
      }
      configTabBtn.addEventListener("click", function () { switchTab("config"); });
      promptTabBtn.addEventListener("click", function () { switchTab("prompt"); });
      graphTabBtn.addEventListener("click", function () { switchTab("flow"); });
      tabBar.appendChild(configTabBtn);
      tabBar.appendChild(promptTabBtn);
      tabBar.appendChild(graphTabBtn);
      editorEl.appendChild(tabBar);

      var idInput = input("input", "agent-id-input", "agents-input", isMain ? "" : (agent && agent.id));
      idInput.placeholder = "小写字母/数字/短横线，如 support-bot";
      idInput.disabled = !isNew;
      var nameInput = input("input", "agent-name-input", "agents-input", agent && agent.name);
      nameInput.placeholder = "显示名称，如 客服助手";
      var identityInput = input("textarea", "agent-identity-input", "agents-textarea", agent && agent.identity);
      identityInput.placeholder = "系统提示身份段；留空使用内置默认";
      identityInput.rows = 3;
      var personaInput = input("textarea", "agent-persona-input", "agents-textarea", agent && agent.persona);
      personaInput.placeholder = "注入系统提示的 persona 段：角色、语气、边界";
      personaInput.rows = 6;
      var providerInput = input("select", "agent-provider-input", "agents-select");
      var autoProvider = el("option", null, "自动选择", null);
      autoProvider.value = "";
      providerInput.appendChild(autoProvider);
      state.providers.forEach(function (provider) {
        var option = el("option", null, provider.name, null);
        option.value = provider.name;
        if (agent && agent.provider === provider.name) option.selected = true;
        providerInput.appendChild(option);
      });
      var modelInput = input("input", "agent-model-input", "agents-input", agent && agent.model);
      modelInput.placeholder = "留空使用全局设置";
      var effortInput = input("select", "agent-effort-input", "agents-select");
      ["", "low", "medium", "high"].forEach(function (value) {
        var option = el("option", null, value || "全局", null);
        option.value = value;
        if ((agent && agent.effort || "") === value) option.selected = true;
        effortInput.appendChild(option);
      });
      var toolsInput = input("textarea", "agent-tools-input", "agents-textarea", agent && Array.isArray(agent.tools) ? agent.tools.join("\n") : "");
      toolsInput.placeholder = isMain
        ? "每行一个工具名，留空表示全部工具"
        : "每行一个工具名，留空表示无工具（bot 预设不继承主档工具）";
      toolsInput.rows = 6;
      var promptInput = input("textarea", "agent-prompt-input", "agents-textarea", agent && agent.prompt);
      promptInput.placeholder = "bot 预设的系统提示正文：角色、边界、输出格式";
      promptInput.rows = 10;

      var hooksBox = el("div", "agents-hooks", null, "agents-hooks");
      var topologyHost = el("div", null, null, "agents-topology");
      function selectedHooks() {
        if (isMain) return state.mainHooks;
        return agent && Array.isArray(agent.loops) ? agent.loops : [];
      }
      function collectHooks() {
        var hooks = [];
        Array.prototype.forEach.call(hooksBox.querySelectorAll("[data-name='agents-hook-row']"), function (row) {
          var on = row.querySelector("[data-name='hook-on']").value;
          var slot = row.querySelector("[data-name='hook-slot']").value;
          var target = row.querySelector("[data-name='hook-target']").value;
          if (on && slot && target) hooks.push({ on: on, slot: slot, target: target });
        });
        return hooks;
      }
      function refreshTopology() {
        var hooks = collectHooks();
        if (App.renderLoopTopology) {
          App.renderLoopTopology(topologyHost, hooks, { builtins: state.builtins, engine: state.engine });
        }
      }
      function fillSelect(select, ids, current) {
        ids.forEach(function (id) {
          var option = el("option", null, id, null);
          option.value = id;
          if (id === current) option.selected = true;
          select.appendChild(option);
        });
        if (current && ids.indexOf(current) < 0) {
          var stale = el("option", null, current + "（已失效）", null);
          stale.value = current;
          stale.selected = true;
          select.appendChild(stale);
        }
      }
      function addHookRow(hook) {
        var row = el("div", "agents-hook-row", null, "agents-hook-row");
        var onSel = el("select", "agents-select", null, "hook-on");
        fillSelect(onSel, state.coreNodes, hook && hook.on);
        var slotSel = el("select", "agents-select", null, "hook-slot");
        ["before", "after", "onError"].forEach(function (value) {
          var option = el("option", null, value, null);
          option.value = value;
          if (value === (hook && hook.slot)) option.selected = true;
          slotSel.appendChild(option);
        });
        var targetSel = el("select", "agents-select", null, "hook-target");
        fillSelect(targetSel, state.allNodes, hook && hook.target);
        var remove = el("button", "agents-hook-remove", "移除", "agents-hook-remove");
        remove.type = "button";
        remove.addEventListener("click", function () { row.parentNode.removeChild(row); refreshTopology(); });
        [onSel, slotSel, targetSel].forEach(function (select) {
          select.addEventListener("change", refreshTopology);
        });
        row.appendChild(onSel);
        row.appendChild(slotSel);
        row.appendChild(targetSel);
        row.appendChild(remove);
        hooksBox.appendChild(row);
        refreshTopology();
      }
      selectedHooks().forEach(addHookRow);
      var addHook = el("button", "agents-hook-add", "+ 添加钩子", "agents-hook-add");
      addHook.type = "button";
      addHook.addEventListener("click", function () {
        addHookRow({ on: state.coreNodes[0], slot: "after", target: state.allNodes[0] });
      });
      hooksBox.appendChild(addHook);
      refreshTopology();

      var configFields = [
        ["名称", nameInput],
        ["provider", providerInput],
        ["模型", modelInput],
        ["推理等级", effortInput],
        ["工具白名单", toolsInput],
      ];
      if (!isMain) configFields.unshift(["id", idInput]);
      var promptFields = [
        ["identity", identityInput],
        ["persona", personaInput],
      ];
      if (!isMain) promptFields.push(["prompt（bot 预设）", promptInput]);
      var toolsHint = el("div", "agents-hint", "可用工具名：" + (state.toolNames.join("、") || "（无）"), "agents-tools-hint");
      configFields.forEach(function (pair) {
        var row = el("div", "agents-field", null, "agents-field");
        row.appendChild(el("span", "agents-field-label", pair[0], "agents-field-label"));
        row.appendChild(pair[1]);
        configPanel.appendChild(row);
        if (pair[1] === toolsInput && !isMain) configPanel.appendChild(toolsHint);
      });
      promptFields.forEach(function (pair) {
        var row = el("div", "agents-field", null, "agents-field");
        row.appendChild(el("span", "agents-field-label", pair[0], "agents-field-label"));
        row.appendChild(pair[1]);
        promptPanel.appendChild(row);
      });
      promptPanel.appendChild(el("div", "agents-hint",
        isMain
          ? "identity 与 persona 注入系统提示；主档是全局默认。"
          : "identity 作为该预设的系统提示第一段；persona 与 prompt 会拼接后注入。",
        "agents-prompt-hint"));

      var topologyRow = el("div", "agents-field", null, "agents-field");
      topologyRow.appendChild(el("span", "agents-field-label", "节点流图（当前档）", "agents-field-label"));
      topologyRow.appendChild(topologyHost);
      graphPanel.appendChild(topologyRow);
      var hookRow = el("div", "agents-field", null, "agents-field");
      hookRow.appendChild(el("span", "agents-field-label", "loops 钩子（on / slot / target）", "agents-field-label"));
      hookRow.appendChild(hooksBox);
      graphPanel.appendChild(hookRow);
      if (isMain) {
        var resetHooks = el("button", "agents-hook-add", "恢复默认 hooks", "agents-reset-hooks");
        resetHooks.type = "button";
        resetHooks.addEventListener("click", function () {
          App.uiConfirm("恢复主档默认的两个翻译 hook？当前编辑将被替换。").then(function (ok) {
            if (!ok) return;
            return window.AgentClient.call("loops.upsert", { payload: { hooks: DEFAULT_HOOKS } })
              .then(load)
              .catch(function (err) { App.reportError("恢复默认失败", err); });
          });
        });
        hookRow.appendChild(resetHooks);
      }

      editorEl.appendChild(configPanel);
      editorEl.appendChild(promptPanel);
      editorEl.appendChild(graphPanel);
      switchTab(state.tab);

      var actions = el("div", "agents-actions", null, "agents-actions");
      var save = el("button", "agents-save-btn", "保存", "agents-save-btn");
      save.type = "button";
      save.addEventListener("click", function () {
        var payload = {
          name: nameInput.value.trim(),
          identity: identityInput.value,
          persona: personaInput.value,
          provider: providerInput.value,
          model: modelInput.value.trim(),
          effort: effortInput.value,
          tools: toolsInput.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
        };
        var hooks = collectHooks();
        var request;
        if (isMain) {
          // 主档的 hooks 存在 agent/loops.json，由 loops.upsert 写；config 仍走 agent.upsert。
          request = window.AgentClient.call("agent.upsert", { payload: payload }).then(function (saved) {
            return window.AgentClient.call("loops.upsert", { payload: { hooks: hooks } }).then(function () { return saved; });
          });
        } else {
          payload.id = isNew ? idInput.value.trim() : agent.id;
          payload.prompt = promptInput.value;
          payload.loops = hooks;
          request = window.AgentClient.call("agent.upsert", { payload: payload });
        }
        request.then(function (saved) {
          if (App.toast) App.toast("已保存 " + ((isMain && "主智能") || saved.name || saved.id));
          state.selectedId = isMain ? "main" : saved.id;
          load();
        }).catch(function (err) {
          if (App.reportError) App.reportError("保存配置档失败", err);
        });
      });
      actions.appendChild(save);
      if (!isNew && !isMain) {
        var remove = el("button", "agents-delete-btn", "删除", "agents-delete-btn");
        remove.type = "button";
        remove.addEventListener("click", function () {
          App.uiConfirm("删除配置档「" + agent.name + "」？被通道绑定的配置档不能删除。").then(function (ok) {
            if (!ok) return;
            return window.AgentClient.call("agent.delete", { id: agent.id }).then(function () {
              state.selectedId = null;
              load();
            }).catch(function (err) {
              if (App.reportError) App.reportError("删除配置档失败", err);
            });
          });
        });
        actions.appendChild(remove);
      }
      editorEl.appendChild(actions);
      editorEl.appendChild(el("div", "agents-hint", "主档存 agent/config.json 与 agent/loops.json；其它代理存 agents/<id>/{config.json,prompt,tools.json,loops.json}。配置只在新的平台会话生效，已有会话继续使用原有 system prompt。", "agents-hint"));
    }

    function render() {
      renderList();
      renderEditor();
    }

    App.agentsUI = {
      onViewChange: function (name) { if (name === "agents" && !state.loaded) load(); },
      reload: load,
    };
    render();
  };
})();
