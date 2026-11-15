"use strict";

// Tool-facing wrapper around the shared validator. The shared module is also
// used by the RPC registry with noun "params"; tools keep the DSH wording
// "invalid arguments: ...".

const { validateSchema: validate } = require("../schema");

function validateSchema(schema, value) {
  return validate(schema, value, { noun: "arguments" });
}

module.exports = { validateSchema };
