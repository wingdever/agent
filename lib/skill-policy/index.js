"use strict";

// Skill name validation and invocation policy. Both are pure functions shared
// by the skills subsystem (core) and the `skill` tool, so a skill looks the
// same no matter which side inspects it.

const { SKILL_NAME_RE, isSkillName } = require("./names");
const { isModelInvocable, isUserInvocable } = require("./policy");

module.exports = { SKILL_NAME_RE, isSkillName, isModelInvocable, isUserInvocable };
