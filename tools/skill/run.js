"use strict";

// Loads a skill's full instructions and returns them as a <skill_content> block.
// Mirrors dsh-tool-skill/lib/index.js:866-885 execute flow: validate name, find
// the summary, gate on model invocability, reload the full definition, re-gate,
// then render. The registry is reached through the startup singleton so this
// module stays decoupled from provider wiring.

const { getSkillsRegistry } = require("../../core/skills/instance");
const { renderSkillContent, isModelInvocable, isSkillName } = require("../../core/skills");

async function run(args, exec = {}) {
  const name = args && args.name;
  if (!isSkillName(name)) {
    throw new Error(`invalid skill name "${name}"`);
  }
  const lookup = { cwd: exec.cwd, signal: exec.signal };
  const registry = getSkillsRegistry();

  const summary = (await registry.list(lookup)).find((s) => s.name === name);
  if (!summary) throw new Error(`skill "${name}" is unknown or no longer available`);
  if (!isModelInvocable(summary)) throw new Error(`skill "${name}" is not available for model invocation`);

  const skill = await registry.get(name, lookup);
  if (!skill) throw new Error(`skill "${name}" is unknown or no longer available`);
  if (!isModelInvocable(skill)) throw new Error(`skill "${name}" is not available for model invocation`);

  return renderSkillContent(skill);
}

module.exports = { run };
