"use strict";

const { validateSchema } = require("../schema");

const EMPTY_PARAMS = { type: "object", properties: {}, additionalProperties: false };

// UI-facing command registry. Each command declares its params schema and
// whether it streams events; transports only need handle()/isStreaming().
class RpcRegistry {
  constructor(core) {
    this.core = core;
    this.commands = new Map();
  }

  define(descriptor) {
    if (!descriptor || typeof descriptor.name !== "string" || !descriptor.name) {
      throw new Error("rpc command requires a name");
    }
    if (typeof descriptor.handler !== "function") {
      throw new Error('rpc command "' + descriptor.name + '" requires a handler');
    }
    if (this.commands.has(descriptor.name)) {
      throw new Error('duplicate rpc command "' + descriptor.name + '"');
    }
    this.commands.set(descriptor.name, {
      name: descriptor.name,
      params: descriptor.params || EMPTY_PARAMS,
      streaming: descriptor.streaming === true,
      handler: descriptor.handler,
    });
    return this;
  }

  get(name) {
    const command = this.commands.get(name);
    if (!command) throw new Error("unknown command: " + name);
    return command;
  }

  isStreaming(name) {
    const command = this.commands.get(name);
    return !!(command && command.streaming);
  }

  list() {
    return [...this.commands.values()].map((c) => ({ name: c.name, streaming: c.streaming }));
  }

  async handle(name, params, { onEvent = () => {} } = {}) {
    const command = this.get(name);
    const value = params == null ? {} : params;
    const violations = validateSchema(command.params, value, { noun: "params" });
    if (violations.length > 0) {
      throw new Error("invalid params: " + violations.join("; "));
    }
    return await command.handler(this.core, value, { onEvent });
  }
}

module.exports = { RpcRegistry, EMPTY_PARAMS };
