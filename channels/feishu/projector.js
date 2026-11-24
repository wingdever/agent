"use strict";

// Turn the event stream into one growing card.
//
// Two constraints shape this: platforms meter message patches (so updates must be
// throttled, not per token), and a terminal event must always leave the card in
// its final state (silence reads as a hung bot).

export function createProjector({ api, throttleMs = 250, now = Date.now, terminalTypes = ["turn-end", "done", "error"] } = {}) {
  if (!api || typeof api.sendCard !== "function") throw new TypeError("projector needs an api with sendCard/patchCard");

  /** conversationKey -> {messageId, text, lastPatchAt} */
  const states = new Map();

  /**
   * @param {Object} message inbound message (needs conversationKey)
   * @param {Object} event core event
   */
  async function push(message, event) {
    const key = message.conversationKey;
    if (!key) throw new TypeError("projection needs a conversationKey");

    const state = states.get(key) || { messageId: null, text: "", lastPatchAt: -Infinity };
    states.set(key, state);

    // core streams `{ type: "token", delta }` (docs/runtime/model-call.md §4.1);
    // `content` is accepted for older emitters. Reading only `content` meant every
    // real model turn produced an empty card — measured on the first model reply.
    if (event.type === "token") state.text += event.delta ?? event.content ?? "";
    // A non-streaming emitter may ship only the final message in `done`; without
    // this fallback the turn ends with nothing to show.
    else if (event.type === "done" && !state.text && event.message && typeof event.message.content === "string") {
      state.text = event.message.content;
    } else if (event.type === "error") state.text += (state.text ? "\n\n" : "") + "执行出错：" + (event.message || "");

    const terminal = terminalTypes.includes(event.type);

    if (!state.messageId) {
      if (!state.text) return; // nothing to show yet; wait for the first token
      state.messageId = await api.sendCard({ receiveId: key, text: state.text });
      state.lastPatchAt = now();
      if (terminal) states.delete(key);
      return;
    }

    if (terminal || now() - state.lastPatchAt >= throttleMs) {
      await api.patchCard(state.messageId, state.text);
      state.lastPatchAt = now();
    }
    if (terminal) states.delete(key);
  }

  return { push, size: () => states.size, _states: states };
}
