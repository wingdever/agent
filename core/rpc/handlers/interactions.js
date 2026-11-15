"use strict";

const planMode = require("../../plan-mode");

const anyId = { oneOf: [{ type: "string" }, { type: "number" }] };
const payload = {
  type: "object",
  properties: { payload: { type: "object" } },
  required: ["payload"],
  additionalProperties: false,
};
const bySession = {
  type: "object",
  properties: { session_id: anyId },
  required: ["session_id"],
  additionalProperties: false,
};

module.exports = function defineInteractionCommands(rpc) {
  rpc.define({
    name: "interactions.approve",
    params: payload,
    handler: (core, params) => core.interactions.approve(params.payload.id, params.payload.decision),
  });

  rpc.define({
    name: "interactions.answerQuestions",
    params: payload,
    handler: (core, params) => core.interactions.answerQuestions(params.payload.id, params.payload.answers),
  });

  rpc.define({
    name: "interactions.answerPlanReview",
    params: payload,
    handler: (core, params) => core.interactions.answerPlanReview(params.payload.id, params.payload),
  });

  rpc.define({
    name: "interactions.answerUserJob",
    params: payload,
    handler: (core, params) => core.interactions.answerUserJob(params.payload.id, params.payload),
  });

  rpc.define({
    name: "plan.get",
    params: bySession,
    handler: (core, params) => ({ active: planMode.isActive(params.session_id) }),
  });

  rpc.define({
    name: "plan.set",
    params: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { session_id: anyId, active: { type: "boolean" } },
          required: ["session_id"],
        },
      },
      required: ["payload"],
      additionalProperties: false,
    },
    handler: (core, params) => ({
      active: planMode.setActive(params.payload.session_id, params.payload.active === true),
    }),
  });
};
