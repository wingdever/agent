"use strict";

import { terminalOwner, requireTerminals, requiredString, errorResult } from "../lib/terminal-tool.js";

export default {
  async run(args = {}, exec = {}) {
    try {
      const sessionId = requiredString(args, "sessionId");
      const terminals = requireTerminals(exec, ["closeTerminal"]);
      const result = await terminals.closeTerminal(terminalOwner(exec), sessionId);
      const captured = Array.isArray(result.captured) ? result.captured : [];
      if (result.detached === true) {
        return {
          text: "Detached terminal " + sessionId + "; it is now read-only for the agent and keeps running for the user.",
          meta: { sessionId, detached: true, gone: false },
        };
      }
      if (result.gone === false) {
        return {
          text: "Error: terminal " + sessionId + " closed, but " + captured.length + " captured process(es) are still alive.",
          isError: true,
          meta: { sessionId, captured, gone: false },
        };
      }
      return {
        text: "Closed terminal " + sessionId + "; " + captured.length + " captured process(es) are gone.",
        meta: { sessionId, captured, gone: true },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
