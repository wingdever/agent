"use strict";


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

export default function defineInteractionCommands(rpc) {
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
    handler: async (core, params) => {
      const agent = await core.agent.getOrCreate(params.session_id);
      return { active: agent.planPolicyActive() };
    },
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
    handler: async (core, params) => {
      const agent = await core.agent.getOrCreate(params.payload.session_id);
      const active = agent.setPlanMode(params.payload.active === true);
      // The UI indicator settles when the switch is accepted; the header keeps
      // the old policy until the next step's pre-step reads the new value.
      agent.turn && agent.turn.emit({ type: "plan-mode", active });
      return { active };
    },
  });
};
