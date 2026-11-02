"use strict";

// Minimal system-prompt assembly (dsh-style): ordered sections contributed by
// the harness and by each tool, plus named variables resolved at render time.
// The assembled prompt is built once per chat() call (one conversation round)
// and reused by every step of that round.
//
// Section order follows dsh's sparse allocation: identity first, persona next,
// tool guidance in name order, then runtime context at the tail. Registering an
// existing section name replaces it, so a deployment persona can shadow the
// default without duplicating text.

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA: 0,
  TOOL_GUIDANCE: 1000,
  RUNTIME_CONTEXT: 10000,
};

const DEFAULT_IDENTITY = "You are an AI agent.";

// Variables are referenced from section text as {{name}}. Unknown references
// throw: a malformed prompt is worse than a loud failure.
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const VARIABLE_REFERENCE = /\{\{([a-z][a-z0-9_]*)\}\}/g;

class SystemPrompt {
  constructor() {
    this._sections = new Map();
    this._variables = new Map();
  }

  getSectionOrder(name) {
    const order = SECTION_ORDERS[name];
    if (order === undefined) throw new Error("unknown prompt section order: " + name);
    return order;
  }

  section({ name, order, text }) {
    if (typeof name !== "string" || !name.trim()) throw new Error("prompt section name must be a non-empty string");
    if (!Number.isFinite(order)) throw new Error('prompt section "' + name + '" order must be a finite number');
    if (typeof text !== "string") throw new Error('prompt section "' + name + '" text must be a string');
    this._sections.set(name, { name, order, text });
    return this;
  }

  variable(name, value) {
    if (!VARIABLE_NAME.test(name)) throw new Error("prompt variable name must match " + VARIABLE_NAME);
    this._variables.set(name, value);
    return this;
  }

  // Sections in render order with variables interpolated and empty text dropped.
  sections() {
    const names = [...this._sections.keys()].sort((a, b) => {
      const sa = this._sections.get(a);
      const sb = this._sections.get(b);
      if (sa.order !== sb.order) return sa.order - sb.order;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const out = [];
    for (const name of names) {
      const section = this._sections.get(name);
      if (!section.text.trim()) continue;
      out.push({ name: section.name, order: section.order, text: this._interpolate(section.name, section.text) });
    }
    return out;
  }

  render() {
    return this.sections().map((section) => section.text).join("\n\n");
  }

  _interpolate(sectionName, text) {
    return text.replace(VARIABLE_REFERENCE, (match, name) => {
      if (!this._variables.has(name)) {
        throw new Error('unknown prompt variable "' + name + '" in section "' + sectionName + '"');
      }
      return String(this._variables.get(name));
    });
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// ISO 8601 timestamp with the host's UTC offset, e.g. 2026-11-02T19:05:00+08:00.
function localIso(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    date.getFullYear() +
    "-" + pad2(date.getMonth() + 1) +
    "-" + pad2(date.getDate()) +
    "T" + pad2(date.getHours()) +
    ":" + pad2(date.getMinutes()) +
    ":" + pad2(date.getSeconds()) +
    sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60)
  );
}

// Runtime context is appended at the tail of the system prompt and frozen for
// one chat() round: a new round re-evaluates cwd/time/model/platform.
function buildRuntimeContext({ cwd, model, now = new Date() } = {}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return [
    "Current working directory: " + JSON.stringify(cwd || process.cwd()) + ".",
    "Current time: " + localIso(now) + " (" + timeZone + ").",
    "Current model: " + (model || "unknown") + ".",
    "Platform: " + process.platform + " (" + process.arch + ").",
  ].join("\n");
}

// Assemble the model-facing system prompt for one chat round.
// `tools` are the tools visible to this round; each may carry a `prompt`
// string contributed by its registry.json.
function assembleSystemPrompt({ identity = DEFAULT_IDENTITY, persona = "", tools = [], cwd, model, now = new Date() } = {}) {
  const prompt = new SystemPrompt();
  prompt.variable("cwd", cwd || process.cwd());
  prompt.variable("model", model || "unknown");

  prompt.section({ name: "harness:identity", order: prompt.getSectionOrder("HARNESS_IDENTITY"), text: identity });
  prompt.section({ name: "deployment:persona", order: prompt.getSectionOrder("DEPLOYMENT_PERSONA"), text: persona });

  const guidance = tools
    .filter((tool) => tool && typeof tool.prompt === "string" && tool.prompt.trim())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  guidance.forEach((tool, index) => {
    prompt.section({
      name: "tool:" + tool.name,
      order: prompt.getSectionOrder("TOOL_GUIDANCE") + index,
      text: tool.prompt,
    });
  });

  prompt.section({
    name: "runtime:context",
    order: prompt.getSectionOrder("RUNTIME_CONTEXT"),
    text: buildRuntimeContext({ cwd, model, now }),
  });

  return { prompt, system: prompt.render(), sections: prompt.sections() };
}

module.exports = {
  DEFAULT_IDENTITY,
  SECTION_ORDERS,
  SystemPrompt,
  assembleSystemPrompt,
  buildRuntimeContext,
  localIso,
};
