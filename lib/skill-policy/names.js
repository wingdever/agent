"use strict";

// Skill names are kebab-case. Mirror of dsh-skill's isSkillName
// (dsh-skill/lib/index.js).

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSkillName(name) {
  return typeof name === "string" && SKILL_NAME_RE.test(name);
}

module.exports = { SKILL_NAME_RE, isSkillName };
