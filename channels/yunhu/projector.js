"use strict";

// Project one turn into one yunhu message.
//
// The platform has no card abstraction: a reply is a message, and `/bot/edit`
// replaces its content. That gives "streaming" in the weak sense -- the first
// send happens once, later partial text edits the same message on a throttle,
// and the terminal event forces the final text.
//
// Both facts that were unknown are now measured against the live gateway:
//   - `/bot/send` answers `{messageInfo:{msgId}}`, so editing is possible;
//   - `/bot/edit` requires `recvId`/`recvType` beside `msgId` (doc 437), and omitting
//     them returns 1002.
// If no msgId ever comes back, edits are skipped (one send, then nothing) rather
// than sending a second message: a duplicate final answer is worse than a missing
// partial update.

import { textContent, sentMsgId } from "./api.js";

export function createProjector({ api, throttleMs = 800, now = Date.now } = {}) {
  if (!api || typeof api.send !== "function") throw new TypeError("projector needs an api");

  /** @type {Map<string, {text: string, msgId: string|null, lastPushAt: number}>} */
  const sessions = new Map();

  function stateFor(key) {
    let state = sessions.get(key);
    if (!state) {
      state = { text: "", msgId: null, lastPushAt: 0 };
      sessions.set(key, state);
    }
    return state;
  }

  // Group replies go to the chat id; direct replies go to the sender. Sending a
  // group answer to the sender id would leak a group conversation into a DM.
  function targetOf(message) {
    const recvType = message.recvType === "group" ? "group" : "user";
    const recvId = recvType === "group" ? message.conversationKey : message.senderId;
    return { recvId, recvType };
  }

  async function deliver(state, message, text) {
    const target = targetOf(message);
    if (state.msgId) {
      await api.edit({ msgId: state.msgId, recvId: target.recvId, recvType: target.recvType, content: textContent(text) });
      state.lastPushAt = now();
      return;
    }
    const result = await api.send({ ...target, contentType: "text", content: textContent(text), parentId: message.replyTo });
    state.msgId = sentMsgId(result) || null;
    state.lastPushAt = now();
  }

  return {
    async push(message, event) {
      const key = message.sessionId || `${message.instanceId}:${message.conversationKey}`;
      const state = stateFor(key);
      const type = event && event.type;

      if (type === "token") {
        state.text += String((event && event.content) || "");
        // First token opens the message so the user sees progress; after that the
        // throttle applies to edits of the same message.
        if (state.text && now() - state.lastPushAt >= throttleMs) {
          await deliver(state, message, state.text);
        }
        return;
      }

      // core's real turn emits `done` with the message on `event.message`;
      // a direct emitter uses `final` with `event.content`. Both end the reply.
      if (type === "final" || type === "done") {
        const content = type === "done" && event.message ? event.message.content : event.content;
        const text = typeof content === "string" && content ? content : state.text;
        await deliver(state, message, text);
        sessions.delete(key);
        return;
      }

      if (type === "error") {
        // A failed turn must still end visibly: silence leaves the user waiting.
        const text = `⚠️ 这轮没有跑完：${(event && (event.message || event.kind)) || "unknown error"}`;
        if (!state.text) state.text = text;
        else if (!state.text.includes("⚠️")) state.text = text;
        await deliver(state, message, state.text);
        sessions.delete(key);
      }
    },
  };
}
