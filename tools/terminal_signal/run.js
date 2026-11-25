"use strict";

import { terminalOwner, requireTerminals, requiredString, errorResult } from "../lib/terminal-tool.js";

const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP"]);

export default {
  async run(args = {}, exec = {}) {
    try {
      const sessionId = requiredString(args, "sessionId");
      const signal = requiredString(args, "signal").toUpperCase();
      if (!SIGNALS.has(signal)) throw new Error("signal must be one of " + [...SIGNALS].join(", "));
      const terminals = requireTerminals(exec, ["signal"]);
      const result = terminals.signal(terminalOwner(exec), sessionId, signal);
      return {
        text: "Sent " + result.signal + " to the foreground process group " + result.pgid +
          " of terminal " + sessionId + ".",
        meta: result,
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
