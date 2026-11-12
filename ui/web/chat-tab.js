"use strict";
// M0 重构：原 app.js 闭包内「会话消息渲染 / turn-step 层级渲染 / 中英对照翻译」区块。
// 抽为独立 <script>，向 window.App 挂载。这是 chat-tab 的核心渲染层，所有原闭包内
// var 提升为 App.xxx，跨域调用走 App.fn(...)。DOM 根（chatTab 等）由 app.js 装配器填入 App。
//
// 本文件涵盖：
//   - 空态提示 / 翻译块辅助
//   - bare-chat 扁平渲染（appendMessage / onChatEventFlat）
//   - turn-step 层级渲染（ensureLiveStep / onChatEvent / 工具卡 / 授权 / 计划审批 / 翻译对照）
//   - renderSessionMessages（按存储重建历史 + checkpoint 卡）
// 注：compaction 相关（handleCompactionEvent / runCompact / runSlashCommand / refreshContextWindow）
// 在 compaction-ui.js；App.compactionHappenedInTurn 为共享状态，已在 state.js。

(function () {
  var App = (window.App = window.App || {});

  // ---------- 空态提示 ----------
  App.hideEmptyHint = function hideEmptyHint() { var h = App.chatTab.querySelector(".empty-hint"); if (h) h.remove(); };
  App.showEmptyHint = function showEmptyHint() {
    if (App.chatTab.querySelector(".empty-hint")) return;
    var h = document.createElement("div");
    h.className = "empty-hint";
    h.textContent = "还没有对话，发送消息开始吧";
    App.chatTab.appendChild(h);
  };

  // ---------- 自动翻译：中英对照块 ----------
  // 翻译块辅助：实现见 translation-ui.js（App.makeTranslationBlock 等）。
  function makeTranslationBlock(label, text, markdown) { return App.makeTranslationBlock(label, text, markdown); }
  function setTranslationText(block, text, markdown) { App.setTranslationText(block, text, markdown); }
  function appendTranslationErrorNotice(container, error) { App.appendTranslationErrorNotice(container, error); }

  function appendFlatUser(text) {
    App.hideEmptyHint();
    var wrap = document.createElement("div");
    wrap.className = "msg msg-user";
    var roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent = "你";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "";
    wrap.appendChild(roleLabel);
    wrap.appendChild(bubble);
    App.chatTab.appendChild(wrap);
    App.scrollChatToBottom();
    return { wrap: wrap, bubble: bubble };
  }

  function resetFlatTranslationState() {
    App.flatUserWrap = App.flatUserBubble = App.flatUserTranslation = App.flatAssistantTranslation = null;
    App.flatUserOriginal = "";
  }

  function ensureFlatUserTranslation(original) { return App.ensureFlatUserTranslation(original); }
  function ensureFlatAssistantTranslation() { return App.ensureFlatAssistantTranslation(); }
  function handleTranslationFlat(evt) { App.handleTranslationFlat(evt); }

  // ---------- bare-chat 扁平渲染（不落库、不支持工具调用） ----------
  function appendMessage(role, text) {
    App.hideEmptyHint();
    var wrap = document.createElement("div");
    wrap.className = "msg msg-" + role;
    var roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent = role === "user" ? "你" : (role === "assistant" ? "助手" : (role === "thought" ? "思考" : role));
    var bubble = document.createElement("div");
    var rich = role === "assistant" || role === "thought";
    bubble.className = "bubble" + (rich ? " textcard " + role : "");
    if (rich) AgentMarkdown.set(bubble, text || "");
    else bubble.textContent = text || "";
    wrap.appendChild(roleLabel);
    wrap.appendChild(bubble);
    App.chatTab.appendChild(wrap);
    App.scrollChatToBottom();
    return bubble;
  }
  function flushMessageBubbles() {
    if (App.currentAssistantBubble) AgentMarkdown.flush(App.currentAssistantBubble);
    if (App.currentThoughtBubble) AgentMarkdown.flush(App.currentThoughtBubble);
  }
  function createToolCard(evt) {
    var card = document.createElement("div");
    card.className = "tool-call";
    var head = document.createElement("div");
    head.className = "tool-head";
    var cat = document.createElement("span");
    cat.className = "tool-cat";
    cat.textContent = (evt.name || "tool").toUpperCase();
    var title = document.createElement("span");
    title.textContent = " " + (evt.name || "tool");
    head.appendChild(cat); head.appendChild(title);
    var args = document.createElement("div");
    args.className = "tool-args";
    args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
    card.appendChild(head); card.appendChild(args);
    return card;
  }
  function setToolResult(card, evt) {
    var text = evt && evt.content != null ? String(evt.content) : "";
    App.renderToolResult(card, text, !!(evt && evt.isError));
    if (evt && evt.name === "todo_write" && evt.meta && Array.isArray(evt.meta.todos)) {
      renderTodoList(card, evt.meta.todos);
    }
  }

  function renderTodoList(card, todos) {
    var old = card.querySelector(".todo-list");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!Array.isArray(todos) || !todos.length) return;
    var list = App.makeEl("todo-list", "todo-list");
    todos.forEach(function (todo) {
      var item = App.makeEl("todo-item", "todo-item todo-status-" + (todo.status || "pending"));
      var mark = App.makeEl("todo-mark", "todo-mark");
      mark.textContent = todo.status === "completed" ? "●" : todo.status === "in_progress" ? "◐" : "○";
      var label = App.makeEl("todo-label", "todo-label");
      label.textContent = todo.content || "";
      item.appendChild(mark);
      item.appendChild(label);
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  function parseToolArgs(call) {
    var value = call && call.arguments;
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch (e) { return {}; }
    }
    return value && typeof value === "object" ? value : {};
  }

  function renderAskUserQuestion(card, evt) {
    if (!card) return;
    var old = card.querySelector(".ask-user-question");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var form = App.makeEl("ask-user-question", "ask-user-question");
    form.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = App.makeEl("ask-title", "ask-title");
    title.textContent = "需要你的回答";
    form.appendChild(title);

    var state = {};
    var questions = Array.isArray(evt.questions) ? evt.questions : [];
    questions.forEach(function (q, index) {
      state[q.id] = { selected: [], custom: "" };
      var section = App.makeEl("ask-question", "ask-question");
      var header = App.makeEl("ask-header", "ask-header");
      header.textContent = q.header || ("问题 " + (index + 1));
      var text = App.makeEl("ask-text", "ask-text");
      text.textContent = q.question || "";
      section.appendChild(header);
      section.appendChild(text);

      if (Array.isArray(q.options) && q.options.length) {
        q.options.forEach(function (opt) {
          var label = document.createElement("label");
          label.className = "ask-option";
          var input = document.createElement("input");
          input.type = q.multi_select ? "checkbox" : "radio";
          input.name = "ask-" + evt.id + "-" + q.id;
          input.value = opt.label || "";
          input.addEventListener("change", function () {
            if (q.multi_select) {
              state[q.id].selected = Array.prototype.slice.call(
                section.querySelectorAll('input[type="checkbox"]:checked')
              ).map(function (node) { return node.value; });
            } else {
              state[q.id].selected = input.checked ? [input.value] : [];
            }
          });
          label.appendChild(input);
          var labelText = App.makeEl("ask-option-label", "ask-option-label");
          labelText.textContent = opt.label || "";
          label.appendChild(labelText);
          if (opt.description) {
            var desc = App.makeEl("ask-option-desc", "ask-option-desc");
            desc.textContent = opt.description;
            label.appendChild(desc);
          }
          section.appendChild(label);
        });
      }

      var custom = document.createElement("input");
      custom.type = "text";
      custom.className = "ask-custom";
      custom.placeholder = (q.options && q.options.length) ? "可选：补充回答" : "输入你的回答";
      custom.addEventListener("input", function () { state[q.id].custom = custom.value; });
      section.appendChild(custom);
      form.appendChild(section);
    });

    var actions = App.makeEl("ask-actions", "ask-actions");
    var error = App.makeEl("ask-error", "ask-error");
    error.hidden = true;
    var skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn-deny";
    skip.textContent = "全部跳过";
    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn-approve";
    submit.textContent = "提交回答";

    function collect() {
      return questions.map(function (q) {
        var value = state[q.id] || { selected: [], custom: "" };
        var customText = String(value.custom || "").trim();
        var answer = { id: q.id, selected: value.selected.slice() };
        if (customText) answer.custom = customText;
        return answer;
      });
    }

    function send(skipAll) {
      var answers = skipAll
        ? questions.map(function (q) { return { id: q.id, selected: [] }; })
        : collect();
      submit.disabled = true;
      skip.disabled = true;
      error.hidden = true;
      window.AgentClient.call("answerQuestions", { id: evt.id, answers: answers }).then(function (ok) {
        if (ok === false) throw new Error("该问题已失效或本轮已结束");
        if (ok && ok.error) throw new Error(ok.error);
        form.querySelectorAll("input,button").forEach(function (node) { node.disabled = true; });
        var done = App.makeEl("ask-submitted", "ask-submitted");
        done.textContent = "已提交回答";
        form.appendChild(done);
      }).catch(function (e) {
        submit.disabled = false;
        skip.disabled = false;
        error.hidden = false;
        error.textContent = "提交失败：" + (e && e.message ? e.message : e);
      });
    }

    submit.addEventListener("click", function () { send(false); });
    skip.addEventListener("click", function () { send(true); });
    actions.appendChild(error);
    actions.appendChild(skip);
    actions.appendChild(submit);
    form.appendChild(actions);
    card.appendChild(form);
    App.scrollChatToBottom();
  }

  function renderUserJob(card, evt) {
    if (!card) return;
    var old = card.querySelector(".user-job");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var form = App.makeEl("user-job", "user-job");
    form.setAttribute("data-job-id", evt.id || "");
    form.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = App.makeEl("ask-title", "ask-title");
    title.textContent = evt.title || "需要你手动完成一项任务";
    form.appendChild(title);

    var desc = App.makeEl("ask-text", "ask-text");
    desc.textContent = evt.description || "";
    form.appendChild(desc);

    var hint = App.makeEl("ask-option-desc", "ask-option-desc");
    hint.textContent = "请在真实环境中完成上述任务，然后在此填写结果报告：";
    form.appendChild(hint);

    var textarea = document.createElement("textarea");
    textarea.className = "user-job-result";
    textarea.rows = 4;
    textarea.placeholder = "在此描述你完成的情况与结果……";
    form.appendChild(textarea);

    var actions = App.makeEl("ask-actions", "ask-actions");
    var error = App.makeEl("ask-error", "ask-error");
    error.hidden = true;
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-deny";
    cancel.textContent = "取消任务";
    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn-approve";
    submit.textContent = "提交结果";

    function send(cancelOnly) {
      var result = cancelOnly ? "" : String(textarea.value || "").trim();
      submit.disabled = true;
      cancel.disabled = true;
      error.hidden = true;
      window.AgentClient.call("answerUserJob", { id: evt.id, cancel: cancelOnly, result: result }).then(function (ok) {
        if (ok === false) throw new Error("该任务已失效或本轮已结束");
        if (ok && ok.error) throw new Error(ok.error);
        form.querySelectorAll("input,textarea,button").forEach(function (node) { node.disabled = true; });
        var done = App.makeEl("ask-submitted", "ask-submitted");
        done.textContent = cancelOnly ? "已取消任务" : "已提交结果";
        form.appendChild(done);
      }).catch(function (e) {
        submit.disabled = false;
        cancel.disabled = false;
        error.hidden = false;
        error.textContent = "提交失败：" + (e && e.message ? e.message : e);
      });
    }

    submit.addEventListener("click", function () { send(false); });
    cancel.addEventListener("click", function () { send(true); });
    actions.appendChild(error);
    actions.appendChild(cancel);
    actions.appendChild(submit);
    form.appendChild(actions);
    card.appendChild(form);
    App.scrollChatToBottom();
  }
  function createApprovalCard(evt) {
    var card = document.createElement("div");
    card.className = "tool-call approval";
    var head = document.createElement("div");
    head.className = "tool-head";
    if (evt.autoDenied) {
      head.textContent = "autonomous 自动拒绝：" + (evt.name || "tool");
      var args = document.createElement("div");
      args.className = "tool-args";
      args.textContent = JSON.stringify(evt.arguments || {}, null, 2);
      card.appendChild(head); card.appendChild(args);
      App.chatTab.appendChild(card);
      App.scrollChatToBottom();
      return;
    }
    var auto = evt.permission === "allow" || evt.permission === "deny";
    head.textContent = auto
      ? (evt.permission === "allow" ? "已自动允许：" : "策略拒绝：") + (evt.name || "tool")
      : "工具授权请求：" + (evt.name || "tool");
    var args2 = document.createElement("div");
    args2.className = "tool-args";
    args2.textContent = JSON.stringify(evt.arguments || {}, null, 2);
    card.appendChild(head); card.appendChild(args2);
    if (!auto) {
      var bar = document.createElement("div");
      bar.className = "approval-bar";
      var allow = document.createElement("button");
      allow.textContent = "批准"; allow.className = "btn-approve";
      var deny = document.createElement("button");
      deny.textContent = "拒绝"; deny.className = "btn-deny";
      allow.addEventListener("click", function () {
        window.AgentClient.call("approval", { id: evt.id, decision: "approve" });
        allow.disabled = true; deny.disabled = true; allow.textContent = "已批准";
      });
      deny.addEventListener("click", function () {
        window.AgentClient.call("approval", { id: evt.id, decision: "deny" });
        allow.disabled = true; deny.disabled = true; deny.textContent = "已拒绝";
      });
      bar.appendChild(allow); bar.appendChild(deny);
      card.appendChild(bar);
    }
    App.chatTab.appendChild(card);
    App.scrollChatToBottom();
  }
  function onChatEventFlat(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "token") {
      if (!App.currentAssistantBubble) App.currentAssistantBubble = appendMessage("assistant", evt.delta || "");
      else AgentMarkdown.append(App.currentAssistantBubble, evt.delta || "");
      App.scrollChatToBottom();
    } else if (evt.type === "reasoning") {
      if (!App.currentThoughtBubble) App.currentThoughtBubble = appendMessage("thought", evt.delta || "");
      else AgentMarkdown.append(App.currentThoughtBubble, evt.delta || "");
      App.scrollChatToBottom();
    } else if (evt.type === "tool_call") {
      var card = createToolCard(evt);
      App.chatTab.appendChild(card);
      App.toolCards[evt.id] = card;
      App.scrollChatToBottom();
    } else if (evt.type === "tool_result") {
      var c = App.toolCards[evt.id];
      if (c) setToolResult(c, evt);
    } else if (evt.type === "done") {
      if (evt.message) App.bareHistory.push({ role: "assistant", content: evt.message.content || "" });
      flushMessageBubbles();
      App.currentAssistantBubble = null;
      App.currentThoughtBubble = null;
      resetFlatTranslationState();
    } else if (evt.type === "turn-end") {
      flushMessageBubbles();
      if (evt.reason === "translation-error") {
        App.currentAssistantBubble = null;
        App.currentThoughtBubble = null;
        resetFlatTranslationState();
        return;
      }
      if (evt.status !== "succeeded") {
        appendMessage("assistant", "[本轮终止] " + (evt.reason || "unknown") + (evt.error ? ": " + evt.error : ""));
      }
      App.turnStat.steps = (evt.steps != null) ? evt.steps : App.turnStat.steps;
      App.turnStat.tools = (evt.tools != null) ? evt.tools : App.turnStat.tools;
      App.turnStat.durationMs = (evt.durationMs != null) ? evt.durationMs : App.turnStat.durationMs;
      App.sessionStat.turns += 1;
      if (evt.steps != null) App.sessionStat.steps += evt.steps;
      App.renderStatusBar();
      App.currentAssistantBubble = null;
      App.currentThoughtBubble = null;
      resetFlatTranslationState();
    } else if (evt.type === "plan-mode") {
      App.currentPlanMode = evt.active === true;
      if (!evt.active) { App.currentActivityCompleted = true; App.setActivityMode("build-code"); App.renderActivityIndicator(); }
    } else if (evt.type === "approval-request") {
      createApprovalCard(evt);
    } else if (evt.type === "error") {
      flushMessageBubbles();
      appendMessage("assistant", "[出错] " + (evt.error || "未知错误"));
      App.currentAssistantBubble = null;
      App.currentThoughtBubble = null;
      resetFlatTranslationState();
    }
  }

  // ---------- turn-step 层级渲染 ----------
  function ensureLiveStep() {
    if (!App.liveTurn) { App.liveTurn = App.makeEl("turn", "turn"); App.chatTab.appendChild(App.liveTurn); }
    if (!App.liveStep) {
      App.liveStep = App.makeEl("step", "step");
      App.liveTurn.appendChild(App.liveStep);
      App.liveResponse = App.makeEl("model-response", "model-response");
      App.liveStep.appendChild(App.liveResponse);
      App.liveAnswer = null; App.liveCards = {};
    }
    return App.liveStep;
  }
  function ensureAnswer() {
    ensureLiveStep();
    if (!App.liveAnswer) { App.liveAnswer = App.makeEl("answer", "answer textcard"); App.liveResponse.appendChild(App.liveAnswer); }
    return App.liveAnswer;
  }
  function flushLiveMarkdown() {
    if (!App.liveResponse) return;
    var cards = App.liveResponse.querySelectorAll(".textcard");
    Array.prototype.forEach.call(cards, function (n) { AgentMarkdown.flush(n); });
  }
  function makeSystemPrompt(content) {
    var details = document.createElement("details");
    details.className = "system-prompt";
    details.setAttribute("data-name", "system-prompt");
    var summary = document.createElement("summary");
    summary.textContent = "系统提示词";
    var pre = document.createElement("pre");
    pre.textContent = content || "";
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }
  function addSystemPrompt(req, content) {
    if (!req || !content) return;
    if (req.querySelector(".system-prompt")) return;
    req.insertBefore(makeSystemPrompt(content), req.firstChild);
  }
  function addAgentRequest(text) {
    ensureLiveStep();
    var req = App.makeEl("agent-request", "agent-request");
    var userInput = App.makeEl("user-input", "user-input");
    userInput.textContent = text || "";
    req.appendChild(userInput);
    App.liveStep.insertBefore(req, App.liveResponse);
    App.liveAgentRequest = req;
    App.liveUserInput = userInput;
    App.liveUserOriginal = text || "";
    App.liveUserTranslation = null;
    App.liveAssistantTranslation = null;
    return req;
  }
  function getToolCard(id) {
    if (App.liveCards[id]) return App.liveCards[id];
    ensureLiveStep();
    var card = App.makeEl("tool-call-card", "tool-call-card tool-call");
    card.setAttribute("data-call-id", id);
    App.liveResponse.appendChild(card);
    card.addEventListener("click", function () { App.showToolDetail(card); });
    App.liveCards[id] = card;
    return card;
  }
  function setToolDesc(card, evt) {
    var argsText = JSON.stringify(evt.arguments || {});
    card.setAttribute("data-tool", evt.name || "tool");
    card.setAttribute("data-op", evt.name || "tool");
    card.setAttribute("data-args", JSON.stringify(evt.arguments || {}, null, 2));
    var desc = card.querySelector(".tool-call-desc");
    if (!desc) {
      desc = App.makeEl("tool-call-desc", "tool-call-desc");
      card.insertBefore(desc, card.firstChild);
    }
    desc.textContent = (evt.name || "tool") + " " + argsText;
    desc.title = desc.textContent;
    maybeAddPreviewBtn(card);
  }
  function maybeAddPreviewBtn(card) {
    var tool = (card.getAttribute("data-tool") || "").toLowerCase();
    if (!App.ARTIFACT_TOOLS[tool]) return;
    var args;
    try { args = JSON.parse(card.getAttribute("data-args") || "{}"); } catch (e) { args = {}; }
    if (!args || !args.file_path) return;
    if (card.querySelector(".artifact-preview-btn")) return;
    var btn = document.createElement("button");
    btn.className = "artifact-preview-btn";
    btn.setAttribute("data-name", "artifact-preview-btn");
    btn.textContent = "预览";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      App.previewArtifact(args.file_path);
    });
    card.appendChild(btn);
  }

  function truncateText(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  function approvalMeta(permission) {
    if (permission === "allow") return { cls: "allow", label: "已允许" };
    if (permission === "deny") return { cls: "deny", label: "已拒绝" };
    return { cls: "ask", label: "待授权" };
  }
  function approvalArgsText(args) {
    try {
      var text = JSON.stringify(args || {});
      return (!text || text === "{}") ? "" : truncateText(text, 60);
    } catch (e) { return ""; }
  }
  function renderApproval(ap, opts) {
    var meta = approvalMeta(opts.permission);
    ap.className = "approval-request " + meta.cls;
    ap.innerHTML = "";
    var status = document.createElement("span");
    status.className = "approval-status";
    status.textContent = opts.autoDenied ? "autonomous 自动拒绝" : meta.label;
    var tool = document.createElement("span");
    tool.className = "approval-tool";
    tool.textContent = opts.name || "tool";
    ap.appendChild(status);
    ap.appendChild(tool);
    if (meta.cls === "ask") {
      var argsText = approvalArgsText(opts.arguments);
      if (argsText) {
        var args = document.createElement("span");
        args.className = "approval-args";
        args.textContent = argsText;
        args.title = JSON.stringify(opts.arguments || {});
        ap.appendChild(args);
      }
    }
    if (meta.cls !== "ask" || !opts.onDecision) return;
    var bar = document.createElement("span");
    bar.className = "approval-bar";
    var allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "批准";
    allow.className = "btn-approve";
    var deny = document.createElement("button");
    deny.type = "button";
    deny.textContent = "拒绝";
    deny.className = "btn-deny";
    function decide(decision) {
      opts.onDecision(decision);
      renderApproval(ap, {
        permission: decision === "approve" ? "allow" : "deny",
        name: opts.name,
        arguments: opts.arguments
      });
    }
    allow.addEventListener("click", function (e) { e.stopPropagation(); decide("approve"); });
    deny.addEventListener("click", function (e) { e.stopPropagation(); decide("deny"); });
    bar.appendChild(allow);
    bar.appendChild(deny);
    ap.appendChild(bar);
  }
  function setApproval(card, evt) {
    setToolDesc(card, evt);
    var permission = evt.permission || "ask";
    card.setAttribute("data-permission", permission);
    var ap = card.querySelector(".approval-request");
    if (!ap) {
      ap = App.makeEl("approval-request", "approval-request");
      var result = card.querySelector(".tool-result");
      card.insertBefore(ap, result || null);
    }
    renderApproval(ap, {
      permission: permission,
      name: evt.name,
      arguments: evt.arguments,
      autoDenied: evt.autoDenied === true,
      onDecision: (permission === "ask" && !evt.autoDenied) ? function (decision) {
        window.AgentClient.call("approval", { id: evt.id, decision: decision });
      } : null
    });
  }

  App.renderToolResult = function renderToolResult(card, text, isError) {
    text = String(text == null ? "" : text);
    var old = card.querySelector(".tool-result");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    card.setAttribute("data-result", text);
    var isRead = (card.getAttribute("data-tool") || "").toLowerCase() === "read";
    if (isError) {
      var err = App.makeEl("tool-result", "tool-result read-error");
      err.textContent = "→ " + text;
      card.appendChild(err);
      return;
    }
    if (!isRead) {
      var plain = App.makeEl("tool-result", "tool-result");
      plain.textContent = "→ " + text;
      card.appendChild(plain);
      return;
    }
    var details = document.createElement("details");
    details.className = "tool-result read-result";
    details.setAttribute("data-name", "tool-result");
    var lines = text.length ? text.split("\n").length : 0;
    var size = window.TextEncoder ? new TextEncoder().encode(text).length : text.length;
    var summary = document.createElement("summary");
    summary.textContent = "→ 读取结果 · " + lines + " 行 · " + App.formatBytes(size);
    try {
      var args = JSON.parse(card.getAttribute("data-args") || "{}");
      if (args && args.file_path) summary.title = args.file_path;
    } catch (e) {}
    var pre = document.createElement("pre");
    pre.textContent = text;
    details.appendChild(summary);
    details.appendChild(pre);
    details.addEventListener("click", function (e) { e.stopPropagation(); });
    card.appendChild(details);
  };
  function renderPlanReview(card, evt) {
    if (!card) return;
    var old = card.querySelector(".plan-review");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = App.makeEl("plan-review", "plan-review");
    box.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = App.makeEl("plan-review-title", "plan-review-title");
    title.textContent = "计划审批：" + (evt.title || "Plan");
    var body = App.makeEl("plan-review-body", "plan-review-body textcard");
    AgentMarkdown.set(body, evt.plan || "");
    var feedback = document.createElement("textarea");
    feedback.className = "plan-review-feedback";
    feedback.rows = 2;
    feedback.placeholder = "不批准时，写下修改意见（可选）";
    var actions = App.makeEl("plan-review-actions", "plan-review-actions");
    var error = App.makeEl("plan-review-error", "plan-review-error");
    error.hidden = true;
    var keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn-deny";
    keep.textContent = "继续计划";
    var approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn-approve";
    approve.textContent = "批准并退出计划模式";

    function send(approved) {
      approve.disabled = true;
      keep.disabled = true;
      error.hidden = true;
      window.AgentClient.call("answerPlanReview", {
        id: evt.id,
        approved: approved,
        feedback: feedback.value,
      }).then(function (ok) {
        if (ok === false) throw new Error("该计划审批已失效或本轮已结束");
        if (ok && ok.error) throw new Error(ok.error);
        feedback.disabled = true;
        var done = App.makeEl("plan-review-done", "plan-review-done");
        done.textContent = approved ? "已批准，计划模式已退出" : "已退回，继续计划";
        box.appendChild(done);
      }).catch(function (e) {
        approve.disabled = false;
        keep.disabled = false;
        error.hidden = false;
        error.textContent = "提交失败：" + (e && e.message ? e.message : e);
      });
    }

    approve.addEventListener("click", function () { send(true); });
    keep.addEventListener("click", function () { send(false); });
    actions.appendChild(error);
    actions.appendChild(keep);
    actions.appendChild(approve);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(feedback);
    box.appendChild(actions);
    card.appendChild(box);
    App.scrollChatToBottom();
  }

  App.resetLive = function resetLive() {
    App.liveTurn = App.liveStep = App.liveResponse = App.liveAnswer = App.liveAgentRequest = null;
    App.liveCards = {};
    App.liveUserInput = null;
    App.liveUserOriginal = "";
    App.liveUserTranslation = null;
    App.liveAssistantTranslation = null;
  };

  // ---------- turn-step 的中英对照渲染 ----------
  function ensureUserTranslation(original) { return App.ensureUserTranslation(original); }
  function ensureAssistantTranslation() { return App.ensureAssistantTranslation(); }
  function handleTranslationTurn(evt) { App.handleTranslationTurn(evt); }

  // composer 内 model-http-status 状态切换（on-wait / on-post / on-get）
  App.setModelHttpStatus = function setModelHttpStatus(state, status) {
    if (!App.modelHttpStatus || !state) return;
    var states = App.modelHttpStatus.querySelectorAll(".state");
    Array.prototype.forEach.call(states, function (s) { s.hidden = true; });
    var el = App.modelHttpStatus.querySelector(".state." + state);
    if (!el) return;
    el.textContent = (state === "on-get" && status) ? ("get " + status) : App.HTTP_STATUS_LABEL[state];
    el.hidden = false;
  };

  App.onChatEvent = function onChatEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === "model-http-status") { App.setModelHttpStatus(evt.state, evt.status); return; }
    if (evt.type === "compaction") { App.handleCompactionEvent(evt); return; }
    if (evt.type === "usage") {
      App.usageState.prompt = evt.promptTokens != null ? evt.promptTokens : App.usageState.prompt;
      App.usageState.completion = evt.completionTokens != null ? evt.completionTokens : App.usageState.completion;
      App.usageState.total = evt.totalTokens != null ? evt.totalTokens : App.usageState.total;
      App.usageState.cached = evt.cachedTokens != null ? evt.cachedTokens : App.usageState.cached;
      App.renderStatusBar();
      return;
    }
    if (evt.type === "translation") {
      if (App.isBare()) handleTranslationFlat(evt);
      else handleTranslationTurn(evt);
      return;
    }
    if (App.isBare()) { onChatEventFlat(evt); return; }
    if (evt.type === "reasoning") {
      ensureLiveStep();
      var thEl = App.liveResponse.querySelector(".thought");
      if (!thEl) { thEl = App.makeEl("thought", "thought textcard"); App.liveResponse.appendChild(thEl); }
      AgentMarkdown.append(thEl, evt.delta || "");
      App.scrollChatToBottom();
    } else if (evt.type === "token") {
      AgentMarkdown.append(ensureAnswer(), evt.delta || "");
      App.scrollChatToBottom();
    } else if (evt.type === "tool_call") {
      setToolDesc(getToolCard(evt.id), evt);
      App.scrollChatToBottom();
    } else if (evt.type === "tool_result") {
      var hc = App.liveCards[evt.id];
      if (hc) {
        App.renderToolResult(hc, evt.content, evt.isError);
        if (evt.name === "todo_write" && evt.meta && Array.isArray(evt.meta.todos)) {
          renderTodoList(hc, evt.meta.todos);
        }
      }
    } else if (evt.type === "ask-user-question") {
      renderAskUserQuestion(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "user-job-request") {
      renderUserJob(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "user-job-update") {
      document.querySelectorAll(".user-job[data-job-id='" + (evt.id || "") + "']").forEach(function (node) {
        if (node.querySelector(".ask-submitted")) return;
        node.querySelectorAll("input,textarea,button").forEach(function (n) { n.disabled = true; });
        var note = App.makeEl("ask-submitted", "ask-submitted");
        note.textContent = evt.status === "killed" ? "任务已被取消" : "任务已结束";
        node.appendChild(note);
      });
    } else if (evt.type === "plan-review") {
      renderPlanReview(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "plan-mode") {
      App.currentPlanMode = evt.active === true;
      if (!evt.active) { App.currentActivityCompleted = true; App.setActivityMode("build-code"); App.renderActivityIndicator(); }
    } else if (evt.type === "approval-request") {
      setApproval(getToolCard(evt.callId || evt.id), evt);
    } else if (evt.type === "system-prompt") {
      ensureLiveStep();
      if (!App.liveAgentRequest) {
        App.liveAgentRequest = App.makeEl("agent-request", "agent-request");
        App.liveStep.insertBefore(App.liveAgentRequest, App.liveResponse);
      }
      addSystemPrompt(App.liveAgentRequest, evt.content);
    } else if (evt.type === "step-start") {
      flushLiveMarkdown();
      if (!App.liveTurn) { App.liveTurn = App.makeEl("turn", "turn"); App.chatTab.appendChild(App.liveTurn); }
      App.liveStep = App.makeEl("step", "step");
      App.liveTurn.appendChild(App.liveStep);
      App.liveResponse = App.makeEl("model-response", "model-response");
      App.liveStep.appendChild(App.liveResponse);
      App.liveAnswer = null; App.liveCards = {}; App.liveAgentRequest = null;
      App.liveUserInput = null; App.liveUserTranslation = null; App.liveAssistantTranslation = null;
      App.scrollChatToBottom();
    } else if (evt.type === "done") {
      flushLiveMarkdown();
      App.resetLive();
    } else if (evt.type === "turn-end") {
      if (evt.reason === "translation-error") { flushLiveMarkdown(); App.resetLive(); return; }
      if (evt.status !== "succeeded") {
        AgentMarkdown.append(ensureAnswer(), "[本轮终止] " + (evt.reason || "unknown") + (evt.error ? ": " + evt.error : ""));
      }
      App.turnStat.steps = (evt.steps != null) ? evt.steps : App.turnStat.steps;
      App.turnStat.tools = (evt.tools != null) ? evt.tools : App.turnStat.tools;
      App.turnStat.durationMs = (evt.durationMs != null) ? evt.durationMs : App.turnStat.durationMs;
      App.sessionStat.turns += 1;
      if (evt.steps != null) App.sessionStat.steps += evt.steps;
      App.renderStatusBar();
      flushLiveMarkdown();
      App.resetLive();
      if (App.compactionHappenedInTurn && App.currentSessionId) {
        App.compactionHappenedInTurn = false;
        App.renderSessionMessages(App.currentSessionId);
      }
    } else if (evt.type === "error") {
      AgentMarkdown.append(ensureAnswer(), "[出错] " + (evt.error || "未知错误"));
      flushLiveMarkdown();
      App.resetLive();
    }
  };

  App.renderSessionMessages = async function renderSessionMessages(sessionId) {
    App.chatTab.innerHTML = "";
    App.resetLive();
    var turns = await window.AgentClient.call("storage", { op: "turn.list", payload: { session_id: sessionId } });
    if (!turns || !turns.length) { App.showEmptyHint(); return; }
    var compactions = [];
    try {
      compactions = await window.AgentClient.call("storage", { op: "session.compactions", payload: { session_id: sessionId } }) || [];
    } catch (e) { compactions = []; }
    var markersByMessage = {};
    var markersByTurn = {};
    (compactions || []).forEach(function (c) {
      if (c.status !== "succeeded") return;
      if (c.upToMessageId != null) {
        if (!markersByMessage[c.upToMessageId]) markersByMessage[c.upToMessageId] = [];
        markersByMessage[c.upToMessageId].push(c);
      } else if (c.upToTurnSeq != null) {
        if (!markersByTurn[c.upToTurnSeq]) markersByTurn[c.upToTurnSeq] = [];
        markersByTurn[c.upToTurnSeq].push(c);
      }
    });
    var nodeByMessageId = {};
    var turnNodeBySeq = {};
    for (var t = 0; t < turns.length; t++) {
      var turnNode = App.makeEl("turn", "turn");
      App.chatTab.appendChild(turnNode);
      turnNodeBySeq[turns[t].seq] = turnNode;
      var steps = await window.AgentClient.call("storage", { op: "step.list", payload: { turn_id: turns[t].id } });
      for (var st = 0; st < (steps || []).length; st++) {
        var stepNode = App.makeEl("step", "step");
        turnNode.appendChild(stepNode);
        var respNode = App.makeEl("model-response", "model-response");
        stepNode.appendChild(respNode);
        var msgs = await window.AgentClient.call("storage", { op: "message.list", payload: { step_id: steps[st].id } });
        var systemMsg = null, userMsg = null, asstMsg = null, toolMsgs = [];
        for (var k = 0; k < (msgs || []).length; k++) {
          var m = msgs[k];
          if (m.role === "system") systemMsg = m;
          else if (m.role === "user") userMsg = m;
          else if (m.role === "assistant") asstMsg = m;
          else if (m.role === "tool") toolMsgs.push(m);
        }
        if (userMsg) {
          var req = App.makeEl("agent-request", "agent-request");
          if (systemMsg && systemMsg.content) req.appendChild(makeSystemPrompt(systemMsg.content));
          var uiInput = App.makeEl("user-input", "user-input");
          uiInput.textContent = userMsg.content || "";
          req.appendChild(uiInput);
          stepNode.insertBefore(req, respNode);
          if (userMsg.id != null) nodeByMessageId[userMsg.id] = req;
        }
        if (asstMsg) {
          if (asstMsg.id != null) nodeByMessageId[asstMsg.id] = respNode;
          if (asstMsg.thought) {
            var th = App.makeEl("thought", "thought textcard");
            AgentMarkdown.set(th, asstMsg.thought);
            respNode.appendChild(th);
          }
          if (asstMsg.content) {
            var ans = App.makeEl("answer", "answer textcard");
            AgentMarkdown.set(ans, asstMsg.content || "");
            respNode.appendChild(ans);
          }
          var calls = await window.AgentClient.call("storage", { op: "call.list", payload: { reply_id: asstMsg.id } });
          for (var c = 0; c < (calls || []).length; c++) {
            var call = calls[c];
            var card = App.makeEl("tool-call-card", "tool-call-card tool-call");
            card.setAttribute("data-call-id", String(call.id));
            card.setAttribute("data-tool", call.name);
            card.setAttribute("data-op", call.name);
            card.setAttribute("data-args", JSON.stringify(call.arguments || {}, null, 2));
            var desc = App.makeEl("tool-call-desc", "tool-call-desc");
            desc.textContent = call.name + " " + JSON.stringify(call.arguments || {});
            desc.title = desc.textContent;
            card.appendChild(desc);
            maybeAddPreviewBtn(card);
            var ap = App.makeEl("approval-request", "approval-request");
            var permission = call.status === "pending" ? "ask" : call.status === "denied" ? "deny" : "allow";
            renderApproval(ap, { permission: permission, name: call.name, arguments: call.arguments });
            card.appendChild(ap);
            var tm = toolMsgs[c] || null;
            if (tm) {
              App.renderToolResult(card, tm.content || "", call.status === "failed" || call.status === "denied");
              if (tm.id != null) nodeByMessageId[tm.id] = card;
            }
            if (call.name === "todo_write") {
              var todoArgs = parseToolArgs(call);
              renderTodoList(card, todoArgs.todos);
            }
            respNode.appendChild(card);
            (function (cc) { cc.addEventListener("click", function () { App.showToolDetail(cc); }); })(card);
          }
        }
      }
    }
    Object.keys(markersByMessage).forEach(function (id) {
      var node = nodeByMessageId[id];
      if (!node) return;
      var cursor = node;
      markersByMessage[id].forEach(function (c) {
        var card = App.renderCompactionCard(c);
        cursor.parentNode.insertBefore(card, cursor.nextSibling);
        cursor = card;
      });
    });
    Object.keys(markersByTurn).forEach(function (seq) {
      var tNode = turnNodeBySeq[seq];
      if (!tNode) return;
      markersByTurn[seq].forEach(function (c) { tNode.appendChild(App.renderCompactionCard(c)); });
    });
    App.scrollChatToBottom();
  };

  // 暴露给其它域文件（composer / translation-ui）调用的本地渲染辅助。
  App.appendFlatUser = appendFlatUser;
  App.appendMessage = appendMessage;
  App.ensureLiveStep = ensureLiveStep;
  App.ensureAnswer = ensureAnswer;
  App.flushLiveMarkdown = flushLiveMarkdown;
  App.addAgentRequest = addAgentRequest;
  App.createToolCard = createToolCard;
  App.setToolResult = setToolResult;
  App.resetFlatTranslationState = resetFlatTranslationState;
})();
