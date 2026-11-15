"use strict";

// UI-facing storage commands. Only the subset the renderer actually uses is
// exposed; the rest of Store.run stays internal.

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };
const payload = {
  type: "object",
  properties: { payload: { type: "object" } },
  required: ["payload"],
  additionalProperties: false,
};
const noParams = { type: "object", properties: {}, additionalProperties: false };
const bySession = {
  type: "object",
  properties: { session_id: anyId },
  required: ["session_id"],
  additionalProperties: false,
};

module.exports = function defineStorageCommands(rpc) {
  const read = (name, storeOp, params) => {
    rpc.define({
      name,
      params,
      handler: (core, value) => core.store.run(storeOp, value),
    });
  };
  const write = (name, storeOp, params = payload) => {
    rpc.define({
      name,
      params,
      handler: (core, value) => core.store.run(storeOp, value.payload),
    });
  };

  read("session.list", "session.list", {
    type: "object",
    properties: {
      workspace_id: anyId,
      includeDeleted: { type: "boolean" },
    },
    additionalProperties: false,
  });
  write("session.create", "session.create");
  write("session.update", "session.update");
  write("session.delete", "session.delete");
  write("session.restore", "session.restore");
  read("session.compactions", "session.compactions", bySession);
  read("session.trajectory", "session.trajectory", bySession);

  read("workspace.list", "workspace.list", noParams);
  write("workspace.create", "workspace.create");
  write("workspace.delete", "workspace.delete");

  read("turn.list", "turn.list", bySession);
  read("step.list", "step.list", {
    type: "object",
    properties: { turn_id: anyId },
    required: ["turn_id"],
    additionalProperties: false,
  });
  read("message.list", "message.list", {
    type: "object",
    properties: { step_id: anyId },
    required: ["step_id"],
    additionalProperties: false,
  });
  read("call.list", "call.list", {
    type: "object",
    properties: { reply_id: anyId },
    required: ["reply_id"],
    additionalProperties: false,
  });
};
