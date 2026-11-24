"use strict";

// web_fetch: retrieve one URL under the DSH public-network policy and render
// the response as bounded markdown/text.

import { DEFAULTS } from "./../lib/web/config.js";
import { HttpFetcher } from "./../lib/web/transport.js";
import { renderFetchOutput } from "./../lib/web/render.js";

const fetcher = new HttpFetcher();

export default {
  async run(args = {}, exec = {}) {
    const url = typeof args.url === "string" ? args.url : "";
    if (url.trim().length === 0) throw new Error("url must be a non-empty string");

    const result = await fetcher.fetch(url, exec.signal);
    const rendered = renderFetchOutput(result, DEFAULTS.fetchMaxOutputChars);

    return {
      text: rendered.text,
      meta: {
        kind: "web",
        operation: "fetch",
        url: result.url,
        statusCode: result.statusCode,
        truncated: rendered.truncated,
      },
    };
  },
};
