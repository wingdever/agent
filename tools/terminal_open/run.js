"use strict";

import { terminalOwner, requireTerminals, requiredString, optionalString, errorResult } from "../lib/terminal-tool.js";

export default {
  async run(args = {}, exec = {}) {
    try {
      const type = requiredString(args, "type");
      const name = optionalString(args, "name");
      const cwd = optionalString(args, "cwd");
      const terminals = requireTerminals(exec, ["open"]);
      const handle = await terminals.open(terminalOwner(exec), {
        type,
        name,
        cwd: cwd === undefined ? exec.cwd : cwd,
      });
      return {
        text: "Opened terminal " + handle.id + " (" + handle.type + ") in " + handle.cwd +
          (handle.name ? " as \"" + handle.name + "\"" : "") + ".",
        meta: {
          sessionId: handle.id,
          id: handle.id,
          name: handle.name,
          type: handle.type,
          cwd: handle.cwd,
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
