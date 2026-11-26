// 暂停控制（docs/runtime/turn-pause.md §3.3）。
// 传输是单向的：暂停在节点内 awaits，事件流里不会出现新的阻塞点，所以 UI
// 靠轮询 turn.state 观察暂停是否生效；继续走 turn.resume，被停住的节点随即
// 恢复执行，后续事件照常进入同一条流。
;(function (global) {
  "use strict";

  var App = global.App || (global.App = {});
  var POLL_MS = 400;

  App.pauseUi = { awaiting: false, timer: null, card: null };

  function label(text) {
    if (App.sendBtn) App.sendBtn.textContent = text;
  }

  function setMode(mode) {
    // "send" | "pause" | "pending" | "resume"
    if (App.sendBtn) App.sendBtn.setAttribute("data-pause", mode);
    if (mode === "send") label("发送");
    else if (mode === "pause") label("暂停");
    else if (mode === "pending") label("将在当前动作结束后暂停");
    // "resume" leaves the label to the card.
  }

  function stopPolling() {
    App.pauseUi.awaiting = false;
    if (App.pauseUi.timer) { clearTimeout(App.pauseUi.timer); App.pauseUi.timer = null; }
    setMode("send");
  }

  function poll(sessionId) {
    App.pauseUi.awaiting = true;
    setMode("pending");
    var tick = async function () {
      if (!App.pauseUi.awaiting) return;
      var state = null;
      try { state = await window.AgentClient.call("turn.state", { session_id: sessionId }); } catch (_) { state = null; }
      if (!App.pauseUi.awaiting) return;
      if (state && state.phase === "paused") {
        App.pauseUi.awaiting = false;
        App.pauseUi.timer = null;
        setMode("send");
        renderCard(state);
        return;
      }
      if (!state || state.phase === "idle") { stopPolling(); return; }
      App.pauseUi.timer = setTimeout(tick, POLL_MS);
    };
    App.pauseUi.timer = setTimeout(tick, POLL_MS);
  }

  // 已暂停：卡片列出暂停点与待执行工具（before-tools）或下一步节点
  // （before-model）；只提供「继续」。
  function renderCard(state) {
    removeCard();
    var visible = App.isBare ? !App.isBare() : true;
    if (!visible || state.sessionId == null || String(state.sessionId) !== String(App.currentSessionId)) return;
    var card = App.makeEl("pause-card", "pause-card");
    var head = App.makeEl("pause-card-head", "pause-card-head");
    head.textContent = state.pausedAt === "before-tools"
      ? "本轮已暂停：工具执行前"
      : "本轮已暂停：下一次模型请求前";
    card.appendChild(head);

    var list = document.createElement("div");
    list.className = "pause-card-list";
    if (state.pausedAt === "before-tools") {
      var calls = Array.isArray(state.pendingCalls) ? state.pendingCalls : [];
      if (!calls.length) {
        list.textContent = "没有待执行的工具。";
      } else {
        calls.forEach(function (call) {
          var row = document.createElement("div");
          row.className = "pause-card-call";
          var name = document.createElement("span");
          name.className = "pause-card-call-name";
          name.textContent = call.name || "unknown";
          var args = document.createElement("span");
          args.className = "pause-card-call-args";
          args.textContent = String(call.arguments || "{}");
          row.appendChild(name);
          row.appendChild(args);
          list.appendChild(row);
        });
      }
    } else {
      list.textContent = "继续后将发出下一次模型请求。";
    }
    card.appendChild(list);

    var actions = document.createElement("div");
    actions.className = "pause-card-actions";
    var btn = document.createElement("button");
    btn.className = "pause-resume-btn";
    btn.textContent = "继续";
    btn.addEventListener("click", function () { App.resumePause(state.sessionId); });
    actions.appendChild(btn);
    card.appendChild(actions);

    App.chatTab.appendChild(card);
    App.pauseUi.card = card;
    App.scrollChatToBottom();
  }

  function removeCard() {
    if (App.pauseUi.card) { App.pauseUi.card.remove(); App.pauseUi.card = null; }
  }

  App.removePauseCard = removeCard;

  // 发送按钮的实际动作：运行时按暂停、暂停中发消息（作为 steer）、空闲时发送。
  App.onSendOrPause = async function onSendOrPause() {
    if (App.pauseUi.awaiting) return; // 已请求，等待生效
    var sessionId = App.currentSessionId;
    if (sessionId) {
      var state = null;
      try { state = await window.AgentClient.call("turn.state", { session_id: sessionId }); } catch (_) { state = null; }
      if (state && state.phase === "paused") {
        // 输入区有内容就作为 steer 一起送，没有就单纯继续。
        var text = App.input ? App.input.value.trim() : "";
        if (text && App.input) App.input.value = "";
        await window.AgentClient.call("turn.resume", { session_id: sessionId, message: text || undefined });
        removeCard();
        return;
      }
      if (state && state.phase === "running") {
        await window.AgentClient.call("turn.pause", { session_id: sessionId });
        poll(sessionId);
        return;
      }
    }
    await App.onSend();
  };

  App.resumePause = async function resumePause(sessionId) {
    var text = App.input ? App.input.value.trim() : "";
    if (text && App.input) App.input.value = "";
    try {
      await window.AgentClient.call("turn.resume", { session_id: sessionId, message: text || undefined });
    } catch (e) {
      App.uiAlert && App.uiAlert("继续失败：" + (e && e.message ? e.message : e));
      return;
    }
    removeCard();
  };

  // 会话状态事件：新一轮开始 → 发送态；本轮结束 → 清理未生效的暂停轮询。
  App.onTurnLifecycle = function onTurnLifecycle(evt) {
    if (evt.type === "turn-start") { removeCard(); setMode("send"); return; }
    if (evt.type === "turn-end") { removeCard(); if (App.pauseUi.awaiting) stopPolling(); }
  };

  App.initPauseUi = function initPauseUi() {
    if (App.sendBtn) App.sendBtn.addEventListener("click", App.onSendOrPause);
    App.setPauseMode = setMode;
  };
})(typeof window !== "undefined" ? window : globalThis);
