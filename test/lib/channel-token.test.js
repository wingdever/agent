"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureServiceToken, readServiceToken, authHeaders } from "../../lib/channel-token.js";

test("the service token file is 0600 and reused by both roles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-token-"));
  try {
    const token = ensureServiceToken({ dir, env: {} });
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(path.join(dir, "service-token")).mode & 0o777, 0o600);
    assert.equal(readServiceToken({ dir, env: {} }), token);
    assert.equal(ensureServiceToken({ dir, env: {} }), token, "second call reuses the file");
    assert.deepEqual(authHeaders(token), { Authorization: `Bearer ${token}` });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CHANNEL_SERVICE_TOKEN overrides the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-token-"));
  try {
    assert.equal(readServiceToken({ dir, env: { CHANNEL_SERVICE_TOKEN: "env-token" } }), "env-token");
    assert.equal(ensureServiceToken({ dir, env: { CHANNEL_SERVICE_TOKEN: "env-token" } }), "env-token");
    assert.equal(fs.existsSync(path.join(dir, "service-token")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
