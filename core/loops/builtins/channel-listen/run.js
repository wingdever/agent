"use strict";

// 二级预定义节点 builtin.channel-listen（type: builtin, kind: entry）。
// 统一承担订阅与监听：attach() 建立到 channel 服务 /messages/subscribe 的长连接，
// 收到消息时以本节点为入口开一个 turn；run() 作为入口阶段把消息注入 ctx。
//
// 这是节点模块的两个面：引擎只加载默认导出的 run()；core 启动时显式调用
// attach() 启动常驻监听（见 core/index.js）。

import channelListen from "./../../../../lib/channel-listen/index.js";
import { profileFor, chatOptions } from "./../../../../lib/agent-profile/index.js";
import { createChannelHistoryReader } from "./../../../../lib/channel-history/reader.js";
import { applyInteraction } from "./../../../../lib/channel-interactions/index.js";
import { createDedupe } from "./../../../../channels/inbound/dedupe.js";
const { createChannelListener } = channelListen;

/** Entrypoint phase: inject the delivered channel message into the turn. */
export default async function run(input, ctx) {
  const message = ctx.channelMessage;
  if (!message) return { output: input };

  const contents = Array.isArray(message.messages)
    ? message.messages
        .map((entry) => entry && entry.content != null ? String(entry.content) : "")
        .filter(Boolean)
    : [];
  ctx.input = ctx.input || {};
  if (contents.length) {
    ctx.input.messages = (ctx.input.messages || []).concat(
      contents.map((content) => ({ role: "user", content }))
    );
  }
  // An entry node bypasses turn-start and assemble-input, which normally set
  // these. Initialize them so downstream nodes and hooks see a valid context.
  if (ctx.request && (!Array.isArray(ctx.request.messages) || !ctx.request.messages.length)) {
    ctx.request.messages = [{ role: "system", content: ctx.system || "" }]
      .concat(ctx.input.messages || []);
    if (ctx.request.header == null) ctx.request.header = ctx.system || "";
  }
  // turn-start normally resolves translate config; hooks like translate-input
  // read it. Without this, an entry-driven turn crashes in those hooks.
  if (ctx.translateCfg == null && ctx.services && ctx.services.context) {
    ctx.translateCfg = ctx.services.context.resolveTranslateConfig(ctx.services.config.readSettings());
  }
  ctx.channelMessages = [message];
  ctx.emit && ctx.emit({
    type: "channel-listen",
    phase: "message",
    eventId: message.eventId,
    conversationKey: message.conversationKey,
  });
  return { output: input };
}

/**
 * Start the long-lived listener. Each incoming message opens a turn whose
 * entry node is this one. Idempotent per (endpoint, instanceId).
 * config: {
 *   endpoint, instanceId, token?, canPromptUser?, interactions?,
 *   historyFile, historyReader?, fetchImpl?, schedule?, log?
 * }
 */
export function attach(core, config = {}) {
  if (!core || !core.agent) throw new TypeError("channel-listen attach needs core.agent");
  const { endpoint, instanceId } = config;
  if (!endpoint || !instanceId) return null;
  const token = config.token || null;
  const baseHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  // SQLite WAL allows core to open the channel service's file read-only across
  // processes. No HTTP history endpoint needed.
  const reader = config.historyReader
    ? config.historyReader
    : createChannelHistoryReader({
        file: config.historyFile || null,
        archiveDir: config.archiveDir || null,
        log: config.log,
      });

  // Core-side idempotency is commit-based: an in-flight event (or one whose
  // process died mid-turn) must be replayable. Only a completed turn is
  // persisted as "seen". This is distinct from the channel service's claim
  // dedupe, which only guards what enters history.
  const dedupe = config.dedupe || createDedupe({
    file: config.dedupeFile || null,
    persistOn: "commit",
  });

  const ack = async (eventId, conversationKey = "", status = "ack") => {
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    try {
      const response = await fetchImpl(String(endpoint).replace(/\/+$/, "") + "/proactive", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, baseHeaders),
        body: JSON.stringify({
          instanceId,
          conversationKey,
          text: "",
          status,
          ackEventId: eventId,
        }),
      });
      if (!response.ok) throw new Error(`http ${response.status}`);
      return response;
    } catch (err) {
      (config.log || console.log)(`[channel-listen] ack failed: ${(err && err.message) || err}`);
      return null;
    }
  };

  const listener = createChannelListener({
    endpoint,
    instanceId,
    fetchImpl: config.fetchImpl,
    schedule: config.schedule,
    headers: baseHeaders,
    log: config.log || ((line) => console.log(line)),
    onMessage: async (message) => {
      // Duplicate event: an in-flight duplicate is ignored (its original turn
      // will ACK or release); a committed duplicate is consumed by ACK.
      if (!dedupe.claim(message.eventId)) {
        if (typeof dedupe.isPending === "function" && dedupe.isPending(message.eventId)) {
          config.emit?.({ type: "channel-listen", phase: "duplicate-inflight", eventId: message.eventId });
          return;
        }
        config.emit?.({ type: "channel-listen", phase: "duplicate", eventId: message.eventId });
        await ack(message.eventId, message.conversationKey || "");
        return;
      }
      const commit = () => { if (typeof dedupe.commit === "function") dedupe.commit(message.eventId); };
      const release = () => { if (typeof dedupe.release === "function") dedupe.release(message.eventId); };
      try {
        const profile = profileFor(instanceId);
        const prior = reader && message.conversationKey
          ? await reader.contextMessages(message.instanceId || instanceId, message.conversationKey)
          : [];
        const delivery = {
          endpoint,
          instanceId: message.instanceId || instanceId,
          conversationKey: message.conversationKey,
          senderId: message.senderId,
          recvType: message.recvType,
          ackEventId: message.eventId,
        };
        if (token) delivery.token = token;
        // Cards are projected through the channel service while the turn is
        // suspended: waiting for a click that was never rendered would hang.
        // Final text stays on channel-send, so it is not projected here twice.
        const CARD_EVENTS = new Set(["approval-request", "ask-user-question", "plan-review"]);
        const projectCard = async (event) => {
          const fetchImpl = config.fetchImpl || globalThis.fetch;
          const response = await fetchImpl(String(endpoint).replace(/\/+$/, "") + "/proactive", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, baseHeaders),
            body: JSON.stringify({
              instanceId: message.instanceId || instanceId,
              conversationKey: message.conversationKey,
              senderId: message.senderId,
              recvType: message.recvType,
              replyTo: message.replyTo || "",
              eventId: message.eventId,
              event,
              text: "",
            }),
          });
          if (!response.ok) throw new Error(`card projection failed: http ${response.status}`);
        };
        const onEvent = (event) => {
          if (config.onEvent) config.onEvent(event);
          if (event && CARD_EVENTS.has(event.type)) {
            projectCard(event).catch((err) => {
              (config.log || console.log)(`[channel-listen] card projection failed: ${(err && err.message) || err}`);
            });
          }
        };
        const result = await core.agent.chat(Object.assign({
          entryNode: "builtin.channel-listen",
          channelMessage: message,
          messages: message.messages,
          contextMessages: prior,
          inputSource: `channel:${message.type || "qq"}:${message.instanceId || instanceId}`,
          // A button-capable channel may wait for a human click. Without that
          // capability, autonomous mode auto-denies ask tools instead of hanging.
          autonomy: config.canPromptUser === true ? "supervised" : "autonomous",
          onEvent,
          loops: profile.loops,
          channelDelivery: delivery,
          channelToken: token,
        }, chatOptions(profile)));

        if (result && result.queued) {
          // The event was accepted into the in-process turn queue. It stays
          // pending so a restart can replay it; the eventual channel-send ACKs
          // it. A live duplicate is ignored via isPending.
          config.emit?.({ type: "channel-listen", phase: "queued", eventId: message.eventId });
          return;
        }

        // A send failure means the user received nothing. Leave the event
        // pending and release the claim so a replay can retry the turn.
        if (delivery.deliveryError) {
          release();
          (config.log || console.log)(`[channel-listen] delivery failed, will retry: ${delivery.deliveryError}`);
          config.emit?.({ type: "channel-listen", phase: "retry", eventId: message.eventId, error: delivery.deliveryError });
          return;
        }

        // A failed model turn produces no reply; notify the service via
        // /proactive with status=failed so it ACKs without sending to QQ.
        const failed = result && (result.error || result.stopReason === "failed");
        if (failed) {
          await ack(message.eventId, message.conversationKey || "", "failed");
        } else if (!delivery.sent) {
          // The agent chose not to reply (or no channel-send hook is configured).
          // Consume the event so the service does not replay it forever.
          await ack(message.eventId, message.conversationKey || "", "ack");
        }
        // channel-send already ACKed when it sent a reply (acked may be false
        // if only the ACK failed; committing here lets a replay ACK-only).
        commit();
        if (config.onTurn) await config.onTurn(message, result);
      } catch (err) {
        release();
        (config.log || console.log)(`[channel-listen] turn failed: ${(err && err.message) || err}`);
      }
    },
  });

  let interactionListener = null;
  const startInteractions = () => {
    if (interactionListener) return interactionListener;
    // Enabling the stream is also the signal that a supervised turn can wait
    // for a click; later messages read this mutable config.
    config.interactions = true;
    config.canPromptUser = true;
    interactionListener = createChannelListener({
      endpoint,
      instanceId,
      path: "/interactions/subscribe",
      fetchImpl: config.fetchImpl,
      schedule: config.schedule,
      headers: baseHeaders,
      log: config.log || ((line) => console.log(line)),
      onMessage: async (interaction) => {
        try {
          applyInteraction(core, interaction);
          config.emit?.({ type: "channel-listen", phase: "interaction", eventId: interaction.eventId });
        } catch (err) {
          (config.log || console.log)(`[channel-listen] interaction failed: ${(err && err.message) || err}`);
        }
      },
    }).start();
    listener.interactionListener = interactionListener;
    return interactionListener;
  };
  if (config.interactions === true || config.canPromptUser === true) startInteractions();

  if (listener.interactionListener === undefined) listener.interactionListener = null;
  listener.enableInteractions = startInteractions;
  listener.closeHistory = () => { if (reader) reader.close(); };
  listener.stop = ((original) => () => {
    original();
    if (interactionListener) interactionListener.stop();
  })(listener.stop);
  return listener.start();
}
