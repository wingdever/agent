"use strict";
// M0 重构：原 app.js 闭包内「轨迹面板」区块（行 701–791）。
// 抽为独立 <script>，向 window.App 挂载。纯展示：复用 store 的 turns/steps/messages/calls。
// 工具卡复用 chat-tab.js 的 App.createToolCard / App.setToolResult；点击复用 App.showToolDetail。

(function () {
  var App = (window.App = window.App || {});

  // 轨迹 DOM 根与缓存（DOMContentLoaded 内由 initTrajectory 填充）。
  var trajectoryTab = null;
  var trajectoryLoadedFor = null; // 缓存：避免重复拉取

  App.initTrajectory = function initTrajectory() {
    trajectoryTab = document.getElementById("trajectoryTab");
  };
  // 切换会话后让轨迹重新拉取（selectSession 调用）。
  App.resetTrajectory = function resetTrajectory() { trajectoryLoadedFor = null; };

  App.loadTrajectory = async function loadTrajectory(sessionId) {
    if (!trajectoryTab) return;
    if (!sessionId) { trajectoryTab.innerHTML = '<div class="empty-hint">请先选择会话</div>'; return; }
    if (trajectoryLoadedFor === sessionId) return;
    trajectoryTab.innerHTML = '<div class="empty-hint">加载轨迹中…</div>';
    try {
      var tree = await window.AgentClient.call("storage", { op: "session.trajectory", payload: { session_id: sessionId } });
      var compactions = [];
      try {
        compactions = await window.AgentClient.call("storage", { op: "session.compactions", payload: { session_id: sessionId } }) || [];
      } catch (e) { compactions = []; }
      trajectoryLoadedFor = sessionId;
      renderTrajectoryTree(tree || [], compactions || []);
    } catch (e) {
      trajectoryTab.innerHTML = '<div class="empty-hint">轨迹加载失败：' + (e && e.message ? e.message : e) + '</div>';
    }
  };

  function renderTrajectoryTree(turns, compactions) {
    if (!trajectoryTab) return;
    trajectoryTab.innerHTML = "";
    if (!turns.length) {
      trajectoryTab.innerHTML = '<div class="empty-hint">暂无轨迹</div>';
      return;
    }
    // 压缩是本轮之外的元事件：在轨迹顶部单列，原始 turns/steps 全部保留。
    var done = (compactions || []).filter(function (c) { return c.status === "succeeded"; });
    if (done.length) {
      var cWrap = App.makeEl("traj-compactions", "traj-compactions");
      done.forEach(function (c) {
        var row = App.makeEl("traj-compaction", "traj-compaction");
        var parts = ["compaction", c.trigger || "manual"];
        if (c.upToTurnSeq != null) parts.push("边界 turn " + c.upToTurnSeq);
        parts.push((c.turns || 0) + " turns");
        if (c.tokensBefore != null && c.tokensAfter != null) {
          parts.push("~" + c.tokensBefore + " → ~" + c.tokensAfter + " tokens");
        }
        row.textContent = parts.join(" · ");
        cWrap.appendChild(row);
      });
      trajectoryTab.appendChild(cWrap);
    }
    turns.forEach(function (turn) {
      var tEl = App.makeEl("traj-turn", "traj-turn");
      tEl.setAttribute("data-turn-id", String(turn.id));
      var tHead = App.makeEl("traj-turn-head", "traj-turn-head");
      tHead.textContent = "Turn " + (turn.seq != null ? turn.seq : turn.id) + " · " + (turn.status || "");
      tEl.appendChild(tHead);
      (turn.steps || []).forEach(function (step) {
        var sEl = App.makeEl("traj-step", "traj-step");
        sEl.setAttribute("data-step-id", String(step.id));
        var sHead = App.makeEl("traj-step-head", "traj-step-head");
        sHead.textContent = "Step " + (step.seq != null ? step.seq : step.id) + " · " + (step.status || "");
        sEl.appendChild(sHead);
        (step.messages || []).forEach(function (msg) {
          if (msg.thought) {
            var th = App.makeEl("traj-thought", "traj-thought");
            var thSummary = App.makeEl("traj-thought-summary", "traj-thought-summary");
            thSummary.textContent = "思考：" + String(msg.thought).slice(0, 120) + (String(msg.thought).length > 120 ? "…" : "");
            th.appendChild(thSummary);
            var thFull = App.makeEl("traj-thought-full", "traj-thought-full");
            if (typeof AgentMarkdown !== "undefined") AgentMarkdown.set(thFull, msg.thought); else thFull.textContent = msg.thought;
            thFull.hidden = true;
            thSummary.addEventListener("click", function () { thFull.hidden = !thFull.hidden; });
            th.appendChild(thFull);
            sEl.appendChild(th);
          }
          if (msg.content && msg.role === "assistant") {
            var ans = App.makeEl("traj-answer", "traj-answer");
            if (typeof AgentMarkdown !== "undefined") AgentMarkdown.set(ans, msg.content); else ans.textContent = msg.content;
            sEl.appendChild(ans);
          }
        });
        (step.calls || []).forEach(function (call) {
          var card = App.createToolCard({
            name: call.name, arguments: typeof call.arguments === "string" ? App.safeParse(call.arguments) : call.arguments,
            description: call.description, status: call.status,
          });
          if (card && call.result != null) {
            var resEvt = { content: call.result, isError: call.status === "failed" || !!call.error };
            App.setToolResult(card, resEvt);
          }
          if (card) {
            card.addEventListener("click", function () { App.showToolDetail(card); });
            sEl.appendChild(card);
          }
        });
        tEl.appendChild(sEl);
      });
      trajectoryTab.appendChild(tEl);
    });
  }
})();
