"use strict";

// Node type registry for flows.
//
// One declaration per node type drives BOTH ends of the feature: the canvas
// reads `inputs`/`outputs` to draw ports and `fields` to build the parameter
// form, and the executor reads the same declaration to validate edges and to
// run the node. Adding a node type is adding one entry here.
//
// A node's `run(input, data, ctx)` returns one of:
//   { port: 'out', output: <value> }  continue along that output port
//   { port: null }                    this branch stops here (no data)
// A thrown error fails the node and therefore the run.

import { render, renderDeep, readPath } from "./templating.js";

const FIELDS = {
  string: (description, extra) => ({ type: "string", description, ...(extra || {}) }),
};

// ---- llm ----

const STRUCTURED_INSTRUCTION = "Answer with a single JSON value that satisfies this JSON Schema, with no prose before or after it:\n";

// Parse and shape-check a structured answer. The same minimal subset as the
// workflow runtime: required fields present and each declared field of the
// right JSON type. A full JSON Schema validator is out of scope here.
function parseStructuredInput(text, schema) {
  let parsed;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(String(text || ""));
  try {
    parsed = JSON.parse((fenced ? fenced[1] : String(text || "")).trim());
  } catch (error) {
    return { error: "the answer is not valid JSON: " + error.message };
  }
  const violations = checkSchemaValue(schema, parsed, "value");
  if (violations.length > 0) return { error: violations.join("; ") };
  return { value: parsed };
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(type, value) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function checkSchemaValue(schema, value, path) {
  if (!schema || typeof schema !== "object") return [];
  const violations = [];
  if (schema.type && !typeMatches(schema.type, value)) {
    violations.push(`${path} must be ${schema.type}`);
    return violations;
  }
  if (schema.type === "object" && typeOf(value) === "object") {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) violations.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        violations.push(...checkSchemaValue(properties[key], child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        violations.push(`${path}.${key} is not allowed`);
      }
    }
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((entry, index) => violations.push(...checkSchemaValue(schema.items, entry, `${path}[${index}]`)));
  }
  return violations;
}

async function runLlm(input, data, ctx) {
  const prompt = render(String(data.prompt == null ? "" : data.prompt), input);
  if (!prompt.trim()) throw new Error("llm node: prompt is empty");
  const messages = [];
  if (typeof data.system === "string" && data.system.trim()) {
    messages.push({ role: "system", content: render(data.system, input) });
  }
  const structured = data.schema && typeof data.schema === "object";
  if (structured) {
    messages.push({ role: "system", content: STRUCTURED_INSTRUCTION + JSON.stringify(data.schema, null, 2) });
  }
  messages.push({ role: "user", content: prompt });

  const target = ctx.resolveTarget(data);
  // A structured answer gets one retry before the node fails: a model that
  // wrapped its JSON in prose once usually gets it right when told why.
  const attempts = structured ? 2 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await ctx.stream({ messages, target, maxTokens: data.maxTokens });
    const text = String(response.content || "");
    if (!structured) return { port: "out", output: { text } };
    const parsed = parseStructuredInput(text, data.schema);
    if (parsed.error === undefined) return { port: "out", output: parsed.value };
    lastError = parsed.error;
    if (attempt + 1 < attempts) {
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: "That answer does not satisfy the schema: " + lastError + ". Answer with the JSON value only." });
    }
  }
  throw new Error("llm node: structured output invalid after retry — " + lastError);
}

// ---- tool ----

async function runToolNode(input, data, ctx) {
  const name = String(data.name || "");
  if (!name) throw new Error("tool node: name is required");
  const allowed = Array.isArray(data.tools) && data.tools.length ? data.tools : null;
  if (allowed && !allowed.includes(name)) {
    throw new Error(`tool node: "${name}" is not in this node's tool list (${allowed.join(", ")})`);
  }
  const tool = ctx.tools.get(name);
  if (!tool) throw new Error(`tool node: unknown tool "${name}"`);
  const args = renderDeep(data.args && typeof data.args === "object" ? data.args : {}, input);
  const result = await ctx.runTool(tool, args);
  return { port: "out", output: { text: result.text, isError: result.isError === true, meta: result.meta } };
}

// ---- condition ----

const OPERATORS = ["eq", "ne", "gt", "lt", "contains", "nonEmpty"];

function compare(op, actual, expected) {
  switch (op) {
    case "eq": return String(actual) === String(expected);
    case "ne": return String(actual) !== String(expected);
    case "gt": return Number(actual) > Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "contains":
      if (Array.isArray(actual)) return actual.some((entry) => String(entry) === String(expected));
      return String(actual == null ? "" : actual).includes(String(expected));
    case "nonEmpty":
      if (actual == null) return false;
      if (Array.isArray(actual)) return actual.length > 0;
      if (typeof actual === "object") return Object.keys(actual).length > 0;
      return String(actual).trim().length > 0;
    default: return false;
  }
}

async function runCondition(input, data, ctx) {
  void ctx;
  const op = String(data.op || "nonEmpty");
  if (!OPERATORS.includes(op)) throw new Error(`condition node: unknown operator "${op}"`);
  let actual;
  try {
    actual = readPath(input, String(data.field || ""));
  } catch (error) {
    // A missing field is a legitimate "false", not a crash: conditions are
    // how a graph asks whether the input carries something.
    if (error && error.name === "TemplateError") actual = undefined;
    else throw error;
  }
  const expected = op === "nonEmpty" ? undefined : render(String(data.value == null ? "" : data.value), input);
  const passed = compare(op, actual, expected);
  return { port: passed ? "true" : "false", output: input };
}

// ---- start / end ----

async function runStart(input) {
  return { port: "out", output: input };
}

async function runEnd(input) {
  return { port: null, output: input };
}

const NODE_TYPES = {
  start: {
    type: "start",
    label: "Start",
    description: "Entry point. Its input is the run input.",
    inputs: [],
    outputs: ["out"],
    fields: {},
    run: runStart,
  },
  llm: {
    type: "llm",
    label: "LLM",
    description: "One stateless model call. Parameters are templates over the input.",
    inputs: ["in"],
    outputs: ["out"],
    fields: {
      system: FIELDS.string("Optional system message, a template over the input."),
      prompt: FIELDS.string("User message, a template over the input.")
        ,
      schema: { type: "object", description: "Optional JSON Schema; the answer is parsed and validated against it." },
      model: FIELDS.string("Optional model override for this node."),
      maxTokens: { type: "number", description: "Optional token ceiling for this node." },
    },
    run: runLlm,
  },
  tool: {
    type: "tool",
    label: "Tool",
    description: "Run one tool with rendered arguments. Falls back to every default-visible tool when the list is empty.",
    inputs: ["in"],
    outputs: ["out"],
    fields: {
      tools: { type: "array", description: "Allowed tool names for this node; empty means all default-visible tools." },
      name: FIELDS.string("The tool to run."),
      args: { type: "object", description: "Argument object; string leaves are templates over the input." },
    },
    run: runToolNode,
  },
  condition: {
    type: "condition",
    label: "Condition",
    description: "Compare a field of the input and continue along the true or false port.",
    inputs: ["in"],
    outputs: ["true", "false"],
    fields: {
      field: FIELDS.string("Dotted path into the input, e.g. text or items.0.name."),
      op: { type: "string", enum: OPERATORS, description: "Comparison operator." },
      value: FIELDS.string("Comparison value (unused by nonEmpty)."),
    },
    run: runCondition,
  },
  end: {
    type: "end",
    label: "End",
    description: "Terminal node. Its input becomes the run output.",
    inputs: ["in"],
    outputs: [],
    fields: {},
    run: runEnd,
  },
};

/** The model-facing projection of every node type (no run functions). */
function describeNodeTypes() {
  const out = {};
  for (const [type, def] of Object.entries(NODE_TYPES)) {
    out[type] = {
      type: def.type,
      label: def.label,
      description: def.description,
      inputs: def.inputs,
      outputs: def.outputs,
      fields: def.fields,
    };
  }
  return out;
}

function getNodeType(type) {
  return Object.prototype.hasOwnProperty.call(NODE_TYPES, type) ? NODE_TYPES[type] : null;
}

const __exports = { NODE_TYPES, describeNodeTypes, getNodeType, OPERATORS, parseStructuredInput, checkSchemaValue };
export { NODE_TYPES, describeNodeTypes, getNodeType, OPERATORS, parseStructuredInput, checkSchemaValue };
export default __exports;
