"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createProxy } from "../../../proxies/lark/index.js";
import { createMemoryTokenStore } from "../../../proxies/lark/token-store.js";
import { assertProxy } from "../../../proxies/contract.js";
import { createFakeOpenPlatform } from "../../../test/proxies/lark/fixtures/fake-open-platform.js";

async function setup({ tokens = { refreshToken: "rt_0" }, scopes, options = {}, credentials, platformOptions } = {}) {
  const platform = await createFakeOpenPlatform(platformOptions).start();
  const store = createMemoryTokenStore(tokens);
  const proxy = createProxy({
    instance: {
      id: "lark-oauth",
      type: "lark",
      scopes: scopes || ["docx:document:readonly", "drive:drive:readonly"],
      credentials: credentials || { clientId: "cli_test", clientSecret: "secret" },
      options: { impl: "oauth", baseUrl: platform.url, qps: 20, ...options },
    },
    deps: { tokenStore: store },
  });
  return { platform, store, proxy };
}

test("the oauth driver is a valid proxy", async () => {
  const { platform, proxy } = await setup();
  try {
    assertProxy(proxy);
    assert.equal(proxy.type, "lark");
  } finally {
    await platform.stop();
  }
});

test("whoami refreshes once and the rotated pair is persisted", async () => {
  const { platform, store, proxy } = await setup();
  try {
    assert.equal(await proxy.whoami(), "OAuth Wing");
    assert.equal(platform.state.tokenRequests, 1, "one refresh for the first call");
    const saved = store.snapshot();
    assert.equal(saved.accessToken, "at_1");
    assert.equal(saved.refreshToken, "rt_1", "the rotated refresh token must be saved, not dropped");
  } finally {
    await platform.stop();
  }
});

test("whoami is cached: a second call makes no network request", async () => {
  const { platform, proxy } = await setup();
  try {
    await proxy.whoami();
    await proxy.whoami();
    assert.equal(platform.state.tokenRequests, 1);
    assert.equal(platform.state.apiRequests.length, 1);
  } finally {
    await platform.stop();
  }
});

test("doc.read accepts a bare token or a document URL", async () => {
  const { platform, proxy } = await setup();
  try {
    const bare = await proxy.call("doc.read", { doc: "doxcnABC" });
    assert.equal(bare.content, "# doc doxcnABC");

    const fromUrl = await proxy.call("doc.read", { doc: "https://x.feishu.cn/docx/doxcnXYZ?from=share" });
    assert.equal(fromUrl.document_id, "doxcnXYZ");
    const paths = platform.state.apiRequests.map((entry) => entry.path);
    assert.ok(paths.some((path) => path.includes("/documents/doxcnABC/")));
    assert.ok(paths.some((path) => path.includes("/documents/doxcnXYZ/")));
  } finally {
    await platform.stop();
  }
});

test("drive.list clamps the page size into a query string", async () => {
  const { platform, proxy } = await setup();
  try {
    const result = await proxy.call("drive.list", { limit: 9999 });
    assert.deepEqual(result.files, [{ name: "a.md", type: "docx" }]);
    const drive = platform.state.apiRequests.find((entry) => entry.path === "/open-apis/drive/v1/files");
    assert.equal(drive.params.page_size, "200");
  } finally {
    await platform.stop();
  }
});

test("a 401 drops the access token, refreshes, and retries the same call", async () => {
  const { platform, proxy } = await setup();
  try {
    await proxy.call("drive.list", {});
    platform.expireNextAccess();

    const result = await proxy.call("drive.list", {});
    assert.deepEqual(result.files, [{ name: "a.md", type: "docx" }]);
    assert.equal(platform.state.tokenRequests, 2, "the retry must have refreshed");

    const lastTwo = platform.state.apiRequests.slice(-2);
    assert.equal(lastTwo[0].authorized, false, "first attempt used the dead token");
    assert.equal(lastTwo[1].authorized, true, "retry used the fresh one");
  } finally {
    await platform.stop();
  }
});

test("a dead refresh token is an auth failure that names invalid_grant", async () => {
  const { platform, proxy } = await setup({ platformOptions: { refreshToken: "rt_other" } });
  try {
    await assert.rejects(proxy.whoami(), (err) => {
      assert.equal(err.kind, "auth");
      assert.match(err.message, /invalid_grant/);
      return true;
    });
  } finally {
    await platform.stop();
  }
});

test("gates run before any request: raw api is closed, and deletes are high risk", async () => {
  const { platform, proxy } = await setup();
  try {
    await assert.rejects(proxy.call("api", { method: "GET", path: "/open-apis/x" }), /requires options.allowApi/);
    await assert.rejects(
      proxy.call("api", { method: "DELETE", path: "/open-apis/x" }),
      /requires options.allowApi/
    );
    assert.deepEqual(platform.state.apiRequests, [], "a refused call must not reach the platform");
  } finally {
    await platform.stop();
  }

  const opened = await setup({ options: { allowApi: true, allow: ["read", "write"] } });
  try {
    await assert.rejects(
      opened.proxy.call("api", { method: "DELETE", path: "/open-apis/x" }),
      /risk "high" is not allowed/
    );
  } finally {
    await opened.platform.stop();
  }
});

test("the raw escape hatch cannot be pointed outside the open platform", async () => {
  const { platform, proxy } = await setup({ options: { allowApi: true } });
  try {
    await assert.rejects(proxy.call("api", { method: "GET", path: "https://evil.example" }), /must start with "\/open-apis\/"/);
    assert.deepEqual(platform.state.apiRequests, []);
  } finally {
    await platform.stop();
  }
});

test("missing client credentials fail at construction, not on the first request", () => {
  assert.throws(
    () => createProxy({ instance: { id: "x", options: { impl: "oauth" }, credentials: {} } }),
    /needs credentials.clientId\/clientSecret/
  );
});

test("drive.read returns the text of a plain drive file", async () => {
  const { platform, proxy } = await setup();
  try {
    const result = await proxy.call("drive.read", { token: "fld_file_tok" });
    assert.equal(result.encoding, "text");
    assert.match(result.content, /^# fake fld_file_tok/);
    assert.equal(result.eof, true);
    assert.equal(platform.state.apiRequests.at(-1).path, "/open-apis/drive/v1/files/fld_file_tok/download");
  } finally {
    await platform.stop();
  }
});

test("drive.read hands a binary file back as base64, not mojibake", async () => {
  const { platform, proxy } = await setup();
  try {
    const result = await proxy.call("drive.read", { token: "bin_token" });
    assert.equal(result.encoding, "base64");
    assert.deepEqual([...Buffer.from(result.content, "base64")], [0, 1, 2, 255, 254]);
  } finally {
    await platform.stop();
  }
});

test("drive.read slices a text file by offset on the oauth route", async () => {
  const { platform, proxy } = await setup();
  try {
    const result = await proxy.call("drive.read", { token: "fld_file_tok", offset: 2, limit: 5 });
    assert.equal(result.offset, 2);
    assert.equal(result.next_offset, 7);
    assert.equal(result.content, "fake ");
    assert.equal(result.eof, false);
  } finally {
    await platform.stop();
  }
});

test("sheet.read turns the value matrix into csv on the oauth route too", async () => {
  const { platform, proxy } = await setup({ scopes: ["sheets:spreadsheet:readonly"] });
  try {
    const result = await proxy.call("sheet.read", { token: "sht_1", sheet: "Sheet1", range: "A1:B2" });
    assert.equal(result.csv, "a,b\n1,2");
    assert.equal(result.actual_range, "Sheet1!A1:B2");
    assert.match(platform.state.apiRequests.at(-1).path, /^\/open-apis\/sheets\/v2\/spreadsheets\/sht_1\/values\//);
  } finally {
    await platform.stop();
  }
});

test("sheet.write updates a range over HTTP", async () => {
  const { platform, proxy } = await setup({ scopes: ["sheets:spreadsheet"], options: { allow: ["read", "write"] } });
  try {
    const result = await proxy.call("sheet.write", { token: "sht_1", sheet: "Sheet1", range: "A2:B3", values: [["x", 1], ["y", 2]] });
    assert.equal(result.updated_range, "Sheet1!A2:B3");
    const call = platform.state.apiRequests.at(-1);
    assert.equal(call.method, "PUT");
    assert.equal(call.path, "/open-apis/sheets/v2/spreadsheets/sht_1/values");
  } finally {
    await platform.stop();
  }
});

test("doc.append sends one text block per line on the oauth route", async () => {
  const { platform, proxy } = await setup({ scopes: ["docx:document"], options: { allow: ["read", "write"] } });
  try {
    const result = await proxy.call("doc.append", { doc: "doxcnNEW", content: "第一行\n第二行" });
    assert.equal(result.appended_blocks, 2);
    const call = platform.state.apiRequests.at(-1);
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/open-apis/docx/v1/documents/doxcnNEW/blocks/doxcnNEW/children");
  } finally {
    await platform.stop();
  }
});

test("doc.write overwrite is still gated as high risk on the oauth route", async () => {
  const { platform, proxy } = await setup({ scopes: ["docx:document"], options: { allow: ["read", "write"] } });
  try {
    await assert.rejects(proxy.call("doc.write", { doc: "d1", mode: "overwrite", content: "# 全替换" }), /risk "high" is not allowed/);
    assert.equal(platform.state.apiRequests.length, 0, "a refused call must not reach the platform");
  } finally {
    await platform.stop();
  }
});

test("multi-range sheet.write is cli-only on the oauth route", async () => {
  const { platform, proxy } = await setup({ scopes: ["sheets:spreadsheet"], options: { allow: ["read", "write"] } });
  try {
    await assert.rejects(
      proxy.call("sheet.write", { token: "s", sheet: "Sheet1", writes: [{ range: "A1", values: [[1]] }] }),
      /only implemented on the cli route/
    );
  } finally {
    await platform.stop();
  }
});

test("im.send posts to the messages API with a JSON string content", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message"], options: { allow: ["read", "write"] } });
  try {
    const result = await proxy.call("im.send", { userId: "ou_wing", text: "早" });
    const req = platform.state.apiRequests.at(-1);
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/open-apis/im/v1/messages");
    assert.equal(req.params.receive_id_type, "open_id");

    // The request body is what the platform actually parses, so assert what the
    // fake server received rather than trusting its echo of the answer.
    const body = platform.state.messageBodies.at(-1);
    assert.equal(body.receive_id, "ou_wing");
    assert.equal(body.msg_type, "text");
    assert.equal(JSON.parse(body.content).text, "早");
    assert.ok(result.message_id);
  } finally {
    await platform.stop();
  }
});

test("doc.blocks reads the tree over HTTP too, with the same flattened shape", async () => {
  const { platform, proxy } = await setup({ scopes: ["docx:document:readonly"] });
  try {
    const result = await proxy.call("doc.blocks", { doc: "d1", pageSize: 20 });
    assert.equal(platform.state.apiRequests.at(-1).path, "/open-apis/docx/v1/documents/d1/blocks");
    assert.deepEqual(result.blocks.map((b) => [b.block_id, b.type, b.text]), [["b_page", "page", ""], ["b1", "text", "第一段"]]);
  } finally {
    await platform.stop();
  }
});

test("im read actions hit the same endpoints and normalize API items", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:chat:readonly", "im:message:readonly", "im:message"] });
  try {
    const chats = await proxy.call("im.chats", { types: "group,p2p" });
    assert.equal(platform.state.apiRequests.at(-1).path, "/open-apis/im/v1/chats");
    assert.deepEqual(chats.chats.map((c) => c.type), ["group", "p2p"]);

    const messages = await proxy.call("im.messages", { chatId: "oc_1" });
    const req = platform.state.apiRequests.at(-1);
    assert.equal(req.path, "/open-apis/im/v1/messages");
    assert.equal(req.params.container_id, "oc_1");
    assert.equal(messages.messages[0].text, "第一条");
    assert.equal(messages.messages[0].create_time, new Date(1763000000000).toISOString(), "epoch ms becomes ISO");

    const found = await proxy.call("im.search", { query: "找到了" });
    assert.equal(platform.state.apiRequests.at(-1).path, "/open-apis/im/v1/messages/search");
    assert.equal(found.messages[0].text, "找到了");
  } finally {
    await platform.stop();
  }
});

test("im.messages resolves a person to a p2p chat before reading", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message:readonly"] });
  try {
    const result = await proxy.call("im.messages", { userId: "ou_friend", pageSize: 5 });
    const paths = platform.state.apiRequests.map((r) => r.path);
    assert.deepEqual(paths, ["/open-apis/im/v1/chat_p2p/batch_query", "/open-apis/im/v1/messages"]);
    assert.equal(platform.state.apiRequests[1].params.container_id, "oc_p2p_ou_friend");
    assert.equal(result.messages[0].text, "第一条");
  } finally {
    await platform.stop();
  }
});

test("im.messages says a person has no p2p chat instead of returning an empty list", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message:readonly"] });
  try {
    await assert.rejects(proxy.call("im.messages", { userId: "ou_ghost" }), /found no p2p chat/);
    assert.deepEqual(platform.state.apiRequests.map((r) => r.path), ["/open-apis/im/v1/chat_p2p/batch_query"]);
  } finally {
    await platform.stop();
  }
});

test("drive.search resolves my open_id before using the owner filter", async () => {
  const { platform, proxy } = await setup({ scopes: ["search:docs:read"] });
  try {
    const result = await proxy.call("drive.search", { mine: true });
    const paths = platform.state.apiRequests.map((entry) => entry.path);
    assert.deepEqual(paths, ["/open-apis/authen/v1/user_info", "/open-apis/search/v2/doc_wiki/search"]);
    const body = platform.state.searchBodies[0];
    assert.deepEqual(body.doc_filter.creator_ids, ["ou_fake"]);
    assert.deepEqual(body.wiki_filter.creator_ids, ["ou_fake"], "the same filter scopes wiki, or wiki hits vanish");
    // The fake answers total:0 when doc_filter is missing, so a non-zero total
    // here is proof the body carried the filter the live endpoint insists on.
    assert.equal(result.total, 2);
    assert.equal(result.results[0].title, "HOWTO-agent-changes.md");
    assert.equal(result.results[1].entity, "wiki");
    assert.equal(result.results[1].title, "API Guide");
    assert.equal(result.results[1].snippet, "uses <API name> to introduce how to make requests");
    assert.equal(result.results[1].cross_tenant, true);
  } finally {
    await platform.stop();
  }
});

test("drive.search keeps wiki out of a folder-scoped search", async () => {
  const { platform, proxy } = await setup({ scopes: ["search:docs:read"] });
  try {
    await proxy.call("drive.search", { folderTokens: ["RtfrfakKtl4MMhdlleecvnvknrd"], query: "HOWTO" });
    const body = platform.state.searchBodies[0];
    assert.deepEqual(body.doc_filter.folder_tokens, ["RtfrfakKtl4MMhdlleecvnvknrd"]);
    assert.equal(body.wiki_filter, undefined, "folder tokens are doc-only, so wiki must not be claimed");
  } finally {
    await platform.stop();
  }
});

test("doc.write block edits go through the docs_ai command endpoint", async () => {
  const { platform, proxy } = await setup({ scopes: ["docx:document"], options: { allow: ["read", "write"] } });
  try {
    const replaced = await proxy.call("doc.write", { doc: "doxcnABC", mode: "block.replace", blockId: "b1", content: "## 新标题" });
    assert.equal(replaced.revision, 7, "the revision comes from document.revision_id");
    assert.equal(replaced.result, "success");
    assert.equal(platform.state.docWrites[0].body.command, "block_replace");
    assert.equal(platform.state.docWrites[0].body.block_id, "b1");
    assert.equal(platform.state.docWrites[0].body.content, "## 新标题");
    assert.equal(platform.state.docWrites[0].body.format, "markdown", "the CLI's --doc-format markdown maps to format");
    assert.equal(platform.state.docWrites[0].document, "doxcnABC");
  } finally {
    await platform.stop();
  }
});

test("doc.write block.delete sends one comma-separated field, and needs the high flag", async () => {
  const { platform, proxy } = await setup({ scopes: ["docx:document"], options: { allow: ["read", "write", "high"] } });
  try {
    const deleted = await proxy.call("doc.write", { doc: "doxcnABC", mode: "block.delete", blockIds: ["b2", "b3"] });
    assert.equal(platform.state.docWrites[0].body.command, "block_delete");
    assert.equal(platform.state.docWrites[0].body.block_id, "b2,b3", "multi-block delete is one comma-separated field");
    assert.equal(deleted.deleted_blocks, 2);
  } finally {
    await platform.stop();
  }
});

test("doc.write replace works on the oauth route now that the command API is known", async () => {
  const { platform, proxy } = await setup({ scopes: ["docx:document"], options: { allow: ["read", "write"] } });
  try {
    const out = await proxy.call("doc.write", { doc: "doxcnABC", mode: "replace", pattern: "旧", replacement: "" });
    const body = platform.state.docWrites[0].body;
    assert.equal(body.command, "str_replace");
    assert.equal(body.pattern, "旧");
    assert.equal(body.content, "", "an empty replacement is a delete, not a missing field");
    assert.equal(out.replaced_with, "");
  } finally {
    await platform.stop();
  }
});

test("im.messages reads a thread, resolving the message id first", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message:readonly"] });
  try {
    const result = await proxy.call("im.messages", { thread: "om_x100", pageSize: 5 });
    const paths = platform.state.apiRequests.map((entry) => entry.path);
    assert.deepEqual(paths, ["/open-apis/im/v1/messages/om_x100", "/open-apis/im/v1/messages"]);
    const params = platform.state.apiRequests[1].params;
    assert.equal(params.container_id, "omt_abc123");
    assert.equal(params.container_id_type, "thread");
    assert.equal(params.sort_type, "ByCreateTimeAsc");
    assert.equal(params.with_sender_name, "true");
    assert.equal(result.thread_id, "omt_abc123");
    assert.equal(result.messages[0].sender_name, "alice", "the platform names it sender.sender_name");
    assert.equal(result.messages[1].text, "话题里的回复");
    assert.equal(result.messages[1].parent_id, "om_root", "a reply keeps the message it answers");
    assert.equal(result.chat_id, "oc_topic", "a thread answers no chat, so it comes from the first message");
    assert.equal(result.chat_name, "数字开发工作组");
  } finally {
    await platform.stop();
  }
});

test("im.messages takes an omt_ thread id without a lookup", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message:readonly"] });
  try {
    await proxy.call("im.messages", { threadId: "omt_abc123", order: "desc" });
    assert.deepEqual(platform.state.apiRequests.map((entry) => entry.path), ["/open-apis/im/v1/messages"]);
    assert.equal(platform.state.apiRequests[0].params.sort_type, "ByCreateTimeDesc");
  } finally {
    await platform.stop();
  }
});

test("im.messages says a message has no thread instead of returning no replies", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message:readonly"] });
  try {
    await assert.rejects(proxy.call("im.messages", { thread: "om_missing" }), /has no thread/);
    assert.deepEqual(platform.state.apiRequests.map((entry) => entry.path), ["/open-apis/im/v1/messages/om_missing"]);
  } finally {
    await platform.stop();
  }
});

test("im.send replies through the reply endpoint, with reply_in_thread", async () => {
  const { platform, proxy } = await setup({ scopes: ["im:message"], options: { allow: ["read", "write"] } });
  try {
    const out = await proxy.call("im.send", { replyTo: "om_x100", markdown: "**收到**", inThread: true });
    assert.deepEqual(platform.state.apiRequests.map((entry) => entry.path), ["/open-apis/im/v1/messages/om_x100/reply"]);
    const body = platform.state.replies[0].body;
    assert.equal(body.msg_type, "post");
    assert.equal(body.reply_in_thread, true);
    assert.equal(body.content, JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "**收到**" }]] } }));
    assert.equal(out.reply_to, "om_x100");
    assert.equal(out.in_thread, true);
    assert.equal(out.message_id, "om_reply_1");
  } finally {
    await platform.stop();
  }
});

test("drive.search in a wiki space sends only wiki_filter", async () => {
  const { platform, proxy } = await setup({ scopes: ["search:docs:read"] });
  try {
    const result = await proxy.call("drive.search", { query: "Feishu", spaceIds: ["7226178700923011075"], sort: "edit_time" });
    const body = platform.state.searchBodies[0];
    assert.equal(body.doc_filter, undefined, "an empty doc_filter would make the platform answer 0");
    assert.deepEqual(body.wiki_filter.space_ids, ["7226178700923011075"]);
    assert.equal(body.wiki_filter.sort_type, "EDIT_TIME");
    assert.equal(result.total, 2);
  } finally {
    await platform.stop();
  }
});

test("drive.search createdByMe resolves the open_id into original_creator_ids", async () => {
  const { platform, proxy } = await setup({ scopes: ["search:docs:read"] });
  try {
    await proxy.call("drive.search", { createdByMe: true });
    assert.deepEqual(platform.state.apiRequests.map((entry) => entry.path), ["/open-apis/authen/v1/user_info", "/open-apis/search/v2/doc_wiki/search"]);
    const body = platform.state.searchBodies[0];
    assert.deepEqual(body.doc_filter.original_creator_ids, ["ou_fake"]);
    assert.equal(body.doc_filter.creator_ids, undefined, "owner and original creator are different questions");
  } finally {
    await platform.stop();
  }
});

test("drive.search sends time windows as seconds in the platform's own keys", async () => {
  const { platform, proxy } = await setup({ scopes: ["search:docs:read"] });
  try {
    await proxy.call("drive.search", { query: "x", createdSince: "2026-04-01", editedSince: 1774973100, openedSince: 1774900000 });
    const body = platform.state.searchBodies[0];
    assert.equal(body.doc_filter.create_time.start, Math.floor(Date.parse("2026-04-01T00:00:00+08:00") / 1000));
    assert.equal(body.doc_filter.my_edit_time.start % 3600, 0);
    assert.equal(body.doc_filter.open_time.start, 1774900000);
    assert.equal(body.wiki_filter.create_time.start, body.doc_filter.create_time.start, "wiki gets the same window or it returns recent-unbounded");
  } finally {
    await platform.stop();
  }
});

function mediaDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-oauth-media-"));
  fs.writeFileSync(path.join(dir, "pic.png"), "png-bytes");
  fs.writeFileSync(path.join(dir, "voice.opus"), "opus-bytes");
  fs.writeFileSync(path.join(dir, "v.mp4"), "mp4-bytes");
  fs.writeFileSync(path.join(dir, "note.txt"), "note-bytes");
  return dir;
}

test("im.send uploads an image first, then sends the key", async () => {
  const dir = mediaDir();
  const { platform, proxy } = await setup({ scopes: ["im:message"], options: { allow: ["read", "write"] } });
  try {
    const out = await proxy.call("im.send", { chatId: "oc_1", image: path.join(dir, "pic.png"), fileRoot: dir });
    assert.deepEqual(platform.state.apiRequests.map((r) => r.path), ["/open-apis/im/v1/images", "/open-apis/im/v1/messages"]);
    const uploaded = platform.state.uploads[0];
    assert.equal(uploaded.fileType, "", "images do not take a file_type");
    assert.equal(uploaded.multipart, true, "the upload endpoint needs a real multipart body");
    // Learned the hard way on the live endpoint: "file" here is 234001 Invalid request param.
    assert.equal(uploaded.field, "image");
    const body = platform.state.messageBodies.at(-1);
    assert.equal(body.msg_type, "image");
    assert.deepEqual(JSON.parse(body.content), { image_key: "img_fake_1" });
    assert.equal(out.msg_type, "image");
  } finally {
    await platform.stop();
  }
});

test("im.send uploads voice as opus and video as mp4 plus a cover image", async () => {
  const dir = mediaDir();
  const { platform, proxy } = await setup({ scopes: ["im:message"], options: { allow: ["read", "write"] } });
  try {
    await proxy.call("im.send", { chatId: "oc_1", audio: path.join(dir, "voice.opus"), fileRoot: dir });
    assert.equal(platform.state.uploads[0].fileType, "opus");
    assert.deepEqual(JSON.parse(platform.state.messageBodies.at(-1).content), { file_key: "file_fake_1" });

    await proxy.call("im.send", { chatId: "oc_1", video: path.join(dir, "v.mp4"), videoCover: path.join(dir, "pic.png"), fileRoot: dir });
    assert.deepEqual(
      platform.state.uploads.slice(1).map((u) => u.fileType),
      ["mp4", ""],
      "the video goes through /files as mp4, the cover through /images"
    );
    const media = platform.state.messageBodies.at(-1);
    assert.equal(media.msg_type, "media");
    assert.deepEqual(JSON.parse(media.content), { file_key: "file_fake_2", image_key: "img_fake_3" });
  } finally {
    await platform.stop();
  }
});

test("im.send sends a file attachment and a reply with an image on the same code path", async () => {
  const dir = mediaDir();
  const { platform, proxy } = await setup({ scopes: ["im:message"], options: { allow: ["read", "write"] } });
  try {
    await proxy.call("im.send", { chatId: "oc_1", file: path.join(dir, "note.txt"), fileRoot: dir });
    assert.equal(platform.state.uploads[0].fileType, "stream");
    assert.equal(platform.state.uploads[0].fileName, "note.txt");
    assert.deepEqual(JSON.parse(platform.state.messageBodies.at(-1).content), { file_key: "file_fake_1" });

    const reply = await proxy.call("im.send", { replyTo: "om_x1", image: path.join(dir, "pic.png"), fileRoot: dir });
    assert.equal(reply.reply_to, "om_x1");
    assert.equal(reply.msg_type, "image");
    assert.deepEqual(platform.state.replies.at(-1).body.msg_type, "image");
  } finally {
    await platform.stop();
  }
});

test("contact.resolve searches users over HTTP and reads the platform's item shape", async () => {
  const { platform, proxy } = await setup({ scopes: ["contact:user:search"] });
  try {
    const out = await proxy.call("contact.resolve", { query: "wing", pageSize: 3 });
    assert.equal(platform.state.apiRequests.at(-1).path, "/open-apis/contact/v3/users/search");
    assert.deepEqual(platform.state.contactQueries[0], { query: "wing" });
    assert.equal(platform.state.apiRequests.at(-1).params.page_size, "3");
    // items[] with meta_data, not the CLI's users[]: the name comes from i18n_names.
    assert.equal(out.users[0].name, "魏宁");
    assert.equal(out.users[0].p2p_chat_id, "oc_8283fef6df8155cd7a85bdceabe93458");
    assert.equal(out.users[1].cross_tenant, true);
    assert.equal(out.count, 2);
  } finally {
    await platform.stop();
  }
});

test("calendar.agenda reads instance_view and reports times in the event's own zone", async () => {
  const { platform, proxy } = await setup({ scopes: ["calendar:calendar:readonly"] });
  try {
    platform.state.events.push({
      event_id: "ev_1",
      summary: "周会",
      start_time: { timestamp: "1795485600", timezone: "Asia/Shanghai" },
      end_time: { timestamp: "1795489200", timezone: "Asia/Shanghai" },
      status: "confirmed",
      self_rsvp_status: "accept",
    });
    platform.state.events.push({
      event_id: "ev_2",
      summary: "全天",
      start_time: { date: "2026-11-25", timezone: "UTC" },
      end_time: { date: "2026-11-26", timezone: "UTC" },
    });
    const out = await proxy.call("calendar.agenda", {
      from: Math.floor(Date.parse("2026-11-24T00:00:00+08:00") / 1000),
      to: Math.floor(Date.parse("2026-11-26T00:00:00+08:00") / 1000),
    });
    const req = platform.state.apiRequests.at(-1);
    assert.equal(req.path, "/open-apis/calendar/v4/calendars/primary/events/instance_view");
    assert.equal(out.count, 2);
    assert.equal(out.events[0].start, "2026-11-24T10:00:00+08:00", "rendered in +08:00, not UTC");
    assert.equal(out.events[0].end, "2026-11-24T11:00:00+08:00");
    assert.equal(out.events[1].all_day, true);
    assert.equal(out.events[1].end, "2026-11-25", "stored exclusive end is reported as the inclusive last day");
  } finally {
    await platform.stop();
  }
});

test("calendar.create posts the event then the invitees, and shapes the same answer as the cli", async () => {
  const { platform, proxy } = await setup({ scopes: ["calendar:calendar"], options: { allow: ["read", "write"] } });
  try {
    const out = await proxy.call("calendar.create", {
      summary: "对齐会",
      start: "2026-11-24T10:00:00+08:00",
      end: "2026-11-24T10:30:00+08:00",
      description: "半小时",
      attendees: "ou_fake,oc_chat",
    });
    assert.deepEqual(platform.state.apiRequests.map((r) => `${r.method} ${r.path}`), [
      "POST /open-apis/calendar/v4/calendars/primary/events",
      "POST /open-apis/calendar/v4/calendars/primary/events/ev_fake_1/attendees",
    ]);
    assert.deepEqual(platform.state.events[0].start_time, { timestamp: "1795485600", timezone: "Asia/Shanghai" });
    const attendeeBody = platform.state.attendeeAttempts[0].body;
    assert.deepEqual(attendeeBody.attendees, [
      { type: "user", user_id: "ou_fake" },
      { type: "chat", chat_id: "oc_chat" },
    ]);
    assert.equal(out.event_id, "ev_fake_1");
    assert.equal(out.start, "2026-11-24T10:00:00+08:00");
    assert.equal(out.all_day, false);
    assert.equal(out.attendees.length, 2);
  } finally {
    await platform.stop();
  }
});

test("calendar.create deletes the event again when the invitees cannot be added", async () => {
  const { platform, proxy } = await setup({
    scopes: ["calendar:calendar"],
    options: { allow: ["read", "write"] },
    platformOptions: { failAttendees: true },
  });
  try {
    await assert.rejects(
      proxy.call("calendar.create", { summary: "会", start: "2026-11-24T10:00:00+08:00", end: "2026-11-24T10:30:00+08:00", attendees: "ou_fake" }),
      /was deleted again/
    );
    assert.equal(platform.state.events.length, 0, "no half-created event is left behind");
    assert.equal(platform.state.deletes.at(-1).eventId, "ev_fake_1");
  } finally {
    await platform.stop();
  }
});

test("calendar.create sends an all-day event as dates, and calendar.delete as a DELETE with apply_to", async () => {
  const { platform, proxy } = await setup({ scopes: ["calendar:calendar"], options: { allow: ["read", "write", "high"] } });
  try {
    const allDay = await proxy.call("calendar.create", { summary: "培训", start: "2026-11-25", end: "2026-11-27", allDay: true });
    assert.deepEqual(platform.state.events[0].start_time, { date: "2026-11-25" });
    assert.equal(allDay.all_day, true);

    const deleted = await proxy.call("calendar.delete", { eventId: "ev_fake_1", applyTo: "single", notify: false });
    const req = platform.state.apiRequests.at(-1);
    assert.equal(req.method, "DELETE");
    assert.equal(req.path, "/open-apis/calendar/v4/calendars/primary/events/ev_fake_1");
    assert.equal(req.params.need_notification, "false");
    assert.equal(req.params.apply_to, "single");
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.notify, false);
  } finally {
    await platform.stop();
  }
});
