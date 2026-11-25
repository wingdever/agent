"use strict";

import { terminalOwner, requireTerminals, requiredString, optionalNumber, errorResult } from "../lib/terminal-tool.js";

export default {
  async run(args = {}, exec = {}) {
    try {
      const id = requiredString(args, "id");
      const lines = optionalNumber(args, "lines", 500);
      if (!Number.isInteger(lines) || lines < 1) throw new Error("lines must be a positive integer");
      const terminals = requireTerminals(exec, ["readScreen", "getInteractive"]);
      const terminal = terminals.getInteractive(terminalOwner(exec), id);
      if (terminal.control !== "user") {
        throw new Error("terminal " + id + " is not controlled by the user; use terminal_read");
      }
      const result = await terminals.readScreen(terminalOwner(exec), id, Math.min(lines, 2000));
      return {
        text: result.text,
        meta: result.meta,
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
