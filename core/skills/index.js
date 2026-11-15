"use strict";

// Skill subsystem entry point.
// - registry.js: provider merge + rank resolution + list/snapshot/get
// - filesystem.js: local skill discovery + frontmatter parsing
// - content.js: shared <skill_content> rendering (used by skill tool and /name)
// - names.js: kebab-case name validation
// - policy.js: invocation-policy readers
// - instance.js: active-registry accessor for tools/gesture wiring

const { SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER } = require("./registry");
const { FileSystemSkillProvider, createFileSystemProvider } = require("./filesystem");
const content = require("./content");
const { isSkillName, SKILL_NAME_RE } = require("./names");
const { isModelInvocable, isUserInvocable } = require("./policy");
const { setSkillsRegistry, getSkillsRegistry } = require("./instance");

module.exports = {
  SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER,
  FileSystemSkillProvider, createFileSystemProvider,
  isSkillName, SKILL_NAME_RE,
  isModelInvocable, isUserInvocable,
  setSkillsRegistry, getSkillsRegistry,
  ...content
};
