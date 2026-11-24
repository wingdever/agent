"use strict";

// Channel lifecycle control, exposed to the model.
//
// Deliberately not a "connect everything" tool: the model may only act on a channel
// the user asked about. The manager keeps the state, this shell only resolves the
// instance id and forwards, the same way the lark tool forwards to a proxy.

const ACTIONS = ["list", "status", "start", "stop"];

async function run(args = {}, exec = {}) {
  const action = args.action;
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new Error(`unknown action "${action}" (known: ${ACTIONS.join(", ")})`);
  }

  const channels = exec.capabilities && exec.capabilities.channels;
  if (!channels || typeof channels.list !== "function") {
    throw new Error("no channel capability in this run: channel control is unavailable");
  }

  if (action === "list") {
    return { text: JSON.stringify(channels.list()) };
  }

  const id = pickChannelId(args.channel, channels);
  if (action === "status") {
    return { text: JSON.stringify(channels.status(id)) };
  }
  if (action === "start") {
    const result = await channels.start(id, { by: "model" });
    return { text: JSON.stringify(result), meta: { channel: id, action } };
  }
  const result = await channels.stop(id);
  return { text: JSON.stringify(result), meta: { channel: id, action } };
}

// One channel configured: the id is redundant. Several: guessing would connect (or
// disconnect) the wrong account, so the caller must name one.
function pickChannelId(explicit, channels) {
  if (explicit) return explicit;
  const known = channels.list();
  if (known.length === 1) return known[0].instanceId;
  const ids = known.map((entry) => entry.instanceId);
  throw new Error(
    ids.length
      ? `several channels are configured (${ids.join(", ")}); pass "channel" explicitly`
      : "no channel is configured"
  );
}

export { run, ACTIONS, pickChannelId };
export default { run };
