"use strict";

// Shared rendering for skill content, copied verbatim from
// @deepseek-ai/dsh@0.2.1-rc.2 / @deepseek-ai/dsh-skill/lib/index.js:57-99.
// Both the `skill` tool result and the `/name` user gesture render through
// renderSkillContent so the model sees one canonical <skill_content> shape.

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;");
}

function renderResourceHint(skill) {
  const base = skill.resourceBase;
  if (base === void 0) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      "Load referenced resources only as needed."
    ];
  }
  switch (base.kind) {
    case "directory":
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed."
      ];
    case "url":
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        "Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed."
      ];
    case "opaque":
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        "Load referenced resources only as needed."
      ];
    default:
      return [
        `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
        "Load referenced resources only as needed."
      ];
  }
}

function renderSkillContent(skill) {
  const resourceHint = renderResourceHint(skill);
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    "<skill_resources>",
    ...resourceHint,
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.content,
    "</skill_instructions>",
    "</skill_content>"
  ].join("\n");
}

module.exports = { escapeText, escapeAttr, renderResourceHint, renderSkillContent };
