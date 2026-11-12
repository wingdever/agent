"use strict";
// M0 重构：原 app.js 闭包内「自动翻译：中英对照块」区块（行 864–900, 919–985, 1656–1713）。
// 抽为独立 <script>，向 window.App 挂载。翻译是 display-only 的中英对照，不落库。
// 这些辅助被 chat-tab.js 的 bare / turn-step 渲染路径调用，故以 App.* 暴露。

(function () {
  var App = (window.App = window.App || {});

  function makeTranslationBlock(label, text, markdown) {
    var details = document.createElement("details");
    details.className = "translation";
    details.setAttribute("data-name", "translation");
    details.open = true;
    var summary = document.createElement("summary");
    summary.textContent = label;
    details.appendChild(summary);
    var body = App.makeEl("translation-body", "translation-body textcard" + (markdown ? "" : " plain"));
    if (markdown) AgentMarkdown.set(body, text || "");
    else body.textContent = text || "";
    details.appendChild(body);
    return details;
  }
  App.makeTranslationBlock = makeTranslationBlock;

  App.setTranslationText = function setTranslationText(block, text, markdown) {
    if (!block) return;
    var body = block.querySelector(".translation-body");
    if (!body) return;
    if (markdown) {
      body.classList.remove("plain");
      AgentMarkdown.set(body, text || "");
    } else {
      body.classList.add("plain");
      body.textContent = text || "";
    }
  };

  App.appendTranslationErrorNotice = function appendTranslationErrorNotice(container, error) {
    if (!container) return;
    var note = App.makeEl("translation-error", "translation-error");
    note.textContent = "翻译失败，已显示英文原文：" + (error || "未知错误");
    container.appendChild(note);
    App.scrollChatToBottom();
  };

  App.ensureFlatUserTranslation = function ensureFlatUserTranslation(original) {
    if (!App.flatUserTranslation && App.flatUserWrap) {
      App.flatUserTranslation = makeTranslationBlock("中文原文", original || "", false);
      App.flatUserWrap.appendChild(App.flatUserTranslation);
      App.scrollChatToBottom();
    }
    return App.flatUserTranslation;
  };
  App.ensureFlatAssistantTranslation = function ensureFlatAssistantTranslation() {
    if (!App.flatAssistantTranslation && App.currentAssistantBubble && App.currentAssistantBubble.parentNode) {
      App.flatAssistantTranslation = makeTranslationBlock("中文译文", "翻译中…", true);
      App.currentAssistantBubble.parentNode.appendChild(App.flatAssistantTranslation);
      App.scrollChatToBottom();
    }
    return App.flatAssistantTranslation;
  };
  App.handleTranslationFlat = function handleTranslationFlat(evt) {
    if (evt.role === "user") {
      if (evt.phase === "start") {
        App.flatUserOriginal = evt.source || App.flatUserOriginal || "";
        if (App.flatUserBubble) {
          App.flatUserBubble.textContent = "翻译中…";
          App.flatUserBubble.classList.add("translating");
        }
        App.ensureFlatUserTranslation(App.flatUserOriginal);
      } else if (evt.phase === "done") {
        if (App.flatUserBubble) {
          App.flatUserBubble.textContent = evt.text || "";
          App.flatUserBubble.classList.remove("translating");
        }
        if (evt.source) App.ensureFlatUserTranslation(evt.source);
        var last = App.bareHistory[App.bareHistory.length - 1];
        if (last && last.role === "user") last.content = evt.text || last.content;
        App.scrollChatToBottom();
      } else if (evt.phase === "error") {
        if (App.input) { App.input.value = evt.source || App.flatUserOriginal || ""; App.input.focus(); }
        if (App.flatUserWrap && App.flatUserWrap.parentNode) App.flatUserWrap.parentNode.removeChild(App.flatUserWrap);
        if (App.bareHistory.length && App.bareHistory[App.bareHistory.length - 1].role === "user") App.bareHistory.pop();
        App.resetFlatTranslationState();
        if (!App.chatTab.querySelector(".msg")) App.showEmptyHint();
        if (window.uiAlert) uiAlert("输入翻译失败：" + (evt.error || "未知错误") + "\n请改用英文重新发送。");
      }
      return;
    }
    if (evt.role !== "assistant") return;
    if (evt.phase === "start") {
      App.ensureFlatAssistantTranslation();
    } else if (evt.phase === "done") {
      var block = App.ensureFlatAssistantTranslation();
      App.setTranslationText(block, evt.text || "", true);
      App.scrollChatToBottom();
    } else if (evt.phase === "error") {
      if (App.flatAssistantTranslation && App.flatAssistantTranslation.parentNode) {
        App.flatAssistantTranslation.parentNode.removeChild(App.flatAssistantTranslation);
      }
      App.flatAssistantTranslation = null;
      if (App.currentAssistantBubble && App.currentAssistantBubble.parentNode) {
        App.appendTranslationErrorNotice(App.currentAssistantBubble.parentNode, evt.error);
      }
    }
  };

  App.ensureUserTranslation = function ensureUserTranslation(original) {
    if (!App.liveUserTranslation && App.liveAgentRequest) {
      App.liveUserTranslation = makeTranslationBlock("中文原文", original || "", false);
      App.liveAgentRequest.appendChild(App.liveUserTranslation);
      App.scrollChatToBottom();
    }
    return App.liveUserTranslation;
  };
  App.ensureAssistantTranslation = function ensureAssistantTranslation() {
    if (!App.liveAssistantTranslation) {
      // 确保已存在 live step / answer（与 chat-tab.js 同构）
      App.ensureLiveStep();
      App.ensureAnswer();
      App.liveAssistantTranslation = makeTranslationBlock("中文译文", "翻译中…", true);
      App.liveResponse.appendChild(App.liveAssistantTranslation);
      App.scrollChatToBottom();
    }
    return App.liveAssistantTranslation;
  };
  App.handleTranslationTurn = function handleTranslationTurn(evt) {
    if (evt.role === "user") {
      if (evt.phase === "start") {
        if (!App.liveUserInput) return;
        App.liveUserOriginal = evt.source || App.liveUserOriginal || "";
        App.liveUserInput.textContent = "翻译中…";
        App.liveUserInput.classList.add("translating");
        App.ensureUserTranslation(App.liveUserOriginal);
      } else if (evt.phase === "done") {
        if (!App.liveUserInput) return;
        App.liveUserInput.textContent = evt.text || "";
        App.liveUserInput.classList.remove("translating");
        if (evt.source) App.ensureUserTranslation(evt.source);
        App.scrollChatToBottom();
      } else if (evt.phase === "error") {
        if (App.input) { App.input.value = evt.source || App.liveUserOriginal || ""; App.input.focus(); }
        if (App.liveTurn && App.liveTurn.parentNode) App.liveTurn.parentNode.removeChild(App.liveTurn);
        App.resetLive();
        if (!App.chatTab.querySelector(".turn")) App.showEmptyHint();
        if (window.uiAlert) uiAlert("输入翻译失败：" + (evt.error || "未知错误") + "\n请改用英文重新发送。");
      }
      return;
    }
    if (evt.role !== "assistant") return;
    if (evt.phase === "start") {
      App.ensureAssistantTranslation();
    } else if (evt.phase === "done") {
      var block = App.ensureAssistantTranslation();
      App.setTranslationText(block, evt.text || "", true);
      App.scrollChatToBottom();
    } else if (evt.phase === "error") {
      if (App.liveAssistantTranslation && App.liveAssistantTranslation.parentNode) {
        App.liveAssistantTranslation.parentNode.removeChild(App.liveAssistantTranslation);
      }
      App.liveAssistantTranslation = null;
      if (App.liveResponse) App.appendTranslationErrorNotice(App.liveResponse, evt.error);
    }
  };
})();
