"use strict";

// Toolpacks (docs/tools/toolpack.md): a package is the capability unit that
// groups several tools, owns the shared prompt section and carries the prompt
// variables that section interpolates.
//
// These tests exercise the synthesis rules directly, without touching the real
// tools directory: `buildToolpacks` is the pure part of the loader.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolpacks } from "../../../core/tools/registry.js";
import { ToolService } from "../../../core/tools/index.js";
import { assembleSystemPrompt } from "../../../core/system-prompt.js";
import { blockedAfter } from "../../../tools/goal/shared.js";

function tool(name, { packageName, group = "utility", section = "", defaults, prompt = "", visible = true } = {}) {
  return {
    name,
    group,
    packageName: packageName || group,
    prompt: prompt,
    promptSection: section,
    promptVarDefaults: defaults,
    defaultVisible: visible,
    description: "",
    parameters: { type: "object", properties: {}, required: [] },
    mode: "write",
  };
}

function quiet(fn) {
  const warn = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    const value = fn();
    return { value, lines };
  } finally {
    console.warn = warn;
  }
}

test("a tool without an explicit package belongs to its group", () => {
  const tools = [tool("a_read", { group: "fs" }), tool("a_write", { group: "fs" })];
  const packs = buildToolpacks(tools, {});
  assert.deepEqual([...packs.keys()], ["fs"]);
  assert.deepEqual(packs.get("fs").members, ["a_read", "a_write"]);
  assert.equal(packs.get("fs").leader, "a_read");
  assert.equal(packs.get("fs").promptSection, "fs", "the section defaults to the package name");
});

test("an explicit package overrides the group and splits it", () => {
  const tools = [
    tool("create_goal", { group: "goal", defaults: { blockedAfterConsecutiveRounds: 3 }, section: "goal" }),
    tool("get_goal", { group: "goal", section: "goal" }),
    tool("todo_write", { group: "goal", packageName: "todo" }),
  ];
  const packs = buildToolpacks(tools, {});
  assert.deepEqual(packs.get("goal").members, ["create_goal", "get_goal"]);
  assert.deepEqual(packs.get("todo").members, ["todo_write"]);
  assert.deepEqual(packs.get("goal").promptVars, { blockedAfterConsecutiveRounds: 3 });
  assert.deepEqual(packs.get("todo").promptVars, {});
});

test("the user's toolpacks.json overrides the leader's defaults", () => {
  const tools = [tool("create_goal", { group: "goal", defaults: { blockedAfterConsecutiveRounds: 3 } })];
  const packs = buildToolpacks(tools, { goal: { promptVars: { blockedAfterConsecutiveRounds: 9 } } });
  assert.deepEqual(packs.get("goal").promptVars, { blockedAfterConsecutiveRounds: 9 });
});

test("defaults on a non-leader member are ignored with a warning", () => {
  const tools = [
    tool("create_goal", { group: "goal", defaults: { blockedAfterConsecutiveRounds: 3 } }),
    tool("update_goal", { group: "goal", defaults: { blockedAfterConsecutiveRounds: 99 } }),
  ];
  const { value, lines } = quiet(() => buildToolpacks(tools, {}));
  assert.deepEqual(value.get("goal").promptVars, { blockedAfterConsecutiveRounds: 3 });
  assert.ok(lines.some((line) => line.includes("update_goal") && line.includes("leader")), "the ignored declaration is reported");
});

test("an unknown package name in the user file is reported and ignored", () => {
  const tools = [tool("create_goal", { group: "goal" })];
  const { value, lines } = quiet(() => buildToolpacks(tools, { nope: { promptVars: { x: 1 } } }));
  assert.equal(value.has("nope"), false);
  assert.ok(lines.some((line) => line.includes("nope")));
});

test("each tool gets a reference to its package", () => {
  const tools = [tool("create_goal", { group: "goal" })];
  const packs = buildToolpacks(tools, {});
  assert.equal(tools[0].package, packs.get("goal"));
});

test("ToolService exposes packages, packageOf and packageVars", () => {
  const tools = new Map();
  for (const item of [tool("create_goal", { group: "goal", defaults: { blockedAfterConsecutiveRounds: 4 } })]) tools.set(item.name, item);
  buildToolpacks([...tools.values()], {});
  const service = new ToolService(tools);
  assert.equal(service.packageOf("create_goal").name, "goal");
  assert.equal(service.package("goal").leader, "create_goal");
  assert.deepEqual(service.packageVars("goal"), { blockedAfterConsecutiveRounds: 4 });
  assert.equal(service.packageOf("missing"), null);
});

test("a prompt section interpolates the variables of its own package", () => {
  const tools = [
    tool("create_goal", { group: "goal", section: "goal", prompt: "at least {{blockedAfterConsecutiveRounds}} rounds", defaults: { blockedAfterConsecutiveRounds: 5 } }),
    tool("get_goal", { group: "goal", section: "goal" }),
  ];
  buildToolpacks(tools, {});
  const out = assembleSystemPrompt({ tools, cwd: process.cwd(), model: "stub" });
  assert.ok(out.system.includes("at least 5 rounds"), out.system);
  assert.ok(!out.system.includes("{{blockedAfterConsecutiveRounds}}"));
});

test("a placeholder without a value keeps its braces", () => {
  const tools = [tool("solo", { group: "utility", prompt: "value {{missingVar}} stays" })];
  buildToolpacks(tools, {});
  const out = assembleSystemPrompt({ tools, cwd: process.cwd(), model: "stub" });
  assert.ok(out.system.includes("value {{missingVar}} stays"));
});

test("the goal tools read the threshold from their package", () => {
  const tools = [tool("create_goal", { group: "goal", defaults: { blockedAfterConsecutiveRounds: 6 } })];
  buildToolpacks(tools, {});
  assert.equal(blockedAfter({ tool: tools[0] }), 6, "the packaged value wins");
  assert.equal(blockedAfter({ tool: tool("create_goal", { group: "goal" }) }), 3, "an unconfigured package falls back to 3");
});
