"use strict";

// The rag-* pipeline runs entirely on typed artifacts. This test exercises the
// closed loop against a local HTTP server: fetch -> normalize -> index ->
// search -> eval, plus the domain and robots.txt gates.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LONG_BODY = "This paragraph explains tool calling and retrieval for agents. ".repeat(12);

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nDisallow: /blocked\n");
      return;
    }
    if (req.url === "/doc") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><head><title>RAG Curator Test Doc</title></head><body>
        <nav>ignored navigation</nav>
        <h1>Function Calling</h1>
        <p>ragcuratoruniqueword ${LONG_BODY}</p>
        <h2>Example</h2><pre><code>const answer = 42;</code></pre>
        <footer>ignored footer</footer></body></html>`);
      return;
    }
    if (req.url === "/short") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>Short</title></head><body>too short</body></html>");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function run(root, collection, command, extra = []) {
  const { stdout } = await execFileAsync(process.execPath,
    ["scripts/rag.js", command, "--collection", collection, "--root", root].concat(extra),
    { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(stdout);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("rag pipeline runs fetch -> normalize -> index -> search -> eval", async () => {
  const server = await serve();
  const port = server.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rag-pipeline-"));
  const dir = path.join(root, "demo");
  try {
    await run(root, "demo", "init");
    assert.equal(fs.existsSync(path.join(dir, "approved-domains.json")), true);

    fs.writeFileSync(path.join(dir, "approved-domains.json"), JSON.stringify([{ domain: "127.0.0.1", tier: "T0" }]));
    fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify([
      { url: `http://127.0.0.1:${port}/doc`, source_tier: "T0", topic: "agent/tool-use" },
      { url: `http://127.0.0.1:${port}/short`, source_tier: "T1", topic: "agent/tool-use" },
      { url: `http://127.0.0.1:${port}/blocked`, source_tier: "T1", topic: "agent/tool-use" },
      { url: "http://example.com/doc", source_tier: "T0", topic: "agent/tool-use" },
    ]));

    const fetched = await run(root, "demo", "fetch", ["--limit", "10"]);
    assert.equal(fetched.counts.ok, 2, "doc and short page are fetched");
    assert.equal(fetched.counts.rejected, 2, "robots and unapproved domain are rejected");
    const reasons = fetched.results.filter((row) => row.status === "rejected").map((row) => row.reason);
    assert.ok(reasons.includes("domain not approved"));
    assert.ok(reasons.includes("robots.txt disallows this path"));

    const metas = fs.readdirSync(path.join(dir, "snapshots")).filter((name) => name.endsWith(".meta.json"));
    assert.equal(metas.length, 2);
    const docMeta = metas.map((name) => readJson(path.join(dir, "snapshots", name)))
      .find((meta) => meta.canonical_url.endsWith("/doc"));
    assert.ok(docMeta && docMeta.content_hash);

    const normalized = await run(root, "demo", "normalize", ["--min-chars", "200"]);
    assert.equal(normalized.counts.ok, 1);
    assert.equal(normalized.counts.skipped, 1, "short body is skipped");
    const documents = fs.readdirSync(path.join(dir, "documents")).filter((name) => name.endsWith(".meta.json"));
    const normalizedMeta = readJson(path.join(dir, "documents", documents[0]));
    assert.equal(normalizedMeta.trust_tier, "T0");
    assert.equal(normalizedMeta.doc_id, docMeta.content_hash);
    const markdown = fs.readFileSync(path.join(dir, normalizedMeta.markdown_path), "utf8");
    assert.ok(markdown.includes("ragcuratoruniqueword"));
    assert.ok(!markdown.includes("ignored navigation"), "nav is stripped");

    const indexed = await run(root, "demo", "index");
    assert.ok(indexed.chunks > 0);
    const index = readJson(path.join(dir, "index.json"));
    assert.equal(index.n, indexed.chunks);
    assert.ok(index.df.ragcuratoruniqueword >= 1);

    const found = await run(root, "demo", "search", ["--query", "ragcuratoruniqueword", "--top", "3"]);
    assert.equal(found[0].doc_id, normalizedMeta.doc_id);

    fs.writeFileSync(path.join(dir, "eval", "golden.jsonl"),
      JSON.stringify({ question: "ragcuratoruniqueword", relevant_doc_ids: [normalizedMeta.doc_id] }) + "\n");
    const evaluated = await run(root, "demo", "eval");
    assert.equal(evaluated.questions, 1);
    assert.equal(evaluated.recall_at_5, 1);

    const duplicate = await run(root, "demo", "fetch", ["--limit", "10"]);
    assert.equal(duplicate.counts.duplicate, 2, "second fetch dedupes by hash/canonical URL");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rag init rejects collection ids that escape the data root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rag-bad-id-"));
  try {
    await assert.rejects(run(root, "../escape", "init"), /collection must start with a letter/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
