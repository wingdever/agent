"use strict";

// Minimal system-prompt assembly (dsh-style): ordered sections contributed by
// the harness and by each tool, plus named variables resolved at render time.
// The assembled prompt is built once per chat() call (one conversation round)
// and reused by every step of that round.

const { isSkillName } = require("./skills");

// Skill catalog message (dsh's session skill-catalog). The block is rendered by
// assembleSystemPrompt as a user-role message appended right after the system
// message, once at session start. The body uses dsh's verbatim catalog template
// (see docs/dev/skill.md 4.1): each entry is `- \`name\`: description`,
// description whitespace collapsed, truncated to catalogDescriptionMaxLength, then
// &/</> escaped; names are validated with isSkillName. The template also carries
// the user-invocation guidance ("A user may also invoke a skill directly; its
// <skill_content> block then appears… do not call the `skill` tool again"), which
// teaches the model to follow an already-injected <skill_content> block instead of
// re-calling the tool. Only model-invocable skills are listed.
function foldWhitespace(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function escapeCatalogText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderSkillCatalog(skills, { catalogDescriptionMaxLength = 500 } = {}) {
  if (!Number.isInteger(catalogDescriptionMaxLength) || catalogDescriptionMaxLength < 3) {
    throw new Error("catalogDescriptionMaxLength must be an integer >= 3");
  }
  if (!Array.isArray(skills) || !skills.length) return null;
  const lines = [];
  for (const skill of skills) {
    if (!skill || typeof skill.name !== "string" || !isSkillName(skill.name)) continue;
    let desc = foldWhitespace(skill.description);
    if (desc.length > catalogDescriptionMaxLength) {
      desc = desc.slice(0, catalogDescriptionMaxLength).trimEnd() + "…";
    }
    lines.push(`- \`${skill.name}\`: ${escapeCatalogText(desc)}`);
  }
  if (!lines.length) return null;
  return [
    "<system-reminder>",
    "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "<available_skills>",
    ...lines,
    "</available_skills>",
    "",
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    "A user may also invoke a skill directly; its `<skill_content>` block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
    "</system-reminder>",
  ].join("\n");
}
//
// Section order follows dsh's sparse allocation: identity first, persona next,
// tool guidance in name order, then runtime context at the tail. Registering an
// existing section name replaces it, so a deployment persona can shadow the
// default without duplicating text.

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA: 0,
  LANGUAGE_POLICY: 500,
  TOOL_GUIDANCE: 1000,
  RUNTIME_CONTEXT: 10000,
};

const DEFAULT_IDENTITY = "You are an AI agent.";
const ENGLISH_ONLY_INSTRUCTION = "Always answer in English.";

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
// string contributed by its registry.json. `skills` (optional) is the list of
// skill summaries (from the registry) to render as the session skill-catalog
// user message; `catalogDescriptionMaxLength` bounds each description.
function assembleSystemPrompt({ identity = DEFAULT_IDENTITY, persona = "", tools = [], cwd, model, now = new Date(), skills, catalogDescriptionMaxLength } = {}) {
  const prompt = new SystemPrompt();
  prompt.variable("cwd", cwd || process.cwd());
  prompt.variable("model", model || "unknown");

  prompt.section({ name: "harness:identity", order: prompt.getSectionOrder("HARNESS_IDENTITY"), text: identity });
  prompt.section({ name: "deployment:persona", order: prompt.getSectionOrder("DEPLOYMENT_PERSONA"), text: persona });
  prompt.section({
    name: "harness:language",
    order: prompt.getSectionOrder("LANGUAGE_POLICY"),
    text: ENGLISH_ONLY_INSTRUCTION,
  });

  // DSH allocates a fixed order per tool instead of alphabetical position.
  // Keeping the same order preserves the prompt's reading order for the model.
  const toolOrders = {
    bash: 1000,
    pwsh: 1010,
    read: 1100,
    write: 1200,
    edit: 1300,
    glob: 1400,
    grep: 1500,
    request_user_job: 1600,
    job_output: 1610,
    job_list: 1620,
    job_kill: 1630,
    web_search: 2000,
    web_fetch: 2100,
    goal: 2400,
  };
  const guidance = tools
    .filter((tool) => tool && typeof tool.prompt === "string" && tool.prompt.trim())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // 同一 promptSection 的工具共用一段：{{tools}} 替换成当前可见工具名，
  // 多个用 or 连接（dsh-tool-subagent/lib/index.js:509-518）。
  const guidanceSections = new Map();
  guidance.forEach((tool, index) => {
    const sectionName = tool.promptSection || tool.name;
    if (!guidanceSections.has(sectionName)) guidanceSections.set(sectionName, { tools: [], index });
    guidanceSections.get(sectionName).tools.push(tool);
  });
  for (const [sectionName, group] of guidanceSections) {
    const names = group.tools.map((tool) => "`" + tool.name + "`").join(" or ");
    prompt.section({
      name: "tool:" + sectionName,
      order: toolOrders[sectionName] !== undefined
        ? toolOrders[sectionName]
        : prompt.getSectionOrder("TOOL_GUIDANCE") + 100 + group.index,
      text: group.tools[0].prompt.replace(/\{\{tools\}\}/g, names),
    });
  }

  prompt.section({
    name: "runtime:context",
    order: prompt.getSectionOrder("RUNTIME_CONTEXT"),
    text: buildRuntimeContext({ cwd, model, now }),
  });

  const system = prompt.render();
  const block = [{ role: "system", content: system }];
  if (skills) {
    const catalogText = renderSkillCatalog(skills, { catalogDescriptionMaxLength });
    if (catalogText) block.push({ role: "user", content: catalogText });
  }
  return { prompt, system, sections: prompt.sections(), block };
}

module.exports = {
  DEFAULT_IDENTITY,
  ENGLISH_ONLY_INSTRUCTION,
  SECTION_ORDERS,
  SystemPrompt,
  assembleSystemPrompt,
  renderSkillCatalog,
  buildRuntimeContext,
  localIso,
};
