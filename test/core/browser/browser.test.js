"use strict";

// Browser service and browser_* tool contract. All cases use a local fixture
// server so the suite never depends on an external site.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { BrowserService, buildSnapshotText, findExecutable, isHttpUrl, assertNavigationAllowed } from "../../../core/browser/index.js";
import { loadTools } from "../../../core/tools/registry.js";

const FIXTURE = `<!doctype html>
<html><head><title>Browser Fixture</title></head>
<body>
  <h1>Sign in</h1>
  <label>Email <input id="email" name="email" placeholder="you@example.com"></label>
  <label>Password <input id="password" type="password" value="secret-value"></label>
  <button id="go" type="button">Go</button>
  <p id="out">waiting</p>
  <script>
    document.getElementById("go").addEventListener("click", () => {
      document.getElementById("out").textContent = "hello " + document.getElementById("email").value;
    });
  </script>
</body></html>`;

async function startFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port + "/" };
}

function refFor(snapshot, tag) {
  const text = typeof snapshot === "string" ? snapshot : snapshot && snapshot.text;
  const match = new RegExp("^- (e\\d+) " + tag + " ", "m").exec(text || "");
  return match ? match[1] : null;
}

test("snapshot text is bounded and keeps interactive refs", () => {
  const raw = {
    url: "https://example.test/",
    title: "Example",
    interactive: [{ ref: "e1", tag: "button", role: null, label: "Go" }],
    headings: [{ level: "h1", text: "Title" }],
    text: "body",
    interactiveMore: 0,
  };
  const text = buildSnapshotText(raw, 200);
  assert.match(text, /^- e1 button "Go"$/m);
  assert.match(text, /^HEADINGS:$/m);
});

test("URL guard accepts only http(s)", () => {
  assert.equal(isHttpUrl("https://example.com/a"), true);
  assert.equal(isHttpUrl("http://127.0.0.1:8080/"), true);
  assert.equal(isHttpUrl("file:///etc/passwd"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
});

test("private navigation is blocked by default", async () => {
  await assert.rejects(
    assertNavigationAllowed("http://127.0.0.1:9/", false),
    /private\/local browser navigation is disabled/,
  );
});

test("browser service navigates, snapshots, types, clicks, and screenshots", async (t) => {
  const executablePath = findExecutable();
  if (!executablePath) return t.skip("no Chromium executable available");
  const fixture = await startFixture();
  const service = new BrowserService({
    settings: { headless: true, executablePath, allowPrivateNetwork: true },
  });
  t.after(async () => {
    await service.stop();
    fixture.server.close();
  });

  const nav = await service.navigate("service-test", fixture.url);
  assert.equal(nav.status, 200);
  assert.match(nav.snapshot.text, /^TITLE: Browser Fixture$/m);
  assert.equal(nav.snapshot.interactiveCount, 3);
  assert.match(nav.snapshot.text, /\[redacted\]/);
  assert.doesNotMatch(nav.snapshot.text, /secret-value/);

  const emailRef = refFor(nav.snapshot, "input");
  const buttonRef = refFor(nav.snapshot, "button");
  assert.ok(emailRef);
  assert.ok(buttonRef);

  const typed = await service.type("service-test", { ref: emailRef, text: "a@b.test" });
  assert.match(typed.snapshot.text, /a@b\.test/);

  const clicked = await service.click("service-test", { ref: buttonRef });
  assert.match(clicked.snapshot.text, /hello a@b\.test/);

  const shot = await service.screenshot("service-test");
  assert.ok(fs.existsSync(shot.path));

  const tabs = await service.tabs("service-test", "list");
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0].current, true);

  const created = await service.tabs("service-test", "new");
  const selected = await service.tabs("service-test", "select", tabs.tabs[0].id);
  assert.equal(selected.tabId, tabs.tabs[0].id);
  const closed = await service.tabs("service-test", "close", created.tabId);
  assert.equal(closed.tabId, tabs.tabs[0].id);
  assert.equal(closed.tabs.length, 1);
});

test("browser_* tools expose refs and operate through the service", async (t) => {
  const executablePath = findExecutable();
  if (!executablePath) return t.skip("no Chromium executable available");
  const fixture = await startFixture();
  const service = new BrowserService({
    settings: { headless: true, executablePath, allowPrivateNetwork: true },
  });
  const tools = await loadTools();
  const exec = { sessionId: "tool-test", browser: service };
  t.after(async () => {
    await service.stop();
    fixture.server.close();
  });

  const nav = await tools.get("browser_navigate").run({ url: fixture.url }, exec);
  assert.equal(nav.meta.operation, "navigate");
  assert.match(nav.text, /^STATUS: 200$/m);
  const emailRef = refFor(nav.text, "input");
  assert.ok(emailRef);

  const typed = await tools.get("browser_type").run({ ref: emailRef, text: "tool@test" }, exec);
  assert.match(typed.text, /tool@test/);

  const tabs = await tools.get("browser_tabs").run({ action: "list" }, exec);
  assert.match(tabs.text, /tab-1 \[current\]/);

  const shot = await tools.get("browser_screenshot").run({}, exec);
  assert.ok(fs.existsSync(shot.meta.path));
});
