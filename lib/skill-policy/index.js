"use strict";

// Skill name validation and invocation policy. Both are pure functions shared
// by the skills subsystem (core) and the `skill` tool, so a skill looks the
// same no matter which side inspects it.

import { SKILL_NAME_RE, isSkillName } from "./names.js";
import { isModelInvocable, isUserInvocable } from "./policy.js";

const __exports = { SKILL_NAME_RE, isSkillName, isModelInvocable, isUserInvocable };
export { SKILL_NAME_RE, isSkillName, isModelInvocable, isUserInvocable };
export default __exports;
