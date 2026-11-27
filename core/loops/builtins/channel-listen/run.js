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
 * config: { endpoint, instanceId, historyFile, historyReader?, fetchImpl?, schedule?, log? }
 */
export function attach(core, config = {}) {
  if (!core || !core.agent) throw new TypeError("channel-listen attach needs core.agent");
  const { endpoint, instanceId } = config;
  if (!endpoint || !instanceId) return null;

  // SQLite WAL allows core to open the channel service's file read-only across
  // processes. No HTTP history endpoint needed.
  const reader = config.historyReader
    ? config.historyReader
    : createChannelHistoryReader({
        file: config.historyFile || null,
        archiveDir: config.archiveDir || null,
        log: config.log,
      });

  // Core-side idempotency: a replayed event must not run a second turn. If the
  // event was already processed, ACK it anyway so the channel service stops
  // replaying it. This is distinct from the channel service's own dedupe,
  // which only guards what enters history.
  const dedupe = config.dedupe || createDedupe({ file: config.dedupeFile || null });

  const ack = async (eventId, conversationKey = "", status = "ack") => {
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    return fetchImpl(String(endpoint).replace(/\/+$/, "") + "/proactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId,
        conversationKey,
        text: "",
        status,
        ackEventId: eventId,
      }),
    }).catch((err) => (config.log || console.log)(`[channel-listen] ack failed: ${(err && err.message) || err}`));
  };

  const listener = createChannelListener({
    endpoint,
    instanceId,
    fetchImpl: config.fetchImpl,
    schedule: config.schedule,
    log: config.log || ((line) => console.log(line)),
    onMessage: async (message) => {
      // Duplicate event: consume it (ACK) without running another turn.
      if (!dedupe.claim(message.eventId)) {
        config.emit?.({ type: "channel-listen", phase: "duplicate", eventId: message.eventId });
        await ack(message.eventId, message.conversationKey || "");
        return;
      }
      try {
        const profile = profileFor(instanceId);
        const prior = reader && message.conversationKey
          ? await reader.contextMessages(message.instanceId || instanceId, message.conversationKey)
          : [];
        const result = await core.agent.chat(Object.assign({
          entryNode: "builtin.channel-listen",
          channelMessage: message,
          messages: message.messages,
          contextMessages: prior,
          inputSource: `channel:${message.type || "qq"}:${message.instanceId || instanceId}`,
          autonomy: "autonomous",
          onEvent: config.onEvent || (() => {}),
          loops: profile.loops,
          channelDelivery: {
            endpoint,
            instanceId: message.instanceId || instanceId,
            conversationKey: message.conversationKey,
            senderId: message.senderId,
            recvType: message.recvType,
            ackEventId: message.eventId,
          },
        }, chatOptions(profile)));

        // A failed turn produces no reply; notify the service via /proactive
        // with status=failed so the message ACKs without sending to QQ.
        const failed = result && (result.error || result.stopReason === "failed");
        if (failed) {
          await ack(message.eventId, message.conversationKey || "", "failed");
        }
        if (config.onTurn) await config.onTurn(message, result);
      } catch (err) {
        (config.log || console.log)(`[channel-listen] turn failed: ${(err && err.message) || err}`);
      }
    },
  });
  listener.closeHistory = () => { if (reader) reader.close(); };
  return listener.start();
}
