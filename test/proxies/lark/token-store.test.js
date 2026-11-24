"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemoryTokenStore, createFileTokenStore } from "../../../proxies/lark/token-store.js";

test("a missing token file means re-authorize, not crash", () => {
  const store = createFileTokenStore({ file: path.join(os.tmpdir(), `nope-${Date.now()}`, "tokens.json") });
  assert.deepEqual(store.loadSync(), {});
});

test("a corrupt token file is treated as absent", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-tokens-")), "tokens.json");
  fs.writeFileSync(file, "not json");
  assert.deepEqual(createFileTokenStore({ file }).loadSync(), {});
});

test("the file store round-trips the rotated pair, with owner-only permissions", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-tokens-")), "tokens.json");
  const store = createFileTokenStore({ file });
  await store.save({ accessToken: "at_1", refreshToken: "rt_1", expiresAt: 123 });

  assert.deepEqual(store.loadSync(), { accessToken: "at_1", refreshToken: "rt_1", expiresAt: 123 });
  assert.equal(fs.statSync(file).mode & 0o077, 0, "group and other must have no access");
});

test("the memory store is synchronous on read and async on write", async () => {
  const store = createMemoryTokenStore({ refreshToken: "rt_0" });
  assert.equal(store.loadSync().refreshToken, "rt_0");
  await store.save({ refreshToken: "rt_1" });
  assert.equal(store.loadSync().refreshToken, "rt_1");
});

test("a rotation keeps the granted scope the consent wrote", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-tokens-")), "tokens.json");
  fs.writeFileSync(file, JSON.stringify({ accessToken: "at_0", refreshToken: "rt_0", scope: "calendar:calendar offline_access" }));
  const store = createFileTokenStore({ file });

  await store.save({ accessToken: "at_1", refreshToken: "rt_1", expiresAt: 456 });

  const saved = store.loadSync();
  assert.equal(saved.scope, "calendar:calendar offline_access", "scope must survive the overwrite");
  assert.equal(saved.refreshToken, "rt_1");
  assert.equal(saved.expiresAt, 456);
});
