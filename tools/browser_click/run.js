"use strict";

// browser_click: click a ref/selector and return the resulting snapshot.
import { requireBrowser, renderSnapshot, snapshotMeta } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    if (!args.ref && !args.selector) throw new Error("provide ref or selector");
    const result = await browser.click(exec.sessionId, {
      ref: args.ref,
      selector: args.selector,
      includeText: args.interactive_only !== true,
      maxChars: args.max_chars,
    });
    return {
      text: renderSnapshot(result.snapshot, ["CLICKED: " + result.clicked]),
      meta: snapshotMeta({ operation: "click", target: result.clicked }, result.snapshot),
    };
  },
};
