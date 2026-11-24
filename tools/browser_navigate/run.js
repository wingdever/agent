"use strict";

// browser_navigate: open an http(s) URL in the session's current or new tab.
import { requireBrowser, renderSnapshot, snapshotMeta } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) throw new Error("url must be a non-empty string");
    const result = await browser.navigate(exec.sessionId, url, { newTab: args.new_tab === true });
    return {
      text: renderSnapshot(result.snapshot, [
        "STATUS: " + (result.status == null ? "n/a" : result.status),
        "TAB: " + (result.tabId || "?"),
        "NEW_TAB: " + (args.new_tab === true ? "yes" : "no"),
      ]),
      meta: snapshotMeta(
        { operation: "navigate", tabId: result.tabId, status: result.status, newTab: args.new_tab === true },
        result.snapshot,
      ),
    };
  },
};
