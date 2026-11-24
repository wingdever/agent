"use strict";

// browser_press: send one keyboard key to the current page.
import { requireBrowser, renderSnapshot, snapshotMeta } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    const key = typeof args.key === "string" ? args.key.trim() : "";
    if (!key) throw new Error("key must be a non-empty string");
    const result = await browser.press(exec.sessionId, key, {
      includeText: args.interactive_only !== true,
      maxChars: args.max_chars,
    });
    return {
      text: renderSnapshot(result.snapshot, ["PRESSED: " + result.key]),
      meta: snapshotMeta({ operation: "press", key }, result.snapshot),
    };
  },
};
