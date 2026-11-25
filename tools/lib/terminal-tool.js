"use strict";

// Shared helpers for the terminal_* tool family. The terminal service owns
// process lifetime; these helpers only normalize the model-facing arguments and
// keep every tool's error shape identical to the rest of the tool surface.

export function terminalOwner(exec = {}) {
  if (exec.sessionId != null && exec.sessionId !== "") return String(exec.sessionId);
  if (exec.agent && exec.agent.key) return "agent:" + exec.agent.key;
  return "__bare__";
}

export function requireTerminals(exec = {}, methods = []) {
  const terminals = exec.terminals;
  if (!terminals) throw new Error("terminal tools require the terminal service");
  for (const method of methods) {
    if (typeof terminals[method] !== "function") {
      throw new Error("terminal service does not support " + method + "()");
    }
  }
  return terminals;
}

export function requiredString(args, name) {
  if (typeof args[name] !== "string" || args[name].trim() === "") {
    throw new Error(name + " is required");
  }
  return args[name].trim();
}

export function optionalString(args, name) {
  if (args[name] === undefined) return undefined;
  if (typeof args[name] !== "string") throw new Error(name + " must be a string");
  return args[name];
}

export function optionalBoolean(args, name, fallback = false) {
  if (args[name] === undefined) return fallback;
  if (typeof args[name] !== "boolean") throw new Error(name + " must be a boolean");
  return args[name];
}

export function optionalNumber(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  if (typeof args[name] !== "number" || !Number.isFinite(args[name])) {
    throw new Error(name + " must be a number");
  }
  return args[name];
}

export function errorResult(error) {
  return { text: "Error: " + ((error && error.message) || error), isError: true };
}

export default {
  terminalOwner,
  requireTerminals,
  requiredString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  errorResult,
};
