// IR node constructors and policy-relevant tables for the bash permission-control
// parse layer (Phase 1). This module is parser-agnostic: it only builds the
// intermediate representation consumed downstream by the (future) policy engine.
//
// No decision (allow/ask/deny) is made here. We only carry structural facts:
// command tree, logical edges, redirects, wrapper markers, dynamic markers,
// the effective command after stripping safe env assignments, and a read/write hint.

// --- env var stripping ------------------------------------------------------
// Assignments in the command prefix (e.g. `NODE_ENV=prod npm ...`) are stripped
// from the effective command used for policy matching. But security-relevant
// variables must NOT be stripped: they change execution semantics and are a known
// privilege-escalation / sandbox-escape vector. See docs/tool/bash.md §6.
//
// A variable name matches the denylist if it is exactly listed, matches a `PREFIX_*`
// wildcard entry, or equals a `*` suffix pattern. We keep it in `raw` when matched.
export const ENV_DENYLIST = [
  // dynamic loader / preload attacks
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_RUN_PATH",
  "LD_DEBUG",
  "DYLD_*",
  // shell / execution environment tampering
  "IFS",
  "PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "GCONV_PATH",
  "PWD",
  // language runtime path injection
  "PYTHONPATH",
  "PERL5LIB",
  "RUBYLIB",
  "NODE_PATH",
  "TZ",
];

function envDenied(name) {
  if (ENV_DENYLIST.includes(name)) return true;
  for (const entry of ENV_DENYLIST) {
    if (entry.endsWith("*") && name.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

export function isEnvStrippable(name) {
  return !envDenied(name);
}

// --- read/write classification ----------------------------------------------
// A coarse, vendor-neutral hint for the policy layer (cmdpolicy-style):
// read-fs / write-fs / mixed / network / neutral. Combined with redirects
// downstream. IR itself does not decide allow/ask/deny.
export const READ_FS = new Set([
  "cat", "cd", "ls", "echo", "printf", "grep", "egrep", "fgrep", "rg", "ag",
  "head", "tail", "less", "more", "wc", "sort", "uniq", "awk", "sed", "cut",
  "tr", "find", "readlink", "stat", "file", "pwd", "which", "type", "basename",
  "dirname", "realpath", "diff", "comm", "env", "printenv", "id", "whoami",
  "uname", "date", "test", "[", "true", "false", "sleep", "jq", "xxd", "od",
  "hexdump", "ps", "top", "free", "df", "du", "mount", "git", // git is mixed but default read-ish
]);

export const WRITE_FS = new Set([
  "rm", "rmdir", "cp", "mv", "touch", "mkdir", "mkfifo", "ln", "chmod",
  "chown", "chgrp", "truncate", "dd", "tee", "install", "mknod", "shred",
  "kill", "pkill", "killall", "mount", "umount", "modprobe", "insmod",
  "rmmod", "sysctl", "useradd", "userdel", "usermod", "chpasswd", "passwd",
]);

export const MIXED_FS = new Set([
  "git", "iptables", "ip", "tc", "mount", "umount", "git", "npm", "yarn",
  "pnpm", "npx", "make", "cargo", "go", "python", "python3", "node", "perl",
  "bash", "sh", "zsh", "sudo", "su", "doas", "docker", "kubectl", "systemctl",
  "service", "crontab", "sed", "awk", "dd", "chmod", "chown",
]);

export const NETWORK_FS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "telnet", "nc", "ncat",
  "ping", "ftp", "tftp", "npm", "yarn", "pnpm", "npx", "docker",
  "kubectl", "sshfs", "dig", "nslookup", "host", "openssl",
]);

export function classifyProgram(program) {
  if (!program) return "neutral"; // dynamic / unknown command name
  if (NETWORK_FS.has(program)) return "network";
  if (MIXED_FS.has(program)) return "mixed";
  if (WRITE_FS.has(program)) return "write";
  if (READ_FS.has(program)) return "read";
  return "neutral";
}

// --- IR constructors --------------------------------------------------------

export function makeIR(source, parseErrors, statements) {
  return {
    source,
    parseErrors: parseErrors.map((e) => ({ message: e.message, pos: e.pos })),
    unreliable: parseErrors.length > 0,
    statements,
  };
}

export function makeStatement(background, range, node) {
  return { kind: "statement", background: Boolean(background), range, node };
}

export function makePipeline(commands, operators, prefixes) {
  const p = { kind: "pipeline", commands, operators };
  for (const pre of prefixes || []) {
    if (pre.type === "Negation") p.negated = true;
    if (pre.type === "Time") p.timed = true;
  }
  return p;
}

export function makeAndOr(commands, operators) {
  return { kind: "andor", commands, operators };
}

export function makeSubshell(body) {
  return { kind: "subshell", body };
}

export function makeBraceGroup(body) {
  return { kind: "bracegroup", body };
}

export function makeRedirectNode(command, redirects) {
  return { kind: "redirect", command, redirects };
}

export function makeCompound(compoundType, range, summary) {
  // Compound control structures are not deeply analyzed (fail-closed posture,
  // see docs/tool/bash.md structural difficulty #1 and bashcage rationale).
  return { kind: "compound", compoundType, dynamic: true, summary, range };
}

export function makeSimpleCommand(fields) {
  return {
    kind: "command",
    program: fields.program,
    programRaw: fields.programRaw,
    raw: fields.raw,
    argv: fields.argv,
    assignmentPrefix: fields.assignmentPrefix,
    envStripped: fields.envStripped,
    redirects: fields.redirects,
    wrappers: fields.wrappers,
    dynamicSubcommands: fields.dynamicSubcommands,
    dynamic: fields.dynamic,
    readWrite: fields.readWrite,
    range: fields.range,
  };
}

export function makeRedirect({ operator, descriptor, target, access, range }) {
  return { operator, descriptor: descriptor ?? null, target: target ?? null, access, range };
}

export function makeWrapper(type, program, args, range, body) {
  const w = { type, program, args, range };
  if (body) w.body = body;
  return w;
}
