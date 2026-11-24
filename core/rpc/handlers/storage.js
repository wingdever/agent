"use strict";

// UI-facing storage commands. Only the subset the renderer actually uses is
// exposed; the rest of Store.run stays internal.

import { resolveWorkspaceFolder } from "./../../context/workspace.js";

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };
const payload = {
  type: "object",
  properties: { payload: { type: "object" } },
  required: ["payload"],
  additionalProperties: false,
};
const noParams = { type: "object", properties: {}, additionalProperties: false };
const bySession = {
  type: "object",
  properties: { session_id: anyId },
  required: ["session_id"],
  additionalProperties: false,
};

export default function defineStorageCommands(rpc) {
  const read = (name, storeOp, params) => {
    rpc.define({
      name,
      params,
      handler: (core, value) => core.store.run(storeOp, value),
    });
  };
  const write = (name, storeOp, params = payload) => {
    rpc.define({
      name,
      params,
      handler: (core, value) => core.store.run(storeOp, value.payload),
    });
  };

  read("session.list", "session.list", {
    type: "object",
    properties: {
      workspace_id: anyId,
      includeDeleted: { type: "boolean" },
    },
    additionalProperties: false,
  });
  write("session.create", "session.create");
  write("session.update", "session.update");
  write("session.delete", "session.delete");
  write("session.restore", "session.restore");
  read("session.compactions", "session.compactions", bySession);
  read("session.trajectory", "session.trajectory", bySession);

  // workspaces.folder_path 存的是用户给的原始值（可能是 "Downloads" 这类相对路径），
  // UI 需要能显示完整位置，因此在返回行上附加计算字段 absolute_path（不落库）：
  // 能解析到真实目录就用解析结果，解析不到就给出基于 cwd 的绝对形式。
  const withAbsolutePath = (row) => {
    if (!row || typeof row.folder_path !== "string" || !row.folder_path.trim()) return row;
    const resolved = resolveWorkspaceFolder(row.folder_path);
    const absolute = resolved || (row.folder_path.startsWith("/") ? row.folder_path : null);
    return absolute ? Object.assign({}, row, { absolute_path: absolute }) : row;
  };
  rpc.define({
    name: "workspace.list",
    params: noParams,
    handler: async (core) => {
      const rows = (await core.store.run("workspace.list", {})) || [];
      return rows.map(withAbsolutePath);
    },
  });
  write("workspace.create", "workspace.create");
  write("workspace.delete", "workspace.delete");

  read("turn.list", "turn.list", bySession);
  read("step.list", "step.list", {
    type: "object",
    properties: { turn_id: anyId },
    required: ["turn_id"],
    additionalProperties: false,
  });
  read("message.list", "message.list", {
    type: "object",
    properties: { step_id: anyId },
    required: ["step_id"],
    additionalProperties: false,
  });
  read("call.list", "call.list", {
    type: "object",
    properties: { reply_id: anyId },
    required: ["reply_id"],
    additionalProperties: false,
  });
};
