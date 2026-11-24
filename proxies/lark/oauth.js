"use strict";

// lark proxy, "oauth" implementation.
//
// Here we do hold the credential: a user_access_token plus its refresh_token, with
// the platform enforcing scope. That is what makes this route deployable -- it
// survives a machine change, unlike the CLI session -- at the cost of an initial
// consent flow (whose output is a refresh_token in config or the token file).
//
// Same contract as cli.js: whoami / scopes / call, same gates, same action table.
// Only the transport and the credential lifecycle differ.

import fs from "fs";
import path from "path";
import { createAuth } from "./../../accounts/auth/index.js";
import { ChannelError, ERROR_KINDS, isAuthCode } from "./../../accounts/errors.js";
import { createOutboundQueue } from "./../../accounts/outbound/queue.js";
import { PROJECT_ROOT } from "./../../lib/paths/index.js";
import { createTokenClient } from "./oauth-token.js";
import { createFileTokenStore } from "./token-store.js";
import { resolveAction } from "./gate.js";

export function createOAuthProxy({ instance = {}, deps = {} } = {}) {
  const options = instance.options || {};
  const credentials = instance.credentials || {};
  const baseUrl = String(options.baseUrl || "https://open.feishu.cn").replace(/\/+$/, "");
  const fetchImpl = deps.fetch || globalThis.fetch;
  const clientId = credentials.clientId || credentials.appId;
  const clientSecret = credentials.clientSecret || credentials.appSecret;
  if (!clientId || !clientSecret) throw new TypeError("lark oauth proxy needs credentials.clientId/clientSecret");

  const scopes = Array.isArray(instance.scopes)
    ? instance.scopes
    : ["docx:document:readonly", "drive:drive:readonly"];
  const instanceId = instance.id || "lark";

  const tokenClient =
    deps.tokenClient || createTokenClient({ baseUrl, clientId, clientSecret, fetchImpl });

  // The token file is the newest state: refresh tokens rotate, so a stale config
  // value would hand the platform a retired grant.
  const store =
    deps.tokenStore ||
    createFileTokenStore({
      file: options.tokensFile || path.join(PROJECT_ROOT, "user", "oauth", `${instanceId}.json`),
    });
  const persisted = store.loadSync ? store.loadSync() : {};
  const tokens = persisted.refreshToken
    ? persisted
    : {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      };

  const auth =
    deps.auth ||
    createAuth({
      strategy: "oauthRefresh",
      deps: {
        tokens,
        refresh: ({ refreshToken }) => tokenClient.refresh(refreshToken),
        onTokens: (next) => store.save(next),
        now: deps.now,
      },
    });

  // HTTP calls are cheap and metered in QPS, so the queue wires auth in: a 401
  // drops the access token and retries once with a fresh one.
  const outbound = createOutboundQueue({ qps: options.qps || 5, maxAttempts: 2, auth, now: deps.now, sleep: deps.sleep });

  async function request(target) {
    const url = new URL(baseUrl + target.path);
    for (const [key, value] of Object.entries(target.params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    return outbound.push(async () => {
      // A multipart body sets its own Content-Type (with the boundary); forcing
      // application/json on top of a FormData is what makes the upload endpoints
      // answer 400.
      const headers = { ...(target.form ? {} : { "Content-Type": "application/json; charset=utf-8" }), ...(await auth.headers()) };
      if (target.binary) return readBinary(String(url), headers);
      if (target.binaryRaw) return readBytes(String(url), headers, target.path);
      const response = await fetchImpl(String(url), {
        method: target.method,
        headers,
        body: target.form || (target.data === undefined ? undefined : JSON.stringify(target.data)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.code !== 0) {
        throw apiError(response.status, payload, target.path);
      }
      return payload.data ?? {};
    });
  }

  /**
   * The IM resource endpoints are multipart, and they are the one place where
   * the oauth route has to do something lark-cli already does internally: stage
   * the bytes, then send the key. A URL is downloaded here rather than by the
   * caller so that both routes accept "key | URL | local path" identically.
   */
  async function upload(target) {
    const { fields = {}, file } = target;
    let bytes = file.bytes;
    if (!bytes && file.url) {
      const res = await fetchImpl(file.url, { method: "GET" });
      if (!res.ok) throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: cannot download ${file.url} (HTTP ${res.status})`);
      bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > MAX_RAW_BYTES) {
        throw new ChannelError(ERROR_KINDS.PLATFORM, `lark: ${file.url} is ${bytes.byteLength} bytes, over the ${MAX_RAW_BYTES} byte upload limit`);
      }
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    // The field name is part of the contract: /im/v1/images wants "image", /im/v1/files
    // wants "file". Getting it wrong answers a bare 234001 "Invalid request param".
    form.append(target.fileField || "file", new Blob([bytes], { type: file.type || "application/octet-stream" }), file.name || "upload.bin");
    return request({ method: "POST", path: target.path, form });
  }

  /**
   * Download endpoints return bytes, not the {code,data} envelope. The oauth
   * route cannot run lark-cli's docx->markdown conversion, so it accepts only
   * files that are already text and says so plainly for anything else instead of
   * handing a binary blob to the model.
   */
  /** Whole-file bytes for a caller that wants to slice them itself. */
  async function readBytes(url, headers, where) {
    const response = await fetchImpl(url, { method: "GET", headers });
    if (!response.ok) throw apiError(response.status, {}, where || new URL(url).pathname);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RAW_BYTES) {
      throw new ChannelError(
        ERROR_KINDS.PLATFORM,
        `lark: ${where} is ${buffer.byteLength} bytes; the oauth route buffers whole files (limit ${MAX_RAW_BYTES}), use the cli route for chunked reads`
      );
    }
    return buffer;
  }

  async function readBinary(url, headers) {
    const response = await fetchImpl(url, { method: "GET", headers });
    if (!response.ok) throw apiError(response.status, {}, new URL(url).pathname);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      throw new ChannelError(ERROR_KINDS.PLATFORM, `drive.read: file is ${buffer.byteLength} bytes, over the ${MAX_TEXT_BYTES} byte text limit`);
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ChannelError(ERROR_KINDS.PLATFORM, "drive.read: file is binary; the oauth route can only return text (use the cli route for conversion)");
    }
    return { content: text, binary: false, bytes: buffer.byteLength, truncated: false };
  }

  let identity = null;

  async function whoami() {
    if (identity === null) {
      const data = await request({ method: "GET", path: "/open-apis/authen/v1/user_info" });
      const name = data.name || data.en_name;
      if (!name) throw new ChannelError(ERROR_KINDS.PLATFORM, "lark: user_info returned no name");
      identity = String(name);
    }
    return identity;
  }

  async function call(action, params = {}) {
    const { spec } = resolveAction({ action, params, scopes, options });

    // Mirror the cli route: an `expand` action runs once per item, and the
    // aggregate answer keeps per-item outcomes instead of hiding one failure.
    const steps = spec.expand ? spec.expand(params) : [params];
    const done = [];
    const failed = [];

    for (const step of steps) {
      const stepParams = steps.length === 1 ? params : { ...params, files: [step] };
      try {
        if (spec.run) {
          const out = await spec.run({
            params: stepParams,
            fs,
            bytes: (target) => request({ method: "GET", binaryRaw: true, ...target }),
            http: (target) => request(target),
            upload: (target) => upload(target),
          });
          done.push(out);
          continue;
        }
        const data = await request(spec.http(stepParams));
        // Actions may normalize the platform's envelope into the same shape the
        // CLI route returns, so callers never branch on which route produced it.
        const out = spec.shape ? spec.shape(data, stepParams) : data;
        done.push(spec.post ? spec.post(out, stepParams) : out);
      } catch (err) {
        if (steps.length === 1) throw err;
        failed.push({ token: step.token, type: step.type, error: err.message });
      }
    }

    if (steps.length === 1) return done[0];
    return { deleted: done, failed, attempted: steps.length };
  }

  return {
    type: "lark",
    instanceId,
    scopes,
    auth,
    whoami,
    call,

    // --- test affordances -------------------------------------------------
    get tokenStore() {
      return store;
    },
  };
}

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_RAW_BYTES = 8 * 1024 * 1024;

function apiError(status, payload, where) {
  const code = Number(payload && payload.code);
  const message = `lark api ${where}: ${
    (payload && (payload.msg || payload.error_description || payload.error)) || status
  }`;
  if (status === 401 || status === 403 || isAuthCode(code)) {
    return new ChannelError(ERROR_KINDS.AUTH, message, { status, code });
  }
  if (status === 429 || status >= 500) return new ChannelError(ERROR_KINDS.RETRYABLE, message, { status, code });
  return new ChannelError(ERROR_KINDS.PLATFORM, message, { status, code });
}
