"use strict";

// In-memory runtime data structures. Other core subdomains reach these only
// through this index (arch.md: 层内边界).
const { RequestSpec } = require("./request-spec");
const { StepState } = require("./step-state");
const { ModelResponse } = require("./model-response");
const { Agent } = require("./agent");
const { AgentRegistry } = require("./registry");
const { createTurnState } = require("./turn-state");

module.exports = { RequestSpec, StepState, ModelResponse, Agent, AgentRegistry, createTurnState };
