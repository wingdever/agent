"use strict";

import { terminalOwner, requireTerminals, errorResult } from "../lib/terminal-tool.js";

function render(terminal) {
  const status = terminal.alive ? "running" : (terminal.exitCode == null ? "exited" : "exit " + terminal.exitCode);
  return "- " + terminal.id + " [" + terminal.type + "] " + terminal.name +
    " — " + status + " — cwd=" + terminal.cwd +
    (terminal.foregroundPgrp ? " — foreground_pgid=" + terminal.foregroundPgrp : "");
}

export default {
  async run(args = {}, exec = {}) {
    try {
      const terminals = requireTerminals(exec, ["list"]);
      const list = terminals.list(terminalOwner(exec));
      if (!list.length) {
        return { text: "No persistent terminals in this session.", meta: { count: 0 } };
      }
      return {
        text: "Persistent terminals (" + list.length + "):\n" + list.map(render).join("\n"),
        meta: { count: list.length },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};
