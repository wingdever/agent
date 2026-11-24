"use strict";

// browser_snapshot: inspect the current page without changing it.
import { requireBrowser, renderSnapshot, snapshotMeta } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    const snapshot = await browser.snapshot(exec.sessionId, {
      includeText: args.interactive_only !== true,
      maxChars: args.max_chars,
    });
    return {
      text: renderSnapshot(snapshot),
      meta: snapshotMeta({ operation: "snapshot" }, snapshot),
    };
  },
};
