"use strict";

const { RpcRegistry } = require("./registry");
const defineChatCommands = require("./handlers/chat");
const defineConfigCommands = require("./handlers/config");
const defineStorageCommands = require("./handlers/storage");
const defineCatalogCommands = require("./handlers/catalog");
const defineInteractionCommands = require("./handlers/interactions");
const defineFlowCommands = require("./handlers/flow");

function createRpc(core) {
  const rpc = new RpcRegistry(core);
  defineChatCommands(rpc);
  defineConfigCommands(rpc);
  defineStorageCommands(rpc);
  defineCatalogCommands(rpc);
  defineInteractionCommands(rpc);
  defineFlowCommands(rpc);
  return rpc;
}

module.exports = { createRpc, RpcRegistry };
