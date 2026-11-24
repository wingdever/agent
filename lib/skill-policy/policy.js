"use strict";

// Invocation policy readers. Mirror dsh-skill/lib/index.js:37-47.
// Both fields default to true; a skill is invocable unless explicitly disabled.

function isModelInvocable(skill) {
  return !!(skill && skill.invocation ? skill.invocation.modelInvocable !== false : true);
}

function isUserInvocable(skill) {
  return !!(skill && skill.invocation ? skill.invocation.userInvocable !== false : true);
}

const __exports = { isModelInvocable, isUserInvocable };
export { isModelInvocable, isUserInvocable };
export default __exports;
