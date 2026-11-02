"use strict";

// Small JSON Schema validator for tool arguments. It covers the constructs the
// tool registries actually use (object/properties/required/items/enum/oneOf/
// additionalProperties) and mirrors DSH's violation wording, so argument errors
// read the same to the model:
//   invalid arguments: missing required property "file_path"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(type, value) {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function childPath(path, key) {
  return path ? path + "." + key : key;
}

function label(path) {
  return path || "arguments";
}

function validateNode(schema, value, path, violations) {
  if (!schema || typeof schema !== "object") return;

  if (Array.isArray(schema.oneOf)) {
    let matched = 0;
    for (const branch of schema.oneOf) {
      const branchViolations = [];
      validateNode(branch, value, path, branchViolations);
      if (branchViolations.length === 0) matched += 1;
    }
    if (matched !== 1) {
      violations.push(`"${label(path)}" must match exactly one oneOf branch (matched ${matched})`);
      return;
    }
  }

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    violations.push(`"${label(path)}" must be a ${schema.type}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`"${label(path)}" must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (schema.type === "object") {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        violations.push(`missing required property "${childPath(path, key)}"`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue;
      validateNode(childSchema, value[key], childPath(path, key), violations);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          violations.push(`"${childPath(path, key)}" is not a declared property (additionalProperties: false)`);
        }
      }
    }
    return;
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      validateNode(schema.items, value[i], path + "[" + i + "]", violations);
    }
  }
}

function validateSchema(schema, value) {
  const violations = [];
  validateNode(schema, value, "", violations);
  return violations;
}

module.exports = { validateSchema };
