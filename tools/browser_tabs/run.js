"use strict";

// browser_tabs: tab lifecycle and selection within one session context.
import { requireBrowser, renderSnapshot, renderTabs } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    const action = typeof args.action === "string" ? args.action : "list";
    const result = await browser.tabs(exec.sessionId, action, args.tab_id || null);
    if (action === "list") {
      return {
        text: "TABS:\n" + renderTabs(result.tabs),
        meta: { kind: "browser", operation: "tabs", action, count: result.tabs.length },
      };
    }
    return {
      text: renderSnapshot(result.snapshot, [
        "TAB: " + result.tabId,
        "TABS:",
        renderTabs(result.tabs),
      ]),
      meta: {
        kind: "browser",
        operation: "tabs",
        action,
        tabId: result.tabId,
        url: result.snapshot ? result.snapshot.url : null,
        title: result.snapshot ? result.snapshot.title : null,
      },
    };
  },
};
