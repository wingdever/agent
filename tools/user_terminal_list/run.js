"use strict";

import { terminalOwner, requireTerminals, errorResult } from "../lib/terminal-tool.js";

function render(terminal) {
  const status = terminal.running || "unknown";
  return "- " + terminal.id + " [" + (terminal.name || terminal.type || "terminal") + "]" +
    " — cwd=" + (terminal.cwd || "") +
    " — running=" + status;
}

export default {
  async run(args = {}, exec = {}) {
    try {
      const terminals = requireTerminals(exec, ["panelList"]);
      const list = terminals.panelList(terminalOwner(exec))
        // `user_terminal_*` is the read-only mirror of terminals the user
      // actually controls. Agent-owned terminals that the user only watched
        // stay in terminal_list until the first keystroke transfers control.
        .filter((terminal) => terminal.control === "user");
      if (!list.length) {
        return { text: "No user-controlled terminals in this session.", meta: { count: 0 } };
      }
      return {
        text: "User terminals (" + list.length + "):\n" + list.map(render).join("\n"),
        meta: { count: list.length },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
