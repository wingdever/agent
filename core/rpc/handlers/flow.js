"use strict";

// Flow-domain commands for the canvas.
//
// The flow canvas is a UI surface over the flow subdomain; these commands are
// its whole interface to core. `flow.run` is the only streaming command: node
// and run events ride the chat event channel so the canvas can tint nodes
// without polling the database.

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };

const definition = {
  type: "object",
  properties: {
    nodes: { type: "array", items: { type: "object" } },
    edges: { type: "array", items: { type: "object" } },
    workdir: { type: "string" },
  },
  required: ["nodes", "edges"],
  additionalProperties: true,
};

const saveParams = {
  type: "object",
  properties: {
    id: anyId,
    name: { type: "string" },
    description: { type: "string" },
    definition,
  },
  required: ["definition"],
  additionalProperties: false,
};

const runParams = {
  type: "object",
  properties: {
    flowId: anyId,
    input: {},
  },
  required: ["flowId"],
  additionalProperties: false,
};

const idParams = {
  type: "object",
  properties: { id: anyId },
  required: ["id"],
  additionalProperties: false,
};

module.exports = function defineFlowCommands(rpc) {
  const service = (core) => {
    if (!core.flow) throw new Error("flow service is not available");
    return core.flow;
  };

  rpc.define({
    name: "flow.nodeTypes",
    params: { type: "object", properties: {}, additionalProperties: false },
    handler: (core) => service(core).nodeTypes(),
  });

  rpc.define({
    name: "flow.list",
    params: { type: "object", properties: {}, additionalProperties: false },
    handler: (core) => service(core).list(),
  });

  rpc.define({
    name: "flow.get",
    params: idParams,
    handler: async (core, value) => {
      const row = await service(core).get(Number(value.id));
      if (!row) return null;
      let parsed = null;
      try { parsed = JSON.parse(row.definition); } catch (_) { parsed = null; }
      return { ...row, definition: parsed };
    },
  });

  rpc.define({
    name: "flow.save",
    params: saveParams,
    handler: (core, value) => service(core).save({
      id: value.id == null ? null : Number(value.id),
      name: value.name,
      description: value.description,
      definition: value.definition,
    }),
  });

  rpc.define({
    name: "flow.validate",
    params: { type: "object", properties: { definition }, required: ["definition"], additionalProperties: false },
    handler: (core, value) => service(core).validate(value.definition),
  });

  rpc.define({
    name: "flow.delete",
    params: idParams,
    handler: (core, value) => service(core).remove(Number(value.id)),
  });

  rpc.define({
    name: "flow.runs",
    params: { type: "object", properties: { flowId: anyId }, required: ["flowId"], additionalProperties: false },
    handler: (core, value) => service(core).listRuns(Number(value.flowId)),
  });

  rpc.define({
    name: "flow.run",
    streaming: true,
    params: runParams,
    handler: async (core, value, { onEvent }) => {
      const result = await service(core).run({
        flowId: Number(value.flowId),
        input: value.input === undefined ? null : value.input,
        onEvent,
      });
      return result;
    },
  });
};
