"use strict";

// Chat-domain commands. Both stream events; the transport appends the final
// result event after the handler returns.

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

export default function defineChatCommands(rpc) {
  rpc.define({
    name: "chat.send",
    params: chatSendParams,
    streaming: true,
    // The cursor: the session of this turn becomes the default for later calls
    // that omit sessionId.
    handler: (core, params, { onEvent }) => core.agent.chat(Object.assign({}, params, { onEvent })),
  });

  rpc.define({
    name: "chat.compact",
    params: chatCompactParams,
    streaming: true,
    handler: (core, params, { onEvent }) =>
      core.agent.compactSession({ sessionId: params.session_id, model: params.model, onEvent }),
  });
};
