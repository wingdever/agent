"use strict";

// Stand-in for the feishu open platform on the OAuth route.
//
// Mirrors what the real endpoints do, including the two shapes that matter:
//   - token endpoint: 200 + {access_token, refresh_token, expires_in} on success,
//     400 + {"error":"invalid_grant","code":20026} on a dead refresh token;
//   - API endpoints: 401 + {code:99991668} when the access token is no longer valid.
// Refresh tokens rotate on every successful grant, like the real platform.

import http from "http";

function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function readRaw(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createFakeOpenPlatform({
  clientId = "cli_test",
  clientSecret = "secret",
  refreshToken = "rt_0",
  userName = "OAuth Wing",
  failAttendees = false,
} = {}) {
  const state = {
    tokenRequests: 0,
    apiRequests: [],
    currentRefresh: refreshToken,
    validAccess: new Set(),
    expireNext: false,
    seq: 0,
    searchBodies: [],
    docWrites: [],
    replies: [],
    uploads: [],
    messageBodies: [],
    contactQueries: [],
    events: [],
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/open-apis/authen/v2/oauth/token") {
      const body = await readJson(request);
      state.tokenRequests++;
      if (body.client_id !== clientId || body.client_secret !== clientSecret) {
        send(response, 400, { error: "invalid_client", error_description: "client credentials are wrong", code: 20009 });
        return;
      }
      if (body.grant_type !== "refresh_token" || body.refresh_token !== state.currentRefresh) {
        send(response, 400, { error: "invalid_grant", error_description: "The refresh token provided is invalid.", code: 20026 });
        return;
      }
      state.seq++;
      const accessToken = `at_${state.seq}`;
      const nextRefresh = `rt_${state.seq}`;
      state.currentRefresh = nextRefresh;
      state.validAccess.add(accessToken);
      send(response, 200, {
        access_token: accessToken,
        refresh_token: nextRefresh,
        expires_in: 7200,
        token_type: "Bearer",
        scope: "docx:document:readonly drive:drive:readonly",
      });
      return;
    }

    // Every API route below requires a live bearer token.
    if (state.expireNext) {
      state.expireNext = false;
      state.validAccess.clear();
    }
    const bearer = String(request.headers.authorization || "").replace(/^Bearer /, "");
    const authorized = state.validAccess.has(bearer);
    state.apiRequests.push({ method: request.method, path: url.pathname, params: Object.fromEntries(url.searchParams), authorized });

    if (!authorized) {
      send(response, 401, { code: 99991668, msg: "invalid access token" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/open-apis/authen/v1/user_info") {
      send(response, 200, { code: 0, data: { name: userName, en_name: "oauth-wing", open_id: "ou_fake" } });
      return;
    }
    const downloadMatch = url.pathname.match(/^\/open-apis\/drive\/v1\/files\/([^/]+)\/download$/);
    if (request.method === "GET" && downloadMatch) {
      const token = decodeURIComponent(downloadMatch[1]);
      // "bin_token" stands in for a real binary file (xlsx, pdf): the oauth route
      // must refuse it rather than guess.
      if (token === "bin_token") {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
      } else {
        response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        response.end(`# fake ${token}\n\nbody text`);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/open-apis/search/v2/doc_wiki/search") {
      const body = await readJson(request);
      state.searchBodies.push(body);
      // The live endpoint answers total:0 and no error when neither filter is present.
      // wiki-only searches are legitimately filterless on the doc side.
      // Reproducing that here is the point: a test can then prove our body always
      // carries the filter instead of trusting that it does.
      if (!body.doc_filter && !body.wiki_filter) {
        send(response, 200, { code: 0, data: { total: 0, has_more: false, res_units: [] } });
        return;
      }
      const docSide = body.doc_filter || {};
      if (docSide.creator_ids && docSide.creator_ids.includes("ou_nobody")) {
        send(response, 200, { code: 0, data: { total: 0, has_more: false, res_units: [] } });
        return;
      }
      const typesSide = body.doc_filter || body.wiki_filter || {};
      const docTypes = typesSide.doc_types ? typesSide.doc_types[0] : "FILE";
      const pageSize = body.page_size || 15;
      send(response, 200, { code: 0, data: {
        total: 2,
        has_more: true,
        page_token: "tok_2",
        res_units: [
          { entity_type: "DOC", result_meta: { create_time: 1795366356, doc_types: docTypes, file_type: "md",
            token: "RkMMbyK5ioniIQxCpMvclifmnvW", url: "https://my.feishu.cn/file/RkMMbyK5ioniIQxCpMvclifmnvW",
            owner_id: "ou_fake", owner_name: "OAuth Wing", update_time: 1795366382, is_cross_tenant: false },
            summary_highlighted: "", title_highlighted: "<h>HOWTO</h>-agent-changes.md" },
          { entity_type: "WIKI", result_meta: { create_time: 1682475838, doc_types: "DOCX", token: "KitmwriSZiqvIrkL2gZceLg9nHd",
            url: "https://waytoagi.feishu.cn/wiki/KitmwriSZiqvIrkL2gZceLg9nHd", owner_id: "ou_8ff", owner_name: "AJ",
            update_time: 1775826121, is_cross_tenant: true },
            summary_highlighted: "uses &lt;API name&gt; to introduce <h>how to</h> make requests", title_highlighted: "API Guide" },
        ].slice(0, pageSize),
      } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/open-apis/im/v1/chat_p2p/batch_query") {
      const body = await readJson(request);
      const ids = body.chatter_ids || [];
      send(response, 200, { code: 0, data: { p2p_chats: ids.map((id) => (id === "ou_ghost" ? {} : { chat_id: `oc_p2p_${id}`, chatter_id1: "ou_me", chatter_id2: id })) } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
      send(response, 200, { code: 0, data: { items: [
        { chat_id: "oc_1", name: "测试群", chat_mode: "group", description: "desc" },
        { chat_id: "oc_2", name: "私聊", chat_mode: "p2p" },
      ], has_more: false } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
      // Thread reads share this endpoint and differ only by container_id_type,
      // exactly like the live platform.
      if (url.searchParams.get("container_id_type") === "thread") {
        send(response, 200, { code: 0, data: {
          thread_id: url.searchParams.get("container_id") || "",
          has_more: false,
          items: [
            { message_id: "om_t1", thread_id: url.searchParams.get("container_id"), chat_id: "oc_topic", chat_default_name: "数字开发工作组", msg_type: "text",
              create_time: "1763000001000", sender: { id: "ou_a", sender_name: "alice", sender_type: "user" },
              body: { content: JSON.stringify({ text: "话题根消息" }) } },
            { message_id: "om_t2", thread_id: url.searchParams.get("container_id"), chat_id: "oc_topic", msg_type: "text", parent_id: "om_root",
              create_time: "1763000002000", sender: { id: "ou_b", sender_name: "bob", sender_type: "user" },
              body: { content: JSON.stringify({ text: "话题里的回复" }) } },
          ],
        } });
        return;
      }
      send(response, 200, { code: 0, data: { items: [
        { message_id: "om_1", chat_id: "oc_1", msg_type: "text", create_time: "1763000000000",
          sender: { id: "ou_a", name: "alice", sender_type: "user" }, body: { content: JSON.stringify({ text: "第一条" }) } },
      ], has_more: false } });
      return;
    }
    const messageMatch = url.pathname.match(/^\/open-apis\/im\/v1\/messages\/([^/]+)$/);
    if (request.method === "GET" && messageMatch) {
      const id = decodeURIComponent(messageMatch[1]);
      // om_missing stands in for a message that is not in a topic group: the
      // live platform answers no thread_id, and that is a real answer.
      const threadId = id === "om_missing" ? "" : "omt_abc123";
      send(response, 200, { code: 0, data: { items: [{ message_id: id, thread_id: threadId, chat_id: "oc_topic", msg_type: "text" }] } });
      return;
    }
    const docAiMatch = url.pathname.match(/^\/open-apis\/docs_ai\/v1\/documents\/([^/]+)$/);
    if (request.method === "PUT" && docAiMatch) {
      const body = await readJson(request);
      state.docWrites.push({ document: decodeURIComponent(docAiMatch[1]), body });
      const supported = ["str_replace", "str_delete", "block_insert_after", "block_replace", "block_delete", "block_move_after", "block_copy_insert_after", "overwrite"];
      if (!supported.includes(body.command)) {
        send(response, 400, { code: 3380002, msg: `Unknown command '${body.command}'` });
        return;
      }
      if (body.command === "str_replace" && !body.pattern) {
        send(response, 400, { code: 99992402, msg: "field validation failed" });
        return;
      }
      send(response, 200, { code: 0, data: {
        document: { revision_id: 7, url: `https://my.feishu.cn/docx/${decodeURIComponent(docAiMatch[1])}` },
        result: "success",
        warnings: [],
      } });
      return;
    }
    const replyMatch = url.pathname.match(/^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/);
    if (request.method === "POST" && replyMatch) {
      const body = await readJson(request);
      state.replies.push({ message: decodeURIComponent(replyMatch[1]), body });
      send(response, 200, { code: 0, data: { message_id: "om_reply_1", chat_id: "oc_topic", reply_to: decodeURIComponent(replyMatch[1]) } });
      return;
    }
    if (request.method === "POST" && (url.pathname === "/open-apis/im/v1/images" || url.pathname === "/open-apis/im/v1/files")) {
      const raw = await readRaw(request);
      // The platform takes multipart here; a JSON body or a missing Content-Type
      // is exactly the mistake a hand-built request makes, so reject it the same way.
      const type = String(request.headers["content-type"] || "");
      if (!type.startsWith("multipart/form-data")) {
        send(response, 400, { code: 99992402, msg: "Content-Type must be multipart/form-data" });
        return;
      }
      const fileType = (raw.match(/name="file_type"\r\n\r\n([a-z0-9]+)/i) || [])[1] || "";
      const fileName = (raw.match(/name="file_name"\r\n\r\n([^\r]+)/i) || [])[1] || "";
      // The multipart field name is part of the contract: images go in "image",
      // files in "file"; the wrong one is a bare 234001 with no hint.
      const fieldName = (raw.match(/name="(image|file)"; filename=/i) || [])[1] || "";
      state.uploads.push({ path: url.pathname, fileType, fileName, field: fieldName, bytes: raw.length, multipart: type.includes("boundary=") });
      if (url.pathname === "/open-apis/im/v1/images") {
        send(response, 200, { code: 0, data: { image_key: `img_fake_${state.uploads.length}` } });
        return;
      }
      send(response, 200, { code: 0, data: { file_key: `file_fake_${state.uploads.length}` } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/open-apis/contact/v3/users/search") {
      const body = await readJson(request);
      state.contactQueries.push(body);
      // Real answer is items[] (not users[]) with meta_data carrying chat_id and i18n names.
      const items = body.query === "nobody" ? [] : [{ id: "ou_fake_1", display_info: "<h>wing</h>\n\n", meta_data: {
        chat_id: "oc_8283fef6df8155cd7a85bdceabe93458",
        i18n_names: { zh_cn: "魏宁", en_us: "wing" },
        is_cross_tenant: false, mail_address: "", tenant_id: "t1" } }, { id: "ou_fake_2", display_info: "外包", meta_data: {
        chat_id: "", i18n_names: { zh_cn: "魏宁（外包）" }, is_cross_tenant: true } }];
      send(response, 200, { code: 0, data: { has_more: false, items } });
      return;
    }
    const viewMatch = url.pathname.match(/^\/open-apis\/calendar\/v4\/calendars\/([^/]+)\/events\/instance_view$/);
    if (request.method === "GET" && viewMatch) {
      const items = state.events.filter((e) => {
        const start = Number(e.start_time.timestamp || 0);
        return !start || (start >= Number(url.searchParams.get("start_time")) && start < Number(url.searchParams.get("end_time")));
      });
      send(response, 200, { code: 0, data: { items, has_more: false } });
      return;
    }
    const createMatch = url.pathname.match(/^\/open-apis\/calendar\/v4\/calendars\/([^/]+)\/events$/);
    if (request.method === "POST" && createMatch) {
      const body = await readJson(request);
      const event = {
        event_id: `ev_fake_${state.events.length + 1}`,
        summary: body.summary || "",
        ...(body.description ? { description: body.description } : {}),
        start_time: body.start_time,
        end_time: body.end_time,
        ...(body.recurrence ? { recurrence: body.recurrence } : {}),
        status: "confirmed",
        self_rsvp_status: "accept",
        event_organizer: { display_name: userName, user_id: "ou_fake" },
        app_link: "https://applink.feishu.cn/client/calendar/event/detail?key=ev_fake",
      };
      state.events.push(event);
      send(response, 200, { code: 0, data: { event } });
      return;
    }
    const attendeeMatch = url.pathname.match(/^\/open-apis\/calendar\/v4\/calendars\/([^/]+)\/events\/([^/]+)\/attendees$/);
    if (request.method === "POST" && attendeeMatch) {
      const body = await readJson(request);
      const eventId = decodeURIComponent(attendeeMatch[2]);
      if (failAttendees) {
        state.attendeeAttempts = (state.attendeeAttempts || []).concat([{ eventId, body }]);
        send(response, 400, { code: 190002, msg: "attendee add refused (fake)" });
        return;
      }
      state.attendeeAttempts = (state.attendeeAttempts || []).concat([{ eventId, body }]);
      send(response, 200, { code: 0, data: { attendees: (body.attendees || []).map((a) => ({
        attendee_id: `att_${a.user_id || a.chat_id || a.room_id}`,
        user_id: a.user_id || "",
        type: a.type,
        display_name: a.user_id ? userName : "",
        rsvp_status: "accept",
        is_organizer: a.user_id === "ou_fake",
      })) } });
      return;
    }
    const deleteMatch = url.pathname.match(/^\/open-apis\/calendar\/v4\/calendars\/([^/]+)\/events\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const eventId = decodeURIComponent(deleteMatch[2]);
      const before = state.events.length;
      state.events = state.events.filter((e) => e.event_id !== eventId);
      state.deletes = (state.deletes || []).concat([{ eventId, params: Object.fromEntries(url.searchParams), removed: state.events.length < before }]);
      send(response, 200, { code: 0, data: {} });
      return;
    }
    if (request.method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
      send(response, 200, { code: 0, data: { items: [
        { message_id: "om_3", chat_id: "oc_1", msg_type: "text", create_time: "1763000060000",
          sender: { id: "ou_a", name: "alice" }, body: { content: JSON.stringify({ text: "找到了" }) } },
      ], has_more: false } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/open-apis/im/v1/messages") {
      const body = await readJson(request);
      state.messageBodies.push(body);
      send(response, 200, { code: 0, data: { message_id: "om_1", chat_id: body.receive_id, msg_type: body.msg_type } });
      return;
    }
    const blockList = url.pathname.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks$/);
    if (request.method === "GET" && blockList) {
      send(response, 200, {
        code: 0,
        data: {
          items: [
            { block_id: "b_page", block_type: 1, parent_id: "", children: ["b1"] },
            { block_id: "b1", block_type: 2, parent_id: "b_page", text: { elements: [{ text_run: { content: "第一段" } }] } },
          ],
          has_more: false,
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
      const body = await readJson(request);
      send(response, 200, { code: 0, data: { document: { document_id: "doxcnNEW", title: body.title || "" } } });
      return;
    }
    const docChildren = url.pathname.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children$/);
    if (request.method === "POST" && docChildren) {
      const body = await readJson(request);
      send(response, 200, { code: 0, data: { children: body.children || [] } });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/open-apis/sheets/v2/spreadsheets/sht_1/values") {
      const body = await readJson(request);
      send(response, 200, { code: 0, data: { updatedRange: body?.valueRange?.range || "", updatedCells: 4 } });
      return;
    }

    const sheetValues = url.pathname.match(/^\/open-apis\/sheets\/v2\/spreadsheets\/([^/]+)\/values\/([^/]+)$/);
    if (request.method === "GET" && sheetValues) {
      send(response, 200, {
        code: 0,
        data: { valueRange: { range: decodeURIComponent(sheetValues[2]), values: [["a", "b"], ["1", "2"]] } },
      });
      return;
    }
    const sheetQuery = url.pathname.match(/^\/open-apis\/sheets\/v3\/spreadsheets\/([^/]+)\/sheets\/query$/);
    if (request.method === "GET" && sheetQuery) {
      send(response, 200, { code: 0, data: { sheets: [{ sheet_id: "s1", title: "Sheet1" }] } });
      return;
    }

    const docMatch = url.pathname.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/raw_content$/);
    if (request.method === "GET" && docMatch) {
      send(response, 200, { code: 0, data: { content: `# doc ${docMatch[1]}`, document_id: docMatch[1] } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/open-apis/drive/v1/files") {
      send(response, 200, { code: 0, data: { files: [{ name: "a.md", type: "docx" }], has_more: false } });
      return;
    }

    send(response, 404, { code: 404, msg: "not found" });
  });

  let port = 0;
  return {
    state,
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
      return this;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    /** Make the next authenticated API call fail with 401, forcing a refresh. */
    expireNextAccess() {
      state.expireNext = true;
    },
  };
}
