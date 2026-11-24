"use strict";

// Shared formatting and guards for browser_* tools. The service returns
// structured values; tools render one bounded text block for the model.

export function requireBrowser(exec) {
  if (!exec || !exec.browser) {
    throw new Error("browser service is not available in this execution context");
  }
  return exec.browser;
}

export function renderSnapshot(snapshot, extraLines = []) {
  const head = [];
  for (const line of extraLines) if (line) head.push(line);
  if (snapshot) {
    head.push("URL: " + snapshot.url);
    head.push("TITLE: " + snapshot.title);
    if (typeof snapshot.interactiveCount === "number") {
      head.push("INTERACTIVE_COUNT: " + snapshot.interactiveCount);
    }
    if (snapshot.text) {
      head.push("");
      head.push(snapshot.text);
    }
  }
  return head.join("\n");
}

export function renderTabs(tabs) {
  if (!tabs || !tabs.length) return "(no tabs)";
  return tabs
    .map((tab) => "- " + tab.id + (tab.current ? " [current]" : "") + " " + (tab.title || "(untitled)") + " " + tab.url)
    .join("\n");
}

export function snapshotMeta(meta, snapshot) {
  return Object.assign(
    {
      kind: "browser",
      operation: meta.operation,
      url: snapshot ? snapshot.url : null,
      title: snapshot ? snapshot.title : null,
      truncated: snapshot ? snapshot.truncated : false,
    },
    meta || {},
  );
}
