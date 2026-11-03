// Phase 1 parse layer for the bash permission-control feature.
//
// Turns a command-line string into a parser-agnostic intermediate representation
// (IR) using `unbash`. The IR carries structural facts only (no allow/ask/deny
// decisions); the policy engine (Phase 2) consumes it.
//
// Safety posture (fail-closed):
//  - unbash returns best-effort partial AST with `errors` on malformed input;
//    we surface `unreliable=true` and the policy layer must treat that as ask/deny.
//  - Dynamic constructs (command/process substitution, variable command names,
//    eval) cannot be statically resolved -> marked `dynamic`.
//  - Compound control structures (if/for/while/case/function) are not deeply
//    analyzed -> marked `dynamic` (rejected-or-ask, not guessed).

import { parse as unbashParse } from "unbash";
import {
  makeIR,
  makeStatement,
  makePipeline,
  makeAndOr,
  makeSubshell,
  makeBraceGroup,
  makeRedirectNode,
  makeCompound,
  makeSimpleCommand,
  makeRedirect,
  makeWrapper,
  isEnvStrippable,
  classifyProgram,
} from "./ir.mjs";

// --- dynamic detection -------------------------------------------------------
// A Word is "literal" (safe to match) only when it has no expansion/subsitution
// parts. Anything else is a dynamic value we cannot statically resolve.
const DYNAMIC_PARTS = new Set([
  "SimpleExpansion",
  "ParameterExpansion",
  "CommandExpansion",
  "ProcessSubstitution",
  "Glob",
  "ExtendedGlob",
  "BraceExpansion",
  "ArithmeticExpansion",
  "AnsiCQuoted",
  "LocaleString",
]);

function isLiteralWord(word) {
  if (!word || word.type !== "Word") return false;
  const parts = word.parts;
  if (!parts) return true; // plain literal word
  return parts.every((p) => p.type === "Literal" || p.type === "SingleQuoted");
}

function wordValue(word) {
  return word && word.value !== undefined ? word.value : "";
}

// Extract nested command/process substitutions inside a Word and parse them into
// SimpleCommand IR nodes (so they are not treated as plain arguments).
function extractDynamicSubcommands(word) {
  const found = [];
  if (!word || !word.parts) return found;
  for (const part of word.parts) {
    if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
      for (const stmt of part.script.commands) {
        const node = convertStatement(stmt);
        if (node) found.push(node);
      }
    }
  }
  return found;
}

// --- redirect access classification -----------------------------------------
function redirectAccess(operator) {
  switch (operator) {
    case "<":
    case "<<<":
      return "read";
    case ">":
    case ">>":
    case ">|":
    case "&>":
    case "&>>":
      return operator === ">>" || operator === "&>>" ? "append" : "write";
    case "<&":
    case ">&":
      return "fd-copy";
    case "<<":
    case "<<-":
      return "heredoc";
    case "<>":
      return "read"; // open for read+write, treat as read-leaning
    default:
      return "write";
  }
}

function convertRedirect(r) {
  let access;
  if (r.type === "HereString") access = "herestring";
  else if (r.type === "HereDoc") access = "heredoc";
  else access = redirectAccess(r.operator);

  let target = null;
  if (r.target) {
    target = { path: wordValue(r.target), dynamic: !isLiteralWord(r.target) };
  }
  let descriptor = null;
  if (r.descriptor) {
    descriptor = r.descriptor.type === "FileDescriptor" ? r.descriptor.value : r.descriptor.name;
  }
  return makeRedirect({
    operator: r.operator || r.type,
    descriptor,
    target,
    access,
    range: { start: r.pos, end: r.end },
  });
}

// --- wrapper detection -------------------------------------------------------
// Returns { wrapperType, body } where body is a nested IR list for transparent
// launchers (bash -c, sh -c, eval, ...). docker run / find -exec are kept opaque.
const PRIVILEGE_WRAPPERS = new Set(["sudo", "su", "doas", "setpriv"]);
const SIMPLE_WRAPPERS = {
  env: "env",
  xargs: "xargs",
  nohup: "nohup",
  timeout: "timeout",
  nice: "nice",
  time: "time",
  stdbuf: "stdbuf",
  ionice: "ionice",
  chrt: "chrt",
};
// interpreter: program -> flag that introduces a code string argument
const INTERPRETER_FLAGS = {
  bash: ["-c"],
  sh: ["-c"],
  zsh: ["-c"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-c"],
  ruby: ["-e"],
  node: ["-e"],
  awk: false,
};

function detectWrapper(program, argv) {
  if (PRIVILEGE_WRAPPERS.has(program)) return { type: program, body: null };
  if (SIMPLE_WRAPPERS[program]) return { type: SIMPLE_WRAPPERS[program], body: null };

  if (program === "eval") {
    // eval "$X" / eval 'code' — the argument is code; re-parse it.
    const code = argv.join(" ");
    return { type: "eval", body: code ? parseCommand(code).statements : [] };
  }
  if ((program === "bash" || program === "sh" || program === "zsh") && argv[0] === "-c") {
    const code = argv.slice(1).join(" ");
    return { type: "bash-c", body: code ? parseCommand(code).statements : [] };
  }
  const interp = INTERPRETER_FLAGS[program];
  if (interp) {
    const idx = argv.findIndex((a) => interp.includes(a));
    if (idx >= 0) {
      const code = argv.slice(idx + 1).join(" ");
      return { type: program + "-c", body: code ? parseCommand(code).statements : [] };
    }
  }
  if (program === "docker" && argv[0] === "run") return { type: "docker-run", body: null };
  if (program === "find") {
    const i = argv.indexOf("-exec");
    if (i >= 0) return { type: "find-exec", body: null };
  }
  return null;
}

// --- SimpleCommand extraction ------------------------------------------------
function convertCommand(cmd) {
  const range = { start: cmd.pos, end: cmd.end };

  // Command name: literal vs dynamic.
  let program = null;
  let dynamic = false;
  if (cmd.name) {
    if (isLiteralWord(cmd.name)) program = wordValue(cmd.name);
    else dynamic = true;
  }

  const assignmentPrefix = [];
  const envStripped = [];
  const redirects = [];
  const argv = [];
  let dynamicSubcommands = [];

  // prefix: assignments + redirects
  for (const item of cmd.prefix || []) {
    if (item.type === "Assignment") {
      const rec = { name: item.name, value: wordValue(item.value), range: { start: item.pos, end: item.end } };
      if (isEnvStrippable(item.name)) envStripped.push(rec);
      else assignmentPrefix.push(rec);
    } else if (item.type === "Redirect" || item.type === "HereString" || item.type === "HereDoc") {
      redirects.push(convertRedirect(item));
    }
  }
  // suffix: words / assignments / redirects
  for (const item of cmd.suffix || []) {
    if (item.type === "Redirect" || item.type === "HereString" || item.type === "HereDoc") {
      redirects.push(convertRedirect(item));
    } else if (item.type === "Assignment") {
      const rec = { name: item.name, value: wordValue(item.value), range: { start: item.pos, end: item.end } };
      if (isEnvStrippable(item.name)) envStripped.push(rec);
      else assignmentPrefix.push(rec);
    } else if (item.type === "Word") {
      if (isLiteralWord(item)) argv.push(wordValue(item));
      else {
        dynamic = true;
        argv.push(wordValue(item)); // keep the literal-ish form for display
      }
      dynamicSubcommands = dynamicSubcommands.concat(extractDynamicSubcommands(item));
    }
  }

  if (dynamicSubcommands.length > 0) dynamic = true;

  // Wrapper detection (transparent node).
  const wrappers = [];
  if (program) {
    const w = detectWrapper(program, argv);
    if (w) {
      wrappers.push(makeWrapper(w.type, program, argv, range, w.body ? w.body : undefined));
      dynamic = true; // a launcher/interpreter hides the real command -> ask
    }
  }

  // Effective command after stripping safe env assignments.
  const keepPrefix = assignmentPrefix.map((a) => `${a.name}=${a.value}`).join(" ");
  const rawParts = [];
  if (keepPrefix) rawParts.push(keepPrefix);
  if (program) rawParts.push(program);
  rawParts.push(...argv);
  const raw = rawParts.join(" ");

  const readWrite = mergeReadWrite(classifyProgram(program), redirects);

  return makeSimpleCommand({
    program,
    programRaw: cmd.name ? wordValue(cmd.name) : null,
    raw,
    argv,
    assignmentPrefix,
    envStripped,
    redirects,
    wrappers,
    dynamicSubcommands,
    dynamic,
    readWrite,
    range,
  });
}

function mergeReadWrite(base, redirects) {
  let hasWrite = false;
  let hasRead = false;
  for (const r of redirects || []) {
    if (r.access === "write" || r.access === "append") hasWrite = true;
    else if (r.access === "read") hasRead = true;
  }
  if (hasWrite) {
    // any write/append redirection makes the command a writer
    if (base === "read") return "mixed"; // reads from fs but also writes -> mixed
    return "write";
  }
  if (hasRead) {
    if (base === "network" || base === "mixed") return "mixed";
    return "read";
  }
  return base;
}

// --- recursive conversion ----------------------------------------------------
function convertNode(node) {
  if (!node) return null;
  switch (node.type) {
    case "Command":
      return convertCommand(node);
    case "Pipeline":
      return makePipeline(
        node.commands.map(convertNode).filter(Boolean),
        node.operators,
        node.prefixes
      );
    case "AndOr":
      return makeAndOr(
        node.commands.map(convertNode).filter(Boolean),
        node.operators
      );
    case "Subshell":
      return makeSubshell(convertList(node.body));
    case "BraceGroup":
      return makeBraceGroup(convertList(node.body));
    case "Redirected":
      return makeRedirectNode(convertNode(node.command), (node.redirects || []).map(convertRedirect));
    case "If":
      return makeCompound("if", { start: node.pos, end: node.end }, "if");
    case "For":
      return makeCompound("for", { start: node.pos, end: node.end }, "for");
    case "While":
      return makeCompound(node.kind || "while", { start: node.pos, end: node.end }, node.kind || "while");
    case "Select":
      return makeCompound("select", { start: node.pos, end: node.end }, "select");
    case "Case":
      return makeCompound("case", { start: node.pos, end: node.end }, "case");
    case "Function":
      return makeCompound("function", { start: node.pos, end: node.end }, "function " + wordValue(node.name));
    case "Coproc":
      return makeCompound("coproc", { start: node.pos, end: node.end }, "coproc");
    default:
      return null;
  }
}

function convertStatement(stmt) {
  if (!stmt || !stmt.command) return null;
  const node = convertNode(stmt.command);
  if (!node) return null;
  return makeStatement(Boolean(stmt.background), { start: stmt.pos, end: stmt.end }, node);
}

function convertList(list) {
  if (!list || !list.commands) return [];
  return list.commands.map(convertStatement).filter(Boolean);
}

// --- public API --------------------------------------------------------------
export function parseCommand(source) {
  if (typeof source !== "string") throw new Error("parseCommand expects a string source");
  const parsed = unbashParse(source);
  const statements = convertList(parsed);
  return makeIR(source, parsed.errors || [], statements);
}

// Depth-first flatten of all simple commands, transparently piercing pipelines,
// logical chains, subshells, brace groups, redirect wrappers, dynamic subcommands
// (command/process substitution), and transparent wrapper bodies (bash -c, eval).
// Returns SimpleCommandIR[] for the policy layer to match individually.
export function flatCommands(ir) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    switch (node.kind) {
      case "command":
        out.push(node);
        // dynamic subcommands discovered inside argument words (each is a Statement IR)
        if (node.dynamicSubcommands) {
          for (const s of node.dynamicSubcommands) visit(s.node);
        }
        // transparent wrapper bodies (bash -c, sh -c, eval, python -c, ...)
        if (node.wrappers) {
          for (const w of node.wrappers) {
            if (w.body) for (const s of w.body) visit(s.node);
          }
        }
        break;
      case "pipeline":
      case "andor":
        node.commands.forEach(visit);
        break;
      case "subshell":
      case "bracegroup":
        node.body.forEach((s) => visit(s.node));
        break;
      case "redirect":
        visit(node.command);
        break;
      case "compound":
        // not deeply analyzed; emit nothing (already flagged dynamic at parent)
        break;
    }
  };
  for (const stmt of ir.statements) visit(stmt.node);
  return out;
}

// Re-export classifier for convenience.
export { classifyProgram };
