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

import { SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER } from "./registry.js";
import _mod0 from "./filesystem.js";
const { FileSystemSkillProvider, createFileSystemProvider } = _mod0;
import content from "./../../lib/skill-content/index.js";
import { isSkillName, SKILL_NAME_RE, isModelInvocable, isUserInvocable } from "./../../lib/skill-policy/index.js";
import { setSkillsRegistry, getSkillsRegistry } from "./../../lib/skill-instance/index.js";

export default {
  SkillRegistry, RUNTIME_RANK, RUNTIME_PROVIDER,
  FileSystemSkillProvider, createFileSystemProvider,
  isSkillName, SKILL_NAME_RE,
  isModelInvocable, isUserInvocable,
  setSkillsRegistry, getSkillsRegistry,
  ...content
};
