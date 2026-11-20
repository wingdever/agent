"use strict";

// Minimal object-rooted JSON Schema support for agent({ schema }): structure
// check at script time, strict JSON parse plus field check at child time. The
// full JSON Schema vocabulary is out of scope; a schema outside this subset is
// rejected loudly (UNSUPPORTED_SCHEMA) rather than silently ignored.

const { WorkflowError } = require("./errors");

const KEYWORDS = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "oneOf", "description", "title"];
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const ANNOTATIONS = ["description", "title"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkNode(node, path, violations, depth) {
  if (depth > 32) {
    violations.push(`${path} is nested too deeply`);
    return;
  }
  if (!isRecord(node)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.includes(key)) {
      violations.push(`${path}.${key} is not a supported keyword (subset: ${KEYWORDS.join("/")})`);
    }
  }
  for (const key of ANNOTATIONS) {
    if (node[key] !== undefined && typeof node[key] !== "string") violations.push(`${path}.${key} must be a string`);
  }
  const hasType = Object.prototype.hasOwnProperty.call(node, "type");
  const hasOneOf = Object.prototype.hasOwnProperty.call(node, "oneOf");
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) {
    violations.push(`${path} must declare type or oneOf`);
    return;
  }
  if (hasOneOf) {
    for (const key of ["properties", "required", "additionalProperties", "items", "enum", "const"]) {
      if (node[key] !== undefined) violations.push(`${path}.${key} is not supported beside oneOf`);
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`);
      return;
    }
    node.oneOf.forEach((entry, index) => checkNode(entry, `${path}.oneOf[${index}]`, violations, depth + 1));
    return;
  }
  if (!TYPES.includes(node.type) || typeof node.type !== "string") {
    violations.push(`${path}.type must be one of ${TYPES.join("/")}`);
    return;
  }
  const type = node.type;
  const wrongOwner = {
    properties: "object", required: "object", additionalProperties: "object", items: "array",
    enum: "scalar", const: "scalar",
  };
  for (const [key, owner] of Object.entries(wrongOwner)) {
    if (node[key] === undefined) continue;
    const fits = owner === "scalar" ? ["string", "number", "integer", "boolean", "null"].includes(type) : owner === type;
    if (!fits) violations.push(`${path}.${key} is not supported on type "${type}"`);
  }
  if (type === "object") {
    if (node.properties !== undefined) {
      if (!isRecord(node.properties)) {
        violations.push(`${path}.properties must be an object of schemas`);
      } else {
        for (const [name, schema] of Object.entries(node.properties)) {
          checkNode(schema, `${path}.properties.${name}`, violations, depth + 1);
        }
      }
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== "string")) {
        violations.push(`${path}.required must be an array of strings`);
      } else if (isRecord(node.properties)) {
        for (const name of node.required) {
          if (!Object.prototype.hasOwnProperty.call(node.properties, name)) {
            violations.push(`${path}.required names "${name}" which is not in properties`);
          }
        }
      }
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
      violations.push(`${path}.additionalProperties must be a boolean`);
    }
  }
  if (type === "array" && node.items !== undefined) checkNode(node.items, `${path}.items`, violations, depth + 1);
  if (["string", "number", "integer", "boolean", "null"].includes(type)) {
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
      violations.push(`${path}.enum must be a non-empty array`);
    }
  }
}

/**
 * Assert a schema belongs to the supported subset and is object-rooted.
 * @param {unknown} schema
 * @throws {WorkflowError} UNSUPPORTED_SCHEMA
 */
function assertObjectJsonSchema(schema) {
  const violations = [];
  checkNode(schema, "schema", violations, 0);
  if (violations.length === 0 && (!isRecord(schema) || schema.type !== "object")) {
    violations.push('schema.type must be "object" (structured output is object-rooted)');
  }
  if (violations.length > 0) {
    throw new WorkflowError(`agent() schema is outside the supported subset — ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
  }
}

function matchesType(type, value) {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function checkValue(schema, value, path, violations) {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((entry) => {
      const local = [];
      checkValue(entry, value, path, local);
      return local.length === 0;
    });
    if (matches.length !== 1) violations.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`);
    return;
  }
  if (!matchesType(schema.type, value)) {
    violations.push(`${path} must be ${schema.type}`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) violations.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  if (schema.type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) violations.push(`${path}.${name} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) checkValue(properties[name], child, `${path}.${name}`, violations);
      else if (schema.additionalProperties === false) violations.push(`${path}.${name} is not allowed`);
    }
  }
  if (schema.type === "array" && schema.items) {
    value.forEach((entry, index) => checkValue(schema.items, entry, `${path}[${index}]`, violations));
  }
}

/**
 * Parse a child's final text as JSON and check it against the schema.
 * @param {string} text
 * @param {object} schema
 * @returns {{ value?: unknown, error?: string }}
 */
function parseStructured(text, schema) {
  let parsed;
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(String(text || ""));
  const body = fence ? fence[1] : String(text || "");
  try {
    parsed = JSON.parse(body.trim());
  } catch (error) {
    return { error: `the answer is not valid JSON: ${error.message}` };
  }
  const violations = [];
  checkValue(schema, parsed, "value", violations);
  if (violations.length > 0) return { error: violations.join("; ") };
  return { value: parsed };
}

module.exports = { assertObjectJsonSchema, parseStructured };
