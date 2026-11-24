"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { run, ACTIONS } from "../../../tools/lark/run.js";
import { createCapabilities } from "../../../core/capabilities.js";

function fakeProxy(id = "me") {
  const calls = [];
  return {
    instanceId: id,
    type: "lark",
    scopes: ["docx:document:readonly"],
    calls,
    whoami: async () => "Fake Wing",
    call: async (action, params) => {
      calls.push({ action, params });
      return { action, params };
    },
  };
}

function execWith(...proxies) {
  return { capabilities: createCapabilities({ proxies }) };
}

test("whoami uses the only configured proxy without naming it", async () => {
  const result = await run({ action: "whoami" }, execWith(fakeProxy()));
  assert.equal(JSON.parse(result.text).whoami, "Fake Wing");
});

test("with several proxies the caller must name one", async () => {
  await assert.rejects(
    run({ action: "whoami" }, execWith(fakeProxy("a"), fakeProxy("b"))),
    /several proxies are configured \(a, b\); pass "proxy" explicitly/
  );
});

test("a named proxy resolves to that instance", async () => {
  const a = fakeProxy("a");
  const b = fakeProxy("b");
  const result = await run({ action: "whoami", proxy: "b" }, execWith(a, b));
  assert.equal(JSON.parse(result.text).proxy, "b");
});

test("doc.read forwards exactly the parameters the model passed", async () => {
  const proxy = fakeProxy();
  const result = await run({ action: "doc.read", params: { doc: "doxcnABC" } }, execWith(proxy));

  assert.deepEqual(proxy.calls, [{ action: "doc.read", params: { doc: "doxcnABC" } }]);
  assert.deepEqual(JSON.parse(result.text), { action: "doc.read", params: { doc: "doxcnABC" } });
  assert.deepEqual(result.meta, { proxy: "me", action: "doc.read" });
});

test("list_proxies answers from metadata alone", async () => {
  const proxy = fakeProxy();
  const result = await run({ action: "list_proxies" }, execWith(proxy));
  assert.deepEqual(JSON.parse(result.text), [
    { instanceId: "me", type: "lark", scopes: ["docx:document:readonly"] },
  ]);
  assert.deepEqual(proxy.calls, [], "listing must not touch the account");
});

test("unknown actions are refused before any proxy is resolved", async () => {
  await assert.rejects(run({ action: "doc.delete" }, execWith(fakeProxy())), (err) => {
    assert.match(err.message, /unknown action "doc.delete"/);
    for (const known of ACTIONS) assert.match(err.message, new RegExp(known));
    return true;
  });
});

test("a run without the capability says so instead of faking a result", async () => {
  await assert.rejects(run({ action: "whoami" }, {}), /no proxy capability in this run/);
});

test("an unknown proxy id surfaces the known ids", async () => {
  await assert.rejects(run({ action: "whoami", proxy: "nobody" }, execWith(fakeProxy())), /unknown proxy "nobody" \(known: me\)/);
});
