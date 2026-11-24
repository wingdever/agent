"use strict";

// browser_screenshot: save a PNG under the system temp directory.
import { requireBrowser } from "./../lib/browser/format.js";

export default {
  async run(args = {}, exec = {}) {
    const browser = requireBrowser(exec);
    const result = await browser.screenshot(exec.sessionId, { fullPage: args.full_page === true });
    return {
      text: [
        "SCREENSHOT: " + result.path,
        "URL: " + result.url,
        "TITLE: " + result.title,
        "TAB: " + result.tabId,
        "FULL_PAGE: " + (result.fullPage ? "yes" : "no"),
        "Read this path to inspect the PNG.",
      ].join("\n"),
      meta: {
        kind: "image",
        operation: "screenshot",
        path: result.path,
        url: result.url,
        title: result.title,
        tabId: result.tabId,
        fullPage: result.fullPage,
      },
    };
  },
};
