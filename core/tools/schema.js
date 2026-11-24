"use strict";

// Tool-facing wrapper around the shared validator. The shared module is also
// used by the RPC registry with noun "params"; tools keep the DSH wording
// "invalid arguments: ...".

import { validateSchema as validate } from "./../schema.js";

function validateSchema(schema, value) {
  return validate(schema, value, { noun: "arguments" });
}

const __exports = { validateSchema };
export { validateSchema };
export default __exports;
