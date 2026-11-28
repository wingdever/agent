"use strict";

// Chat-domain commands. Both stream events; the transport appends the final
// result event after the handler returns.

import path from "path";
import { PROJECT_ROOT } from "./../../../lib/paths/index.js";
import { loadAgentProfile, chatOptions } from "./../../../lib/agent-profile/index.js";

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };

const chatSendParams = {
  type: "object",
  properties: {
    messages: { type: "array", items: { type: "object" } },
    sessionId: anyId,
    mode: { enum: ["bare", "persisted"] },
    stream: { type: "boolean" },
    autonomy: { type: "string" },
    activity: { type: "string" },
    references: { type: "array" },
    effort: { oneOf: [{ type: "string" }, { type: "null" }] },
    toolNames: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    contextMessages: { type: "array" },
    model: { type: "string" },
    inputSource: { type: "string" },
    agentId: { type: "string" },
  },
  required: ["messages"],
  additionalProperties: false,
};

const chatCompactParams = {
  type: "object",
  properties: {
    session_id: anyId,
    model: { type: "string" },
  },
  required: ["session_id"],
  additionalProperties: false,
};

export default function defineChatCommands(rpc, { agentsDir = path.join(PROJECT_ROOT, "agents") } = {}) {
  rpc.define({
    name: "chat.send",
    params: chatSendParams,
    streaming: true,
    // The cursor: the session of this turn becomes the default for later calls
    // that omit sessionId.
    handler: (core, params, { onEvent }) => {
      const ctx = Object.assign({}, params);
      if (params.agentId) {
        // A preset is resolved on the server: the caller picks an id, never the
        // persona/tool whitelist/hooks. Model and effort may still be overridden
        // for the session (e.g. by the composer's selectors).
        const profile = loadAgentProfile(params.agentId, { agentsDir });
        const options = chatOptions(profile);
        ctx.identity = options.identity !== undefined ? options.identity : "";
        ctx.persona = options.persona !== undefined ? options.persona : "";
        ctx.toolNames = options.toolNames !== undefined ? options.toolNames : [];
        ctx.loops = profile.loops;
        if (ctx.model === undefined && options.model !== undefined) ctx.model = options.model;
        if (ctx.effort === undefined && options.effort !== undefined) ctx.effort = options.effort;
      }
      return core.agent.chat(Object.assign(ctx, { onEvent }));
    },
  });

  rpc.define({
    name: "chat.compact",
    params: chatCompactParams,
    streaming: true,
    handler: (core, params, { onEvent }) =>
      core.agent.compactSession({ sessionId: params.session_id, model: params.model, onEvent }),
  });
};
