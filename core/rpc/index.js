"use strict";

import { RpcRegistry } from "./registry.js";
import defineChatCommands from "./handlers/chat.js";
import defineConfigCommands from "./handlers/config.js";
import defineGoalCommands from "./handlers/goal.js";
import defineStorageCommands from "./handlers/storage.js";
import defineCatalogCommands from "./handlers/catalog.js";
import defineInteractionCommands from "./handlers/interactions.js";
import defineFlowCommands from "./handlers/flow.js";
import defineTerminalCommands from "./handlers/terminal.js";
import defineChannelCommands from "./handlers/channels.js";
import defineAgentCommands from "./handlers/agents.js";
import defineTurnCommands from "./handlers/turn.js";

function createRpc(core) {
  const rpc = new RpcRegistry(core);
  defineChatCommands(rpc);
  defineConfigCommands(rpc);
  defineGoalCommands(rpc);
  defineStorageCommands(rpc);
  defineCatalogCommands(rpc);
  defineInteractionCommands(rpc);
  defineFlowCommands(rpc);
  defineTerminalCommands(rpc);
  defineChannelCommands(rpc);
  defineAgentCommands(rpc);
  defineTurnCommands(rpc);
  return rpc;
}

const __exports = { createRpc, RpcRegistry };
export { createRpc, RpcRegistry };
export default __exports;
