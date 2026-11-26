"use strict";

// The prompt side of MCP resources: server names and instructions are external
// content, so they appear only while a live server provides them, they are
// ordered deterministically, and they never trigger variable interpolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSystemPrompt } from "../../../core/system-prompt.js";

function assemble(extra = {}) {
  return assembleSystemPrompt({ identity: "test identity", tools: [], cwd: "/tmp", model: "test-model", ...extra }).system;
}

test("no resource server means no MCP section at all", () => {
  const system = assemble();
  assert.doesNotMatch(system, /MCP resource servers/);
  assert.doesNotMatch(system, /list_mcp_resources/);
});

test("the resource section names servers sorted, as the tool argument", () => {
  const system = assemble({ mcpResourceServers: ["zeta", "alpha"] });
  assert.match(system, /## MCP resource servers/);
  assert.match(system, /as the server argument: \["alpha","zeta"\]\./);
  assert.doesNotMatch(system, /list_mcp_resources.*`list_mcp_resources`/);
});

test("the resource section sits after tool guidance and before runtime context", () => {
  const system = assemble({ mcpResourceServers: ["memory"] });
  const section = system.indexOf("MCP resource servers");
  const runtime = system.indexOf("Current working directory");
  assert.ok(section >= 0 && runtime > section);
});

test("each server instruction becomes its own section, sorted by server name", () => {
  const system = assemble({
    mcpInstructions: [
      { server: "beta", text: "Beta guidance." },
      { server: "alpha", text: "Alpha guidance." },
    ],
  });
  const alpha = system.indexOf("Alpha guidance.");
  const beta = system.indexOf("Beta guidance.");
  assert.ok(alpha >= 0 && beta > alpha, "instructions are ordered by server name");
});

test("empty or whitespace instructions contribute no section", () => {
  const system = assemble({
    mcpInstructions: [
      { server: "empty", text: "   " },
      { server: "missing", text: undefined },
    ],
  });
  assert.doesNotMatch(system, /empty|missing/);
});

test("server text containing braces is not treated as a prompt variable", () => {
  // Instructions are server-owned content; a literal {{cwd}} must survive as is
  // rather than being substituted or throwing.
  const text = "Use {{cwd}} literally and {{unsupported_var}} too.";
  const system = assemble({ mcpInstructions: [{ server: "braces", text }] });
  assert.match(system, /\{\{cwd\}\}/);
  assert.match(system, /\{\{unsupported_var\}\}/);
});

test("instructions appear even without resource capability", () => {
  // Instructions and resources are independent: a tool-only server can still
  // contribute guidance.
  const system = assemble({ mcpInstructions: [{ server: "toolsonly", text: "Prefer the ping tool." }] });
  assert.match(system, /Prefer the ping tool\./);
  assert.doesNotMatch(system, /MCP resource servers/);
});

test("identity must come from configuration, not a code constant", () => {
  assert.throws(
    () => assembleSystemPrompt({ tools: [], cwd: "/tmp", model: "test-model" }),
    /requires a non-empty identity from agent\/config\.json/
  );
});

test("language policy is contributed only when translation supplies one", () => {
  assert.doesNotMatch(assemble(), /Always answer in English/);
  const withPolicy = assemble({ languagePolicy: "Always answer in English." });
  assert.match(withPolicy, /Always answer in English\./);
  const sections = assembleSystemPrompt({
    identity: "test identity",
    languagePolicy: "Always answer in English.",
    tools: [],
    cwd: "/tmp",
    model: "test-model",
  }).sections;
  assert.ok(sections.some((section) => section.name === "translation:language"));
});
