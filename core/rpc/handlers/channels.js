"use strict";

// UI-facing channel lifecycle commands. The manager owns all state; these
// handlers only project its roster and forward explicit start/stop requests.
// Configuration stays in user/channels.json -- this surface never writes it.

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };
const noParams = { type: "object", properties: {}, additionalProperties: false };
const byId = {
  type: "object",
  properties: { id: anyId },
  required: ["id"],
  additionalProperties: false,
};

function service(core) {
  const channels = core.capabilities && core.capabilities.channels;
  if (!channels || typeof channels.list !== "function") {
    throw new Error("channel manager is not available");
  }
  return channels;
}

export default function defineChannelCommands(rpc) {
  rpc.define({
    name: "channel.list",
    params: noParams,
    handler: (core) => service(core).list(),
  });

  rpc.define({
    name: "channel.start",
    params: byId,
    handler: (core, value) => service(core).start(String(value.id), { by: "user" }),
  });

  rpc.define({
    name: "channel.stop",
    params: byId,
    handler: (core, value) => service(core).stop(String(value.id)),
  });

  // The stream stays open until the transport cancels it. The manager sends a
  // full roster snapshot on subscribe and after every status change, so a
  // client can replace its state wholesale and needs no separate status call.
  rpc.define({
    name: "channel.subscribe",
    streaming: true,
    params: noParams,
    handler: (core, value, { onEvent, onCancel }) => new Promise((resolve) => {
      const channels = service(core);
      let off = () => {};
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        off();
        resolve(null);
      };
      onCancel(finish);
      off = channels.subscribe((roster) => {
        if (done) return;
        onEvent({ type: "snapshot", channels: roster });
      });
      if (done) off();
    }),
  });
}
