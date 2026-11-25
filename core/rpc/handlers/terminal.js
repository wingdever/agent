"use strict";

// UI-facing terminal panel commands. Creating a terminal from the sidebar is
// explicitly a user-created terminal: it is never visible to agent terminal_*
// tools and its first keystroke is already under user control.

import { resolveWorkspaceFolder } from "./../../context/workspace.js";

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };
const sessionParams = {
  type: "object",
  properties: { session_id: anyId },
  required: ["session_id"],
  additionalProperties: false,
};

async function sessionCwd(core, sessionId, explicit) {
  if (explicit) return explicit;
  try {
    const session = await core.store.getSession({ id: sessionId });
    const workspace = session?.workspace_id != null
      ? await core.store.getWorkspace({ id: session.workspace_id })
      : null;
    if (workspace?.folder_path) {
      return resolveWorkspaceFolder(workspace.folder_path) || workspace.folder_path;
    }
  } catch (_) { /* fall through to process cwd */ }
  return process.cwd();
}

export default function defineTerminalCommands(rpc) {
  rpc.define({
    name: "terminal.panel.list",
    params: sessionParams,
    handler: (core, params) => core.terminals.panelList(params.session_id),
  });

  rpc.define({
    name: "terminal.panel.open",
    params: {
      type: "object",
      properties: {
        session_id: anyId,
        name: { type: "string" },
        cwd: { type: "string" },
        cols: { type: "number" },
        rows: { type: "number" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    handler: async (core, params) => {
      const cwd = await sessionCwd(core, params.session_id, params.cwd);
      return core.terminals.openPanel(params.session_id, {
        name: params.name,
        cwd,
        cols: params.cols,
        rows: params.rows,
      });
    },
  });

  rpc.define({
    name: "terminal.panel.close",
    params: {
      type: "object",
      properties: { session_id: anyId, id: { type: "string" } },
      required: ["session_id", "id"],
      additionalProperties: false,
    },
    handler: (core, params) => core.terminals.closePanel(params.session_id, params.id),
  });
}
