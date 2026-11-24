"use strict";

// Values that cross the script boundary are lossless JSON data. Scripts run in
// their own vm context, so an object from there is not `instanceof` anything
// the host knows; the walk only looks at the observable structure. Anything
// JSON cannot represent losslessly fails with the offending path so the model
// can correct the script.

class MaterializeError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = "MaterializeError";
    this.path = path;
    this.reason = reason;
  }
}

/** Render any thrown value to text without ever throwing. */
function renderThrown(error) {
  try {
    const stack = error && error.stack;
    if (typeof stack === "string" && stack.length > 0) return stack;
    const message = error && error.message;
    if (typeof message === "string" && message.length > 0) return message;
    return String(error);
  } catch (_) {
    return "[unrenderable thrown value]";
  }
}

// A plain data object is `null`-prototype or a prototype whose own prototype is
// null (the realm's Object.prototype, which cannot be compared by identity
// across contexts). Date / Map / class instances have a longer chain.
function hasPlainPrototype(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  return Object.getPrototypeOf(proto) === null;
}

function scalarCopy(value, path) {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new MaterializeError(path, "non-finite numbers are not JSON data");
      return value;
    case "bigint":
      throw new MaterializeError(path, "bigints are not JSON data");
    case "function":
      throw new MaterializeError(path, "functions are not plain JSON data");
    case "symbol":
      throw new MaterializeError(path, "symbols are not plain JSON data");
    case "undefined":
      throw new MaterializeError(path, "undefined is not JSON data");
    default:
      return undefined;
  }
}

function copyArray(value, path, seen) {
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) throw new MaterializeError(`${path}[${index}]`, "sparse arrays are not JSON data");
    out.push(materialize(value[index], `${path}[${index}]`, seen));
  }
  for (const key of Object.keys(value)) {
    const numeric = Number(key);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric >= value.length) {
      throw new MaterializeError(`${path}.${key}`, "arrays with non-index properties are not JSON data");
    }
  }
  return out;
}

function copyObject(value, path, seen) {
  if (!hasPlainPrototype(value)) {
    throw new MaterializeError(path, "only plain objects and arrays are JSON data (exotic prototype)");
  }
  const out = {};
  for (const key of Object.keys(value)) {
    // defineProperty, never assignment: a "__proto__" key must become an own
    // data property of the copy, not a prototype mutation.
    Object.defineProperty(out, key, {
      value: materialize(value[key], `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function materialize(value, path, seen) {
  const scalar = scalarCopy(value, path);
  if (scalar !== undefined) return scalar;
  if (value === null) return null;
  if (seen.has(value)) throw new MaterializeError(path, "circular references are not JSON data");
  seen.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, path, seen) : copyObject(value, path, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * Copy a value into plain JSON data. A root `undefined` is returned unchanged
 * (callers map it to null); nested `undefined`, unsupported values, cycles,
 * sparse arrays and exotic prototypes fail.
 * @param {unknown} value
 * @param {string} [root] path label for error messages
 * @throws {MaterializeError}
 */
function materializeJson(value, root = "value") {
  if (value === undefined) return undefined;
  try {
    return materialize(value, root, new Set());
  } catch (error) {
    if (error instanceof MaterializeError) throw error;
    // A property read ran script code that threw; keep the narrow contract.
    throw new MaterializeError(root, `reading the value threw: ${renderThrown(error)}`);
  }
}

const __exports = { MaterializeError, materializeJson, renderThrown, hasPlainPrototype };
export { MaterializeError, materializeJson, renderThrown, hasPlainPrototype };
export default __exports;
