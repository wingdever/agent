"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createProxy, type } from "../../../proxies/lark/index.js";
import { assertProxy } from "../../../proxies/contract.js";
import { loadDrivers } from "../../../proxies/registry.js";
import { createCliRunner } from "../../../proxies/lark/runner.js";

const FIXTURE = path.join(import.meta.dirname, "../../../test/proxies/lark/fixtures", "fake-lark-cli.js");

function makeProxy({ scopes, options = {}, env = {} } = {}) {
  return createProxy({
    instance: {
      id: "lark-me",
      type: "lark",
      scopes,
      options: { impl: "cli", qps: 50, ...options },
      env,
    },
    deps: {
      runner: createCliRunner({ command: process.execPath, prefixArgs: [FIXTURE], env }),
    },
  });
}

function recordFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-proxy-")), "argv.log");
  return file;
}

function recorded(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("the driver is a valid proxy", () => {
  const proxy = makeProxy();
  assertProxy(proxy);
  assert.equal(proxy.type, type);
  assert.equal(proxy.instanceId, "lark-me");
  assert.equal(typeof proxy.auth.headers, "function");
});

test("whoami reports the person behind the CLI session, once", async () => {
  const file = recordFile();
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });
  assert.equal(await proxy.whoami(), "Fake Wing");
  assert.equal(await proxy.whoami(), "Fake Wing");
  assert.equal(recorded(file).length, 1, "identity is cached for the process lifetime");
});

test("a tenant (bot) session is refused: a human proxy must act as a human", async () => {
  const proxy = makeProxy({ env: { FAKE_LARK_MODE: "identity-tenant" } });
  await assert.rejects(proxy.whoami(), /running as "tenant", but this proxy requires a human/);
});

test("doc.read maps to the documented CLI command line", async () => {
  const file = recordFile();
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("doc.read", { doc: "doxcnABC" });

  const argv = recorded(file).at(-1);
  assert.deepEqual(argv, ["docs", "+fetch", "--doc", "doxcnABC", "--doc-format", "markdown"]);
  assert.equal(result.content, "# fake doc");
});

test("drive.list stays inside the page-size cap", async () => {
  const file = recordFile();
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });
  await proxy.call("drive.list", { limit: 9999 });

  const argv = recorded(file).at(-1);
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--params") + 1]), { page_size: 200 });
});

test("a missing scope is refused before any process is started", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document:readonly"], env: { FAKE_LARK_RECORD: file } });

  await assert.rejects(proxy.call("drive.list"), /scope "drive:drive:readonly" is not granted/);
  assert.deepEqual(recorded(file), [], "a refused call must have no side effect");
});

test("unknown actions are refused and the known list is shown", async () => {
  const proxy = makeProxy();
  await assert.rejects(proxy.call("doc.delete"), (err) => {
    assert.match(err.message, /unknown action "doc.delete"/);
    for (const known of ["doc.read", "drive.list", "api"]) assert.match(err.message, new RegExp(known));
    return true;
  });
});

test("risk gating: writes and deletes need an explicit allowlist", async () => {
  const file = recordFile();
  const writer = makeProxy({ options: { allow: ["read", "write"], allowApi: true }, env: { FAKE_LARK_RECORD: file } });

  await assert.rejects(writer.call("api", { method: "DELETE", path: "/open-apis/drive/v1/files/x" }), /risk "high" is not allowed/);
  const result = await writer.call("api", { method: "POST", path: "/open-apis/docx/v1/documents" });
  assert.equal(result.method, "POST");
});

test("the raw api escape hatch is off unless options.allowApi is set", async () => {
  const proxy = makeProxy();
  await assert.rejects(proxy.call("api", { method: "GET", path: "/open-apis/x" }), /requires options.allowApi/);

  const opened = makeProxy({ options: { allowApi: true } });
  const result = await opened.call("api", { method: "GET", path: "/open-apis/x" });
  assert.deepEqual(result, { method: "GET", path: "/open-apis/x" });
});

test("a dead CLI credential surfaces as an auth error, not as a platform refusal", async () => {
  const proxy = makeProxy({ env: { FAKE_LARK_MODE: "auth" } });
  await assert.rejects(proxy.whoami(), (err) => {
    assert.equal(err.kind, "auth");
    assert.equal(err.code, 99991668);
    return true;
  });
});

test("a CLI that prints non-JSON is a platform error with the output quoted", async () => {
  const proxy = makeProxy({ env: { FAKE_LARK_MODE: "garbage" } });
  await assert.rejects(proxy.call("doc.read", { doc: "doxcnABC" }), (err) => {
    assert.equal(err.kind, "platform");
    assert.match(err.message, /printed no JSON: boom/);
    return true;
  });
});

test("a non-zero exit is reported with exit code and stderr", async () => {
  const proxy = makeProxy({ env: { FAKE_LARK_MODE: "exit1" } });
  await assert.rejects(proxy.call("drive.list"), (err) => {
    assert.equal(err.kind, "platform");
    assert.match(err.message, /exited 1/);
    assert.match(err.message, /no profile configured/);
    return true;
  });
});

test("the slot loader discovers lark next to the other drivers", async () => {
  const drivers = await loadDrivers();
  assert.ok(drivers.has("lark"));
  assert.equal(typeof drivers.get("lark"), "function");
});

test("only known routes are accepted: a typo must not pick one silently", () => {
  assert.throws(
    () => createProxy({ instance: { id: "lark-oauth", options: { impl: "magic" } } }),
    /unknown impl "magic" \(known: cli, oauth\)/
  );
});

test("drive.list browses a specific folder and passes page tokens through", async () => {
  const file = recordFile();
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });
  await proxy.call("drive.list", { folder: "https://my.feishu.cn/drive/folder/fldcnABC?from=x", limit: 30, pageToken: "pg1" });

  const argv = recorded(file).at(-1);
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--params") + 1]), {
    page_size: 30,
    folder_token: "fldcnABC",
    page_token: "pg1",
  });
});

test("drive.list keeps the root query clean when no folder is given", async () => {
  const file = recordFile();
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });
  await proxy.call("drive.list", { limit: 10 });

  const argv = recorded(file).at(-1);
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--params") + 1]), { page_size: 10 });
});

test("a CLI failure is classified from its structured error, not the raw exit", async () => {
  const proxy = makeProxy({ env: { FAKE_LARK_MODE: "api-error" } });
  await assert.rejects(proxy.call("doc.read", { doc: "doxcnABC" }), (err) => {
    assert.equal(err.kind, "platform");
    assert.equal(err.code, 3380002);
    assert.match(err.message, /Unsupported document type/, "the CLI message survives");
    assert.ok(!err.message.includes("{"), "no raw JSON blob in the message");
    return true;
  });
});

test("drive.read downloads once, then slices by offset", async () => {
  const file = recordFile();
  // The cache lives under user/.cache on purpose (downloads are expensive), so a
  // test that wants to observe the download must start from an empty cache.
  const cache = path.join(import.meta.dirname, "../../../user", ".cache", "drive", "Tok123.bin");
  fs.rmSync(cache, { force: true });
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });

  const first = await proxy.call("drive.read", { token: "https://my.feishu.cn/file/Tok123?x=1", limit: 12 });
  const argv = recorded(file).at(-1);
  assert.deepEqual(argv.slice(0, 3), ["drive", "+download", "--file-token"]);
  assert.equal(argv[3], "Tok123");
  assert.ok(argv[5].endsWith("/user/.cache/drive/Tok123.bin"), "the cache path is derived from the token");
  assert.equal(first.encoding, "text");
  assert.equal(first.content, "# fake snaps");
  assert.equal(first.next_offset, 12);
  assert.equal(first.eof, false);

  const second = await proxy.call("drive.read", { token: "Tok123", offset: first.next_offset });
  assert.equal(recorded(file).length, 1, "a second offset must not download again");
  assert.ok(second.content.startsWith("hot of Tok123"), "the next slice continues where the last one stopped");
  assert.equal(second.eof, true);
});

test("drive.read returns binary as base64 rather than mojibake", async () => {
  const file = recordFile();
  const proxy = makeProxy({ env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("drive.read", { token: "bin123" });
  assert.equal(result.encoding, "base64");
  assert.deepEqual([...Buffer.from(result.content, "base64")], [0, 1, 2, 255, 254]);
  assert.equal(result.total_bytes, 5);
  assert.equal(result.eof, true);
});

test("sheet.read maps a sheet range to csv-get", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet:readonly"], env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("sheet.read", { token: "shtABC", sheet: "Sheet1", range: "A1:C10", maxChars: 5000 });

  const argv = recorded(file).at(-1);
  assert.deepEqual(argv, [
    "sheets", "+csv-get", "--spreadsheet-token", "shtABC",
    "--sheet-name", "Sheet1", "--range", "A1:C10", "--max-chars", "5000",
  ]);
  assert.equal(result.csv, "a,b\n1,2");
});

test("sheet.read can address a sub-sheet by id and defaults the char cap", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet:readonly"], env: { FAKE_LARK_RECORD: file } });
  await proxy.call("sheet.read", { token: "https://x.feishu.cn/sheets/shtABC?sheet=s1", sheetId: "s1" });

  const argv = recorded(file).at(-1);
  assert.equal(argv[argv.indexOf("--sheet-id") + 1], "s1");
  assert.ok(!argv.includes("--sheet-name"), "exactly one of sheet-id / sheet-name");
  assert.equal(argv[argv.indexOf("--max-chars") + 1], "120000");
});

test("sheet.read without a sheet name is refused before spawning", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet:readonly"], env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("sheet.read", { token: "shtABC" }), /action needs "sheet"/);
  assert.deepEqual(recorded(file), []);
});

test("sheet.info lists sub-sheets", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet:readonly"], env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("sheet.info", { token: "shtABC" });

  const argv = recorded(file).at(-1);
  assert.deepEqual(argv, ["sheets", "+workbook-info", "--spreadsheet-token", "shtABC"]);
  assert.equal(result.sheets[0].title, "Sheet1");
});

test("a whole-sheet read drops trailing blank rows and columns", async () => {
  const { actionSpec } = await import("../../../proxies/lark/actions.js");
  const spec = actionSpec("sheet.read");
  const trimmed = spec.post({ csv: "a,b,c,,,,,\n1,2,3,,,,,\n,,,,,,,\n,,,,,,,\n", actual_range: "A1:H200" });
  assert.equal(trimmed.csv, "a,b,c\n1,2,3");
  assert.equal(trimmed.rows, 2);
  assert.equal(trimmed.columns, 3);
  assert.equal(trimmed.actual_range, "A1:H200", "the platform range is preserved, not rewritten");
});

test("trimming keeps a quoted cell with commas and quotes intact", async () => {
  const { actionSpec } = await import("../../../proxies/lark/actions.js");
  const spec = actionSpec("sheet.read");
  const trimmed = spec.post({ csv: 'name,note,,\n"carol, x","a""b",,\n', actual_range: "A1:D4" });
  assert.equal(trimmed.csv, 'name,note\n"carol, x","a""b"');
  assert.equal(trimmed.columns, 2);
});


test("an explicit range is never trimmed: blank rows are part of the answer", async () => {
  const { actionSpec } = await import("../../../proxies/lark/actions.js");
  const spec = actionSpec("sheet.read");
  const result = spec.post({ csv: "1\n\n3" }, { range: "B2:B4" });
  assert.equal(result.csv, "1\n\n3");
  assert.equal(result.trimmed, false);
});

test("sheet.write maps a value matrix into per-cell objects", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await proxy.call("sheet.write", { token: "shtABC", sheet: "Sheet1", range: "A2:B3", values: [["x", 1], ["y", 2]] });

  const argv = recorded(file).at(-1);
  assert.deepEqual(argv, [
    "sheets", "+cells-set", "--spreadsheet-token", "shtABC",
    "--sheet-name", "Sheet1", "--range", "A2:B3",
    "--cells", '[[{"value":"x"},{"value":1}],[{"value":"y"},{"value":2}]]',
  ]);
});

test("doc.create and doc.append use markdown so the body is human-shaped", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  const created = await proxy.call("doc.create", { title: "笔记", content: "# 标题", folder: "fld1" });
  assert.deepEqual(recorded(file).at(-1), [
    "docs", "+create", "--title", "笔记", "--content", "# 标题", "--doc-format", "markdown", "--parent-token", "fld1",
  ]);
  assert.equal(created.document_id, "doxcnNEW");

  await proxy.call("doc.append", { doc: "https://x.feishu.cn/docx/doxcnNEW?from=y", content: "第一行\n第二行" });
  assert.deepEqual(recorded(file).at(-1), [
    "docs", "+update", "--doc", "doxcnNEW", "--command", "append",
    "--content", "第一行\n第二行", "--doc-format", "markdown",
  ]);
});

test("writes are refused by the risk gate unless the instance allows them", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet"], env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("sheet.write", { token: "s", sheet: "Sheet1", range: "A1", values: [["x"]] }), /risk "write" is not allowed/);
  assert.deepEqual(recorded(file), [], "a refused write must not spawn a process");
});

test("a write scope missing is refused even when risk is allowed", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document:readonly"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("sheet.write", { token: "s", sheet: "Sheet1", range: "A1", values: [["x"]] }), /scope "sheets:spreadsheet" is not granted/);
});

test("doc.read normalizes the CLI's nested document payload", async () => {
  const { actionSpec } = await import("../../../proxies/lark/actions.js");
  const spec = actionSpec("doc.read");
  const shaped = spec.shape({ document: { document_id: "d1", content: "# hi", revision_id: 7 } });
  assert.deepEqual(shaped, { content: "# hi", document_id: "d1", title: "", revision: 7 });
  const flat = spec.shape({ content: "plain", document_id: "d2" });
  assert.equal(flat.content, "plain", "the HTTP shape passes through");
});

test("doc.write replace is a patch, and an empty replacement deletes the match", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await proxy.call("doc.write", { doc: "https://x.feishu.cn/docx/doxcnNEW", mode: "replace", pattern: "旧句子", replacement: "新句子" });
  assert.deepEqual(recorded(file).at(-1), [
    "docs", "+update", "--doc", "doxcnNEW", "--command", "str_replace",
    "--pattern", "旧句子", "--content", "新句子", "--doc-format", "markdown",
  ]);

  await proxy.call("doc.write", { doc: "doxcnNEW", mode: "replace", pattern: "删掉这行" });
  assert.equal(recorded(file).at(-1).at(-3), "");
});

test("doc.write overwrite is high risk even when writes are allowed", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(
    proxy.call("doc.write", { doc: "doxcnNEW", mode: "overwrite", content: "# 全替换" }),
    /risk "high" is not allowed/
  );
  assert.deepEqual(recorded(file), [], "a refused rewrite must not spawn a process");
});

test("doc.write refuses a mode it does not implement", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("doc.write", { doc: "doxcnNEW", mode: "insert" }), /needs mode "replace", "overwrite", "block.replace", "block.insert" or "block.delete"/);
});

test("a soft failure keeps its warning text", async () => {
  const fake = process.execPath;
  const script = `
    process.stdout.write(JSON.stringify({ok:false,data:{result:"failed",warnings:["matched multiple locations"]}}));
    process.exit(1);
  `;
  const { createCliRunner } = await import("../../../proxies/lark/runner.js");
  const runner = createCliRunner({ command: fake, prefixArgs: ["-e", script] });
  await assert.rejects(runner.run(["docs"]), /matched multiple locations/);
});

test("sheet.write takes a batch of ranges, each able to name its own sheet", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["sheets:spreadsheet"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("sheet.write", {
    token: "shtABC",
    sheet: "Sheet1",
    writes: [
      { range: "A1:B2", values: [["a", 1], ["b", 2]] },
      { sheet_name: "Sheet2", range: "D1:E1", values: [["x", "y"]] },
    ],
  });
  const argv = recorded(file).at(-1);
  assert.equal(argv.at(-2), "--writes");
  const items = JSON.parse(argv.at(-1));
  assert.deepEqual(items[1], { sheet_name: "Sheet2", range: "D1:E1", cells: [[{ value: "x" }, { value: "y" }]] });
  assert.equal(items[0].sheet_name, undefined, "an item without a selector falls back to the top-level sheet");
  assert.deepEqual(result.updated_ranges, ["Sheet1!A1:B2", "Sheet2!D1:E1"]);
  assert.equal(result.updated_cells, 6);
});

test("drive.delete fans out to one process per file and repairs the aggregate by hand", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["drive:drive"], options: { allow: ["read", "write", "high"] }, env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("drive.delete", {
    files: [
      { token: "sht1", type: "sheet" },
      { token: "doc1", type: "docx" },
      { token: "sht2", type: "sheet" },
    ],
  });
  const calls = recorded(file);
  assert.equal(calls.length, 3, "one CLI process per file");
  for (const argv of calls) assert.equal(argv.at(-1), "--yes", "the CLI's high-risk confirmation is always passed");
  assert.equal(result.deleted.length, 3);
  assert.equal(result.failed.length, 0);
  assert.equal(result.deleted[0].task_id, "schedule|sht1");
  assert.equal(result.deleted[1].type, "docx");
});

test("drive.delete stays high risk and is refused when writes are merely allowed", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["drive:drive"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("drive.delete", { token: "sht1", type: "sheet" }), /risk "high" is not allowed/);
  assert.deepEqual(recorded(file), []);
});

test("drive.delete rejects an unknown type before spawning anything", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["drive:drive"], options: { allow: ["read", "write", "high"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("drive.delete", { token: "x", type: "spreadsheet" }), /unknown type/);
  assert.deepEqual(recorded(file), []);
});

test("doc.blocks reads the structure, not the rendered text", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document:readonly"], env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("doc.blocks", { doc: "https://x.feishu.cn/docx/doxcnABC?from=y" });
  assert.deepEqual(recorded(file).at(-1), [
    "api", "GET", "/open-apis/docx/v1/documents/doxcnABC/blocks", "--params", '{"page_size":100}',
  ]);
  assert.equal(result.blocks.length, 3);
  assert.deepEqual(
    result.blocks.slice(1).map((b) => [b.block_id, b.type, b.text]),
    [["b1", "text", "第一段"], ["b2", "h2", "小节"]]
  );
});

test("doc.write can replace, insert after, and delete blocks by id", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document"], options: { allow: ["read", "write", "high"] }, env: { FAKE_LARK_RECORD: file } });

  await proxy.call("doc.write", { doc: "d1", mode: "block.replace", blockId: "b1", content: "新的一段" });
  assert.deepEqual(recorded(file).at(-1), [
    "docs", "+update", "--doc", "d1", "--command", "block_replace",
    "--block-id", "b1", "--content", "新的一段", "--doc-format", "markdown",
  ]);

  await proxy.call("doc.write", { doc: "d1", mode: "block.insert", blockId: "b1", content: "插在下面" });
  assert.equal(recorded(file).at(-1)[5], "block_insert_after");

  const del = await proxy.call("doc.write", { doc: "d1", mode: "block.delete", blockIds: ["b2", "b3"] });
  assert.deepEqual(recorded(file).at(-1), ["docs", "+update", "--doc", "d1", "--command", "block_delete", "--block-id", "b2,b3"]);
  assert.equal(del.deleted_blocks, 2);
});

test("block.delete is high risk and refused when only writes are allowed", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["docx:document"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("doc.write", { doc: "d1", mode: "block.delete", blockId: "b1" }), /risk "high" is not allowed/);
  assert.deepEqual(recorded(file), []);
});

test("a network failure reported on stderr is retryable, not a platform rejection", async () => {
  const script = `
    process.stderr.write(JSON.stringify({ok:false,identity:"user",error:{type:"network",subtype:"timeout",message:"server time out error"}}));
    process.exit(4);
  `;
  const { createCliRunner } = await import("../../../proxies/lark/runner.js");
  const runner = createCliRunner({ command: process.execPath, prefixArgs: ["-e", script] });
  await assert.rejects(runner.run(["docs"]), (err) => {
    assert.equal(err.kind, "retryable");
    assert.match(err.message, /server time out error/);
    return true;
  });
});

test("im.send picks one receiver and one body shape", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });

  const dm = await proxy.call("im.send", { userId: "ou_wing", text: "早" });
  assert.deepEqual(recorded(file).at(-1), ["im", "+messages-send", "--user-id", "ou_wing", "--text", "早"]);
  assert.equal(dm.receiver_type, "open_id");

  const group = await proxy.call("im.send", { chatId: "oc_1", markdown: "**hi**", idempotencyKey: "k1" });
  assert.deepEqual(recorded(file).at(-1), ["im", "+messages-send", "--chat-id", "oc_1", "--markdown", "**hi**", "--idempotency-key", "k1"]);
  assert.equal(group.message_id, "om_fake");
});

test("im.send refuses ambiguous receivers or two bodies", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", userId: "ou_1", text: "x" }), /either "chatId" or "userId"/);
  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", text: "x", markdown: "y" }), /takes one content kind/);
  assert.deepEqual(recorded(file), [], "nothing is sent when the parameters disagree");
});

test("drive.upload refuses a path outside the file root before spawning", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["drive:drive"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("drive.upload", { path: "/etc/passwd" }), /must stay inside/);
  assert.deepEqual(recorded(file), [], "a refused upload must not read the file or spawn the CLI");
});

test("drive.upload and drive.export map to the documented command lines", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["drive:drive"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });

  const up = await proxy.call("drive.upload", { path: "docs/accounts/proxy.md", folder: "fld1", name: "proxy.md" });
  const uploadArgv = recorded(file).at(-1);
  assert.deepEqual(uploadArgv.slice(0, 3), ["drive", "+upload", "--file"]);
  assert.ok(uploadArgv[3].endsWith("/docs/accounts/proxy.md"), "relative paths are resolved against the file root");
  assert.deepEqual(uploadArgv.slice(4), ["--folder-token", "fld1", "--name", "proxy.md"]);
  assert.equal(up.name, "proxy.md");
  assert.equal(up.file_token, "file_up");

  const ex = await proxy.call("drive.export", { token: "doxcnABC", docType: "docx", extension: "pdf", outputDir: "tmp-out" });
  const exportArgv = recorded(file).at(-1);
  assert.deepEqual(exportArgv.slice(0, 8), [
    "drive", "+export", "--token", "doxcnABC", "--doc-type", "docx", "--file-extension", "pdf",
  ]);
  assert.ok(exportArgv[9].endsWith("/tmp-out"), "output dir stays inside the file root");
  assert.equal(ex.extension, "pdf");
  assert.equal(ex.bytes, 1234);
});

test("drive.export rejects an unsupported target format", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["drive:drive"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("drive.export", { token: "doxcnABC", extension: "gif" }), /unknown extension/);
  await assert.rejects(proxy.call("drive.export", { token: "mystery", extension: "pdf" }), /needs "docType"/);
  // A URL needs no docType: the CLI infers it.
  await proxy.call("drive.export", { token: "https://x.feishu.cn/docx/doxcnABC", extension: "pdf" });
  assert.deepEqual(recorded(file).at(-1).slice(0, 4), ["drive", "+export", "--url", "https://x.feishu.cn/docx/doxcnABC"]);
});

test("im.chats and im.messages map to their read commands", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:chat:readonly", "im:message:readonly"], env: { FAKE_LARK_RECORD: file } });

  const chats = await proxy.call("im.chats", { types: "group,p2p", pageSize: 5, excludeMuted: true });
  assert.deepEqual(recorded(file).at(-1), ["im", "+chat-list", "--types", "group,p2p", "--page-size", "5", "--sort", "create_time", "--exclude-muted"]);
  assert.deepEqual(chats.chats.map((c) => [c.chat_id, c.type]), [["oc_1", "group"], ["oc_2", "p2p"]]);

  const messages = await proxy.call("im.messages", { chatId: "oc_1", pageSize: 2 });
  const argv = recorded(file).at(-1);
  assert.deepEqual(argv.slice(0, 5), ["im", "+chat-messages-list", "--chat-id", "oc_1", "--page-size"]);
  assert.ok(argv.includes("--no-reactions"), "reactions are opt-in, not paid by default");
  assert.deepEqual(messages.messages.map((m) => [m.message_id, m.sender_name, m.text]), [["om_1", "alice", "第一条"], ["om_2", "bob", "第二条"]]);
});

test("im.search requires a query and returns normalized hits", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message:readonly"], env: { FAKE_LARK_RECORD: file } });
  const found = await proxy.call("im.search", { query: "找到了", pageSize: 3 });
  assert.deepEqual(recorded(file).at(-1).slice(0, 4), ["im", "+messages-search", "--query", "找到了"]);
  assert.equal(found.messages[0].text, "找到了");
  assert.equal(found.total, 1);

  await assert.rejects(proxy.call("im.search", {}), /needs "query"/);
});

test("drive.search returns a title, not highlight markup", async () => {
  const proxy = makeProxy({ scopes: ["search:docs:read"] });
  const result = await proxy.call("drive.search", { query: "HOWTO" });
  assert.equal(result.results[0].title, "HOWTO-agent-changes.md", "<h> markers are stripped");
  assert.equal(result.results[0].type, "file");
  assert.equal(result.results[0].file_type, "md");
  assert.equal(result.results[0].updated_at, "2026-11-23T00:53:02+08:00");
  assert.equal(result.total, 1);
  assert.equal(result.page_token, "tok_next");
});

test("drive.search translates filters into CLI flags", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  await proxy.call("drive.search", {
    query: "agent",
    mine: true,
    docTypes: ["docx", "sheet"],
    sort: "edit_time",
    onlyTitle: true,
    pageSize: 5,
    pageToken: "cur",
  });
  const argv = recorded(file).at(-1);
  assert.deepEqual(argv, [
    "drive", "+search",
    "--page-size", "5",
    "--query", "agent",
    "--doc-types", "docx,sheet",
    "--mine",
    "--only-title",
    "--sort", "edit_time",
    "--page-token", "cur",
  ]);
});

test("drive.search refuses an unscoped browse instead of reporting a false empty", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("drive.search", {}), /needs a query or a scope filter/);
  assert.deepEqual(recorded(file), [], "a refused call must have no side effect");
});

test("drive.search rejects unknown document types and sorts by name", async () => {
  const proxy = makeProxy({ scopes: ["search:docs:read"] });
  await assert.rejects(proxy.call("drive.search", { query: "x", docTypes: "pdf" }), /unknown doc type "pdf"/);
  await assert.rejects(proxy.call("drive.search", { query: "x", sort: "relevance" }), /unknown sort "relevance"/);
});

test("drive.search truncates an over-long query and says so", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("drive.search", { query: "x".repeat(45) });
  const argv = recorded(file).at(-1);
  assert.equal(argv[argv.indexOf("--query") + 1], "x".repeat(30));
  assert.match(result.notice, /truncated/);
});

test("im.messages reads a topic thread, resolving a message id itself", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message:readonly"], env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("im.messages", { thread: "om_x100b414779f120cc", pageSize: 10 });
  assert.deepEqual(recorded(file).at(-1), [
    "im", "+threads-messages-list", "--thread", "om_x100b414779f120cc", "--page-size", "10", "--order", "asc", "--no-reactions",
  ]);
  assert.equal(result.thread_id, "omt_resolved");
  assert.deepEqual(result.messages.map((m) => [m.message_id, m.text]), [["om_t1", "话题根消息"], ["om_t2", "话题里的回复"]]);
  assert.equal(result.messages[1].thread_id, "omt_resolved", "a caller can hop to the thread from any message");
});

test("im.messages takes a thread id directly", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message:readonly"], env: { FAKE_LARK_RECORD: file } });
  const result = await proxy.call("im.messages", { threadId: "omt_abc", order: "desc", includeReactions: true });
  const argv = recorded(file).at(-1);
  assert.equal(argv[3], "omt_abc");
  assert.equal(argv[argv.indexOf("--order") + 1], "desc");
  assert.ok(!argv.includes("--no-reactions"));
  assert.equal(result.thread_id, "omt_abc");
});

test("im.send replies to a message, optionally inside its thread", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  const out = await proxy.call("im.send", { replyTo: "om_x100", text: "收到", inThread: true });
  assert.deepEqual(recorded(file).at(-1), ["im", "+messages-reply", "--message-id", "om_x100", "--text", "收到", "--reply-in-thread"]);
  assert.equal(out.reply_to, "om_x100");
  assert.equal(out.in_thread, true);
});

test("im.send refuses a reply that also names a receiver", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(
    proxy.call("im.send", { replyTo: "om_x100", chatId: "oc_1", text: "收到" }),
    /a reply belongs to the message, not to a chat/
  );
  assert.deepEqual(recorded(file), [], "a refused call must have no side effect");
});

test("drive.search scopes to a wiki space and translates every filter", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  await proxy.call("drive.search", {
    query: "Feishu",
    spaceIds: ["7226178700923011075"],
    chatIds: "oc_a,oc_b",
    sharerIds: "ou_x",
    secureLabelIds: ["1", "2"],
    onlyComment: true,
    sort: "edit_time",
    createdSince: "2026-04-01",
    createdUntil: 1774972800,
    editedSince: 1774973100,
  });
  const argv = recorded(file).at(-1);
  assert.equal(argv[argv.indexOf("--space-ids") + 1], "7226178700923011075");
  assert.equal(argv[argv.indexOf("--chat-ids") + 1], "oc_a,oc_b");
  assert.equal(argv[argv.indexOf("--sharer-ids") + 1], "ou_x");
  assert.equal(argv[argv.indexOf("--secure-label-ids") + 1], "1,2");
  assert.ok(argv.includes("--only-comment"));
  assert.ok(!argv.includes("--folder-tokens"));
  assert.equal(argv[argv.indexOf("--created-since") + 1], String(Date.parse("2026-04-01T00:00:00+08:00") / 1000));
});

test("drive.search refuses asking for folders and a wiki space at once", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(
    proxy.call("drive.search", { query: "x", folderTokens: ["f"], spaceIds: ["s"] }),
    /folderTokens and spaceIds are exclusive/
  );
  assert.deepEqual(recorded(file), []);
});

test("drive.search turns 7d into seconds and floors edited windows to the hour", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  const before = Math.floor(Date.now() / 1000);
  await proxy.call("drive.search", { query: "x", editedSince: "7d" });
  const argv = recorded(file).at(-1);
  const since = Number(argv[argv.indexOf("--edited-since") + 1]);
  assert.equal(since % 3600, 0, "my_edit_time is hour-bucketed, so the number is on the hour");
  // Flooring to the hour can move the number by up to 3599s, so the assertion is
  // "seven days back, within one bucket", not "exactly 604800 seconds".
  assert.ok(Math.abs(before - 7 * 86400 - since) < 3700, "seven calendar days back, within one hour bucket");
});

test("drive.search rejects a time it cannot turn into a number", async () => {
  const proxy = makeProxy({ scopes: ["search:docs:read"] });
  await assert.rejects(proxy.call("drive.search", { query: "x", createdSince: "上周" }), /must be unix seconds/);
});

test("drive.search warns when an edit window finds nothing, and refuses a short number", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["search:docs:read"], env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(
    proxy.call("drive.search", { query: "x", editedSince: 31536000 }),
    /not a unix timestamp \(epoch seconds are 10 digits\)/
  );
  assert.deepEqual(recorded(file), [], "a refused bound must not start a process");
});

function mediaDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lark-media-"));
}

test("im.send sends an image by a cwd-relative path, never an absolute one", async () => {
  const dir = mediaDir();
  fs.writeFileSync(path.join(dir, "pic.png"), "png-bytes");
  const file = recordFile();
  const cwdFile = path.join(dir, "cwd.log");
  const proxy = makeProxy({
    scopes: ["im:message"],
    options: { allow: ["read", "write"] },
    env: { FAKE_LARK_RECORD: file, FAKE_LARK_CWD_RECORD: cwdFile },
  });

  const out = await proxy.call("im.send", { chatId: "oc_1", image: path.join(dir, "pic.png"), fileRoot: dir });
  // lark-cli refuses absolute paths, so the name is the basename and the process
  // runs inside the file's directory. Both halves are asserted.
  assert.deepEqual(recorded(file).at(-1), ["im", "+messages-send", "--chat-id", "oc_1", "--image", "pic.png"]);
  assert.equal(fs.readFileSync(cwdFile, "utf8").trim(), fs.realpathSync(dir));
  assert.equal(out.msg_type, "image");
});

test("im.send passes an uploaded key straight through, with no working directory", async () => {
  const file = recordFile();
  const cwdFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-cwd-")), "cwd.log");
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file, FAKE_LARK_CWD_RECORD: cwdFile } });
  await proxy.call("im.send", { chatId: "oc_1", file: "file_v3_abc" });
  assert.deepEqual(recorded(file).at(-1), ["im", "+messages-send", "--chat-id", "oc_1", "--file", "file_v3_abc"]);
  // No cwd was passed, so the child inherited the test process's own directory.
  assert.equal(fs.readFileSync(cwdFile, "utf8").trim(), process.cwd(), "a key needs no cwd of its own");
});

test("im.send takes one content kind and refuses the mixes before spawning", async () => {
  const dir = mediaDir();
  fs.writeFileSync(path.join(dir, "pic.png"), "png");
  fs.writeFileSync(path.join(dir, "voice.mp3"), "mp3");
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });

  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", text: "x", image: path.join(dir, "pic.png"), fileRoot: dir }), /one content kind/);
  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", image: "file_v3_abc", fileRoot: dir }), /takes img_… keys/);
  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", audio: path.join(dir, "voice.mp3"), fileRoot: dir }), /must be Opus/);
  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", video: path.join(dir, "pic.png"), fileRoot: dir }), /needs "videoCover"/);
  await assert.rejects(proxy.call("im.send", { chatId: "oc_1", image: path.join(dir, "pic.png"), videoCover: "img_x", fileRoot: dir }), /only makes sense together with "video"/);
  assert.deepEqual(recorded(file), [], "a readonly mix must not reach a process");
});

test("im.send sends a video with its cover, and refuses a cover in another directory", async () => {
  const dir = mediaDir();
  const other = mediaDir();
  fs.writeFileSync(path.join(dir, "v.mp4"), "mp4");
  fs.writeFileSync(path.join(dir, "cover.png"), "png");
  fs.writeFileSync(path.join(other, "cover.png"), "png");
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["im:message"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });

  const out = await proxy.call("im.send", { chatId: "oc_1", video: path.join(dir, "v.mp4"), videoCover: path.join(dir, "cover.png"), fileRoot: path.dirname(dir) });
  assert.deepEqual(recorded(file).at(-1), ["im", "+messages-send", "--chat-id", "oc_1", "--video", "v.mp4", "--video-cover", "cover.png"]);
  assert.equal(out.msg_type, "media");

  await assert.rejects(
    proxy.call("im.send", { chatId: "oc_1", video: path.join(dir, "v.mp4"), videoCover: path.join(other, "cover.png"), fileRoot: "/tmp" }),
    /must live in the same directory/
  );
});

test("contact.resolve turns a name into the ids the other actions want", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["contact:user:search"], env: { FAKE_LARK_RECORD: file } });
  const out = await proxy.call("contact.resolve", { query: "魏宁", pageSize: 5 });
  assert.deepEqual(recorded(file).at(-1), ["contact", "+search-user", "--query", "魏宁", "--page-size", "5"]);
  assert.equal(out.count, 2);
  // p2p_chat_id is the value im.send wants; keeping it is the point of resolving first.
  assert.equal(out.users[0].p2p_chat_id, "oc_8283fef6df8155cd7a85bdceabe93458");
  assert.equal(out.users[0].name, "魏宁");
  assert.equal(out.users[1].cross_tenant, true);
});

test("contact.resolve refuses an empty query before spawning", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["contact:user:search"], env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("contact.resolve", {}), /needs "query"/);
  assert.deepEqual(recorded(file), []);
});

test("calendar.agenda maps a window to the CLI and normalizes all-day ends", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["calendar:calendar:readonly"], env: { FAKE_LARK_RECORD: file } });
  const out = await proxy.call("calendar.agenda", { from: "2026-11-24", to: "2026-11-26" });
  const argv = recorded(file).at(-1);
  assert.equal(argv.slice(0, 2).join(" "), "calendar +agenda");
  assert.equal(argv[argv.indexOf("--start") + 1], "2026-11-24T00:00:00+08:00");
  assert.equal(argv[argv.indexOf("--end") + 1], "2026-11-26T00:00:00+08:00");
  assert.equal(out.count, 2);
  assert.equal(out.events[0].start, "2026-11-24T10:00:00+08:00");
  // Stored end dates are exclusive; the platform's own CLI answers 11-26 for a
// one-day 11-25 event, so reporting 11-25 keeps "last day" a single meaning.
  assert.equal(out.events[1].all_day, true);
  assert.equal(out.events[1].start, "2026-11-25");
  assert.equal(out.events[1].end, "2026-11-25");
});

test("calendar.agenda refuses a window that runs backwards", async () => {
  const proxy = makeProxy({ scopes: ["calendar:calendar:readonly"] });
  await assert.rejects(proxy.call("calendar.agenda", { from: "2026-11-26", to: "2026-11-24" }), /must be after/);
});

test("calendar.create maps an all-day event with invitees to the CLI", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["calendar:calendar"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  const out = await proxy.call("calendar.create", {
    summary: "培训",
    start: "2026-11-25",
    end: "2026-11-27",
    allDay: true,
    attendees: "ou_x,oc_y",
    description: "全天",
  });
  const argv = recorded(file).at(-1);
  assert.equal(argv[argv.indexOf("--start") + 1], "2026-11-25");
  assert.equal(argv[argv.indexOf("--end") + 1], "2026-11-27");
  assert.equal(argv[argv.indexOf("--attendee-ids") + 1], "ou_x,oc_y");
  assert.equal(out.event_id, "ev_cli_new");
  assert.equal(out.all_day, true);
});

test("calendar.create refuses nonsense before spawning", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["calendar:calendar"], options: { allow: ["read", "write"] }, env: { FAKE_LARK_RECORD: file } });
  await assert.rejects(proxy.call("calendar.create", { summary: "x", start: "2026-11-24T11:00:00+08:00", end: "2026-11-24T10:00:00+08:00" }), /"end" must be after "start"/);
  await assert.rejects(proxy.call("calendar.create", { summary: "x", start: "2026-11-25T10:00:00+08:00", end: "2026-11-25", allDay: true }), /allDay needs/);
  await assert.rejects(proxy.call("calendar.create", { summary: "x", start: "2026-11-25", end: "2026-11-26", attendees: "alice" }), /must be an open_id/);
  assert.deepEqual(recorded(file), [], "a refused create must not reach the calendar");
});

test("calendar.delete maps applyTo and notify=false, and reports what is gone", async () => {
  const file = recordFile();
  const proxy = makeProxy({ scopes: ["calendar:calendar"], options: { allow: ["read", "write", "high"] }, env: { FAKE_LARK_RECORD: file } });
  const out = await proxy.call("calendar.delete", { eventId: "ev_x", applyTo: "single", notify: false });
  assert.deepEqual(recorded(file).at(-1), ["calendar", "+delete", "--event-id", "ev_x", "--apply-to", "single", "--notify=false", "--yes"]);
  assert.equal(out.event_id, "ev_x");
  assert.equal(out.deleted, true);
});
