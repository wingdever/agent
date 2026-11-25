"use strict";

import { terminalOwner, requireTerminals, requiredString, optionalNumber, errorResult } from "../lib/terminal-tool.js";

export default {
  async run(args = {}, exec = {}) {
    try {
      const sessionId = requiredString(args, "sessionId");
      const offset = optionalNumber(args, "offset", 0);
      const count = optionalNumber(args, "count", 500);
      if (offset < 0) throw new Error("offset must be non-negative");
      if (count < 0) throw new Error("count must be non-negative");
      const terminals = requireTerminals(exec, ["read"]);
      const result = terminals.read(terminalOwner(exec), sessionId, { offset, count });
      return {
        text: result.text,
        meta: result.meta,
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
