"use strict";

// What a proxy may do, expressed once.
//
// Each action carries a scope (who is allowed to do it) and a risk (how much
// damage a mistake causes). Scope and risk are different gates: a doc:readonly
// grant still lets you read a document you were not asked to read, so the risk
// gate is about intent, not permission.
//
// Nothing here is a generic "call anything" surface: adding an action is a
// deliberate code change, which is what keeps the model's reach auditable.

import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./../../lib/paths/index.js";
import { ChannelError, ERROR_KINDS } from "./../../accounts/errors.js";

export const RISK_LEVELS = Object.freeze(["read", "write", "high"]);

// Declared above ACTIONS on purpose: a spec reads its scope while the object
// literal is being built, so a later declaration would be a TDZ error, not a
// missing value.
const CONTACT_PAGE_MAX = 30;
const CALENDAR_SCOPES = Object.freeze({ read: "calendar:calendar:readonly", write: "calendar:calendar" });

const ACTIONS = {
  "doc.read": {
    scope: "docx:document:readonly",
    risk: "read",
    args: (params) => [
      "docs",
      "+fetch",
      "--doc",
      required(params.doc, "doc"),
      "--doc-format",
      "markdown",
      ...(params.scope ? ["--scope", String(params.scope)] : []),
    ],
    http: (params) => ({
      method: "GET",
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(docToken(params.doc))}/raw_content`,
    }),
    // The CLI nests the answer under `document`, the HTTP route does not. Callers
    // should not have to know which one ran, so both land on the same keys.
    shape: (data) => {
      const doc = data && data.document ? data.document : data || {};
      return {
        content: doc.content ?? doc.raw_content ?? "",
        document_id: doc.document_id || "",
        title: doc.title || "",
        revision: doc.revision_id ?? doc.revision ?? 0,
      };
    },
  },
  // Markdown is the readable view; blocks are the structural one. Editing needs
  // the latter, because block_replace addresses one block by id, not by text.
  "doc.blocks": {
    scope: "docx:document:readonly",
    risk: "read",
    args: (params) => [
      "api",
      "GET",
      `/open-apis/docx/v1/documents/${encodeURIComponent(docToken(required(params.doc, "doc")))}/blocks`,
      "--params",
      JSON.stringify({ page_size: clampPageSize(params.pageSize, 500, 100), ...(params.pageToken ? { page_token: String(params.pageToken) } : {}) }),
    ],
    http: (params) => ({
      method: "GET",
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(docToken(required(params.doc, "doc")))}/blocks`,
      params: { page_size: clampPageSize(params.pageSize, 500, 100), ...(params.pageToken ? { page_token: String(params.pageToken) } : {}) },
    }),
    // A block's payload is a keyed union (`text`, `heading1`, …) whose key is
    // implied by block_type. Flattening it into text + type is what a caller
    // actually decides on, and keeps the raw block out of the model's context.
    shape: (data) => ({
      blocks: (data?.items || []).map(flattenBlock),
      has_more: data?.has_more === true,
      page_token: data?.page_token || "",
    }),
  },
  "drive.list": {
    scope: "drive:drive:readonly",
    risk: "read",
    // A folder token is what turns this from "my root" into "browse": the drive
    // root only ever lists top-level folders, so without it a proxy can see a
    // folder exists but never what is inside it.
    args: (params) => [
      "api",
      "GET",
      "/open-apis/drive/v1/files",
      "--params",
      JSON.stringify(driveListParams(params)),
    ],
    http: (params) => ({ method: "GET", path: "/open-apis/drive/v1/files", params: driveListParams(params) }),
  },
  // Browsing a folder is one layer at a time, so finding something three levels
  // down means already knowing the path. search/v2 is the only way to ask "what
  // did I write about X" without walking the tree.
  //
  // Two platform quirks the caller should never have to discover:
  //   - a body without `doc_filter` answers total:0 and no error. Silence, not
  //     "nothing matched". So the filter objects are always sent, even empty.
  //   - an unscoped browse (no query, no person, no folder) also answers total:0:
  //     the server needs one of those to know where to look.
  "drive.search": {
    scope: "search:docs:read",
    risk: "read",
    args: (params) => searchArgs(params),
    shape: (data, params) => searchShape(data, params),
    // "mine" is server-side owner filtering keyed on the caller's open_id: the
    // CLI knows who it is, the HTTP route has to ask /authen/v1/user_info first.
    run: async (ctx) => {
      const params = ctx.params;
      if (ctx.cli) return searchShape(await ctx.cli(searchArgs(params)), params);
      const plan = searchPlan(params);
      // Two filters are phrased from the caller's own identity: "mine" (owner)
      // and "createdByMe" (original creator). The CLI knows who it is; over HTTP
      // we ask /authen/v1/user_info once, and only when one of them is used.
      const actor = plan.mine || plan.createdByMe ? [await resolveOpenId(ctx.http)] : [];
      return searchShape(await ctx.http(searchTarget(params, actor)), params);
    },
  },
  // Many "documents" in a real drive are plain files (md, txt), not docx: docs
  // +fetch rejects them with 3380002. drive +fetch converts whatever the file is
  // into a readable markdown snapshot, which is the only route that can read a
  // .md file the person wrote.
  // Large files and binaries: a proxy that returns a 300MB string is useless,
  // and one that refuses binaries cannot read a PNG. So reads are slices of
  // bytes, addressed by offset, and the encoding is decided by what the bytes
  // actually are rather than by the file's extension.
  "drive.read": {
    scope: "docx:document:readonly",
    risk: "read",
    args: (params) => [
      "drive",
      "+download",
      "--file-token",
      docToken(required(params.token || params.file, "token")),
      "--output",
      cachePath(docToken(required(params.token || params.file, "token"))),
      "--overwrite",
    ],
    http: (params) => ({
      method: "GET",
      path: `/open-apis/drive/v1/files/${encodeURIComponent(docToken(required(params.token || params.file, "token")))}/download`,
      binaryRaw: true,
    }),
    run: async (ctx) => {
      const token = docToken(required(ctx.params.token || ctx.params.file, "token"));
      const params = ctx.params;
      if (ctx.cli) {
        // The CLI only downloads whole files, so the cache is what makes chunked
        // reads cheap: the first call pays the download, every later offset is a
        // local seek.
        const file = cachePath(token);
        ctx.fs.mkdirSync(path.dirname(file), { recursive: true });
        if (params.refresh || !ctx.fs.existsSync(file)) {
          await ctx.cli(["drive", "+download", "--file-token", token, "--output", file, "--overwrite"]);
        }
        const size = ctx.fs.statSync(file).size;
        const { offset, limit } = chunkPlan(params);
        const length = Math.min(limit, Math.max(0, size - offset));
        const fd = ctx.fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(length);
          if (length) ctx.fs.readSync(fd, buffer, 0, length, offset);
          return sliceResult(buffer, size, params, offset);
        } finally {
          ctx.fs.closeSync(fd);
        }
      }
      // oauth: no ranged GET on this route, so a whole download is sliced in
      // memory; refusing a huge file is better than buffering it twice.
      const buffer = await ctx.bytes({
        path: `/open-apis/drive/v1/files/${encodeURIComponent(token)}/download`,
      });
      const { offset, limit } = chunkPlan(params);
      const slice = buffer.subarray(offset, Math.min(buffer.length, offset + limit));
      return sliceResult(slice, buffer.length, params, offset);
    },
  },
  // A spreadsheet is read as CSV, not as a grid of JSON cells: the consumer is a
  // model or a script, and CSV survives both without a schema argument.
  "sheet.read": {
    scope: "sheets:spreadsheet:readonly",
    risk: "read",
    args: (params) => [
      "sheets",
      "+csv-get",
      "--spreadsheet-token",
      docToken(required(params.token || params.spreadsheet, "token")),
      ...(params.sheetId ? ["--sheet-id", String(params.sheetId)] : ["--sheet-name", required(params.sheet || params.sheetName, "sheet")]),
      ...(params.range ? ["--range", String(params.range)] : []),
      "--max-chars",
      String(clampChars(params.maxChars)),
    ],
    http: (params) => ({
      method: "GET",
      path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(docToken(required(params.token || params.spreadsheet, "token")))}/values/${encodeURIComponent(
        `${params.sheetId || required(params.sheet || params.sheetName, "sheet")}!${params.range || ""}`
      )}`,
    }),
    shape: (data) => {
      // The CLI already answers in csv; only the HTTP route needs reshaping.
      if (data && typeof data.csv === "string") return data;
      const range = data && data.valueRange;
      return { csv: toCsv((range && range.values) || []), actual_range: (range && range.range) || "" };
    },
    // A whole-sheet read comes back as the full grid (A1:T200 for a 4-row table):
    // 4000 mostly-empty cells for 12 values. Trailing blank rows and columns are
    // noise, so trim them for every consumer, on both routes.
    post: trimSheetPayload,
  },
  "sheet.info": {
    scope: "sheets:spreadsheet:readonly",
    risk: "read",
    args: (params) => [
      "sheets",
      "+workbook-info",
      "--spreadsheet-token",
      docToken(required(params.token || params.spreadsheet, "token")),
    ],
    http: (params) => ({
      method: "GET",
      path: `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(docToken(required(params.token || params.spreadsheet, "token")))}/sheets/query`,
    }),
    // The real CLI calls the field sheet_name while the fake fixture (written
    // before a real workbook was ever opened) called it title. Normalize, so a
    // caller can pass sheets[0].title straight back into sheet.read.
    shape: (data) => ({
      title: data?.title || "",
      document_id: data?.token || "",
      revision: data?.revision ?? 0,
      sheets: (data?.sheets || []).map((s) => ({
        sheet_id: s.sheet_id || "",
        title: s.title || s.sheet_name || "",
        rows: s.row_count ?? s.rows ?? 0,
        columns: s.column_count ?? s.columns ?? 0,
        hidden: s.is_hidden === true,
      })),
    }),
  },
  // ---- writes ---------------------------------------------------------
  // These mutate the person's own documents. The permission gate is the thing
  // that decides whether a call happens without asking (options.allow +
  // user/permissions.json), not the driver: the driver only grades the risk.
  "doc.create": {
    scope: "docx:document",
    risk: "write",
    args: (params) => [
      "docs",
      "+create",
      "--title",
      required(params.title, "title"),
      "--content",
      required(params.content, "content"),
      "--doc-format",
      "markdown",
      ...(params.folder ? ["--parent-token", String(params.folder)] : []),
    ],
    http: (params) => ({
      method: "POST",
      path: "/open-apis/docx/v1/documents",
      data: { title: String(params.title), ...(params.folder ? { folder_token: String(params.folder) } : {}) },
    }),
    shape: (data, params) => ({
      document_id: data?.document?.document_id || data?.document_id || "",
      // The create call returns an id and a url but not the title it was given.
      title: data?.document?.title || String(params.title || ""),
      url: data?.document?.url || "",
    }),
  },
  "doc.append": {
    scope: "docx:document",
    risk: "write",
    args: (params) => [
      "docs",
      "+update",
      "--doc",
      docToken(required(params.doc, "doc")),
      "--command",
      "append",
      "--content",
      required(params.content, "content"),
      "--doc-format",
      "markdown",
    ],
    http: (params) => ({
      method: "POST",
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(docToken(required(params.doc, "doc")))}/blocks/${encodeURIComponent(
        docToken(required(params.doc, "doc"))
      )}/children`,
      data: { children: markdownLines(params.content), index: 0 },
    }),
    shape: (data, params) => ({ appended_blocks: (data?.children || []).length || markdownLines(params.content).length }),
  },
  // Editing a document is two different acts wearing one verb. Replacing a
  // matched string is a patch; overwriting is a rewrite. They get separate risk
  // levels so "writes may run silently" never quietly means "may wipe a doc".
  "doc.write": {
    scope: "docx:document",
    risk: (params) => {
      const mode = String(params.mode || "");
      // overwrite wipes a document, block.delete removes content: both are
      // "cannot be read back", so both sit above plain writes.
      return mode === "overwrite" || mode === "block.delete" ? "high" : "write";
    },
    args: (params) => docWriteArgs(params),
    shape: (data, params) => docWriteShape(data, params),
    // Both routes can do every mode. They differ only in transport: the CLI
    // speaks the docs_ai command API on our behalf, the oauth route speaks it
    // itself. Same command names, so this is one mapping, not two.
    run: async (ctx) => {
      const params = ctx.params;
      if (ctx.cli) return docWriteShape(await ctx.cli(docWriteArgs(params)), params);
      const token = docToken(required(params.doc, "doc"));
      return docWriteShape(
        await ctx.http({
          method: "PUT",
          path: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(token)}`,
          data: docWriteBody(params),
        }),
        params
      );
    },
  },
  // Talking as the person is the point of a proxy: a bot's message reads like a
  // bot's. Sending is a write, not a delete: a wrong message can be recalled,
  // which is why it does not need the high-risk gate.
  // Reading the person's chats is reading their mail: powerful, and easy to
  // mistake for "the whole workspace". Chats, messages and search are three
  // separate actions because they have three different scopes and three
  // different paging behaviours.
  "im.chats": {
    scope: "im:chat:readonly",
    risk: "read",
    args: (params) => [
      "im",
      "+chat-list",
      "--types",
      chatTypes(params),
      "--page-size",
      String(clampPageSize(params.pageSize, 100, 20)),
      "--sort",
      String(params.sort || "create_time"),
      ...(params.excludeMuted ? ["--exclude-muted"] : []),
      ...(params.pageToken ? ["--page-token", String(params.pageToken)] : []),
    ],
    http: (params) => ({
      method: "GET",
      path: "/open-apis/im/v1/chats",
      params: {
        page_size: clampPageSize(params.pageSize, 100, 20),
        types: chatTypes(params),
        sort_type: params.sort === "active_time" ? "ByActiveTimeDesc" : "ByCreateTimeAsc",
        user_id_type: "open_id",
        ...(params.pageToken ? { page_token: String(params.pageToken) } : {}),
      },
    }),
    shape: (data) => ({
      chats: (data?.chats || data?.items || []).map((c) => ({
        chat_id: c.chat_id || "",
        name: c.name || c.chat_name || "",
        type: c.chat_mode || c.chat_type || "",
        description: c.description || "",
        external: c.external === true,
        partner_id: c.p2p_target_id || "",
      })),
      has_more: data?.has_more === true,
      page_token: data?.page_token || "",
    }),
  },
  "im.messages": {
    scope: "im:message:readonly",
    risk: "read",
    args: (params) => imMessagesArgs(params),
    http: (params) => (threadTokenOf(params) ? imThreadTarget(params, String(threadTokenOf(params))) : imMessagesTarget(params)),
    shape: (data) => imMessagesShape(data),
    // Two resolutions happen before a read: a person is not a conversation
    // (p2p chat lookup), and a message id is not a thread id (topic replies).
    // The CLI does both itself, which is why the cli branch just shells out.
    run: async (ctx) => {
      const params = ctx.params;
      const thread = threadTokenOf(params);
      if (ctx.cli) return imMessagesShape(await ctx.cli(imMessagesArgs(params)));
      if (thread) {
        return imMessagesShape(await ctx.http(imThreadTarget(params, await resolveThreadId(thread, ctx.http))));
      }
      const chatId = params.chatId || params.chat_id;
      const resolved = chatId ? String(chatId) : await resolveP2pChat(params.userId || params.user_id, ctx.http);
      return imMessagesShape(await ctx.http(imMessagesTarget({ ...params, chatId: resolved })));
    },
  },
  "im.search": {
    scope: "im:message:readonly",
    risk: "read",
    args: (params) => [
      "im",
      "+messages-search",
      "--query",
      required(params.query || params.keyword, "query"),
      "--page-size",
      String(clampPageSize(params.pageSize, 50, 20)),
      ...(params.chatId ? ["--chat-id", String(params.chatId)] : []),
      ...(params.sender ? ["--sender", String(params.sender)] : []),
      ...(params.start ? ["--start", String(params.start)] : []),
      ...(params.end ? ["--end", String(params.end)] : []),
      ...(params.pageToken ? ["--page-token", String(params.pageToken)] : []),
      ...(params.includeReactions ? [] : ["--no-reactions"]),
    ],
    http: (params) => ({
      method: "POST",
      path: "/open-apis/im/v1/messages/search",
      params: { page_size: clampPageSize(params.pageSize, 50, 20), ...(params.pageToken ? { page_token: String(params.pageToken) } : {}) },
      data: { query: String(required(params.query || params.keyword, "query")) },
    }),
    shape: (data) => ({
      messages: (data?.messages || data?.items || []).map(normalizeMessage),
      has_more: data?.has_more === true,
      page_token: data?.page_token || "",
      total: data?.total ?? null,
    }),
  },
  "im.send": {
    scope: "im:message",
    risk: "write",
    // Text, markdown, image, file, voice or video: one message, one content kind.
    args: (params) => (replyToOf(params) ? replyArgs(params) : sendArgs(params)),
    // Only the cli route needs a working directory (relative attachment paths).
    cwdOf: (params) => imMediaCwd(params),
    // The oauth route uploads the bytes first, so it cannot be a one-shot body.
    run: (ctx) => imSendRun(ctx),
    shape: (data, params) => imSendShape(data, params),
  },
  // Resolving a person is the missing link between "I know their name" and every
  // action that takes an open_id or chat id. One query per call, by design: a
  // multi-name fanout would hide which name resolved to whom behind a merge.
  "contact.resolve": {
    scope: "contact:user:search",
    risk: "read",
    args: (params) => [
      "contact",
      "+search-user",
      "--query",
      String(contactQueryOf(params)),
      "--page-size",
      String(contactPageSize(params.pageSize || params.page_size)),
    ],
    http: (params) => ({
      method: "POST",
      path: "/open-apis/contact/v3/users/search",
      params: { page_size: contactPageSize(params.pageSize || params.page_size) },
      data: { query: String(contactQueryOf(params)) },
    }),
    shape: (data, params) => contactShape(data, params),
  },
  "calendar.agenda": {
    scope: CALENDAR_SCOPES.read,
    risk: "read",
    args: (params) => calendarAgendaArgs(params),
    http: (params) => {
      const window = calendarWindow(params);
      return {
        method: "GET",
        path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarIdOf(params))}/events/instance_view`,
        params: { start_time: String(window.start), end_time: String(window.end) },
      };
    },
    shape: (data) => calendarAgendaShape(data),
  },
  "calendar.create": {
    scope: CALENDAR_SCOPES.write,
    risk: "write",
    args: (params) => calendarCreateArgs(params),
    // Two requests on oauth (invitees are a separate endpoint), one command on cli.
    run: (ctx) => calendarCreateRun(ctx),
    shape: (data, params) => calendarCreateShape(data, params),
  },
  // Deleting an appointment cannot be undone, and it notifies every attendee by
  // default: same rule as drive.delete, forever high risk.
  "calendar.delete": {
    scope: CALENDAR_SCOPES.write,
    risk: "high",
    args: (params) => calendarDeleteArgs(params),
    http: (params) => calendarDeleteTarget(params),
    shape: (data, params) => calendarDeleteShape(data, params),
  },
  "sheet.write": {
    scope: "sheets:spreadsheet",
    risk: "write",
    // Two shapes, one action: a single rectangle, or a batch of rectangles that
    // may even live on different sheets. The platform writes the batch as one
    // request and fails fast, so a half-written sheet is not a possible outcome.
    args: (params) => {
      const token = docToken(required(params.token || params.spreadsheet, "token"));
      const writes = params.writes;
      if (Array.isArray(writes) && writes.length) {
        if (writes.length > 100) throw new TypeError("sheet.write accepts at most 100 writes per call");
        const items = writes.map((item, i) => {
          const range = required(item && item.range, `writes[${i}].range`);
          const selector = item.sheet_id || item.sheetId
            ? { sheet_id: String(item.sheet_id || item.sheetId) }
            : item.sheet_name || item.sheet
              ? { sheet_name: String(item.sheet_name || item.sheet) }
              : {};
          return { ...selector, range, cells: cellsFrom(item.values ?? item.cells) };
        });
        // The CLI wants a default sheet even when every item names its own.
        const fallback = params.sheetId
          ? ["--sheet-id", String(params.sheetId)]
          : ["--sheet-name", required(params.sheet || params.sheetName, "sheet")];
        return ["sheets", "+cells-set", "--spreadsheet-token", token, ...fallback, "--writes", JSON.stringify(items)];
      }
      return [
        "sheets",
        "+cells-set",
        "--spreadsheet-token",
        token,
        ...(params.sheetId ? ["--sheet-id", String(params.sheetId)] : ["--sheet-name", required(params.sheet || params.sheetName, "sheet")]),
        "--range",
        required(params.range, "range"),
        "--cells",
        JSON.stringify(cellsFrom(params.values)),
      ];
    },
    http: (params) => {
      if (Array.isArray(params.writes) && params.writes.length) {
        throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: multi-range sheet.write is only implemented on the cli route");
      }
      return {
        method: "PUT",
        path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(docToken(required(params.token || params.spreadsheet, "token")))}/values`,
        data: {
          valueRange: {
            range: `${params.sheetId || required(params.sheet || params.sheetName, "sheet")}!${required(params.range, "range")}`,
            values: params.values,
          },
        },
      };
    },
    shape: (data, params) => {
      if (Array.isArray(params.writes) && params.writes.length) {
        const cells = params.writes.reduce((n, w) => n + (Array.isArray(w.values || w.cells) ? (w.values || w.cells).reduce((m, r) => m + (r ? r.length : 0), 0) : 0), 0);
        return {
          updated_ranges: params.writes.map((w) => `${w.sheet_name || w.sheet || w.sheet_id || w.sheetId || params.sheet || params.sheetId}!${w.range}`),
          updated_cells: cells,
          revision: data?.revision ?? 0,
        };
      }
      return {
        updated_range: data?.updatedRange || `${params.sheet || params.sheetId}!${params.range}`,
        updated_cells: Array.isArray(params.values) ? params.values.reduce((n, row) => n + (row ? row.length : 0), 0) : 0,
        revision: data?.revision ?? 0,
      };
    },
  },
  // Deleting is the one thing that cannot be undone by another call, so it stays
  // high risk and never rides along with "writes may run silently". The CLI only
  // deletes one token per process; a multi-file call is N requests, which is also
  // why the result reports per-token outcomes instead of a single boolean.
  // Files cross the boundary here, in both directions, so the path is the
  // interesting part of the design: a proxy that can read any local path can
  // read the machine's secrets. Both directions are confined to `fileRoot`
  // (PROJECT_ROOT by default; configure options.fileRoot to widen it).
  "drive.upload": {
    scope: "drive:drive",
    risk: "write",
    args: (params) => {
      const local = resolveLocalPath(params.path || params.file, "path", params);
      return [
        "drive",
        "+upload",
        "--file",
        local,
        ...(params.folder ? ["--folder-token", String(params.folder)] : []),
        ...(params.name ? ["--name", String(params.name)] : []),
      ];
    },
    http: () => {
      throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: drive.upload is only implemented on the cli route (multipart)");
    },
    shape: (data, params) => ({
      file_token: data?.file_token || data?.token || "",
      name: data?.name || String(params.name || path.basename(String(params.path || params.file || ""))),
      parent: data?.parent_token || String(params.folder || ""),
    }),
  },
  // Export runs a platform-side async task; the CLI polls it and writes the file
  // locally, so the answer worth returning is where it landed and how big it is.
  "drive.export": {
    scope: "drive:drive",
    risk: "read",
    args: (params) => {
      const extension = required(params.extension || params.ext, "extension");
      if (!EXPORT_FORMATS.includes(extension)) throw new TypeError(`drive.export: unknown extension "${extension}"`);
      // A URL carries its own type; a bare token does not, and Feishu token
      // strings are random ids (no type prefix), so guessing is not an option.
      const target = String(params.token || params.doc || "");
      if (!target) throw new TypeError('drive.export needs "token" or a document URL');
      return [
        "drive",
        "+export",
        ...(/^https?:/.test(target)
          ? ["--url", target]
          : ["--token", docToken(target), "--doc-type", required(params.docType || params.documentType, "docType")]),
        "--file-extension",
        extension,
        "--output-dir",
        resolveLocalDir(params.outputDir, params),
        ...(params.overwrite ? ["--overwrite"] : []),
        ...(params.fileName ? ["--file-name", String(params.fileName)] : []),
      ];
    },
    http: () => {
      throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: drive.export is only implemented on the cli route");
    },
    shape: (data, params) => ({
      // The CLI names the landed file `saved_path` and its size `size_bytes`;
      // `path`/`bytes` never exist. Keep the friendly keys, fill them truthfully.
      path: data?.saved_path || data?.path || data?.file_path || "",
      bytes: data?.size_bytes ?? data?.bytes ?? data?.size ?? 0,
      name: data?.file_name || "",
      file_token: data?.file_token || "",
      ticket: data?.ticket || "",
      extension: String(params.extension || params.ext || ""),
    }),
  },
  "drive.delete": {
    scope: "drive:drive",
    risk: "high",
    args: (params) => {
      const files = normalizeDeletes(params);
      const first = files[0];
      return ["drive", "+delete", "--file-token", first.token, "--type", first.type, "--yes"];
    },
    http: (params) => {
      const files = normalizeDeletes(params);
      const first = files[0];
      return {
        method: "DELETE",
        path: "/open-apis/drive/v1/files/" + encodeURIComponent(first.token),
        params: { type: first.type },
      };
    },
    // The driver sees one request per call, so the multi-file loop lives in the
    // proxy wrapper: this spec keeps the single-file meaning, `expand()` tells
    // the driver how many times to run it.
    expand: (params) => normalizeDeletes(params),
    shape: (data, params) => {
      const files = normalizeDeletes(params);
      const deleted = {
        file_token: data?.file_token || files[0].token,
        type: data?.type || files[0].type,
        deleted: data?.deleted !== false,
        task_id: data?.task_id || "",
        ready: data?.ready === true,
        status: data?.status || "",
      };
      return files.length === 1 ? deleted : { deleted: [deleted] };
    },
  },
  // Escape hatch. Off unless the instance sets options.allowApi, and graded by
  // HTTP method: DELETE is treated as high risk without asking the platform.
  api: {
    scope: "*",
    risk: "method",
    requiresFlag: "allowApi",
    scopeBypass: true,
    args: (params) => [
      "api",
      httpMethod(params.method),
      required(params.path, "path"),
      ...(params.params ? ["--params", JSON.stringify(params.params)] : []),
      ...(params.data ? ["--data", JSON.stringify(params.data)] : []),
    ],
    http: (params) => ({
      method: httpMethod(params.method),
      path: openApiPath(params.path),
      params: params.params,
      data: params.data,
    }),
  },
};

export const KNOWN_ACTIONS = Object.keys(ACTIONS);

export function actionSpec(action) {
  const spec = ACTIONS[action];
  if (!spec) return null;
  return spec;
}

/** Risk of one call. `api` is graded by method; everything else is fixed by the table. */
export function riskOf(action, params = {}) {
  const spec = ACTIONS[action];
  if (!spec) return null;
  if (typeof spec.risk === "function") return spec.risk(params);
  if (spec.risk !== "method") return spec.risk;
  const method = httpMethod(params.method);
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "DELETE") return "high";
  return "write";
}

function httpMethod(value) {
  const method = String(value || "").toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('api action needs "method", e.g. "GET"');
  return method;
}

/** A doc may be given as a bare token or a URL; both reduce to the last path segment. */
function blockIdsOf(params = {}) {
  const ids = Array.isArray(params.blockIds)
    ? params.blockIds.map(String)
    : params.blockId || params.block_id
      ? [String(params.blockId || params.block_id)]
      : [];
  return ids;
}

function docWriteArgs(params) {
  const doc = docToken(required(params.doc, "doc"));
  const mode = String(params.mode || "");
  if (mode === "replace") {
    // An empty replacement is legal and means "delete the match", so only
    // the pattern is mandatory here.
    const replacement = params.replacement === undefined ? "" : String(params.replacement);
    return [
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      "str_replace",
      "--pattern",
      required(params.pattern, "pattern"),
      "--content",
      replacement,
      "--doc-format",
      "markdown",
    ];
  }
  if (mode === "overwrite") {
    return [
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      "overwrite",
      "--content",
      required(params.content, "content"),
      "--doc-format",
      "markdown",
    ];
  }
  // Block-level edits: address one block (or a sibling range) by id. This is
  // how you touch a table, an image, or a paragraph without regex-ing text.
  if (mode === "block.replace" || mode === "block.insert") {
    return [
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      mode === "block.replace" ? "block_replace" : "block_insert_after",
      "--block-id",
      required(params.blockId || params.block_id, "blockId"),
      "--content",
      required(params.content, "content"),
      "--doc-format",
      "markdown",
    ];
  }
  if (mode === "block.delete") {
    const ids = blockIdsOf(params);
    if (!ids.length && !(params.startBlockId && params.endBlockId)) {
      throw new TypeError('doc.write block.delete needs "blockId"/"blockIds" or "startBlockId" + "endBlockId"');
    }
    return [
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      "block_delete",
      ...(ids.length ? ["--block-id", ids.join(",")] : ["--start-block-id", String(params.startBlockId), "--end-block-id", String(params.endBlockId)]),
    ];
  }
  throw new TypeError('doc.write needs mode "replace", "overwrite", "block.replace", "block.insert" or "block.delete"');
}

// The HTTP route's body for the same intent. `append` is CLI sugar (it turns into
// block_insert_after with the "-1" end sentinel), so it is spelled out here rather
// than assumed; `str_delete` exists server-side but is not exposed by the CLI, and
// an empty str_replace already means delete.
function docWriteBody(params) {
  const mode = String(params.mode || "");
  const base = {
    scene: "DoubaoCLI",
    format: String(params.format || "markdown"),
    revision_id: params.revisionId === undefined ? -1 : Number(params.revisionId),
  };
  if (mode === "replace") {
    return {
      ...base,
      command: "str_replace",
      pattern: required(params.pattern, "pattern"),
      content: params.replacement === undefined ? "" : String(params.replacement),
    };
  }
  if (mode === "overwrite") return { ...base, command: "overwrite", content: required(params.content, "content") };
  if (mode === "block.replace" || mode === "block.insert") {
    return {
      ...base,
      command: mode === "block.replace" ? "block_replace" : "block_insert_after",
      block_id: String(required(params.blockId || params.block_id, "blockId")),
      content: required(params.content, "content"),
    };
  }
  if (mode === "block.delete") {
    const ids = blockIdsOf(params);
    if (!ids.length && !(params.startBlockId && params.endBlockId)) {
      throw new TypeError('doc.write block.delete needs "blockId"/"blockIds" or "startBlockId" + "endBlockId"');
    }
    return ids.length
      ? { ...base, command: "block_delete", block_id: ids.join(",") }
      : { ...base, command: "block_delete", start_block_id: String(params.startBlockId), end_block_id: String(params.endBlockId) };
  }
  throw new TypeError('doc.write needs mode "replace", "overwrite", "block.replace", "block.insert" or "block.delete"');
}

function docWriteShape(data, params) {
  const revision = data?.document?.revision_id ?? data?.revision_id ?? data?.revision ?? 0;
  const mode = String(params.mode || "");
  // Both routes can fail "softly": result:"failed" with warnings worth showing.
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  const result = data?.result || (warnings.length ? "failed" : "success");
  const common = { mode, revision, result, ...(warnings.length ? { warnings } : {}) };
  if (mode === "overwrite") return { ...common, overwritten: true };
  if (mode === "replace") {
    return {
      ...common,
      pattern: String(params.pattern || ""),
      replaced_with: params.replacement === undefined ? "" : String(params.replacement),
    };
  }
  if (mode === "block.delete") {
    const ids = blockIdsOf(params);
    return { ...common, deleted_blocks: ids.length || (params.startBlockId ? 1 : 0) };
  }
  return { ...common, block_id: String(params.blockId || params.block_id || "") };
}

function docToken(value) {
  const text = String(value).split("?")[0].split("#")[0];
  const tail = text.split("/").filter(Boolean).pop() || "";
  if (!tail) throw new TypeError('action needs "doc"');
  return tail;
}

/** The raw escape hatch only reaches documented open-platform paths. */
function openApiPath(value) {
  const path = required(value, "path");
  if (!path.startsWith("/open-apis/")) throw new TypeError('api path must start with "/open-apis/"');
  return path;
}

export { httpMethod, docToken, openApiPath, driveListParams };

function driveListParams(params = {}) {
  const query = { page_size: clampPageSize(params.limit) };
  const folder = folderToken(params.folder);
  if (folder) query.folder_token = folder;
  if (params.pageToken) query.page_token = String(params.pageToken);
  return query;
}

const SEARCH_DOC_TYPES = Object.freeze([
  "doc", "sheet", "bitable", "mindnote", "file", "wiki", "docx", "folder", "catalog", "slides", "shortcut",
]);
const SEARCH_SORTS = Object.freeze({
  default: "",
  edit_time: "EDIT_TIME",
  edit_time_asc: "EDIT_TIME_ASC",
  open_time: "OPEN_TIME",
  create_time: "CREATE_TIME",
});
const SEARCH_QUERY_CHARS = 30;

function listOf(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * Time filters are the one place where "3 days ago" has to become a number.
 * Accepted: unix seconds, 7d/1m/1y (calendar arithmetic, not 30-day buckets),
 * a full ISO timestamp, or YYYY-MM-DD. The date-only form is read as midnight
 * Asia/Shanghai, because that is where the workspace's clock is; guessing UTC
 * would shift a window by eight hours without anybody noticing.
 */
function searchTime(value, name, nowMs = Date.now()) {
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // A small integer is not a timestamp -- the platform reads "31536000" as an
    // unix second of 1971 and then rejects it, so refuse with a reason instead.
    if (n < 1000000000) {
      throw new TypeError(`drive.search: ${name} got ${n}, which is not a unix timestamp (epoch seconds are 10 digits); use 7d/1m/1y or YYYY-MM-DD instead`);
    }
    return n;
  }
  const relative = raw.match(/^(\d+)([dmy])$/);
  if (relative) {
    const n = Number(relative[1]);
    const date = new Date(nowMs);
    if (relative[2] === "d") date.setDate(date.getDate() - n);
    if (relative[2] === "m") date.setMonth(date.getMonth() - n);
    if (relative[2] === "y") date.setFullYear(date.getFullYear() - n);
    return Math.floor(date.getTime() / 1000);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const iso = new Date(`${raw}T00:00:00+08:00`);
    if (!Number.isNaN(iso.getTime())) return Math.floor(iso.getTime() / 1000);
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000);
  throw new TypeError(`drive.search: ${name} must be unix seconds, 7d/1m/1y, an ISO timestamp or YYYY-MM-DD, got "${raw}"`);
}

// my_edit_time / my_comment_time are hour-bucketed server-side; asking for 11:37
// and getting 11:00 back is the platform's normal answer, so floor both bounds
// and say so instead of pretending the window is exact.
function hourWindow(since, until, name) {
  if (since === undefined && until === undefined) return null;
  const start = since === undefined ? undefined : Math.floor(searchTime(since, `${name}Since`) / 3600) * 3600;
  const end = until === undefined ? undefined : Math.floor(searchTime(until, `${name}Until`) / 3600) * 3600;
  return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) };
}

function dayWindow(since, until) {
  if (since === undefined && until === undefined) return null;
  const start = since === undefined ? undefined : searchTime(since, "since");
  const end = until === undefined ? undefined : searchTime(until, "until");
  return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) };
}

// One plan, two transports: argv and body are translations of the same decision,
// so a filter exists in both routes or in neither.
function searchPlan(params = {}) {
  const query = params.query === undefined || params.query === null ? "" : String(params.query);
  const points = Array.from(query);
  const truncated = points.length > SEARCH_QUERY_CHARS ? points.slice(0, SEARCH_QUERY_CHARS).join("") : query;

  const docTypes = listOf(params.docTypes || params.doc_types || params.type).map((t) => t.toLowerCase());
  const unknown = docTypes.find((t) => !SEARCH_DOC_TYPES.includes(t));
  if (unknown) throw new TypeError(`drive.search: unknown doc type "${unknown}" (known: ${SEARCH_DOC_TYPES.join(", ")})`);

  const folderTokens = listOf(params.folderTokens || params.folderToken || params.folder);
  const spaceIds = listOf(params.spaceIds || params.space_ids || params.space);
  // Documents live in folders, wiki lives in spaces: the platform forbids asking
  // for both, and a request that asks for both would search neither.
  if (folderTokens.length && spaceIds.length) {
    throw new TypeError("drive.search: folderTokens and spaceIds are exclusive (folders are doc-only, space ids are wiki-only)");
  }

  const creatorIds = listOf(params.creatorIds || params.creator_ids);
  const originalCreatorIds = listOf(params.originalCreatorIds || params.original_creator_ids);
  const chatIds = listOf(params.chatIds || params.chat_ids);
  const sharerIds = listOf(params.sharerIds || params.sharer_ids);
  const secureLabelIds = listOf(params.secureLabelIds || params.secure_label_ids);
  const sortKey = String(params.sort || "default").toLowerCase();
  if (!(sortKey in SEARCH_SORTS)) {
    throw new TypeError(`drive.search: unknown sort "${sortKey}" (known: ${Object.keys(SEARCH_SORTS).join(", ")})`);
  }
  const mine = params.mine === true;
  const createdByMe = params.createdByMe === true || params.created_by_me === true;
  if (createdByMe && originalCreatorIds.length) {
    throw new TypeError("drive.search: createdByMe and originalCreatorIds ask the same question; use one");
  }
  const onlyTitle = params.onlyTitle === true || params.only_title === true;
  const onlyComment = params.onlyComment === true || params.only_comment === true;

  const created = dayWindow(params.createdSince ?? params.created_since, params.createdUntil ?? params.created_until);
  const opened = dayWindow(params.openedSince ?? params.opened_since, params.openedUntil ?? params.opened_until);
  const edited = hourWindow(params.editedSince ?? params.edited_since, params.editedUntil ?? params.edited_until, "edited");
  const commented = hourWindow(params.commentedSince ?? params.commented_since, params.commentedUntil ?? params.commented_until, "commented");

  // An unscoped browse is not "everything": the server answers total:0 because
  // it has no idea where to look. Refuse rather than report a false empty result.
  const scoped = truncated || mine || createdByMe || creatorIds.length || originalCreatorIds.length ||
    folderTokens.length || spaceIds.length || chatIds.length || created || opened || edited || commented;
  if (!scoped) {
    throw new TypeError("drive.search needs a query or a scope filter (mine, createdByMe, creatorIds, folderTokens, spaceIds, chatIds or a time window): an unscoped browse answers 0");
  }

  return {
    query: truncated,
    notice: truncated === query ? "" : `the query was truncated to ${SEARCH_QUERY_CHARS} characters (the platform limit)`,
    docTypes,
    folderTokens,
    spaceIds,
    creatorIds,
    originalCreatorIds,
    chatIds,
    sharerIds,
    secureLabelIds,
    mine,
    createdByMe,
    onlyTitle,
    onlyComment,
    created,
    opened,
    edited,
    commented,
    sort: sortKey === "default" ? "" : sortKey,
    sortType: SEARCH_SORTS[sortKey],
    pageSize: clampPageSize(params.pageSize, 20, 15),
    pageToken: params.pageToken ? String(params.pageToken) : "",
  };
}

function windowArgs(name, window) {
  if (!window) return [];
  return [
    ...(window.start === undefined ? [] : [`--${name}-since`, String(window.start)]),
    ...(window.end === undefined ? [] : [`--${name}-until`, String(window.end)]),
  ];
}

function searchArgs(params) {
  const plan = searchPlan(params);
  return [
    "drive",
    "+search",
    "--page-size",
    String(plan.pageSize),
    ...(plan.query ? ["--query", plan.query] : []),
    ...(plan.docTypes.length ? ["--doc-types", plan.docTypes.join(",")] : []),
    ...(plan.folderTokens.length ? ["--folder-tokens", plan.folderTokens.join(",")] : []),
    ...(plan.spaceIds.length ? ["--space-ids", plan.spaceIds.join(",")] : []),
    ...(plan.mine ? ["--mine"] : []),
    ...(plan.createdByMe ? ["--created-by-me"] : []),
    ...(plan.creatorIds.length ? ["--creator-ids", plan.creatorIds.join(",")] : []),
    ...(plan.originalCreatorIds.length ? ["--original-creator-ids", plan.originalCreatorIds.join(",")] : []),
    ...(plan.chatIds.length ? ["--chat-ids", plan.chatIds.join(",")] : []),
    ...(plan.sharerIds.length ? ["--sharer-ids", plan.sharerIds.join(",")] : []),
    ...(plan.secureLabelIds.length ? ["--secure-label-ids", plan.secureLabelIds.join(",")] : []),
    ...(plan.onlyTitle ? ["--only-title"] : []),
    ...(plan.onlyComment ? ["--only-comment"] : []),
    // The window is already seconds: both routes get the same number, so the CLI
    // never re-parses "7d" its own way and the two routes cannot drift.
    ...windowArgs("created", plan.created),
    ...windowArgs("opened", plan.opened),
    ...windowArgs("edited", plan.edited),
    ...windowArgs("commented", plan.commented),
    ...(plan.sort ? ["--sort", plan.sort] : []),
    ...(plan.pageToken ? ["--page-token", plan.pageToken] : []),
  ];
}

function searchTarget(params, creators = []) {
  const plan = searchPlan(params);
  const shared = {};
  if (plan.onlyTitle) shared.only_title = true;
  if (plan.onlyComment) shared.only_comment = true;
  const ids = plan.mine ? creators : plan.creatorIds;
  if (plan.mine && !ids.length) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: drive.search could not resolve your open_id for the mine filter");
  }
  if (ids.length) shared.creator_ids = ids;
  if (plan.originalCreatorIds.length) shared.original_creator_ids = plan.originalCreatorIds;
  if (plan.createdByMe) {
    if (!creators.length) {
      throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: drive.search could not resolve your open_id for the createdByMe filter");
    }
    shared.original_creator_ids = creators;
  }
  if (plan.chatIds.length) shared.chat_ids = plan.chatIds;
  if (plan.sharerIds.length) shared.sharer_ids = plan.sharerIds;
  if (plan.secureLabelIds.length) shared.secure_label_ids = plan.secureLabelIds;
  if (plan.created) shared.create_time = plan.created;
  if (plan.opened) shared.open_time = plan.opened;
  if (plan.edited) shared.my_edit_time = plan.edited;
  if (plan.commented) shared.my_comment_time = plan.commented;
  const byType = plan.docTypes.length ? { doc_types: plan.docTypes.map((t) => t.toUpperCase()) } : {};

  // A space id means "wiki only". Sending an empty doc_filter alongside it makes
  // the platform answer 0 (verified), so the doc half is omitted entirely -- and
  // that also stops a space search from quietly returning files outside the space.
  if (plan.spaceIds.length) {
    return {
      method: "POST",
      path: "/open-apis/search/v2/doc_wiki/search",
      data: {
        query: plan.query,
        page_size: plan.pageSize,
        wiki_filter: { ...shared, ...byType, space_ids: plan.spaceIds, ...(plan.sortType ? { sort_type: plan.sortType } : {}) },
        ...(plan.pageToken ? { page_token: plan.pageToken } : {}),
      },
    };
  }

  const data = {
    query: plan.query,
    page_size: plan.pageSize,
    // Always present, even empty: a body with no filter at all answers total:0.
    doc_filter: { ...shared, ...byType, ...(plan.folderTokens.length ? { folder_tokens: plan.folderTokens } : {}), ...(plan.sortType ? { sort_type: plan.sortType } : {}) },
    ...(plan.pageToken ? { page_token: plan.pageToken } : {}),
  };
  // Folder tokens scope documents only, so a folder search must not pretend to
  // cover wiki too -- the CLI omits wiki_filter in exactly this case.
  if (!plan.folderTokens.length) data.wiki_filter = { ...shared, ...byType };
  return { method: "POST", path: "/open-apis/search/v2/doc_wiki/search", data };
}

const SEARCH_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " });

// Search answers with highlight-marked, HTML-escaped text ("<h>HOWTO</>").
// A caller wants the title, not the markup or the escaping.
function plainText(value) {
  if (!value) return "";
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return SEARCH_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

function isoFrom(seconds, iso) {
  if (iso) return String(iso);
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
}

// The search answer carries a lot of metadata (icon_info JSON, version numbers,
// cross-tenant flags) that no caller decides on. Keep the fields that answer
// "which file is this and how do I get it".
function normalizeHit(unit) {
  const meta = (unit && unit.result_meta) || {};
  return {
    token: meta.token || "",
    title: plainText(unit && unit.title_highlighted),
    type: String(meta.doc_types || "").toLowerCase(),
    file_type: meta.file_type || "",
    entity: String((unit && unit.entity_type) || "").toLowerCase(),
    url: meta.url || "",
    owner_id: meta.owner_id || "",
    owner_name: meta.owner_name || "",
    created_at: isoFrom(meta.create_time, meta.create_time_iso),
    updated_at: isoFrom(meta.update_time, meta.update_time_iso),
    cross_tenant: meta.is_cross_tenant === true,
    snippet: plainText(unit && unit.summary_highlighted),
  };
}

function searchShape(data, params = {}) {
  const plan = searchPlan(params);
  const units = (data && (data.res_units || data.results)) || [];
  const total = data && data.total !== undefined ? data.total : null;
  // Measured, not assumed: a 7-day my_edit_time window answered 0 while five
  // documents were created in the same seven days. An edit window that finds
  // nothing is the most likely misread of an empty result, so say it out loud.
  const editWindow = plan.edited || plan.commented;
  const editNotice = total === 0 && editWindow
    ? "no match with the edit/comment window: my_edit_time and my_comment_time appear not to be populated for this account (a 7-day window answered 0 while 5 documents were created in it), so retry without editedSince/commentedSince and filter on createdSince instead"
    : "";
  const notice = [data && data.notice, plan.notice, editNotice].filter(Boolean).join("; ");
  return {
    results: units.map(normalizeHit),
    has_more: Boolean(data && data.has_more === true),
    page_token: (data && data.page_token) || "",
    total,
    ...(notice ? { notice } : {}),
  };
}

async function resolveOpenId(http) {
  const data = await http({ method: "GET", path: "/open-apis/authen/v1/user_info" });
  const openId = (data && (data.open_id || (data.data && data.data.open_id))) || "";
  if (!openId) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: /authen/v1/user_info returned no open_id, so the mine filter cannot be built");
  }
  return String(openId);
}

function chatTypes(params) {
  const raw = params.types || (params.includeP2p ? "group,p2p" : "group");
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const clean = list.map((t) => String(t).trim()).filter((t) => t === "group" || t === "p2p");
  if (!clean.length) throw new TypeError('im.chats: types must be "group", "p2p" or "group,p2p"');
  return [...new Set(clean)].join(",");
}

function messageReceiver(params) {
  const chatId = params.chatId || params.chat_id;
  const userId = params.userId || params.user_id;
  if (chatId && userId) throw new TypeError('im.messages takes either "chatId" or "userId", not both');
  if (!chatId && !userId) throw new TypeError('im.messages needs "chatId" or "userId"');
  return chatId ? ["--chat-id", String(chatId)] : ["--user-id", String(userId)];
}

function threadTokenOf(params = {}) {
  return params.thread || params.threadId || params.thread_id || "";
}

// Thread reads are chronological by default: a topic reply chain is a
// conversation, and reading it backwards is the odd choice.
function imThreadArgs(params, thread = String(threadTokenOf(params))) {
  return [
    "im",
    "+threads-messages-list",
    "--thread",
    String(thread),
    "--page-size",
    String(clampPageSize(params.pageSize, 50, 50)),
    "--order",
    String(params.order || "asc"),
    ...(params.includeReactions ? [] : ["--no-reactions"]),
    ...(params.pageToken ? ["--page-token", String(params.pageToken)] : []),
  ];
}

function imMessagesArgs(params) {
  if (threadTokenOf(params)) return imThreadArgs(params);
  return [
    "im",
    "+chat-messages-list",
    ...messageReceiver(params),
    "--page-size",
    String(clampPageSize(params.pageSize, 50, 50)),
    "--order",
    String(params.order || "desc"),
    ...(params.start ? ["--start", String(params.start)] : []),
    ...(params.end ? ["--end", String(params.end)] : []),
    // Reactions cost one extra request per message; a reader that only wants
    // text should not pay for them by default.
    ...(params.includeReactions ? [] : ["--no-reactions"]),
    ...(params.pageToken ? ["--page-token", String(params.pageToken)] : []),
  ];
}

function imMessagesTarget(params) {
  const chatId = params.chatId || params.chat_id;
  if (!chatId) throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: im.messages needs a resolved chatId on this route");
  return {
    method: "GET",
    path: "/open-apis/im/v1/messages",
    params: {
      container_id: String(chatId),
      container_id_type: "chat",
      page_size: clampPageSize(params.pageSize, 50, 50),
      sort_type: params.order === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
      with_sender_name: "true",
      ...(params.pageToken ? { page_token: String(params.pageToken) } : {}),
    },
  };
}

function imThreadTarget(params, threadId) {
  // An om_ id is a message, not a thread: it has to be resolved first, which is
  // exactly what resolveThreadId does. Executing here would silently ask the
  // platform for a thread that does not exist.
  if (!String(threadId).startsWith("omt_")) {
    throw new ChannelError(
      ERROR_KINDS.PLATFORM,
      `lark: im.messages needs a resolved thread id on this route, got "${threadId}" (the run hook resolves message ids first)`
    );
  }
  return {
    method: "GET",
    path: "/open-apis/im/v1/messages",
    params: {
      container_id: String(threadId),
      container_id_type: "thread",
      page_size: clampPageSize(params.pageSize, 50, 50),
      sort_type: params.order === "desc" ? "ByCreateTimeDesc" : "ByCreateTimeAsc",
      with_sender_name: "true",
      card_msg_content_type: "raw_card_content",
      ...(params.pageToken ? { page_token: String(params.pageToken) } : {}),
    },
  };
}

/**
 * A topic reply lives in a thread, and the thread id is omt_…, but what a caller
 * has in hand is the message they were reading (om_…). GET /im/v1/messages/:id
 * answers items[].thread_id; a message outside a topic has none, and saying so
 * beats returning an empty list that looks like "no replies".
 */
async function resolveThreadId(token, http) {
  const value = String(token);
  if (value.startsWith("omt_")) return value;
  const data = await http({ method: "GET", path: `/open-apis/im/v1/messages/${encodeURIComponent(value)}` });
  const first = (data?.items || [])[0] || {};
  const threadId = first.thread_id || "";
  if (!threadId) {
    throw new ChannelError(
      ERROR_KINDS.PLATFORM,
      `lark: im.messages: message "${value}" has no thread — it is not in a topic group, so there are no thread replies to read`
    );
  }
  return String(threadId);
}

function imMessagesShape(data) {
  const raw = (data?.messages || data?.items || [])[0] || {};
  const messages = (data?.messages || data?.items || []).map(normalizeMessage);
  const first = messages[0] || {};
  return {
    // A thread container answers messages only; the chat is implied by the first
    // one, so fill it in rather than hand back an empty chat_id.
    chat_id: data?.chat_id || first.chat_id || "",
    ...(data?.thread_id ? { thread_id: String(data.thread_id) } : {}),
    chat_name: data?.chat_name || raw.chat_default_name || "",
    messages,
    has_more: data?.has_more === true,
    page_token: data?.page_token || "",
  };
}

/**
 * A person is not a conversation. `chat_p2p/batch_query` turns `chatter_ids` into
 * `p2p_chats[].chat_id`; without a hit the person has never talked to us, which
 * is a real answer, not an error to paper over with an empty list.
 */
async function resolveP2pChat(userId, http) {
  if (!userId) throw new TypeError('im.messages needs "chatId" or "userId"');
  const data = await http({
    method: "POST",
    path: "/open-apis/im/v1/chat_p2p/batch_query",
    data: { chatter_ids: [String(userId)] },
  });
  const hit = (data?.p2p_chats || []).find((c) => c && c.chat_id);
  if (!hit) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: im.messages found no p2p chat with "${userId}" — they have never messaged you`);
  }
  return hit.chat_id;
}

/**
 * The CLI hands back a rendered `content` string; the HTTP API nests the same
 * text inside `body.content` as JSON. Both become {text} here so a caller never
 * has to branch on the route.
 */
function firstI18nName(names) {
  if (!names || typeof names !== "object") return "";
  return names.zh_cn || Object.values(names).find((value) => typeof value === "string") || "";
}

function normalizeMessage(m) {
  const sender = m.sender || {};
  let text = "";
  if (typeof m.content === "string") text = m.content;
  else if (m.body && typeof m.body.content === "string") {
    try {
      const parsed = JSON.parse(m.body.content);
      text = parsed.text ?? parsed.content ?? m.body.content;
      if (typeof text !== "string") text = JSON.stringify(text);
    } catch {
      text = m.body.content;
    }
  }
  const rawTime = m.create_time ?? m.createTime ?? "";
  const time = typeof rawTime === "number" || /^\d{10,}$/.test(String(rawTime))
    ? new Date(Number(rawTime)).toISOString()
    : String(rawTime);
  return {
    message_id: m.message_id || "",
    // Topic groups carry a thread per root message; keeping it is what makes
    // "read the replies to this one" possible without a second lookup.
    ...(m.thread_id ? { thread_id: String(m.thread_id) } : {}),
    // parent_id is "the message this one answers": the difference between a reply
    // and a new topic in a thread, and the only way to rebuild a reply tree.
    ...(m.parent_id || m.root_id ? { parent_id: m.parent_id || m.root_id } : {}),
    chat_id: m.chat_id || "",
    chat_type: m.chat_type || "",
    create_time: time,
    msg_type: m.msg_type || (m.body && m.body.msg_type) || "",
    text: typeof text === "string" ? text : String(text),
    sender_id: sender.id || sender.open_id || "",
    // Live messages carry sender.sender_name (plus sender_i18n_names); only the
    // CLI's rendered shape uses sender.name. Reading just one of them is how a
    // field we invented survives a test suite and then fails on the platform.
    sender_name: sender.name || sender.sender_name || firstI18nName(sender.sender_i18n_names) || "",
    sender_type: sender.sender_type || "",
    deleted: m.deleted === true,
  };
}

/** Exactly one receiver: a chat id or a person's open_id. */
// A reply is not a new message: it hangs off a message id and has no receiver.
// Kept in the same action because the risk is identical (a message can be
// recalled) and the body is the same text/markdown either way.
function replyToOf(params = {}) {
  return params.replyTo || params.reply_to || params.messageId || params.message_id || "";
}

function assertReplyReceiver(params) {
  const chatId = params.chatId || params.chat_id;
  const userId = params.userId || params.user_id || params.openId || params.open_id;
  if (chatId || userId) {
    throw new TypeError('im.send: a reply belongs to the message, not to a chat — drop "chatId"/"userId" when using replyTo');
  }
}

function receiverOf(params) {
  const chatId = params.chatId || params.chat_id;
  const userId = params.userId || params.user_id || params.openId || params.open_id;
  if (chatId && userId) throw new TypeError('im.send takes either "chatId" or "userId", not both');
  if (!chatId && !userId) throw new TypeError('im.send needs "chatId" or "userId"');
  return chatId ? { receiveIdType: "chat_id", receiveId: String(chatId) } : { receiveIdType: "open_id", receiveId: String(userId) };
}

function receiverArgs(params) {
  const { receiveIdType, receiveId } = receiverOf(params);
  return receiveIdType === "chat_id" ? ["--chat-id", receiveId] : ["--user-id", receiveId];
}

// --- im.send: one content kind, four labels --------------------------------
//
// The platform has four attachment message types (image, file, audio, media)
// whose content is a single uploaded key. On the cli route lark-cli does the
// upload itself but accepts only a *cwd-relative* path; on the oauth route the
// upload is ours (/im/v1/images, /im/v1/files) and the key is what the message
// carries. Both routes therefore accept the same three input forms -- an
// already-uploaded key, an http(s) URL, or a local path inside fileRoot -- and
// build the same content. The one thing that must not drift is which key field
// each type expects, so it lives in a single table.
const MEDIA_TYPES = Object.freeze({
  image: { msgType: "image", keyField: "image_key", cliFlag: "--image", keyPrefix: "img_", fileType: null, limit: 10 * 1024 * 1024 },
  file: { msgType: "file", keyField: "file_key", cliFlag: "--file", keyPrefix: "file_", fileType: "stream", limit: 30 * 1024 * 1024 },
  audio: { msgType: "audio", keyField: "file_key", cliFlag: "--audio", keyPrefix: "file_", fileType: "opus", limit: 30 * 1024 * 1024 },
  video: { msgType: "media", keyField: "file_key", cliFlag: "--video", keyPrefix: "file_", fileType: "mp4", limit: 30 * 1024 * 1024 },
});
const MEDIA_KINDS = Object.freeze(Object.keys(MEDIA_TYPES));
const AUDIO_EXTS = Object.freeze([".opus", ".ogg"]);
const MEDIA_MIME = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".opus": "audio/opus", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".txt": "text/plain", ".md": "text/markdown",
  ".pdf": "application/pdf", ".zip": "application/zip",
});

function mimeOf(name) {
  return MEDIA_MIME[String(name).slice(String(name).lastIndexOf(".")).toLowerCase()] || "application/octet-stream";
}

/**
 * A media argument is one of three things, and the platform's refusal for the
 * wrong one is opaque, so classify here and say what was wrong.
 */
function mediaRefOf(value, kind) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) throw new TypeError(`im.send: "${kind}" is empty`);
  const { keyPrefix } = MEDIA_TYPES[kind];
  if (raw.startsWith("img_") || raw.startsWith("file_")) {
    if (!raw.startsWith(keyPrefix)) {
      throw new TypeError(`im.send: ${kind} takes ${keyPrefix}… keys, got a ${raw.slice(0, 5)}… key`);
    }
    return { form: "key", value: raw };
  }
  if (/^https?:\/\//i.test(raw)) return { form: "url", value: raw };
  if (kind === "audio" && !AUDIO_EXTS.some((ext) => raw.toLowerCase().endsWith(ext))) {
    throw new TypeError(`im.send: a voice message must be Opus (${AUDIO_EXTS.join(" / ")}); convert it first (ffmpeg -c:a libopus), or send it as "file"`);
  }
  return { form: "path", value: raw };
}

/** Exactly one content kind: text, markdown, or one attachment (with a cover). */
function imContentPlan(params = {}) {
  const kinds = ["text", "markdown", ...MEDIA_KINDS];
  const given = kinds.filter((k) => params[k] !== undefined && String(params[k]).trim() !== "");
  if (given.length > 1) {
    throw new TypeError(`im.send takes one content kind, got ${given.join(" + ")} — a message carries text or one attachment, not both`);
  }
  if (!given.length) {
    throw new TypeError(`im.send needs one of ${kinds.map((k) => `"${k}"`).join(", ")}`);
  }
  const kind = given[0];
  if (params.videoCover !== undefined && params.videoCover !== "" && kind !== "video") {
    throw new TypeError('im.send: "videoCover" only makes sense together with "video"');
  }
  if (kind === "video" && (params.videoCover === undefined || params.videoCover === "")) {
    throw new TypeError('im.send: "video" needs "videoCover" (image key, URL or path) — the platform does not render a video without one');
  }
  if (kind === "text") return { kind: "text", msgType: "text", text: String(params.text) };
  if (kind === "markdown") return { kind: "post", msgType: "post", text: String(params.markdown) };
  const media = {
    kind,
    msgType: MEDIA_TYPES[kind].msgType,
    keyField: MEDIA_TYPES[kind].keyField,
    ref: mediaRefOf(params[kind], kind),
  };
  if (kind === "video") media.coverRef = mediaRefOf(params.videoCover, "image");
  return { kind, msgType: media.msgType, media };
}

function imContentOf(plan, keys = {}) {
  if (plan.kind === "text") return { text: plan.text };
  if (plan.kind === "post") return { zh_cn: { content: [[{ tag: "text", text: plan.text }]] } };
  const content = { [plan.media.keyField]: keys[plan.media.keyField] };
  if (plan.media.coverRef) content.image_key = keys.image_key;
  return content;
}

function imTargetOf(params, plan, keys = {}) {
  const content = JSON.stringify(imContentOf(plan, keys));
  const uuid = params.idempotencyKey ? { uuid: String(params.idempotencyKey) } : {};
  if (!replyToOf(params)) {
    const { receiveIdType, receiveId } = receiverOf(params);
    return {
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: plan.msgType, content, ...uuid },
    };
  }
  assertReplyReceiver(params);
  return {
    method: "POST",
    path: `/open-apis/im/v1/messages/${encodeURIComponent(String(replyToOf(params)))}/reply`,
    data: {
      msg_type: plan.msgType,
      content,
      ...(params.inThread === true ? { reply_in_thread: true } : {}),
      ...uuid,
    },
  };
}

/**
 * lark-cli refuses absolute paths and "..", so a local attachment is named by
 * its basename and the process runs with that file's directory as cwd. Two
 * attachments in two directories (video + cover) cannot share one cwd, and
 * silently choosing one would send the wrong file -- so that is refused.
 */
function imMediaCwd(params) {
  const plan = imContentPlan(params);
  if (!plan.media) return undefined;
  const dirs = [plan.media.ref, plan.media.coverRef]
    .filter((ref) => ref && ref.form === "path")
    .map((ref) => path.dirname(resolveLocalPath(ref.value, `${plan.media.kind} path`, params)));
  if (!dirs.length) return undefined;
  if (new Set(dirs).size > 1) {
    throw new TypeError("im.send: video and videoCover must live in the same directory (lark-cli only accepts cwd-relative paths)");
  }
  return dirs[0];
}

function imCliBody(params) {
  const plan = imContentPlan(params);
  if (!plan.media) return plan.msgType === "post" ? ["--markdown", plan.text] : ["--text", plan.text];
  const localName = (ref) =>
    ref.form === "path" ? path.basename(resolveLocalPath(ref.value, `${plan.media.kind} path`, params)) : ref.value;
  const flags = [MEDIA_TYPES[plan.media.kind].cliFlag, localName(plan.media.ref)];
  if (plan.media.coverRef) flags.push("--video-cover", localName(plan.media.coverRef));
  return flags;
}

function sendArgs(params) {
  return [
    "im",
    "+messages-send",
    ...receiverArgs(params),
    ...imCliBody(params),
    ...(params.idempotencyKey ? ["--idempotency-key", String(params.idempotencyKey)] : []),
  ];
}

function replyArgs(params) {
  assertReplyReceiver(params);
  return [
    "im",
    "+messages-reply",
    "--message-id",
    String(replyToOf(params)),
    ...imCliBody(params),
    ...(params.inThread === true ? ["--reply-in-thread"] : []),
    ...(params.idempotencyKey ? ["--idempotency-key", String(params.idempotencyKey)] : []),
  ];
}

function imSendShape(data, params, plan = imContentPlan(params)) {
  const messageId = data?.message_id || data?.message?.message_id || "";
  const chatId = data?.chat_id || data?.message?.chat_id || "";
  if (replyToOf(params)) {
    return {
      message_id: messageId,
      chat_id: chatId,
      reply_to: String(replyToOf(params)),
      in_thread: params.inThread === true,
      msg_type: plan.msgType,
    };
  }
  const { receiveIdType, receiveId } = receiverOf(params);
  return {
    message_id: messageId,
    chat_id: chatId || receiveId,
    receiver_type: receiveIdType,
    msg_type: plan.msgType,
  };
}

/** Local bytes for an upload, with the platform's own size ceiling per type. */
function readMediaFile(ctx, ref, params, kind) {
  if (ref.form === "url") {
    const name = path.basename(new URL(ref.value).pathname) || `${kind}.bin`;
    return { url: ref.value, name, type: mimeOf(name) };
  }
  const local = resolveLocalPath(ref.value, `${kind} path`, params);
  if (!ctx.fs.existsSync(local)) throw new TypeError(`im.send: ${kind} path does not exist: ${local}`);
  const bytes = ctx.fs.readFileSync(local);
  if (bytes.byteLength > MEDIA_TYPES[kind].limit) {
    throw new TypeError(`im.send: ${kind} is ${bytes.byteLength} bytes, over the ${MEDIA_TYPES[kind].limit} byte platform limit`);
  }
  return { bytes, name: path.basename(local), type: mimeOf(local) };
}

/** Upload once, reuse forever: a key naming an attachment skips this entirely. */
async function uploadMedia(ctx, ref, params, kind) {
  if (ref.form === "key") return ref.value;
  const file = readMediaFile(ctx, ref, params, kind);
  if (kind === "image") {
    const out = await ctx.upload({ path: "/open-apis/im/v1/images", fields: { image_type: "message" }, fileField: "image", file });
    return out.image_key;
  }
  const out = await ctx.upload({
    path: "/open-apis/im/v1/files",
    fields: { file_type: MEDIA_TYPES[kind].fileType, file_name: file.name },
    file,
  });
  return out.file_key;
}

/**
 * The oauth route needs two calls where the cli route needs one: upload the
 * bytes, then send the key. Doing it in `run` keeps send and reply on one path
 * -- a reply carries an attachment exactly like a new message does.
 */
async function imSendRun(ctx) {
  const plan = imContentPlan(ctx.params);
  // The cli route owns no upload endpoint: it hands lark-cli a relative path and
  // the CLI uploads as part of the same command. Same plan, one process.
  if (!ctx.upload) {
    const argv = replyToOf(ctx.params) ? replyArgs(ctx.params) : sendArgs(ctx.params);
    const cwd = imMediaCwd(ctx.params);
    const data = await ctx.cli(argv, cwd ? { cwd } : undefined);
    return imSendShape(data, ctx.params, plan);
  }
  const keys = {};
  if (plan.media) {
    keys[plan.media.keyField] = await uploadMedia(ctx, plan.media.ref, ctx.params, plan.media.kind);
    if (plan.media.coverRef) keys.image_key = await uploadMedia(ctx, plan.media.coverRef, ctx.params, "image");
  }
  return imSendShape(await ctx.http(imTargetOf(ctx.params, plan, keys)), ctx.params, plan);
}

// --- contact + calendar ----------------------------------------------------
//
// Two domains that were empty until now. Both share one property the other
// domains do not have: the answer is a *time* (or a *person*), and a wrong
// timezone or a wrong id is not an error the platform reports -- it is a wrong
// appointment nobody notices until the meeting is missed. So the parsing lives
// here, once, and both routes consume the same parsed value.


/** "primary" is a literal the platform understands; it is not resolved by us. */
function calendarIdOf(params) {
  return String(params.calendarId || params.calendar_id || "primary");
}

/** Epoch seconds -> ISO 8601 in the event's own zone, so both routes agree. */
function isoInZone(epochSeconds, zone) {
  const date = new Date(Number(epochSeconds) * 1000);
  if (!zone) return date.toISOString();
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || "00";
    const naive = `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}`;
    // The offset is the difference between "this wall clock read as UTC" and the
    // real instant -- the only way to get "+08:00" out of Intl.
    const offsetMinutes = Math.round((Date.parse(`${naive}Z`) - date.getTime()) / 60000);
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    return `${naive}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  } catch (_) {
    return date.toISOString();
  }
}

/** A calendar time argument: epoch seconds, ISO 8601, or YYYY-MM-DD (local midnight). */
function calendarTime(value, name) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) throw new TypeError(`calendar: "${name}" is empty`);
  if (/^\d{10,}$/.test(raw)) return { epoch: Number(raw), date: "" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const epoch = Math.floor(Date.parse(`${raw}T00:00:00+08:00`) / 1000);
    return { epoch, date: raw };
  }
  const epoch = Math.floor(Date.parse(raw) / 1000);
  if (Number.isNaN(epoch)) {
    throw new TypeError(`calendar: ${name} must be ISO 8601 (2026-11-24T10:00:00+08:00), YYYY-MM-DD or epoch seconds, got "${raw}"`);
  }
  return { epoch, date: "" };
}

function calendarZone(params) {
  return String(params.timeZone || params.timezone || "Asia/Shanghai");
}

/** agenda window: explicit from/to, or "today" in the caller's configured zone. */
function calendarWindow(params) {
  if (params.from || params.to) {
    const from = calendarTime(params.from, "from");
    const to = calendarTime(params.to, "to");
    if (to.epoch <= from.epoch) throw new TypeError("calendar.agenda: \"to\" must be after \"from\"");
    return { start: from.epoch, end: to.epoch };
  }
  const zone = calendarZone(params);
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "01";
  const today = `${pick("year")}-${pick("month")}-${pick("day")}`;
  const start = Math.floor(Date.parse(`${today}T00:00:00+08:00`) / 1000);
  return { start, end: start + 86400 };
}

/** ISO for the CLI (which converts to epoch itself) out of an epoch + zone. */
function calendarIso(epoch, zone) {
  const iso = isoInZone(epoch, zone);
  return iso;
}

function normalizeEvent(raw = {}, fallbackZone = "") {
  const start = raw.start_time || {};
  const end = raw.end_time || {};
  const allDay = Boolean(start.date);
  // All-day events carry dates, not instants, so the platform often omits a
  // timezone. Falling back to UTC would label a date the caller read as Asia/Shanghai
  // with a zone it never had; use the zone the request was made in instead.
  const zone = start.timezone || end.timezone || fallbackZone || "";
  const asTime = (value) => (value.datetime ? String(value.datetime) : value.timestamp ? isoInZone(value.timestamp, value.timezone || zone) : "");
  const organizer = raw.event_organizer || {};
  const appLink = raw.app_link || "";
  // All-day events are stored with an *exclusive* end date: asking for 11-26..11-27
  // answers start 11-26 end 11-28. Reporting the stored exclusive date would make
  // every caller re-derive "last day", so return the inclusive one and say all_day.
  const inclusiveEnd = (date) => {
    if (!date) return "";
    const day = Date.parse(`${date}T00:00:00Z`) - 86400000;
    return Number.isNaN(day) ? date : new Date(day).toISOString().slice(0, 10);
  };
  return {
    event_id: raw.event_id || raw.key || "",
    summary: raw.summary || "",
    all_day: allDay,
    start: allDay ? String(start.date) : asTime(start),
    end: allDay ? inclusiveEnd(String(end.date)) : asTime(end),
    // A date has no timezone. The platform sometimes fills one in anyway (UTC),
    // which would mislabel a plain date; omit it instead of guessing.
    ...(allDay || !zone ? {} : { timezone: zone }),
    ...(raw.recurrence ? { recurring: true, recurrence: String(raw.recurrence) } : {}),
    ...(raw.is_exception ? { is_exception: true } : {}),
    ...(raw.status ? { status: String(raw.status) } : {}),
    ...(raw.self_rsvp_status ? { self_rsvp: String(raw.self_rsvp_status) } : {}),
    ...(raw.description ? { description: plainText(raw.description) } : {}),
    ...(raw.location ? { location: String(raw.location.name || raw.location) } : {}),
    ...(organizer.user_id ? { organizer: { open_id: organizer.user_id, name: organizer.display_name || "" } } : {}),
    ...(appLink ? { app_link: appLink } : {}),
  };
}

function contactQueryOf(params = {}) {
  const raw = params.query ?? params.name ?? params.keyword ?? params.q;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new TypeError('contact.resolve needs "query" (a name, email or open_id)');
  }
  if (Array.from(String(raw)).length > 50) throw new TypeError("contact.resolve: the query is limited to 50 characters by the platform");
  return String(raw).trim();
}

function contactPageSize(value) {
  return clampPageSize(value, CONTACT_PAGE_MAX, 10);
}

/** Both routes answer one person shape, whether it came from items or users. */
function contactShape(data = {}, params = {}) {
  const items = data.users || data.items || [];
  const users = items.map((item) => {
    const meta = item.meta_data || {};
    const names = item.i18n_names || meta.i18n_names || {};
    const name = item.localized_name || item.name || firstI18nName(names) || plainText(item.display_info || "");
    return {
      open_id: item.open_id || item.id || "",
      name: String(name || ""),
      // The CLI exposes the p2p chat id directly; the HTTP answer puts it in
      // meta_data.chat_id. It is the value im.send wants, which is the whole
      // point of resolving a name first.
      p2p_chat_id: item.p2p_chat_id || meta.chat_id || "",
      ...(item.has_chatted !== undefined ? { has_chatted: item.has_chatted === true } : {}),
      ...(meta.is_cross_tenant !== undefined || item.is_cross_tenant !== undefined
        ? { cross_tenant: (item.is_cross_tenant ?? meta.is_cross_tenant) === true }
        : {}),
      ...(item.email || meta.mail_address ? { email: String(item.email || meta.mail_address) } : {}),
      ...(item.enterprise_email || meta.enterprise_mail_address
        ? { enterprise_email: String(item.enterprise_email || meta.enterprise_mail_address) }
        : {}),
      ...(item.department ? { department: String(item.department) } : {}),
      ...(item.matched_query ? { matched_query: String(item.matched_query) } : {}),
    };
  });
  return {
    users,
    count: users.length,
    has_more: data.has_more === true,
    ...(data.page_token ? { page_token: String(data.page_token) } : {}),
    ...(params.query ? { query: String(params.query) } : {}),
  };
}

/** ou_ -> user, oc_ -> chat, omm_ -> room: the platform wants the type spelled out. */
function attendeeListOf(params) {
  const raw = params.attendees ?? params.attendeeIds ?? params.attendee_ids;
  if (raw === undefined || raw === null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list
    .map((id) => String(id).trim())
    .filter(Boolean)
    .map((id) => {
      const type = id.startsWith("ou_") ? "user" : id.startsWith("omm_") ? "room" : id.startsWith("oc_") ? "chat" : "";
      if (!type) throw new TypeError(`calendar.create: attendee "${id}" must be an open_id (ou_), chat id (oc_) or room id (omm_)`);
      return { type, id };
    });
}

function eventTimesOf(params) {
  const allDay = params.allDay === true || params.all_day === true;
  const start = calendarTime(params.start, "start");
  const end = calendarTime(params.end, "end");
  if (allDay) {
    if (!start.date || !end.date) throw new TypeError('calendar.create: allDay needs "start" and "end" as YYYY-MM-DD (the last day is inclusive)');
    if (Date.parse(end.date) < Date.parse(start.date)) throw new TypeError("calendar.create: end date is before the start date");
    // Inclusive end goes to the platform as-is; it stores exclusive (+1 day) and
    // normalizeEvent subtracts the day back when reading.
    return { allDay: true, startIso: start.date, endIso: end.date, body: { start_time: { date: start.date }, end_time: { date: end.date } } };
  }
  if (end.epoch <= start.epoch) throw new TypeError('calendar.create: "end" must be after "start"');
  const zone = calendarZone(params);
  return {
    allDay: false,
    startIso: calendarIso(start.epoch, zone),
    endIso: calendarIso(end.epoch, zone),
    body: {
      start_time: { timestamp: String(start.epoch), timezone: zone },
      end_time: { timestamp: String(end.epoch), timezone: zone },
    },
  };
}

function calendarCreateArgs(params) {
  const times = eventTimesOf(params);
  const summary = required(params.summary || params.title, "summary");
  const attendees = attendeeListOf(params);
  return [
    "calendar",
    "+create",
    "--summary",
    summary,
    "--start",
    times.startIso,
    "--end",
    times.endIso,
    ...(params.description ? ["--description", String(params.description)] : []),
    ...(attendees.length ? ["--attendee-ids", attendees.map((a) => a.id).join(",")] : []),
    ...(params.calendarId || params.calendar_id ? ["--calendar-id", calendarIdOf(params)] : []),
  ];
}

function calendarCreateTarget(params) {
  const times = eventTimesOf(params);
  return {
    method: "POST",
    path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarIdOf(params))}/events`,
    data: {
      summary: required(params.summary || params.title, "summary"),
      ...(params.description ? { description: String(params.description) } : {}),
      ...times.body,
    },
  };
}

/**
 * The oauth route needs the attendee call as a second request. lark-cli rolls the
 * event back when that second call fails ("on failure: auto-delete event"), so a
 * half-created event with no invitees is a state neither route should leave behind.
 */
async function calendarCreateRun(ctx) {
  const times = eventTimesOf(ctx.params);
  // cli route: one command that already does create + invite (+ rollback).
  if (!ctx.http) {
    const data = await ctx.cli(calendarCreateArgs(ctx.params));
    return calendarCreateShape(data, ctx.params, times);
  }
  const created = await ctx.http(calendarCreateTarget(ctx.params));
  const event = created.event || created;
  const eventId = event.event_id || "";
  const attendees = attendeeListOf(ctx.params);
  if (!attendees.length) return calendarCreateShape(created, ctx.params, times);

  const typeParams = { user_id_type: "open_id" };
  try {
    const added = await ctx.http({
      method: "POST",
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarIdOf(ctx.params))}/events/${encodeURIComponent(eventId)}/attendees`,
      params: typeParams,
      data: {
        attendees: attendees.map((a) => ({
          type: a.type,
          ...(a.type === "user" ? { user_id: a.id } : a.type === "chat" ? { chat_id: a.id } : { room_id: a.id }),
        })),
        need_notification: ctx.params.notify !== false,
      },
    });
    const out = calendarCreateShape(created, ctx.params, times);
    const list = added.attendees || [];
    return {
      ...out,
      attendees: list.map((a) => ({
        open_id: a.user_id || "",
        name: a.display_name || "",
        type: a.type || "user",
        rsvp: a.rsvp_status || "",
      })),
    };
  } catch (err) {
    // Leaving an event behind would be a silent side effect of a failed invite.
    try {
      await ctx.http({
        method: "DELETE",
        path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarIdOf(ctx.params))}/events/${encodeURIComponent(eventId)}`,
        params: { need_notification: "false" },
      });
    } catch (_) {
      throw new ChannelError(ERROR_KINDS.PLATFORM, `${err.message}; and the created event ${eventId} could not be deleted, so it still exists`);
    }
    throw new ChannelError(ERROR_KINDS.PLATFORM, `${err.message}; the created event ${eventId} was deleted again, so no invitation went out`);
  }
}

/** cli answers {event_id, start, end}; oauth answers {event}. One shape for both. */
function calendarCreateShape(data = {}, params = {}, times = null) {
  const event = data.event || data;
  const shape = normalizeEvent(event, calendarZone(params));
  const start = shape.start || data.start || (times && times.startIso) || "";
  const end = shape.end || data.end || (times && times.endIso) || "";
  // lark-cli turns a date range into a timed block (00:00:00 - 23:59:59), so an
  // "all-day" request on that route is not an all-day event on the platform.
  // Reporting the request instead of the result would be a quiet lie, so report
  // the result and say why.
  const allDayAsked = Boolean(times ? times.allDay : shape.all_day);
  const timedStart = /T\d{2}:\d{2}/.test(String(start));
  const allDay = allDayAsked && !timedStart;
  const drift = allDayAsked && timedStart
    ? "lark-cli creates an all-day request as a timed 00:00:00-23:59:59 event; the oauth route stores a real all-day event"
    : "";
  return {
    event_id: event.event_id || data.event_id || "",
    summary: event.summary || data.summary || String(params.summary || params.title || ""),
    all_day: allDay,
    start,
    end,
    ...(allDay ? {} : { timezone: shape.timezone || calendarZone(params) }),
    ...(drift ? { notice: drift } : {}),
    ...(data.app_link ? { app_link: String(data.app_link) } : shape.app_link ? { app_link: shape.app_link } : {}),
  };
}

function calendarAgendaArgs(params) {
  const window = calendarWindow(params);
  const zone = calendarZone(params);
  return [
    "calendar",
    "+agenda",
    "--start",
    calendarIso(window.start, zone),
    "--end",
    calendarIso(window.end, zone),
    ...(params.calendarId || params.calendar_id ? ["--calendar-id", calendarIdOf(params)] : []),
  ];
}

function calendarAgendaShape(data, params = {}) {
  const items = Array.isArray(data) ? data : data.items || [];
  return {
    events: items.map((item) => normalizeEvent(item, calendarZone(params))),
    count: items.length,
  };
}

function calendarDeleteArgs(params) {
  const eventId = required(params.eventId || params.event_id || params.event, "eventId");
  return [
    "calendar",
    "+delete",
    "--event-id",
    String(eventId),
    ...(params.calendarId || params.calendar_id ? ["--calendar-id", calendarIdOf(params)] : []),
    ...(params.applyTo || params.apply_to ? ["--apply-to", String(params.applyTo || params.apply_to)] : []),
    ...(params.notify === false ? ["--notify=false"] : []),
    // The CLI asks for confirmation on its own; the risk gate in front of this
    // action already asked, and a second prompt inside a script would just hang.
    "--yes",
  ];
}

function calendarDeleteTarget(params) {
  const eventId = required(params.eventId || params.event_id || params.event, "eventId");
  return {
    method: "DELETE",
    path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarIdOf(params))}/events/${encodeURIComponent(String(eventId))}`,
    params: {
      need_notification: params.notify === false ? "false" : "true",
      ...(params.applyTo || params.apply_to ? { apply_to: String(params.applyTo || params.apply_to) } : {}),
    },
  };
}

function calendarDeleteShape(data = {}, params = {}) {
  const deleted = data.deleted_event || {};
  return {
    event_id: deleted.event_id || String(params.eventId || params.event_id || params.event || ""),
    deleted: data.error ? false : true,
    ...(deleted.action ? { action: String(deleted.action) } : {}),
    apply_to: data.apply_to || String(params.applyTo || params.apply_to || ""),
    notify: params.notify !== false,
  };
}


/** Accepts a bare folder token or a /drive/folder/<token> URL. */
function folderToken(value) {
  if (value === undefined || value === null || value === "") return "";
  return docToken(String(value));
}

/** A simple matrix of values becomes the CLI's per-cell objects. */
function cellsFrom(values) {
  if (!Array.isArray(values) || !values.length) throw new TypeError('action needs "values" (a 2D array)');
  return values.map((row) => (Array.isArray(row) ? row : [row]).map((value) => ({ value })));
}

/** Markdown -> docx text blocks, one block per line, so an append is readable. */
function markdownLines(content) {
  const text = String(content ?? "");
  if (!text) throw new TypeError('action needs "content"');
  return text
    .split("\n")
    .map((line) => ({
      block_type: 2,
      text: { elements: [{ text_run: { content: line } }] },
    }));
}

function clampChars(value) {
  const chars = Number(value);
  if (!Number.isFinite(chars) || chars <= 0) return 120000;
  return Math.min(1000000, Math.floor(chars));
}

/** Drop trailing empty rows and columns, keeping the original width semantics. */
function trimSheetPayload(payload, params = {}) {
  if (!payload || typeof payload.csv !== "string") return payload;
  // An explicit range is a promise about which cells come back: trimming it
  // would silently drop the blank rows the caller asked for (and break row
  // alignment). Only whole-sheet reads get trimmed.
  if (params.range) return { ...payload, trimmed: false };
  const rows = parseCsv(payload.csv);
  let lastRow = -1;
  let lastCol = -1;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== "") {
        lastRow = Math.max(lastRow, r);
        lastCol = Math.max(lastCol, c);
      }
    }
  }
  if (lastRow < 0) return { ...payload, csv: "", trimmed: true };
  const kept = rows.slice(0, lastRow + 1).map((row) => row.slice(0, lastCol + 1));
  return { ...payload, csv: toCsv(kept), trimmed: true, rows: kept.length, columns: lastCol + 1 };
}

/** Minimal RFC4180 reader: quotes are the only thing that can contain a comma. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** RFC4180-ish quoting: only quote when the cell contains a comma, quote or newline. */
function toCsv(rows) {
  return rows
    .map((row) =>
      (row || [])
        .map((cell) => {
          const text = cell === null || cell === undefined ? "" : String(cell);
          return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(",")
    )
    .join("\n");
}

function clampRows(value) {
  const rows = Number(value);
  if (!Number.isFinite(rows) || rows < 0) return 20;
  return Math.min(200, Math.floor(rows));
}

function clampPageSize(limit, cap = 200, fallback = 50) {
  const size = Number(limit);
  if (!Number.isFinite(size) || size <= 0) return fallback;
  return Math.min(cap, Math.floor(size));
}

const DEFAULT_CHUNK = 64 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;

function clampChunk(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK;
  return Math.min(MAX_CHUNK, Math.floor(n));
}

function chunkPlan(params) {
  const offset = Math.max(0, Math.floor(Number(params.offset || 0)) || 0);
  return { offset, limit: clampChunk(params.limit) };
}

/** Cache location for downloaded Drive files; inside the writable user dir. */
function cachePath(token) {
  const safe = String(token).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(PROJECT_ROOT, "user", ".cache", "drive", `${safe}.bin`);
}

/**
 * Turn a byte slice into something a model can consume.
 *
 * `auto` means: valid UTF-8 without NUL bytes → text; anything else → base64.
 * A text slice that ends mid-character is trimmed back to the last complete
 * character, and `next_offset` follows the trimmed length, so the next call
 * starts exactly where this one stopped.
 */
function sliceResult(buffer, total, params, baseOffset) {
  const requested = String(params.encoding || "auto");
  if (!["auto", "text", "base64"].includes(requested)) throw new TypeError('drive.read: encoding must be "auto", "text" or "base64"');
  const offset = baseOffset;
  const end = Math.min(total, offset + buffer.length);
  let encoding = requested === "auto" ? sniffEncoding(buffer) : requested;
  let content = "";
  let consumed = buffer.length;

  if (encoding === "text") {
    let cut = buffer.length;
    while (cut > 0) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, cut));
        break;
      } catch {
        cut--;
      }
    }
    if (cut === 0 && buffer.length > 0) {
      // Not text after all: fall back instead of returning mojibake.
      encoding = "base64";
      content = buffer.toString("base64");
      consumed = buffer.length;
    } else {
      consumed = cut;
    }
  }
  if (encoding === "base64") content = buffer.toString("base64");

  const nextOffset = offset + consumed;
  return {
    content,
    encoding,
    offset,
    bytes_read: consumed,
    next_offset: nextOffset,
    eof: nextOffset >= total,
    total_bytes: total,
    truncated: !!(params.limit && requested !== "text" && nextOffset < total),
  };
}

/** NUL bytes or invalid UTF-8 mean "not text"; both are cheap to check. */
function sniffEncoding(buffer) {
  if (buffer.includes(0)) return "base64";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "text";
  } catch {
    return "base64";
  }
}

const EXPORT_FORMATS = Object.freeze(["docx", "pdf", "xlsx", "csv", "markdown", "base", "pptx"]);

/**
 * Resolve a caller-supplied path and refuse anything outside the file root.
 * Both uploads and exports go through here: the model names a path, the person
 * owns the machine.
 */
function resolveLocalPath(value, name, params = {}) {
  const given = required(value, name);
  const root = path.resolve(params.fileRoot || PROJECT_ROOT);
  const resolved = path.resolve(root, given);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: ${name} must stay inside ${root} (got ${resolved})`);
  }
  return resolved;
}

function resolveLocalDir(value, params = {}) {
  const root = path.resolve(params.fileRoot || PROJECT_ROOT);
  const resolved = path.resolve(root, String(value || "."));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: outputDir must stay inside ${root} (got ${resolved})`);
  }
  return resolved;
}

/** docx blocks are {block_id, block_type, parent_id, <type-keyed payload>}. */
function flattenBlock(block) {
  const type = block.block_type;
  const payload = block.text || block.heading1 || block.heading2 || block.heading3 || block.bullet || block.ordered || block.code || block.quote || block.todo || null;
  const text = payload && Array.isArray(payload.elements)
    ? payload.elements.map((el) => (el && el.text_run && el.text_run.content) || "").join("")
    : "";
  return {
    block_id: block.block_id || "",
    type: BLOCK_TYPES[type] || `type:${type}`,
    parent_id: block.parent_id || "",
    text,
    children: Array.isArray(block.children) ? block.children : [],
  };
}

// The numeric block_type enum, named. Only the ones a caller can act on.
const BLOCK_TYPES = Object.freeze({
  1: "page",
  2: "text",
  3: "h1",
  4: "h2",
  5: "h3",
  6: "h4",
  7: "h5",
  8: "h6",
  9: "h7",
  10: "bullet",
  11: "ordered",
  12: "code",
  13: "quote",
  19: "callout",
  27: "image",
  31: "table",
  32: "table_cell",
});

/** Accepts {{files:[{{token,type}}], {tokens:[...], type}, or a single {token,type}. */
function normalizeDeletes(params) {
  const raw = params.files || (params.tokens ? params.tokens.map((token) => ({ token })) : params.token ? [params] : []);
  if (!Array.isArray(raw) || raw.length === 0) throw new TypeError('drive.delete needs "files" or "token"');
  if (raw.length > 20) throw new TypeError("drive.delete accepts at most 20 files per call");
  return raw.map((entry, i) => {
    const item = entry || {};
    const token = required(item.token || item.file_token || item.fileToken, `files[${i}].token`);
    const type = String(item.type || params.type || "file");
    if (!/^(file|docx|doc|sheet|bitable|mindnote|folder|shortcut|slides)$/.test(type)) {
      throw new TypeError(`drive.delete: unknown type "${type}"`);
    }
    return { token: docToken(token), type };
  });
}

function required(value, name) {
  if (value === undefined || value === null || value === "") throw new TypeError(`action needs "${name}"`);
  return String(value);
}
