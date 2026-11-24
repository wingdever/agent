"use strict";

// Strip surface metadata (event seq / message id / turn seq) before a message
// reaches the provider; the request body keeps only Chat Completions fields.
function cleanMessage(message) {
  const clean = { role: message.role, content: message.content };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) clean.tool_calls = message.tool_calls;
  if (message.tool_call_id) clean.tool_call_id = message.tool_call_id;
  return clean;
}

const __exports = { cleanMessage };
export { cleanMessage };
export default __exports;
