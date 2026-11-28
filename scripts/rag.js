#!/usr/bin/env node
"use strict";

// RAG cold-start pipeline: deterministic stages over typed artifacts.
// The agent works at the edges (query plans, URL grading, repair advice,
// golden questions); fetching, normalization and indexing stay scripted.
// Artifacts live under data/rag/<collection>/ (or --root for tests).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import TurndownService from "turndown";
import { PROJECT_ROOT } from "../lib/paths/index.js";

const ID_RE = /^[a-z][a-z0-9-]*$/;
const MAX_BYTES = 5_000_000;

const USAGE = `rag <command> --collection <id> [options]

Commands:
  init        create collection directories and empty control files
  fetch       fetch approved URLs into snapshots
  normalize   turn snapshots into checked Markdown documents
  index       split documents into chunks and build a BM25 index
  search      --query <text> [--top 5] [--tier T0,T1]
  eval        score golden questions with recall@5
  all         fetch -> normalize -> index

Options:
  --root <dir>        artifact root (default: <project>/data/rag)
  --candidates <file> candidate JSON for fetch (default: sources.json)
  --limit <n>         max URLs per fetch (default: 50)
  --min-chars <n>     minimum body length in normalize (default: 200)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function baseDir(args) {
  return args.root && args.root !== true ? path.resolve(String(args.root)) : path.join(PROJECT_ROOT, "data", "rag");
}

function collectionDir(args) {
  const id = String(args.collection || "");
  if (!ID_RE.test(id)) throw new Error("collection must start with a letter and use only lower-case letters, digits and hyphens");
  return path.join(baseDir(args), id);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function manifest(dir) {
  return readJson(path.join(dir, "manifest.json"), {});
}

function updateManifest(dir, patch) {
  const next = Object.assign(manifest(dir), patch || {}, { updated_at: new Date().toISOString() });
  writeJson(path.join(dir, "manifest.json"), next);
  return next;
}

function tokens(text) {
  return String(text || "").toLowerCase().match(/[\u3400-\u9fff]|[a-z0-9_]+/g) || [];
}

function termFreq(words) {
  const tf = {};
  words.forEach((word) => { tf[word] = (tf[word] || 0) + 1; });
  return tf;
}

function canonicalUrl(raw) {
  const url = new URL(String(raw));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol " + url.protocol);
  Array.from(url.searchParams.keys()).forEach((key) => {
    if (/^utm_/i.test(key) || key === "ref") url.searchParams.delete(key);
  });
  url.hash = "";
  return url.toString();
}

function approvedDomains(dir) {
  const raw = readJson(path.join(dir, "approved-domains.json"), []);
  const list = Array.isArray(raw) ? raw : (raw.domains || []);
  return list.map((item) => (typeof item === "string" ? item : item && item.domain)).filter(Boolean);
}

function isApproved(url, domains) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((entry) => {
    const domain = String(entry).toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith("." + domain);
  });
}

function parseRobots(text) {
  const rules = [];
  let active = false;
  String(text || "").split(/\r?\n/).forEach((line) => {
    const clean = line.replace(/#.*$/, "").trim();
    const idx = clean.indexOf(":");
    if (idx < 0) return;
    const key = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (key === "user-agent") active = value === "*";
    else if (active && key === "disallow" && value) rules.push(value);
  });
  return rules;
}

async function robotsAllowed(url, cache) {
  const origin = new URL(url).origin;
  if (!cache.has(origin)) {
    let rules = [];
    try {
      const response = await fetch(origin + "/robots.txt", { signal: AbortSignal.timeout(8000) });
      if (response.ok) rules = parseRobots(await response.text());
    } catch (_) {
      rules = [];
    }
    cache.set(origin, rules);
  }
  const pathname = new URL(url).pathname || "/";
  return !cache.get(origin).some((rule) => pathname.startsWith(rule));
}

function extractCanonical(html, fallback) {
  const match = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)
    || /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html);
  if (!match) return fallback;
  try { return canonicalUrl(match[1]); } catch (_) { return fallback; }
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
}

function extensionFor(contentType, url) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("html")) return ".html";
  if (type.includes("markdown") || /\.md$/i.test(url)) return ".md";
  if (type.includes("pdf") || /\.pdf$/i.test(url)) return ".pdf";
  if (type.includes("text")) return ".txt";
  return ".txt";
}

function snapshotIndex(dir) {
  const hashes = new Set();
  const urls = new Set();
  const snapDir = path.join(dir, "snapshots");
  if (!fs.existsSync(snapDir)) return { hashes, urls };
  fs.readdirSync(snapDir).filter((name) => name.endsWith(".meta.json")).forEach((name) => {
    const meta = readJson(path.join(snapDir, name), {});
    if (meta.content_hash) hashes.add(meta.content_hash);
    if (meta.canonical_url) urls.add(meta.canonical_url);
  });
  return { hashes, urls };
}

function loadEntries(dir, args) {
  const file = args.candidates && args.candidates !== true
    ? path.resolve(dir, String(args.candidates))
    : path.join(dir, "sources.json");
  const raw = readJson(file, []);
  const list = Array.isArray(raw) ? raw : (raw.candidates || raw.sources || []);
  return list.filter((entry) => entry && entry.url && entry.status !== "rejected");
}

async function cmdFetch(args) {
  const dir = collectionDir(args);
  const domains = approvedDomains(dir);
  const snapDir = path.join(dir, "snapshots");
  const runDir = path.join(dir, "runs");
  fs.mkdirSync(snapDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const existing = snapshotIndex(dir);
  const robotsCache = new Map();
  const limit = Math.max(1, Number(args.limit) || 50);
  const results = [];

  for (const entry of loadEntries(dir, args).slice(0, limit)) {
    let url;
    try { url = canonicalUrl(entry.url); } catch (err) {
      results.push({ url: entry.url, status: "rejected", reason: err.message });
      continue;
    }
    if (!isApproved(url, domains)) {
      results.push({ url, status: "rejected", reason: "domain not approved" });
      continue;
    }
    if (!(await robotsAllowed(url, robotsCache))) {
      results.push({ url, status: "rejected", reason: "robots.txt disallows this path" });
      continue;
    }
    let response;
    try {
      response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
        headers: { "User-Agent": "rag-curator/0.1" },
      });
    } catch (err) {
      results.push({ url, status: "failed", reason: String(err.message || err) });
      continue;
    }
    if (!response.ok) {
      results.push({ url, status: "failed", reason: "http " + response.status });
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      results.push({ url, status: "failed", reason: "body too large" });
      continue;
    }
    const contentType = response.headers.get("content-type") || "";
    let html = "";
    if (contentType.includes("html") || extensionFor(contentType, url) === ".html") {
      html = buffer.toString("utf8");
    }
    const canonical = extractCanonical(html, response.url || url);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (existing.hashes.has(hash) || existing.urls.has(canonical)) {
      results.push({ url, canonical_url: canonical, status: "duplicate", reason: "already snapshotted" });
      continue;
    }
    const ext = extensionFor(contentType, url);
    const rawFile = path.join(snapDir, hash + ext);
    fs.writeFileSync(rawFile, buffer);
    const meta = {
      snapshot_id: hash,
      url,
      canonical_url: canonical,
      title: extractTitle(html),
      http_status: response.status,
      content_hash: hash,
      raw_path: path.relative(dir, rawFile),
      content_type: contentType,
      fetched_at: new Date().toISOString(),
      source_tier: entry.source_tier || entry.tier || "T3",
      topic: entry.topic || "",
      version: entry.version || "",
      license: entry.license || "",
    };
    if (ext === ".pdf") {
      try {
        const text = execFileSync("pdftotext", ["-layout", rawFile, "-"], {
          encoding: "utf8", maxBuffer: MAX_BYTES * 2,
        });
        const textFile = rawFile + ".txt";
        fs.writeFileSync(textFile, text);
        meta.text_path = path.relative(dir, textFile);
      } catch (_) {
        meta.parse_note = "pdftotext unavailable; PDF left as raw snapshot";
      }
    }
    writeJson(path.join(snapDir, hash + ".meta.json"), meta);
    existing.hashes.add(hash);
    existing.urls.add(canonical);
    results.push({ url, canonical_url: canonical, status: "ok", snapshot_id: hash });
  }

  const report = {
    collection: path.basename(dir),
    fetched_at: new Date().toISOString(),
    counts: results.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}),
    results,
  };
  const reportFile = path.join(runDir, "fetch-" + stamp() + ".json");
  writeJson(reportFile, report);
  updateManifest(dir, { snapshots: snapshotIndex(dir).hashes.size, last_fetch: reportFile });
  console.log(JSON.stringify({ report: path.relative(dir, reportFile), counts: report.counts, results }, null, 2));
}

function htmlToMarkdown(html) {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  service.remove(["script", "style", "nav", "footer"]);
  return service.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

function qualityIssues(markdown) {
  const issues = [];
  if ((markdown.match(/^```/gm) || []).length % 2) issues.push("unbalanced-code-fence");
  const lines = markdown.split(/\r?\n/);
  const linkLines = lines.filter((line) => /^\s*[-*]\s+\[/.test(line)).length;
  if (lines.length > 10 && linkLines > lines.length / 2) issues.push("suspicious-link-list");
  return issues;
}

function cmdNormalize(args) {
  const dir = collectionDir(args);
  const snapDir = path.join(dir, "snapshots");
  const docDir = path.join(dir, "documents");
  const runDir = path.join(dir, "runs");
  fs.mkdirSync(docDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const minChars = Math.max(1, Number(args["min-chars"]) || 200);
  const results = [];

  const metas = fs.existsSync(snapDir)
    ? fs.readdirSync(snapDir).filter((name) => name.endsWith(".meta.json"))
    : [];
  for (const name of metas) {
    const meta = readJson(path.join(snapDir, name), {});
    const rawRel = meta.text_path || meta.raw_path;
    const rawPath = rawRel ? path.join(dir, rawRel) : null;
    if (!rawPath || !fs.existsSync(rawPath)) {
      results.push({ snapshot_id: meta.snapshot_id, status: "failed", reason: "raw snapshot missing" });
      continue;
    }
    const body = fs.readFileSync(rawPath, "utf8");
    const markdown = /\.html$/i.test(meta.raw_path || "") ? htmlToMarkdown(body) : body.trim();
    const issues = qualityIssues(markdown);
    if (markdown.length < minChars) issues.push("below-min-chars");
    if (issues.length) {
      results.push({ snapshot_id: meta.snapshot_id, status: "skipped", reason: issues.join(",") });
      continue;
    }
    const docId = meta.content_hash;
    const docMeta = {
      doc_id: docId,
      snapshot_id: meta.snapshot_id,
      canonical_url: meta.canonical_url || meta.url,
      title: meta.title || extractTitle(body) || path.basename(meta.canonical_url || meta.url || ""),
      publisher: meta.publisher || "",
      version: meta.version || "",
      published_at: meta.published_at || "",
      language: meta.language || "",
      markdown_path: path.relative(dir, path.join(docDir, docId + ".md")),
      topic: meta.topic || "",
      trust_tier: meta.source_tier || "T3",
      license: meta.license || "",
    };
    fs.writeFileSync(path.join(docDir, docId + ".md"), markdown + "\n");
    writeJson(path.join(docDir, docId + ".meta.json"), docMeta);
    results.push({ doc_id: docId, status: "ok", title: docMeta.title });
  }

  const report = {
    collection: path.basename(dir),
    normalized_at: new Date().toISOString(),
    counts: results.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}),
    results,
  };
  const reportFile = path.join(runDir, "normalize-" + stamp() + ".json");
  writeJson(reportFile, report);
  updateManifest(dir, { documents: results.filter((row) => row.status === "ok").length, last_normalize: reportFile });
  console.log(JSON.stringify({ report: path.relative(dir, reportFile), counts: report.counts, results }, null, 2));
}

function splitSections(markdown, docTitle) {
  const sections = [];
  let headings = [];
  let current = { path: [], lines: [] };
  markdown.split(/\r?\n/).forEach((line) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      if (current.lines.length) sections.push(current);
      const level = match[1].length;
      headings = headings.filter((heading) => heading.level < level);
      headings.push({ level, title: match[2].trim() });
      current = { path: headings.map((heading) => heading.title), lines: [line] };
    } else {
      current.lines.push(line);
    }
  });
  if (current.lines.length) sections.push(current);
  return sections.map((section) => ({
    section_path: [docTitle].concat(section.path).filter(Boolean).join(" > "),
    text: section.lines.join("\n").trim(),
  })).filter((section) => section.text);
}

function groupParagraphs(text, maxChars) {
  const paragraphs = text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const groups = [];
  let current = [];
  let length = 0;
  paragraphs.forEach((paragraph) => {
    if (current.length && length + paragraph.length > maxChars) {
      groups.push(current.join("\n\n"));
      const overlap = current[current.length - 1];
      current = [overlap];
      length = overlap.length;
    } else {
      current.push(paragraph);
      length += paragraph.length;
    }
  });
  if (current.length) groups.push(current.join("\n\n"));
  return groups;
}

function cmdIndex(args) {
  const dir = collectionDir(args);
  const docDir = path.join(dir, "documents");
  const maxChars = Math.max(200, Number(args["chunk-chars"]) || 900);
  const chunks = [];

  const metas = fs.existsSync(docDir)
    ? fs.readdirSync(docDir).filter((name) => name.endsWith(".meta.json"))
    : [];
  metas.forEach((name) => {
    const meta = readJson(path.join(docDir, name), {});
    const mdFile = path.join(dir, meta.markdown_path || "");
    if (!meta.markdown_path || !fs.existsSync(mdFile)) return;
    const markdown = fs.readFileSync(mdFile, "utf8");
    splitSections(markdown, meta.title || "").forEach((section) => {
      const parts = /```/.test(section.text)
        ? [section.text]
        : groupParagraphs(section.text, maxChars);
      parts.forEach((part, index) => {
        const text = "# " + section.section_path + "\n" + part;
        const words = tokens(text);
        chunks.push({
          chunk_id: meta.doc_id + "-" + chunks.length,
          doc_id: meta.doc_id,
          section_path: section.section_path,
          chunk_index: index,
          text,
          token_count: words.length,
          tf: termFreq(words),
        });
      });
    });
  });

  const df = {};
  let totalLength = 0;
  chunks.forEach((chunk) => {
    totalLength += chunk.token_count;
    Object.keys(chunk.tf).forEach((term) => { df[term] = (df[term] || 0) + 1; });
  });
  const index = {
    collection: path.basename(dir),
    n: chunks.length,
    avgdl: chunks.length ? totalLength / chunks.length : 0,
    df,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chunks.jsonl"), chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + (chunks.length ? "\n" : ""));
  writeJson(path.join(dir, "index.json"), index);
  updateManifest(dir, { chunks: chunks.length, collection_version: path.basename(dir) + "-v1" });
  console.log(JSON.stringify({ collection: path.basename(dir), chunks: chunks.length, avgdl: Number(index.avgdl.toFixed(2)) }, null, 2));
}

function loadChunks(dir) {
  return readLines(path.join(dir, "chunks.jsonl")).map((line) => JSON.parse(line));
}

function docTiers(dir) {
  const result = {};
  const docDir = path.join(dir, "documents");
  if (!fs.existsSync(docDir)) return result;
  fs.readdirSync(docDir).filter((name) => name.endsWith(".meta.json")).forEach((name) => {
    const meta = readJson(path.join(docDir, name), {});
    if (meta.doc_id) result[meta.doc_id] = meta.trust_tier || "";
  });
  return result;
}

function scoreChunks(dir, query, tiers) {
  const index = readJson(path.join(dir, "index.json"), { n: 0, avgdl: 0, df: {} });
  const chunks = loadChunks(dir);
  const words = tokens(query);
  const docTierMap = tiers ? docTiers(dir) : null;
  const k1 = 1.5;
  const b = 0.75;
  return chunks.map((chunk) => {
    let score = 0;
    words.forEach((word) => {
      const termDf = index.df[word] || 0;
      if (!termDf) return;
      const freq = chunk.tf[word] || 0;
      if (!freq) return;
      const idf = Math.log(1 + (index.n - termDf + 0.5) / (termDf + 0.5));
      const dl = chunk.token_count || 1;
      score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * dl / (index.avgdl || 1)));
    });
    return { chunk, score };
  }).filter((row) => row.score > 0 && (!tiers || tiers.indexOf(docTierMap[row.chunk.doc_id]) >= 0))
    .sort((a, b2) => b2.score - a.score);
}

function summarize(row) {
  return {
    chunk_id: row.chunk.chunk_id,
    doc_id: row.chunk.doc_id,
    section_path: row.chunk.section_path,
    score: Number(row.score.toFixed(4)),
    text: row.chunk.text.slice(0, 500),
  };
}

function cmdSearch(args) {
  const dir = collectionDir(args);
  const top = Math.max(1, Number(args.top) || 5);
  const tiers = args.tier && args.tier !== true ? String(args.tier).split(",") : null;
  const rows = scoreChunks(dir, String(args.query || ""), tiers).slice(0, top);
  console.log(JSON.stringify(rows.map(summarize), null, 2));
}

function cmdEval(args) {
  const dir = collectionDir(args);
  const golden = readLines(path.join(dir, "eval", "golden.jsonl")).map((line) => JSON.parse(line));
  const top = 5;
  const rows = golden.map((item) => {
    const relevant = item.relevant_doc_ids || [];
    const found = scoreChunks(dir, item.question || "", null).slice(0, top)
      .map((row) => row.chunk.doc_id);
    const hits = found.filter((docId) => relevant.indexOf(docId) >= 0).length;
    return {
      question: item.question,
      relevant: relevant.length,
      found: found.length,
      recall: relevant.length ? Number((hits / relevant.length).toFixed(4)) : 0,
    };
  });
  const recall = rows.length ? rows.reduce((sum, row) => sum + row.recall, 0) / rows.length : 0;
  const report = {
    collection: path.basename(dir),
    evaluated_at: new Date().toISOString(),
    questions: rows.length,
    recall_at_5: Number(recall.toFixed(4)),
    rows,
  };
  const reportFile = path.join(dir, "runs", "eval-" + stamp() + ".json");
  writeJson(reportFile, report);
  console.log(JSON.stringify({ report: path.relative(dir, reportFile), questions: report.questions, recall_at_5: report.recall_at_5 }, null, 2));
}

function cmdInit(args) {
  const dir = collectionDir(args);
  ["snapshots", "documents", "eval", "runs", "query-plans", "candidates"].forEach((name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  });
  const defaults = [
    ["approved-domains.json", []],
    ["sources.json", []],
    ["eval/golden.jsonl", ""],
  ];
  defaults.forEach(([name, value]) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  });
  writeJson(path.join(dir, "manifest.json"), Object.assign(manifest(dir), {
    collection: path.basename(dir),
    initialized_at: new Date().toISOString(),
  }));
  console.log(JSON.stringify({ collection: path.basename(dir), dir }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  try {
    switch (command) {
      case "init": cmdInit(args); break;
      case "fetch": await cmdFetch(args); break;
      case "normalize": cmdNormalize(args); break;
      case "index": cmdIndex(args); break;
      case "search": cmdSearch(args); break;
      case "eval": cmdEval(args); break;
      case "all":
        await cmdFetch(args);
        cmdNormalize(args);
        cmdIndex(args);
        break;
      case "help": console.log(USAGE); break;
      default: throw new Error("unknown command: " + command + "\n" + USAGE);
    }
  } catch (err) {
    console.error("rag: " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

main();
