import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, flatCommands, classifyProgram } from "./index.mjs";

// helper: find first simple command by program name across the IR
function firstCommand(ir, program) {
  return flatCommands(ir).find((c) => c.program === program);
}
function programs(ir) {
  return flatCommands(ir).map((c) => c.program);
}

test("parses a simple command with args", () => {
  const ir = parseCommand("ls -la /tmp");
  assert.equal(ir.unreliable, false);
  assert.equal(ir.statements.length, 1);
  const c = ir.statements[0].node;
  assert.equal(c.kind, "command");
  assert.equal(c.program, "ls");
  assert.deepEqual(c.argv, ["-la", "/tmp"]);
});

test("pipeline carries both commands and operators", () => {
  const ir = parseCommand("cat a.txt | grep x > out.txt");
  const node = ir.statements[0].node;
  assert.equal(node.kind, "pipeline");
  assert.deepEqual(node.operators, ["|"]);
  assert.equal(node.commands[0].program, "cat");
  assert.equal(node.commands[1].program, "grep");
  // redirect attached to grep
  const writes = node.commands[1].redirects.filter((r) => r.access === "write");
  assert.equal(writes.length, 1);
});

test("and/or logical edges preserved", () => {
  const ir = parseCommand("sudo rm -rf / && echo done || false");
  const node = ir.statements[0].node;
  assert.equal(node.kind, "andor");
  assert.deepEqual(node.operators, ["&&", "||"]);
  // sudo is the program; rm is its argument (must not be a separate command)
  assert.ok(programs(ir).includes("sudo"));
  assert.ok(programs(ir).includes("echo"));
  assert.ok(!programs(ir).includes("rm"));
});

test("subshell and brace group are distinct node kinds", () => {
  const ir = parseCommand("( cd /tmp; ls )");
  assert.equal(ir.statements[0].node.kind, "subshell");
  const ir2 = parseCommand("{ cd /tmp; ls; }");
  assert.equal(ir2.statements[0].node.kind, "bracegroup");
});

test("redirect access classification (read/write/append/fd-copy)", () => {
  const ir = parseCommand("curl http://x > out.txt 2>&1");
  const c = ir.statements[0].node;
  const ops = c.redirects.map((r) => `${r.operator}:${r.access}`);
  assert.ok(ops.includes(">:write"));
  assert.ok(ops.includes(">&:fd-copy"));
});

test("safe env assignment stripped from raw, dangerous kept", () => {
  const ir = parseCommand("NODE_ENV=prod npm run build");
  const c = ir.statements[0].node;
  assert.equal(c.program, "npm");
  assert.equal(c.raw, "npm run build");
  assert.deepEqual(c.envStripped.map((e) => e.name), ["NODE_ENV"]);

  const ir2 = parseCommand("LD_PRELOAD=evil.so curl http://x");
  const c2 = ir2.statements[0].node;
  assert.ok(c2.raw.startsWith("LD_PRELOAD=evil.so curl"));
  assert.equal(c2.envStripped.length, 0);
});

test("wrapper detection: sudo marks dynamic and transparent", () => {
  const ir = parseCommand("sudo rm -rf /");
  const c = ir.statements[0].node;
  assert.equal(c.wrappers[0].type, "sudo");
  assert.equal(c.dynamic, true);
});

test("interpreter bash -c re-parses code body (transparent)", () => {
  const ir = parseCommand("bash -c 'rm -rf /'");
  const c = ir.statements[0].node;
  assert.equal(c.wrappers[0].type, "bash-c");
  assert.ok(Array.isArray(c.wrappers[0].body));
  assert.equal(c.dynamic, true);
  // the inner rm command is reachable
  assert.ok(flatCommands(ir).some((x) => x.program === "rm"));
});

test("docker run and find -exec flagged as opaque wrappers", () => {
  const ir = parseCommand("docker run --rm alpine echo hi");
  assert.equal(firstCommand(ir, "docker").wrappers[0].type, "docker-run");
  const ir2 = parseCommand("find . -exec rm {} ;");
  assert.equal(firstCommand(ir2, "find").wrappers[0].type, "find-exec");
});

test("dynamic command name ($CMD) flagged dynamic", () => {
  const ir = parseCommand("$CMD arg");
  const c = ir.statements[0].node;
  assert.equal(c.program, null);
  assert.equal(c.dynamic, true);
});

test("eval string arg flagged dynamic with re-parsed body", () => {
  const ir = parseCommand('eval "$USER_INPUT"');
  const c = ir.statements[0].node;
  assert.equal(c.wrappers[0].type, "eval");
  assert.equal(c.dynamic, true);
});

test("command substitution recursed into as real command", () => {
  const ir = parseCommand("echo $(whoami) and `date`");
  const cmds = flatCommands(ir);
  assert.ok(cmds.some((c) => c.program === "whoami"));
  assert.ok(cmds.some((c) => c.program === "date"));
  assert.equal(ir.statements[0].node.dynamic, true);
});

test("process substitution recursed into", () => {
  const ir = parseCommand("echo foo >(bar)");
  assert.ok(flatCommands(ir).some((c) => c.program === "bar"));
});

test("read/write classification by program", () => {
  assert.equal(classifyProgram("cat"), "read");
  assert.equal(classifyProgram("rm"), "write");
  assert.equal(classifyProgram("curl"), "network");
  assert.equal(classifyProgram("git"), "mixed");
  assert.equal(classifyProgram("frobnicate"), "neutral");

  // redirect promotes a read-class command to mixed (reads fn + writes file)
  const ir = parseCommand("echo hi > file.txt");
  assert.equal(ir.statements[0].node.readWrite, "mixed");
  // redirect promotes a neutral command to write
  const ir2 = parseCommand("frobnicate hi > file.txt");
  assert.equal(ir2.statements[0].node.readWrite, "write");
});

test("background flag captured", () => {
  const ir = parseCommand("(: ) &");
  assert.equal(ir.statements[0].background, true);
});

test("unreliable when unbash reports parse errors", () => {
  // A construct that triggers unbash errors (best-effort partial AST).
  const ir = parseCommand("echo $(( 1 + )");
  // Either it errors (unreliable) or it parses best-effort; assert we surface errors.
  if (ir.parseErrors.length > 0) {
    assert.equal(ir.unreliable, true);
  } else {
    // no errors -> still fine, but must not crash
    assert.equal(ir.unreliable, false);
  }
});

test("compound control structures flagged dynamic, not analyzed", () => {
  const ir = parseCommand("if true; then echo a; fi");
  const node = ir.statements[0].node;
  assert.equal(node.kind, "compound");
  assert.equal(node.dynamic, true);
  assert.equal(node.compoundType, "if");
});

test("sequential list yields multiple statements", () => {
  const ir = parseCommand("echo a; echo b\n echo c");
  assert.equal(ir.statements.length, 3);
});
