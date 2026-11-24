"use strict";

// Template substitution for flow node parameters.
//
// The first version deliberately has no expression language: a template is
// text with `{{path}}` placeholders, and a path reads a field of the input
// value. That keeps evaluation total (no eval, no timeout, no injection) at
// the cost of expressiveness, which the `condition` node covers for decisions.
//
//   {{text}}           -> input.text
//   {{items.0.name}}   -> input.items[0].name
//   {{}}               -> the whole input value
//
// A missing path is an error, not an empty string: a typo in a node parameter
// must surface at run time instead of silently feeding the model nothing.

class TemplateError extends Error {
  constructor(message, path) {
    super(message);
    this.name = "TemplateError";
    this.path = path;
  }
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Read a dotted path from a value. An empty path returns the value itself.
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 * @throws {TemplateError} when any segment is missing
 */
function readPath(value, path) {
  if (path === "") return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) {
      throw new TemplateError(`"${path}" is not available in the input value`, path);
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) throw new TemplateError(`"${path}" indexes an array with "${segment}"`, path);
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object") {
      throw new TemplateError(`"${path}" reads "${segment}" from a ${typeof current}`, path);
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new TemplateError(`"${path}" is not available in the input value`, path);
    }
    current = current[segment];
  }
  return current;
}

function renderValue(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Render a template string against an input value.
 * @param {string} template
 * @param {unknown} input
 * @returns {string}
 * @throws {TemplateError}
 */
function render(template, input) {
  if (typeof template !== "string") return "";
  return template.replace(PLACEHOLDER, (_match, path) => renderValue(readPath(input, String(path).trim())));
}

/**
 * Walk a node parameter value and render every string leaf as a template.
 * Objects and arrays are rebuilt; other scalars pass through unchanged, so a
 * number stays a number.
 * @param {unknown} value
 * @param {unknown} input
 * @returns {unknown}
 */
function renderDeep(value, input) {
  if (typeof value === "string") return render(value, input);
  if (Array.isArray(value)) return value.map((entry) => renderDeep(entry, input));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = renderDeep(entry, input);
    return out;
  }
  return value;
}

/** Whether a string contains at least one placeholder. */
function hasPlaceholder(template) {
  if (typeof template !== "string") return false;
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(template);
}

const __exports = { TemplateError, readPath, render, renderDeep, hasPlaceholder };
export { TemplateError, readPath, render, renderDeep, hasPlaceholder };
export default __exports;
