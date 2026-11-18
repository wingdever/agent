"use strict";

// Skill subsystem entry point.
// - registry.js: provider merge + rank resolution + list/snapshot/get
// - filesystem.js: local skill discovery + frontmatter parsing
// Shared, host-agnostic pieces live in lib/ so the skill tool can use them
// without depending on core:
// - lib/skill-content: <skill_content> rendering
// - lib/skill-policy: kebab-case name validation + invocation policy
// - lib/skill-instance: active-registry accessor
// Subsystem-only pieces stay here:
// - registry.js / filesystem.js: provider merge, discovery, caching

const { SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER } = require("./registry");
const { FileSystemSkillProvider, createFileSystemProvider } = require("./filesystem");
const content = require("../../lib/skill-content");
const { isSkillName, SKILL_NAME_RE, isModelInvocable, isUserInvocable } = require("../../lib/skill-policy");
const { setSkillsRegistry, getSkillsRegistry } = require("../../lib/skill-instance");

module.exports = {
  SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER,
  FileSystemSkillProvider, createFileSystemProvider,
  isSkillName, SKILL_NAME_RE,
  isModelInvocable, isUserInvocable,
  setSkillsRegistry, getSkillsRegistry,
  ...content
};
