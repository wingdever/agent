"use strict";

// Tool service: wraps the directory-registry Map with the deterministic
// selection/definition helpers used by the loop engines and RPC.
class ToolService {
  constructor(tools) {
    this.tools = tools instanceof Map ? tools : new Map();
    // Toolpack index (docs/tools/toolpack.md): the packages are synthesized by
    // the registry and attached to each tool; this is the lookup surface.
    this.packages = new Map();
    for (const tool of this.tools.values()) {
      if (tool.package && !this.packages.has(tool.package.name)) this.packages.set(tool.package.name, tool.package);
    }
  }

  // ---- toolpacks ----

  package(name) {
    return this.packages.get(name) || null;
  }

  // The package a tool belongs to, or null for a tool without one.
  packageOf(toolName) {
    const tool = this.tools.get(toolName);
    return tool && tool.package ? tool.package : null;
  }

  // Values a package declares for its prompt sections, merged with the user's
  // toolpacks.json entry at load time.
  packageVars(name) {
    const pack = this.package(name);
    return pack ? pack.promptVars : {};
  }

  get(name) {
    return this.tools.get(name);
  }

  values() {
    return this.tools.values();
  }

  keys() {
    return this.tools.keys();
  }

  entries() {
    return this.tools.entries();
  }

  get size() {
    return this.tools.size;
  }

  [Symbol.iterator]() {
    return this.tools[Symbol.iterator]();
  }

  list() {
    return [...this.tools.values()];
  }

  // Deterministic schema/guidance order: registration order is a filesystem
  // artifact. Explicit toolNames keep that order; otherwise defaultVisible only.
  select(toolNames) {
    return (toolNames
      ? toolNames.map((n) => this.tools.get(n)).filter(Boolean)
      : [...this.tools.values()].filter((t) => t.defaultVisible !== false))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  defs(tools) {
    return (tools || []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  // UI tool catalog, including type/prompt/defaultVisible in addition to the
  // model-facing fields.
  listFunctions() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      mode: t.mode,
      group: t.group,
      prompt: t.prompt || "",
      defaultVisible: t.defaultVisible,
    }));
  }
}

const __exports = { ToolService };
export { ToolService };
export default __exports;
