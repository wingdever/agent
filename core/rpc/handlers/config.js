"use strict";

// Config-domain commands. Write commands keep the `payload` wrapper; reads take
// direct filter fields.

module.exports = function defineConfigCommands(rpc) {
  const payloadObject = {
    type: "object",
    properties: { payload: { type: "object" } },
    required: ["payload"],
    additionalProperties: false,
  };
  const payloadArray = {
    type: "object",
    properties: { payload: { type: "array" } },
    required: ["payload"],
    additionalProperties: false,
  };
  const noParams = { type: "object", properties: {}, additionalProperties: false };

  rpc.define({
    name: "config.get",
    params: noParams,
    handler: (core) => core.config.readSettings(),
  });

  rpc.define({
    name: "config.set",
    params: payloadObject,
    handler: (core, params) => core.config.writeSettings(params.payload),
  });

  rpc.define({
    name: "config.providers.get",
    params: noParams,
    handler: (core) => core.config.readProviders(),
  });

  rpc.define({
    name: "config.providers.upsert",
    params: payloadArray,
    handler: (core, params) => core.config.writeProviders(params.payload),
  });

  rpc.define({
    name: "config.permissions.get",
    params: noParams,
    handler: (core) => core.config.permissionsSnapshot(),
  });

  rpc.define({
    name: "config.permissions.upsert",
    params: payloadObject,
    handler: (core, params) => core.config.writePermissionsRaw(params.payload),
  });

  rpc.define({
    name: "config.permissions.bashPolicy.upsert",
    params: payloadObject,
    handler: (core, params) => core.config.writeBashPolicyRaw(params.payload),
  });

  rpc.define({
    name: "config.permissions.fsPolicy.upsert",
    params: payloadObject,
    handler: (core, params) => core.config.writeFsPolicyRaw(params.payload),
  });
};
