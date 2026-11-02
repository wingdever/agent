// Markdown rendering for text cards (thought / answer).
// - Untrusted model output: marked parses, DOMPurify sanitizes.
// - Streaming: raw text accumulates and repaints at most once per THROTTLE ms.
// - Oversized replies fall back to plain text to keep per-frame cost bounded.
// - Fenced code blocks get a CSS-counter line-number gutter (see styles.css).
(function () {
  "use strict";

  var MAX_MARKDOWN_CHARS = 32 * 1024;
  var THROTTLE_MS = 80;
  var states = new WeakMap();

  function hasLibs() {
    return typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined";
  }

  function stateOf(el) {
    var s = states.get(el);
    if (!s) {
      s = { raw: "", last: null, timer: null, plain: false };
      states.set(el, s);
    }
    return s;
  }

  function plainPaint(el, s) {
    el.classList.add("textcard-plain");
    el.textContent = s.raw;
    s.last = s.raw;
    s.timer = null;
  }

  function decorateCode(code) {
    var pre = code.parentNode;
    if (!pre || pre.tagName !== "PRE") return;
    var source = code.textContent.replace(/\n$/, "");
    var lines = source.split("\n");
    code.textContent = "";
    for (var i = 0; i < lines.length; i++) {
      var span = document.createElement("span");
      span.className = "code-line";
      span.textContent = lines[i];
      code.appendChild(span);
    }
    code.classList.add("code-lines");

    var match = /(?:^|\s)language-([\w.+#-]+)/.exec(code.className || "");
    var lang = match ? match[1] : "";

    var block = document.createElement("div");
    block.className = "code-block";
    pre.parentNode.insertBefore(block, pre);
    block.appendChild(pre);
    if (lang) {
      var head = document.createElement("div");
      head.className = "code-lang";
      head.textContent = lang;
      block.insertBefore(head, pre);
    }
  }

  function decorate(el) {
    var links = el.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      links[i].target = "_blank";
      links[i].rel = "noopener noreferrer";
    }
    var images = el.querySelectorAll("img");
    for (var j = 0; j < images.length; j++) {
      images[j].loading = "lazy";
      images[j].referrerPolicy = "no-referrer";
      images[j].addEventListener("error", function () { this.hidden = true; });
    }
    var codes = el.querySelectorAll("pre > code");
    for (var k = 0; k < codes.length; k++) decorateCode(codes[k]);
  }

  function paint(el) {
    var s = stateOf(el);
    s.timer = null;
    if (s.raw === s.last) return;
    if (s.plain || s.raw.length > MAX_MARKDOWN_CHARS || !hasLibs()) {
      s.plain = s.plain || s.raw.length > MAX_MARKDOWN_CHARS || !hasLibs();
      plainPaint(el, s);
      return;
    }
    try {
      var html = window.marked.parse(s.raw, { gfm: true, breaks: true });
      var clean = window.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_ATTR: ["style"],
      });
      el.classList.remove("textcard-plain");
      el.innerHTML = clean;
      decorate(el);
      s.last = s.raw;
    } catch (e) {
      // A streaming tail can be unparsable for one frame; retry on the next append.
      el.classList.add("textcard-plain");
      el.textContent = s.raw;
      s.last = null;
    }
  }

  function schedule(el) {
    var s = stateOf(el);
    if (s.timer) return;
    s.timer = window.setTimeout(function () { paint(el); }, THROTTLE_MS);
  }

  function set(el, text) {
    if (!el) return;
    var s = stateOf(el);
    if (s.timer) { window.clearTimeout(s.timer); s.timer = null; }
    s.raw = text || "";
    s.plain = false;
    paint(el);
  }

  function append(el, delta) {
    if (!el || !delta) return;
    var s = stateOf(el);
    s.raw += delta;
    schedule(el);
  }

  function flush(el) {
    if (!el) return;
    var s = stateOf(el);
    if (s.timer) { window.clearTimeout(s.timer); s.timer = null; }
    if (s.raw !== s.last) paint(el);
  }

  window.AgentMarkdown = { set: set, append: append, flush: flush };
})();
