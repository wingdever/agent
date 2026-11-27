"use strict";

// Node channel-send: send a message to a channel service, then continue.
//
// Like builtin.translate-output this node writes no history of its own — it
// only emits an event and hands the actual delivery to lib/channel-send, which
// POSTs to the channel service's callback endpoint. The service owns the
// message history and the QQ send.
//
// Delivery parameters are injected by the orchestration layer into
// ctx.channelDelivery: { endpoint, instanceId, conversationKey, text,
// senderId?, recvType? }. The text may also be a function of the current step
// response when the orchestrator wants to send the model's final answer.
// No ctx.channelDelivery means nothing to send — the node is a no-op.

import channelSend from "./../../../../lib/channel-send/index.js";
const { sendToChannel } = channelSend;

function resolveText(delivery, ctx) {
  const raw = delivery && delivery.text;
  if (typeof raw === "function") {
    return raw(ctx.step && ctx.step.response, ctx);
  }
  if (raw != null) return raw;
  // Default to the model's latest answer when orchestration only supplies a
  // target and leaves the content implicit.
  const response = ctx.step && ctx.step.response;
  return response && response.content != null ? response.content : "";
}

export default async function run(input, ctx) {
  const delivery = ctx.channelDelivery;
  if (!delivery || !delivery.endpoint || !delivery.instanceId || !delivery.conversationKey) {
    return { output: input, next: "decide-next" };
  }

  const text = String(resolveText(delivery, ctx) || "").trim();
  if (!text) return { output: input, next: "decide-next" };

  ctx.emit({
    type: "channel-send",
    phase: "start",
    instanceId: delivery.instanceId,
    conversationKey: delivery.conversationKey,
    text,
  });
  try {
    await sendToChannel({
      endpoint: delivery.endpoint,
      instanceId: delivery.instanceId,
      conversationKey: delivery.conversationKey,
      text,
      senderId: delivery.senderId,
      recvType: delivery.recvType,
      ackEventId: delivery.ackEventId || (ctx.channelMessage && ctx.channelMessage.eventId),
      fetchImpl: ctx.fetchImpl,
    });
    ctx.emit({
      type: "channel-send",
      phase: "done",
      instanceId: delivery.instanceId,
      conversationKey: delivery.conversationKey,
      text,
    });
  } catch (err) {
    ctx.emit({
      type: "channel-send",
      phase: "error",
      instanceId: delivery.instanceId,
      conversationKey: delivery.conversationKey,
      error: String((err && err.message) || err),
    });
  }
  return { output: input, next: "decide-next" };
}
