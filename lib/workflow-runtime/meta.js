"use strict";

// The workflow identity block travels as JSON data alongside the script body,
// never as evaluated script text. Validation rejects every unrecognized field
// by name and returns a normalized copy, so the engine never aliases the
// caller's object.

const { WorkflowError } = require("./errors");

const META_FIELDS = ["name", "description", "whenToUse", "phases"];
const PHASE_FIELDS = ["title", "detail", "provider", "model"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function checkObject(value, path, known, violations) {
  if (!isRecord(value)) {
    violations.push(`${path} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) violations.push(`${path}.${key} is not a recognized field (${known.join("/")})`);
  }
  return true;
}

function normalizePhases(rawPhases, violations) {
  if (!Array.isArray(rawPhases)) {
    violations.push("meta.phases must be an array");
    return undefined;
  }
  const phases = [];
  rawPhases.forEach((phase, index) => {
    const path = `meta.phases[${index}]`;
    if (!checkObject(phase, path, PHASE_FIELDS, violations)) return;
    if (!nonEmptyString(phase.title)) violations.push(`${path}.title must be a non-empty string`);
    for (const key of ["detail", "provider", "model"]) {
      if (phase[key] !== undefined && typeof phase[key] !== "string") violations.push(`${path}.${key} must be a string`);
    }
    const entry = { title: phase.title };
    for (const key of ["detail", "provider", "model"]) {
      if (phase[key] !== undefined) entry[key] = phase[key];
    }
    phases.push(entry);
  });
  return phases;
}

/**
 * Validate a meta value against the WorkflowMeta contract.
 * @param {unknown} value
 * @returns {{ name: string, description: string, whenToUse?: string, phases?: Array }}
 * @throws {WorkflowError} META_INVALID naming every violation
 */
function validateMeta(value) {
  const violations = [];
  if (!checkObject(value, "meta", META_FIELDS, violations)) {
    throw new WorkflowError(`invalid meta: ${violations.join("; ")}`, "META_INVALID");
  }
  if (!nonEmptyString(value.name)) violations.push("meta.name must be a non-empty string");
  if (!nonEmptyString(value.description)) violations.push("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") violations.push("meta.whenToUse must be a string");
  let phases;
  if (value.phases !== undefined) phases = normalizePhases(value.phases, violations);
  if (violations.length > 0) {
    throw new WorkflowError(`invalid meta: ${violations.join("; ")}`, "META_INVALID");
  }
  const meta = { name: value.name, description: value.description };
  if (value.whenToUse !== undefined) meta.whenToUse = value.whenToUse;
  if (phases !== undefined) meta.phases = phases;
  return meta;
}

module.exports = { validateMeta, META_FIELDS, PHASE_FIELDS };
