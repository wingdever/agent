"use strict";

// browser_type: fill one field, optionally submit, then snapshot.
import { requireBrowser, renderSnapshot, snapshotMeta } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    if (!args.ref && !args.selector) throw new Error("provide ref or selector");
    if (typeof args.text !== "string") throw new Error("text must be a string");
    const result = await browser.type(exec.sessionId, {
      ref: args.ref,
      selector: args.selector,
      text: args.text,
      submit: args.submit === true,
      includeText: args.interactive_only !== true,
      maxChars: args.max_chars,
    });
    return {
      text: renderSnapshot(result.snapshot, [
        "TYPED: " + result.typed,
        "SUBMIT: " + (args.submit === true ? "yes" : "no"),
      ]),
      meta: snapshotMeta(
        { operation: "type", target: result.typed, submit: args.submit === true },
        result.snapshot,
      ),
    };
  },
};
