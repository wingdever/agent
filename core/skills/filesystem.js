"use strict";

// Local filesystem skill provider. Discovers directory-bundle (<name>/SKILL.md)
// and flat (<name>.md) skills from project, custom, user and bundled roots,
// parses YAML frontmatter, and loads bodies on demand.
//
// Adapted from @deepseek-ai/dsh@0.2.1-rc.2 / @deepseek-ai/dsh-skill-filesystem.
//
// NOTE: dsh parses frontmatter with the `yaml` package. This project does not
// yet depend on it, so we use a focused subset parser (see parseYaml) that
// supports scalar fields (string/boolean/number, quoted or unquoted) and a
// single-level nested `metadata:` mapping. For full YAML fidelity (multi-line
// scalars, lists, deep nesting) add the `yaml` package and replace parseYaml
// with `parse`.

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { isSkillName } = require("../../lib/skill-policy");

const PROJECT_DSH_RANK = 100;
const PROJECT_AGENTS_RANK = 200;
const CUSTOM_RANK = 300;
const USER_DSH_RANK = 400;
const USER_AGENTS_RANK = 500;
const BUNDLED_SKILL_RANK = 600;

// ---------------------------------------------------------------------------
// Focused YAML frontmatter parser (subset)
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const value = m[2];
    if (value === "") {
      // block mapping; only a single-level `metadata:` block is supported here
      const child = {};
      i++;
      while (i < lines.length) {
        const cl = lines[i];
        if (cl.trim() === "") { i++; continue; }
        const cm = cl.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!cm) break;
        child[cm[1]] = parseScalar(cm[2]);
        i++;
      }
      root[key] = child;
      continue;
    }
    root[key] = parseScalar(value);
    i++;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (mirror of dsh-skill-filesystem/lib/index.js:667-889)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return void 0;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === void 0) return void 0;
  const parsed = parseYaml(raw.slice(start, closing.start));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  return { data: parsed, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
    }
    if (nextNewline < 0) return void 0;
    lineStart = nextNewline + 1;
  }
  return void 0;
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

function parseInvocationPolicy(data) {
  rejectLegacyInvocationKey(data, "disableModelInvocation", "disable-model-invocation");
  rejectLegacyInvocationKey(data, "modelInvocable", "disable-model-invocation");
  rejectLegacyInvocationKey(data, "userInvocable", "user-invocable");
  const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
  const userInvocable = frontmatterBoolean(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false
  };
}

function rejectLegacyInvocationKey(data, legacy, canonical) {
  if (Object.prototype.hasOwnProperty.call(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
  }
}

function frontmatterBoolean(data, key) {
  if (!Object.prototype.hasOwnProperty.call(data, key)) return void 0;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true": case "yes": case "on": return true;
      case "false": case "no": case "off": return false;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

function optionalMetadata(data) {
  const value = data.metadata;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  return void 0;
}

async function parseSkillFile(skPath, warn) {
  let raw;
  try {
    raw = await fsp.readFile(skPath, "utf8");
  } catch {
    return void 0;
  }
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (e) {
    warn?.(`skill file ${skPath} ignored: invalid YAML frontmatter: ${e && e.message}`);
    return void 0;
  }
  if (!parsed) {
    warn?.(`skill file ${skPath} ignored: missing YAML frontmatter`);
    return void 0;
  }
  const name = stringField(parsed.data, "name");
  const description = stringField(parsed.data, "description");
  if (name === void 0 || description === void 0) {
    warn?.(`skill file ${skPath} ignored: frontmatter requires name and description`);
    return void 0;
  }
  if (!isSkillName(name)) {
    warn?.(`skill file ${skPath} ignored: invalid skill name "${name}"`);
    return void 0;
  }
  let invocation;
  try {
    invocation = parseInvocationPolicy(parsed.data);
  } catch (e) {
    warn?.(`skill file ${skPath} ignored: invalid invocation frontmatter: ${e && e.message}`);
    return void 0;
  }
  return {
    name,
    description,
    whenToUse: optionalString(parsed.data, "whenToUse"),
    invocation,
    metadata: optionalMetadata(parsed.data),
    path: skPath,
    content: parsed.body.trim()
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function findProjectRoot(cwd) {
  let current = cwd;
  while (true) {
    try {
      await fsp.access(path.join(current, ".git"));
      return current;
    } catch {
      // not found here
    }
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

async function discoverRoot(root, providerName, warn) {
  let entries;
  try {
    entries = await fsp.readdir(root.path, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    warn?.(`skill root ${root.path} unreadable: ${e && e.message}`);
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const name = entry.name;
      if (!isSkillName(name)) continue;
      const skPath = path.join(root.path, name, "SKILL.md");
      try {
        const st = await fsp.stat(skPath);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const parsed = await parseSkillFile(skPath, warn);
      if (!parsed) continue;
      candidates.push(toCandidate(parsed, root, providerName, { path: skPath, directory: path.join(root.path, name) }));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const baseName = entry.name.slice(0, -3);
      if (!isSkillName(baseName)) continue;
      const skPath = path.join(root.path, entry.name);
      const parsed = await parseSkillFile(skPath, warn);
      if (!parsed) continue;
      candidates.push(toCandidate(parsed, root, providerName, { path: skPath, directory: root.path }));
    }
  }
  return candidates;
}

function toCandidate(parsed, root, providerName, locator) {
  const candidate = {
    name: parsed.name,
    description: parsed.description,
    invocation: parsed.invocation,
    source: root.source,
    provider: providerName,
    rank: root.rank,
    path: parsed.path,
    locator
  };
  if (parsed.whenToUse !== void 0) candidate.whenToUse = parsed.whenToUse;
  if (parsed.metadata !== void 0) candidate.metadata = parsed.metadata;
  return candidate;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class FileSystemSkillProvider {
  constructor(config = {}, deps = {}) {
    this.name = config.providerName ?? "filesystem";
    this.includeDefaultRoots = config.includeDefaultRoots ?? true;
    this.dshHome = config.dshHome ? path.resolve(config.dshHome) : path.join(os.homedir(), ".dsh");
    this.agentsHome = config.agentsHome ? path.resolve(config.agentsHome) : path.join(os.homedir(), ".agents");
    this.customSkillDirs = (config.customSkillDirs ?? []).map((d) => path.resolve(d));
    this.bundledSkillDir = config.bundledSkillDir ? path.resolve(config.bundledSkillDir) : void 0;
    this.watch = config.watch ?? true;
    this.control = deps.control ?? { invalidate() {} };
    this.warn = deps.warn ?? ((m) => console.warn(m));
  }

  async roots(cwd) {
    const roots = [];
    if (this.includeDefaultRoots && cwd !== void 0) {
      const projectRoot = await findProjectRoot(path.resolve(cwd));
      roots.push(
        { path: path.join(projectRoot, ".dsh/skills"), source: "project-dsh", rank: PROJECT_DSH_RANK, projectRoot },
        { path: path.join(projectRoot, ".agents/skills"), source: "project-agents", rank: PROJECT_AGENTS_RANK, projectRoot }
      );
    }
    for (const d of this.customSkillDirs) {
      roots.push({ path: d, source: "custom", rank: CUSTOM_RANK });
    }
    if (this.includeDefaultRoots) {
      roots.push(
        { path: path.join(this.dshHome, "skills"), source: "user-dsh", rank: USER_DSH_RANK },
        { path: path.join(this.agentsHome, "skills"), source: "user-agents", rank: USER_AGENTS_RANK }
      );
    }
    if (this.bundledSkillDir !== void 0) {
      roots.push({ path: this.bundledSkillDir, source: "bundled", rank: BUNDLED_SKILL_RANK });
    }
    return roots;
  }

  async list(options = {}) {
    const roots = await this.roots(options.cwd);
    let complete = true;
    if (this.watch) {
      try { this.observeRoots(roots); } catch { complete = false; }
    }
    const candidates = [];
    for (const root of roots) {
      const found = await discoverRoot(root, this.name, this.warn);
      for (const c of found) candidates.push(c);
    }
    return complete ? candidates : { candidates, complete };
  }

  observeRoots(roots) {
    for (const root of roots) {
      try {
        fs.watch(root.path, { persistent: false }, () => this.control.invalidate());
      } catch {
        // directory may not exist yet; ignore
      }
    }
  }

  async get(candidate, options = {}) {
    const locator = candidate.locator;
    if (!locator || !locator.path) return void 0;
    const parsed = await parseSkillFile(locator.path, this.warn);
    if (parsed === void 0) return void 0;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: "directory", path: locator.directory },
      path: parsed.path,
      ...(parsed.metadata !== void 0 ? { metadata: parsed.metadata } : {}),
      content: parsed.content
    };
  }
}

module.exports = { FileSystemSkillProvider, createFileSystemProvider: (config, deps) => new FileSystemSkillProvider(config, deps) };
