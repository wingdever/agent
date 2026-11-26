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

    var state = { main: {}, agents: [], providers: [], selectedId: "main", loaded: false };

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
      ]).then(function (results) {
        state.main = (results[0] && results[0].main) || {};
        state.agents = (results[0] && results[0].agents) || [];
        state.providers = results[1] || [];
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
      toolsInput.placeholder = "每行一个工具名，留空表示全部工具";
      toolsInput.rows = 6;

      var fields = [
        ["名称", nameInput],
        ["identity", identityInput],
        ["persona", personaInput],
        ["provider", providerInput],
        ["模型", modelInput],
        ["推理等级", effortInput],
        ["工具白名单", toolsInput],
      ];
      if (!isMain) fields.unshift(["id", idInput]);
      fields.forEach(function (pair) {
        var row = el("div", "agents-field", null, "agents-field");
        row.appendChild(el("span", "agents-field-label", pair[0], "agents-field-label"));
        row.appendChild(pair[1]);
        editorEl.appendChild(row);
      });

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
        if (!isMain) payload.id = isNew ? idInput.value.trim() : agent.id;
        window.AgentClient.call("agent.upsert", { payload: payload }).then(function (saved) {
          if (App.toast) App.toast("已保存 " + (saved.name || (isMain ? "主智能" : saved.id)));
          state.selectedId = saved.id;
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
      editorEl.appendChild(el("div", "agents-hint", "主档存 agent/config.json，其它代理存 agents/<id>/config.json。只在新的平台会话生效；已有会话继续使用原有 system prompt。", "agents-hint"));
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
