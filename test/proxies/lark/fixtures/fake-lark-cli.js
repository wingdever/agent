// Stand-in for lark-cli used by proxies/lark tests.
//
// Reproduces the CLI's real conventions: JSON on stdout, exit code 0 even for API
// failures, --dry-run printing the request instead of sending it. Fault modes are
// switched by FAKE_LARK_MODE; FAKE_LARK_RECORD appends every argv to a file so a
// test can assert the mapped command line.

import fs from "fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_LARK_MODE || "";
const record = process.env.FAKE_LARK_RECORD || "";

if (record) fs.appendFileSync(record, JSON.stringify(argv) + "\n");
// lark-cli only accepts cwd-relative attachment paths, so a test has to be able
// to prove where the process ran, not just what it was told.
const cwdRecord = process.env.FAKE_LARK_CWD_RECORD || "";
if (cwdRecord) fs.appendFileSync(cwdRecord, process.cwd() + "\n");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

if (mode === "auth") {
  emit({ ok: false, identity: "user", error: { type: "api", subtype: "token_expired", code: 99991668, message: "token expired" } });
  process.exit(0);
}
if (mode === "identity-tenant") {
  emit({ ok: true, identity: "tenant", data: { name: "Bot" } });
  process.exit(0);
}
if (mode === "garbage") {
  process.stdout.write("boom: not json");
  process.exit(0);
}
if (mode === "api-error") {
  // Real CLI behaviour when the API rejects the call: structured error on stdout
  // *and* a non-zero exit status.
  emit({
    ok: false,
    identity: "user",
    error: { type: "api", subtype: "unknown", code: 3380002, message: "Unsupported document type 'file'. Only docx is supported." },
  });
  process.exit(1);
}
if (mode === "exit1") {
  process.stderr.write("fatal: no profile configured\n");
  process.exit(1);
}

const dryRun = argv.includes("--dry-run");
const method = argv[1];
const path = argv[2];

if (dryRun) {
  emit({ ok: true, identity: "user", dry_run: true, data: { api: [{ method, url: path }] } });
  process.exit(0);
}

if (argv[0] === "api" && path === "/open-apis/authen/v1/user_info") {
  emit({ ok: true, identity: "user", data: { name: "Fake Wing", en_name: "fake-wing", open_id: "ou_fake" } });
  process.exit(0);
}
if (argv[0] === "api" && String(path).includes("/blocks")) {
  emit({
    ok: true,
    identity: "user",
    data: {
      items: [
        { block_id: "b_page", block_type: 1, parent_id: "", children: ["b1"] },
        { block_id: "b1", block_type: 2, parent_id: "b_page", text: { elements: [{ text_run: { content: "第一段" } }] } },
        { block_id: "b2", block_type: 4, parent_id: "b_page", heading2: { elements: [{ text_run: { content: "小节" } }] } },
      ],
      has_more: false,
    },
  });
  process.exit(0);
}
if (argv[0] === "api" && path === "/open-apis/drive/v1/files") {
  emit({ ok: true, identity: "user", data: { files: [{ name: "a.md", type: "docx" }], has_more: false } });
  process.exit(0);
}
if (argv[0] === "sheets" && argv[1] === "+cells-set") {
  const writes = argv[argv.indexOf("--writes") + 1];
  if (argv.includes("--writes")) {
    emit({ ok: true, identity: "user", data: { updated_ranges: JSON.parse(writes).map((w) => w.range), updated_cells: 8 } });
    process.exit(0);
  }
  emit({ ok: true, identity: "user", data: { updated_range: argv[argv.indexOf("--range") + 1], updated_cells: 4 } });
  process.exit(0);
}
if (argv[0] === "im" && argv[1] === "+chat-list") {
  emit({ ok: true, identity: "user", data: { chats: [
    { chat_id: "oc_1", name: "测试群", chat_mode: "group", description: "desc", external: false },
    { chat_id: "oc_2", name: "私聊", chat_mode: "p2p", p2p_target_id: "ou_peer" },
  ], has_more: false } });
  process.exit(0);
}
if (argv[0] === "im" && argv[1] === "+chat-messages-list") {
  emit({ ok: true, identity: "user", data: {
    chat_id: argv[argv.indexOf("--chat-id") + 1] || "",
    chat_name: "测试群",
    messages: [
      { message_id: "om_1", chat_id: "oc_1", chat_type: "group", create_time: "2026-11-23 10:46", msg_type: "text",
        content: "第一条", sender: { id: "ou_a", name: "alice", sender_type: "user" } },
      { message_id: "om_2", chat_id: "oc_1", chat_type: "group", create_time: "2026-11-23 10:47", msg_type: "text",
        content: "第二条", sender: { id: "ou_b", name: "bob", sender_type: "user" } },
    ], has_more: false, page_token: "" } });
  process.exit(0);
}
if (argv[0] === "im" && argv[1] === "+threads-messages-list") {
  const thread = argv[argv.indexOf("--thread") + 1];
  emit({ ok: true, identity: "user", data: {
    thread_id: thread.startsWith("omt_") ? thread : "omt_resolved",
    has_more: false,
    messages: [
      { message_id: "om_t1", thread_id: thread.startsWith("omt_") ? thread : "omt_resolved", chat_id: "oc_topic", chat_type: "topic",
        create_time: "2026-11-23 11:20", msg_type: "text", content: "话题根消息",
        sender: { id: "ou_a", name: "alice", sender_type: "user" } },
      { message_id: "om_t2", thread_id: thread.startsWith("omt_") ? thread : "omt_resolved", chat_id: "oc_topic", chat_type: "topic",
        create_time: "2026-11-23 11:21", msg_type: "text", content: "话题里的回复",
        sender: { id: "ou_b", name: "bob", sender_type: "user" } },
    ],
  } });
  process.exit(0);
}
if (argv[0] === "im" && argv[1] === "+messages-search") {
  emit({ ok: true, identity: "user", data: { messages: [
    { message_id: "om_3", chat_id: "oc_1", chat_type: "group", create_time: "2026-11-23 10:48", msg_type: "text",
      content: "找到了", sender: { id: "ou_a", name: "alice", sender_type: "user" } },
  ], has_more: false, total: 1 } });
  process.exit(0);
}
if (argv[0] === "im" && argv[1] === "+messages-reply") {
  const id = argv[argv.indexOf("--message-id") + 1];
  emit({ ok: true, identity: "user", data: { message_id: "om_reply_fake", chat_id: "oc_1", reply_to: id, in_thread: argv.includes("--reply-in-thread") } });
  process.exit(0);
}
if (argv[0] === "im" && argv[1] === "+messages-send") {
  const chat = argv[argv.indexOf("--chat-id") + 1];
  const user = argv[argv.indexOf("--user-id") + 1];
  const media = ["--image", "--file", "--audio", "--video"].filter((flag) => argv.includes(flag));
  emit({ ok: true, identity: "user", data: { message_id: "om_fake", chat_id: chat || `p2p_${user}`, media: media[0] || "" } });
  process.exit(0);
}
if (argv[0] === "contact" && argv[1] === "+search-user") {
  const query = argv[argv.indexOf("--query") + 1] || "";
  // Real CLI shape: users[] with localized_name and p2p_chat_id, plus has_more.
  emit({ ok: true, identity: "user", data: {
    users: query === "nobody" ? [] : [{
      open_id: "ou_fake_1",
      localized_name: "魏宁",
      email: "",
      enterprise_email: "",
      is_activated: true,
      is_cross_tenant: false,
      p2p_chat_id: "oc_8283fef6df8155cd7a85bdceabe93458",
      has_chatted: true,
      department: "",
      match_segments: [query],
    }, {
      open_id: "ou_fake_2",
      localized_name: "魏宁（外包）",
      is_cross_tenant: true,
      p2p_chat_id: "",
      has_chatted: false,
    }],
    has_more: false,
  }, meta: { count: 2 } });
  process.exit(0);
}
if (argv[0] === "calendar" && argv[1] === "+agenda") {
  // Real CLI renders times as datetime strings, not raw timestamps.
  emit({ ok: true, identity: "user", data: [
    { event_id: "ev_cli_1", summary: "周会", start_time: { datetime: "2026-11-24T10:00:00+08:00", timezone: "Asia/Shanghai" },
      end_time: { datetime: "2026-11-24T11:00:00+08:00", timezone: "Asia/Shanghai" }, status: "confirmed",
      self_rsvp_status: "accept", event_organizer: { display_name: "wing", user_id: "ou_fake_1" } },
    { event_id: "ev_cli_2", summary: "全天培训", start_time: { date: "2026-11-25", timezone: "UTC" },
      end_time: { date: "2026-11-26", timezone: "UTC" }, status: "confirmed" },
  ], meta: { count: 2 } });
  process.exit(0);
}
if (argv[0] === "calendar" && argv[1] === "+create") {
  emit({ ok: true, identity: "user", data: {
    event_id: "ev_cli_new",
    summary: argv[argv.indexOf("--summary") + 1] || "",
    start: argv[argv.indexOf("--start") + 1] || "",
    end: argv[argv.indexOf("--end") + 1] || "",
    time_range_text: "probe",
  } });
  process.exit(0);
}
if (argv[0] === "calendar" && argv[1] === "+delete") {
  emit({ ok: true, identity: "user", data: {
    apply_to: argv[argv.indexOf("--apply-to") + 1] || "single",
    calendar_id: "primary",
    deleted_event: { action: "deleted", event_id: argv[argv.indexOf("--event-id") + 1] || "" },
  } });
  process.exit(0);
}
if (argv[0] === "drive" && argv[1] === "+search") {
  // Real CLI shape: results[] with highlight-marked titles and *_iso timestamps.
  const docTypes = argv.includes("--doc-types") ? argv[argv.indexOf("--doc-types") + 1] : "";
  const result = {
    ok: true,
    identity: "user",
    data: {
      results: [
        { entity_type: "DOC", result_meta: { create_time: 1795366356, create_time_iso: "2026-11-23T00:52:36+08:00",
          doc_types: docTypes || "FILE", file_type: "md", token: "RkMMbyK5ioniIQxCpMvclifmnvW",
          url: "https://my.feishu.cn/file/RkMMbyK5ioniIQxCpMvclifmnvW", owner_id: "ou_me", owner_name: "wing(wing)",
          update_time: 1795366382, update_time_iso: "2026-11-23T00:53:02+08:00", is_cross_tenant: false },
          summary_highlighted: "", title_highlighted: "<h>HOWTO</h>-agent-changes.md" },
      ],
      has_more: false,
      page_token: "tok_next",
      total: 1,
    },
  };
  const query = argv.includes("--query") ? argv[argv.indexOf("--query") + 1] : "";
  if (Array.from(query).length > 30) result.data.notice = "The query is too long and has been truncated to the first 30 characters for search.";
  emit(result);
  process.exit(0);
}
if (argv[0] === "drive" && argv[1] === "+download") {
  // Download writes bytes to disk; the proxy slices the file afterwards.
  const token = argv[argv.indexOf("--file-token") + 1];
  const out = argv[argv.indexOf("--output") + 1];
  const bytes = token.startsWith("bin") ? Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]) : Buffer.from(`# fake snapshot of ${token}\nsecond line\n`);
  fs.writeFileSync(out, bytes);
  emit({ ok: true, identity: "user", data: { file_token: token, saved_path: out, size_bytes: bytes.length } });
  process.exit(0);
}
if (argv[0] === "drive" && argv[1] === "+upload") {
  const local = argv[argv.indexOf("--file") + 1];
  emit({ ok: true, identity: "user", data: { file_token: "file_up", name: argv[argv.indexOf("--name") + 1] || local.split("/").pop(), parent_token: argv[argv.indexOf("--folder-token") + 1] || "" } });
  process.exit(0);
}
if (argv[0] === "drive" && argv[1] === "+export") {
  const dir = argv[argv.indexOf("--output-dir") + 1];
  const ext = argv[argv.indexOf("--file-extension") + 1];
  emit({ ok: true, identity: "user", data: { saved_path: `${dir}/d1.${ext}`, size_bytes: 1234, file_name: `d1.${ext}`, file_token: "file_export" } });
  process.exit(0);
}
if (argv[0] === "drive" && argv[1] === "+delete") {
  const token = argv[argv.indexOf("--file-token") + 1];
  const type = argv[argv.indexOf("--type") + 1];
  emit({ ok: true, identity: "user", data: { deleted: true, file_token: token, type, ready: true, status: "success", task_id: `schedule|${token}` } });
  process.exit(0);
}
if (argv[0] === "docs" && argv[1] === "+create") {
  emit({ ok: true, identity: "user", data: { document_id: "doxcnNEW", title: argv[argv.indexOf("--title") + 1] } });
  process.exit(0);
}
if (argv[0] === "docs" && argv[1] === "+update") {
  emit({ ok: true, identity: "user", data: { document_id: argv[argv.indexOf("--doc") + 1], revision: 2, updated: true } });
  process.exit(0);
}
if (argv[0] === "sheets" && argv[1] === "+csv-get") {
  const sheet = argv[argv.indexOf("--sheet-id") + 1] || argv[argv.indexOf("--sheet-name") + 1];
  emit({ ok: true, identity: "user", data: { csv: "a,b\n1,2", actual_range: `${sheet}!A1:B2` } });
  process.exit(0);
}
if (argv[0] === "sheets" && argv[1] === "+workbook-info") {
  // The real CLI names the field sheet_name, not title: keep the fixture honest.
  emit({ ok: true, identity: "user", data: { sheets: [{ sheet_id: "s1", sheet_name: "Sheet1", row_count: 100, column_count: 20 }] } });
  process.exit(0);
}
if (argv[0] === "drive" && argv[1] === "+fetch") {
  const token = argv[argv.indexOf("--token") + 1];
  emit({ ok: true, identity: "user", data: { content: `# fake snapshot of ${token}`, file_token: token } });
  process.exit(0);
}
if (argv[0] === "docs" && argv[1] === "+fetch") {
  emit({ ok: true, identity: "user", data: { content: "# fake doc", doc_token: argv[argv.indexOf("--doc") + 1] } });
  process.exit(0);
}
if (argv[0] === "api") {
  emit({ ok: true, identity: "user", data: { method: method || "GET", path: path || "" } });
  process.exit(0);
}

emit({ ok: false, identity: "user", error: { type: "api", subtype: "not_found", code: 404, message: "no route" } });
process.exit(0);
