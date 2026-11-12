"use strict";
// M0 重构：原 app.js 闭包内「上下文压缩（/compact + 自动触发）」区块（行 1913–2026）。
// 抽为独立 <script>，向 window.App 挂载。compactionHappenedInTurn 为共享状态（state.js）。
// chat-tab.js 的 onChatEvent 在收到 compaction 事件时调用 App.handleCompactionEvent。

(function () {
  var App = (window.App = window.App || {});

  // checkpoint 卡：默认展开全文（原文 turns 仍在下方全部展示，DSH transcript 语义）。
  App.renderCompactionCard = function renderCompactionCard(c) {
    var card = App.makeEl("compaction-card", "compaction-card");
    var head = App.makeEl("compaction-card-head", "compaction-card-head");
    var meta = ["上下文已压缩"];
    if (c.turns != null) meta.push(c.turns + " turns");
    if (c.tokensBefore != null && c.tokensAfter != null) meta.push("~" + c.tokensBefore + " → ~" + c.tokensAfter + " tokens");
    if (c.upToMessageId != null) meta.push("边界 message #" + c.upToMessageId);
    if (c.model) meta.push(c.model);
    if (c.createdAt) meta.push(String(c.createdAt));
    head.textContent = meta.join(" · ");
    var body = App.makeEl("compaction-card-body", "compaction-card-body textcard");
    if (typeof AgentMarkdown !== "undefined") AgentMarkdown.set(body, c.summary || "");
    else body.textContent = c.summary || "";
    card.appendChild(head);
    card.appendChild(body);
    return card;
  };

  function showCompactionNotice(text) {
    var old = App.chatTab.querySelector(".compaction-notice");
    if (old) old.remove();
    var n = App.makeEl("compaction-notice", "compaction-notice");
    n.textContent = text;
    App.chatTab.appendChild(n);
    App.scrollChatToBottom();
  }
  App.showCompactionNotice = showCompactionNotice;

  App.handleCompactionEvent = function handleCompactionEvent(evt) {
    if (evt.phase === "start") {
      showCompactionNotice("正在压缩上下文（" + (evt.trigger || "manual") + "）…");
    } else if (evt.phase === "prune") {
      showCompactionNotice("已裁剪 " + (evt.count || 0) + " 条超长工具结果（~" + (evt.charsRemoved || 0) + " 字符）");
    } else if (evt.phase === "overflow") {
      showCompactionNotice("上下文超限，压缩后重试…");
    } else if (evt.phase === "done") {
      App.compactionHappenedInTurn = true;
      if (App.resetTrajectory) App.resetTrajectory();
      showCompactionNotice("上下文已压缩 · " + (evt.turns || 0) + " turns · ~" + (evt.tokensBefore || 0) + " → ~" + (evt.tokensAfter || 0) + " tokens");
    } else if (evt.phase === "failed") {
      showCompactionNotice("压缩失败：" + (evt.error || "unknown"));
    }
  };

  // 手动 /compact：走后端 compact 事务（与自动触发同一实现）。
  App.runCompact = async function runCompact() {
    if (!App.currentSessionId) { await App.uiAlert("请先选择一个会话。"); return; }
    if (App.sendBtn) App.sendBtn.disabled = true;
    if (App.input) App.input.disabled = true;
    try {
      var res = await window.AgentClient.call("compact", {
        session_id: App.currentSessionId,
        model: (App.modelSelector && App.modelSelector.value) ? App.modelSelector.value : undefined,
      }, App.handleCompactionEvent);
      if (res && res.ok) {
        App.compactionHappenedInTurn = false; // 手动压缩已按存储重建，避免下轮 turn-end 再刷一次
        await App.renderSessionMessages(App.currentSessionId);
        showCompactionNotice("上下文已压缩 · " + (res.turns || 0) + " turns · ~" + (res.tokensBefore || 0) + " → ~" + (res.tokensAfter || 0) + " tokens");
      } else if (res && /already in progress/.test(String(res.error || ""))) {
        showCompactionNotice("压缩进行中…");
      } else if (res && /no compactable history/.test(String(res.error || ""))) {
        await App.uiAlert("没有可压缩的历史：至少需要 2 个完整 turn。");
      } else if (res && /not smaller/.test(String(res.error || ""))) {
        await App.uiAlert("压缩未执行：这段历史太短，摘要不会比原文更小。");
      } else {
        await App.uiAlert("压缩未执行：" + (res && res.error ? res.error : "unknown"));
      }
    } catch (e) {
      await App.uiAlert("压缩失败：" + (e && e.message ? e.message : e));
    } finally {
      if (App.sendBtn) App.sendBtn.disabled = false;
      if (App.input) App.input.disabled = false;
      if (App.input) App.input.focus();
    }
  };

  // 斜杠命令：目前只有 /compact（与 DSH 的 /command 范式一致）。
  App.runSlashCommand = async function runSlashCommand(raw) {
    var parts = String(raw || "").trim().split(/\s+/);
    var name = parts[0];
    if (name !== "/compact") {
      App.input.value = "";
      await App.uiAlert("未知命令：" + name + "（可用：/compact）");
      return;
    }
    if (parts.length > 1) {
      App.input.value = "";
      await App.uiAlert("用法：/compact（无参数）");
      return;
    }
    if (App.isBare()) {
      App.input.value = "";
      await App.uiAlert("纯对话模式不落库，没有可压缩的历史。");
      return;
    }
    App.input.value = "";
    await App.runCompact();
  };

  // 上下文窗口：providers.json 每模型 context_window > settings.contextWindow > 128k，
  // 与 core 的自动压缩阈值同源。
  App.refreshContextWindow = async function refreshContextWindow() {
    try {
      var res = await window.AgentClient.call("contextWindow", {
        model: (App.modelSelector && App.modelSelector.value) ? App.modelSelector.value : undefined,
      });
      if (res && res.contextWindow > 0) {
        App.CONTEXT_WINDOW = res.contextWindow;
        App.renderStatusBar();
      }
    } catch (e) { /* 后端未就绪时沿用 128k */ }
  };
})();
