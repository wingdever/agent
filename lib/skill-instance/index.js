"use strict";

// Holds the active skills registry created at core startup. The `skill` tool and
// the `/name` gesture reach the registry through this accessor instead of via the
// tool `exec` object, keeping the provider wiring in one place (createCore).

let active = null;

function setSkillsRegistry(reg) {
  active = reg;
}

function getSkillsRegistry() {
  if (!active) {
    throw new Error("skills registry not initialized; call setSkillsRegistry() during startup");
  }
  return active;
}

const __exports = { setSkillsRegistry, getSkillsRegistry };
export { setSkillsRegistry, getSkillsRegistry };
export default __exports;
