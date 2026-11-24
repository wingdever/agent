"use strict";

// Session-scoped browser automation. One Chromium process is shared by the
// agent; every session gets an isolated BrowserContext and its own tabs.
// This layer owns page lifecycle and the ref-based snapshot; tools only
// translate arguments into operations here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { chromium } from "playwright-core";
import config from "../config/index.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  headless: true,
  executablePath: null,
  timeoutMs: 30000,
  navigationTimeoutMs: 45000,
  snapshotMaxChars: 12000,
  maxInteractive: 200,
  viewport: { width: 1280, height: 800 },
  locale: "zh-CN",
  userAgent: null,
  idleTimeoutMs: 15 * 60 * 1000,
  allowPrivateNetwork: false,
};

function readBrowserSettings(settings) {
  const fromConfig = (config.readSettings() || {}).browser || {};
  return Object.assign({}, DEFAULT_SETTINGS, fromConfig, settings || {});
}

function normalizeViewport(value) {
  const v = value || {};
  const width = Number(v.width);
  const height = Number(v.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.floor(width) : DEFAULT_SETTINGS.viewport.width,
    height: Number.isFinite(height) && height > 0 ? Math.floor(height) : DEFAULT_SETTINGS.viewport.height,
  };
}

function existingFile(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function findExecutable(configured) {
  const candidates = [
    configured,
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/usr/local/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) {
    if (existingFile(candidate)) return candidate;
  }
  return null;
}

function isHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch (_) {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function clampText(text, max) {
  if (typeof text !== "string") return "";
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 12000;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n… [snapshot truncated]";
}

function stripIpv6Brackets(hostname) {
  const text = String(hostname == null ? "" : hostname);
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

function isPublicIp(input) {
  try {
    const parsed = ipaddr.parse(stripIpv6Brackets(input));
    if (parsed.kind() === "ipv4") return parsed.range() === "unicast";
    if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === "unicast";
    return parsed.range() === "unicast";
  } catch (_) {
    return false;
  }
}

function isLocalHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0";
}

async function assertNavigationAllowed(rawUrl, allowPrivate = false) {
  const url = new URL(String(rawUrl || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser navigation only supports http(s) URLs");
  }
  if (url.username || url.password) throw new Error("credentials in browser URLs are not allowed");
  if (allowPrivate) return url;
  const host = stripIpv6Brackets(url.hostname);
  if (isLocalHostname(host)) {
    throw new Error("private/local browser navigation is disabled (browser.allowPrivateNetwork=false)");
  }
  if (net.isIP(host)) {
    if (!isPublicIp(host)) {
      throw new Error("private/local browser navigation is disabled (browser.allowPrivateNetwork=false)");
    }
    return url;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error("cannot resolve browser navigation hostname: " + (error && error.message ? error.message : error));
  }
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error("browser navigation hostname resolves to a non-public address");
  }
  return url;
}

function isLikelyPrivateNavigation(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol === "file:" || url.protocol === "javascript:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = stripIpv6Brackets(url.hostname);
    if (isLocalHostname(host)) return true;
    return net.isIP(host) ? !isPublicIp(host) : false;
  } catch (_) {
    return true;
  }
}

function buildSnapshotText(raw, maxChars) {
  const lines = [];
  lines.push("URL: " + raw.url);
  lines.push("TITLE: " + raw.title);
  lines.push("");
  lines.push("INTERACTIVE:");
  if (!raw.interactive.length) {
    lines.push("(none)");
  } else {
    for (const item of raw.interactive) {
      const bits = [item.tag];
      if (item.role && item.role !== item.tag) bits.push("[" + item.role + "]");
      let line = "- " + item.ref + " " + bits.join(" ");
      if (item.label) line += " " + JSON.stringify(item.label);
      const extra = [];
      if (item.type) extra.push("type=" + item.type);
      if (item.name) extra.push("name=" + JSON.stringify(item.name));
      if (item.placeholder) extra.push("placeholder=" + JSON.stringify(item.placeholder));
      if (item.href) extra.push("href=" + JSON.stringify(item.href));
      if (item.value != null && item.value !== "") extra.push("value=" + JSON.stringify(item.value));
      if (item.checked != null) extra.push("checked=" + String(item.checked));
      if (item.disabled) extra.push("disabled");
      if (extra.length) line += " [" + extra.join(" ") + "]";
      lines.push(line);
    }
  }
  if (raw.headings.length) {
    lines.push("");
    lines.push("HEADINGS:");
    for (const h of raw.headings) lines.push("- " + h.level + " " + JSON.stringify(h.text));
  }
  if (raw.text) {
    lines.push("");
    lines.push("TEXT:");
    lines.push(raw.text);
  }
  if (raw.interactiveMore) {
    lines.push("");
    lines.push("(" + raw.interactiveMore + " more interactive elements omitted; use selector or a narrower snapshot)");
  }
  return clampText(lines.join("\n"), maxChars);
}

async function evaluateSnapshot(page, { maxInteractive, includeText }) {
  return page.evaluate(({ maxInteractive, includeText }) => {
    const SELECTOR = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "textarea",
      "select",
      "[contenteditable=true]",
      "[role=button]",
      "[role=link]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=menuitem]",
      "[role=tab]",
      "[role=combobox]",
      "[role=textbox]",
      "summary",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function visible(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.closest("[aria-hidden=true]")) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function clean(value, max) {
      return String(value == null ? "" : value)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max || 120);
    }

    function labelOf(el) {
      const tag = el.tagName.toLowerCase();
      const aria = el.getAttribute("aria-label");
      const placeholder = el.getAttribute("placeholder");
      const value = tag === "input" && el.type !== "password" ? el.value : "";
      const text = el.innerText || el.textContent || "";
      return clean(aria || text || value || placeholder || el.getAttribute("name") || el.getAttribute("title"));
    }

    const all = Array.from(document.querySelectorAll(SELECTOR)).filter(visible);
    const interactive = [];
    let seq = Number(window.__doubaoRefSeq || 0);
    for (const el of all) {
      let ref = el.getAttribute("data-doubao-ref");
      if (!ref) {
        seq += 1;
        ref = "e" + seq;
        el.setAttribute("data-doubao-ref", ref);
      }
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || null;
      const item = {
        ref,
        tag,
        role,
        label: labelOf(el),
        type: tag === "input" ? (el.getAttribute("type") || "text") : null,
        name: el.getAttribute("name") || null,
        placeholder: el.getAttribute("placeholder") || null,
        href: tag === "a" ? (el.getAttribute("href") || null) : null,
        value: tag === "input" || tag === "textarea" || tag === "select" ? clean(el.value, 80) : null,
        checked: tag === "input" && (el.type === "checkbox" || el.type === "radio") ? Boolean(el.checked) : null,
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      };
      if (tag === "input" && el.type === "password" && item.value) item.value = "[redacted]";
      if (el.tagName.toLowerCase() === "select") {
        const option = el.options && el.options[el.selectedIndex];
        item.value = option ? clean(option.textContent, 80) : item.value;
      }
      interactive.push(item);
      if (interactive.length >= maxInteractive) break;
    }
    window.__doubaoRefSeq = seq;

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"))
      .filter(visible)
      .slice(0, 40)
      .map((el) => ({
        level: /^h[1-6]$/i.test(el.tagName) ? el.tagName.toLowerCase() : (el.getAttribute("aria-level") || "heading"),
        text: clean(el.innerText || el.textContent, 160),
      }))
      .filter((h) => h.text);

    const bodyText = includeText && document.body
      ? String(document.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000)
      : "";
    return {
      url: location.href,
      title: document.title || "",
      interactive,
      interactiveMore: Math.max(0, all.length - interactive.length),
      headings,
      text: bodyText,
    };
  }, { maxInteractive, includeText });
}

class BrowserService {
  constructor({ settings, logger } = {}) {
    this.settings = readBrowserSettings(settings);
    this.logger = logger || console;
    this.browser = null;
    this.sessions = new Map();
    this.starting = null;
    this.lastSweep = 0;
    this.screenshotDir = path.join(os.tmpdir(), "micro-agent-browser");
  }

  get enabled() {
    return this.settings.enabled !== false;
  }

  async start() {
    if (!this.enabled) throw new Error("browser is disabled in settings (browser.enabled=false)");
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const executablePath = findExecutable(this.settings.executablePath);
      if (!executablePath) {
        throw new Error(
          "no Chromium executable found; set browser.executablePath in user/settings.json or BROWSER_EXECUTABLE_PATH"
        );
      }
      this.browser = await chromium.launch({
        executablePath,
        headless: this.settings.headless !== false,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        timeout: this.settings.timeoutMs,
      });
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.sessions.clear();
      });
      return this.browser;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async contextFor(sessionId) {
    const key = String(sessionId || "default");
    const now = Date.now();
    if (now - this.lastSweep > 60 * 1000) {
      this.lastSweep = now;
      await this.sweepIdle(now).catch(() => {});
    }
    let entry = this.sessions.get(key);
    if (entry && entry.context && !entry.context.isClosed()) {
      entry.lastUsed = now;
      return entry;
    }
    const browser = await this.start();
    const context = await browser.newContext({
      viewport: normalizeViewport(this.settings.viewport),
      locale: this.settings.locale || "zh-CN",
      userAgent: this.settings.userAgent || undefined,
      acceptDownloads: false,
    });
    context.setDefaultTimeout(this.settings.timeoutMs);
    context.setDefaultNavigationTimeout(this.settings.navigationTimeoutMs);
    if (this.settings.allowPrivateNetwork !== true) {
      await context.route("**/*", async (route) => {
        if (isLikelyPrivateNavigation(route.request().url())) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
    }
    entry = {
      sessionId: key,
      context,
      tabs: [],
      currentId: null,
      seq: 0,
      lastUsed: Date.now(),
    };
    this.sessions.set(key, entry);
    context.on("page", (page) => {
      if (!this.findTab(entry, page)) this.registerPage(entry, page);
    });
    context.on("close", () => {
      this.sessions.delete(key);
    });
    return entry;
  }

  findTab(entry, page) {
    return entry.tabs.find((tab) => tab.page === page) || null;
  }

  registerPage(entry, page) {
    const existing = this.findTab(entry, page);
    if (existing) {
      entry.currentId = existing.id;
      return existing;
    }
    const tab = { id: "tab-" + (++entry.seq), page };
    entry.tabs.push(tab);
    entry.currentId = tab.id;
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => {});
    });
    page.on("close", () => {
      const index = entry.tabs.findIndex((t) => t.id === tab.id);
      if (index >= 0) entry.tabs.splice(index, 1);
      if (entry.currentId === tab.id) {
        entry.currentId = entry.tabs.length ? entry.tabs[entry.tabs.length - 1].id : null;
      }
    });
    return tab;
  }

  async currentPage(sessionId) {
    const entry = await this.contextFor(sessionId);
    let tab = entry.tabs.find((t) => t.id === entry.currentId && !t.page.isClosed());
    if (tab) return { entry, tab };
    tab = entry.tabs.find((t) => !t.page.isClosed()) || null;
    if (tab) {
      entry.currentId = tab.id;
      return { entry, tab };
    }
    const page = await entry.context.newPage();
    tab = this.findTab(entry, page) || this.registerPage(entry, page);
    entry.currentId = tab.id;
    return { entry, tab };
  }

  async tabInfo(entry, tab) {
    const page = tab.page;
    let title = "";
    try {
      title = page.isClosed() ? "" : await page.title();
    } catch (_) {}
    return { id: tab.id, url: page.url(), title, current: tab.id === entry.currentId };
  }

  async sessionTabs(entry) {
    return Promise.all(entry.tabs.map((tab) => this.tabInfo(entry, tab)));
  }

  async withPage(sessionId, fn) {
    const { entry, tab } = await this.currentPage(sessionId);
    try {
      return await fn(tab.page, entry, tab);
    } finally {
      entry.lastUsed = Date.now();
    }
  }

  async navigate(sessionId, url, { newTab = false } = {}) {
    if (!isHttpUrl(url)) throw new Error("url must be an absolute http(s) URL");
    await assertNavigationAllowed(url, this.settings.allowPrivateNetwork === true);
    let target = null;
    if (newTab) {
      const entry = await this.contextFor(sessionId);
      target = await entry.context.newPage();
      this.registerPage(entry, target);
    }
    return this.withPage(sessionId, async (page, entry) => {
      const targetPage = target || page;
      const response = await targetPage.goto(String(url).trim(), {
        waitUntil: "domcontentloaded",
        timeout: this.settings.navigationTimeoutMs,
      });
      await targetPage.waitForTimeout(300).catch(() => {});
      const tab = this.findTab(entry, targetPage);
      return {
        url: targetPage.url(),
        title: await targetPage.title().catch(() => ""),
        status: response ? response.status() : null,
        tabId: tab ? tab.id : null,
        snapshot: await this.snapshotPage(targetPage, {}),
      };
    });
  }

  async snapshotPage(page, options = {}) {
    const maxInteractive = Number(options.maxInteractive) > 0
      ? Math.floor(Number(options.maxInteractive))
      : this.settings.maxInteractive;
    const includeText = options.includeText !== false;
    const raw = await evaluateSnapshot(page, { maxInteractive, includeText });
    const requestedChars = Number(options.maxChars);
    const maxChars = Number.isFinite(requestedChars) && requestedChars > 0
      ? Math.min(Math.floor(requestedChars), 200000)
      : this.settings.snapshotMaxChars;
    const text = buildSnapshotText(raw, maxChars);
    return {
      url: raw.url,
      title: raw.title,
      text,
      interactiveCount: raw.interactive.length,
      truncated: text.includes("[snapshot truncated]"),
    };
  }

  async snapshot(sessionId, options = {}) {
    return this.withPage(sessionId, async (page) => this.snapshotPage(page, options));
  }

  locatorFor(page, args = {}) {
    const ref = typeof args.ref === "string" ? args.ref.trim() : "";
    const selector = typeof args.selector === "string" ? args.selector.trim() : "";
    if (ref) {
      if (!/^e\d+$/.test(ref)) throw new Error('ref must look like "e12"');
      return page.locator('[data-doubao-ref="' + ref + '"]');
    }
    if (selector) return page.locator(selector);
    throw new Error("provide ref from browser_snapshot or a CSS selector");
  }

  async resolveLocator(page, args) {
    const locator = this.locatorFor(page, args);
    const count = await locator.count();
    if (count === 0) throw new Error("element not found; take a new browser_snapshot and use its latest ref");
    return locator.first();
  }

  async click(sessionId, args = {}) {
    return this.withPage(sessionId, async (page) => {
      const locator = await this.resolveLocator(page, args);
      await locator.waitFor({ state: "visible", timeout: this.settings.timeoutMs });
      await locator.click({ timeout: this.settings.timeoutMs });
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
      return { snapshot: await this.snapshotPage(page, args), clicked: args.ref || args.selector };
    });
  }

  async type(sessionId, args = {}) {
    const text = typeof args.text === "string" ? args.text : "";
    return this.withPage(sessionId, async (page) => {
      const locator = await this.resolveLocator(page, args);
      await locator.waitFor({ state: "visible", timeout: this.settings.timeoutMs });
      try {
        await locator.fill(text, { timeout: this.settings.timeoutMs });
      } catch (_) {
        await locator.click({ timeout: this.settings.timeoutMs });
        await page.keyboard.press("Control+A");
        await page.keyboard.type(text);
      }
      if (args.submit === true) await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
      return { snapshot: await this.snapshotPage(page, args), typed: args.ref || args.selector };
    });
  }

  async press(sessionId, key, options = {}) {
    if (!key) throw new Error("key is required");
    return this.withPage(sessionId, async (page) => {
      await page.keyboard.press(key);
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200).catch(() => {});
      return { snapshot: await this.snapshotPage(page, options), key };
    });
  }

  async screenshot(sessionId, { fullPage = false } = {}) {
    return this.withPage(sessionId, async (page, entry, tab) => {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
      const safeSession = String(entry.sessionId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const file = path.join(
        this.screenshotDir,
        `${safeSession}-${tab.id}-${Date.now()}.png`,
      );
      await page.screenshot({ path: file, fullPage: fullPage === true });
      return {
        path: file,
        tabId: tab.id,
        url: page.url(),
        title: await page.title().catch(() => ""),
        fullPage: fullPage === true,
      };
    });
  }

  async tabs(sessionId, action = "list", tabId = null) {
    const entry = await this.contextFor(sessionId);
    if (action === "new") {
      const page = await entry.context.newPage();
      const tab = this.registerPage(entry, page);
      entry.currentId = tab.id;
      return this.tabResult(entry, tab);
    }
    if (action === "select") {
      const tab = entry.tabs.find((t) => t.id === tabId) || null;
      if (!tab) throw new Error("tab not found: " + String(tabId || ""));
      entry.currentId = tab.id;
      await tab.page.bringToFront().catch(() => {});
      return this.tabResult(entry, tab);
    }
    if (action === "close") {
      const targetId = tabId || entry.currentId;
      const tab = entry.tabs.find((t) => t.id === targetId) || null;
      if (!tab) throw new Error("tab not found: " + String(targetId || ""));
      await tab.page.close().catch(() => {});
      const rest = entry.tabs.filter((t) => t.id !== tab.id);
      if (entry.currentId === tab.id) entry.currentId = rest.length ? rest[rest.length - 1].id : null;
      const next = rest.find((t) => t.id === entry.currentId) || (rest.length ? rest[rest.length - 1] : null);
      if (!next) {
        const page = await entry.context.newPage();
        const created = this.registerPage(entry, page);
        return this.tabResult(entry, created);
      }
      entry.currentId = next.id;
      return this.tabResult(entry, next);
    }
    if (action !== "list") throw new Error('action must be "list", "new", "select" or "close"');
    return {
      tabs: await this.sessionTabs(entry),
      currentId: entry.currentId,
    };
  }

  async tabResult(entry, tab) {
    return {
      tabId: tab.id,
      tabs: await this.sessionTabs(entry),
      snapshot: await this.snapshotPage(tab.page, {}),
    };
  }

  async closeSession(sessionId) {
    const key = String(sessionId || "default");
    const entry = this.sessions.get(key);
    if (!entry) return false;
    this.sessions.delete(key);
    await entry.context.close().catch(() => {});
    return true;
  }

  async sweepIdle(now = Date.now()) {
    const idle = Number(this.settings.idleTimeoutMs) || 0;
    if (idle <= 0) return 0;
    let closed = 0;
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUsed >= idle) {
        this.sessions.delete(key);
        await entry.context.close().catch(() => {});
        closed += 1;
      }
    }
    return closed;
  }

  async stop() {
    this.sessions.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

const __exports = {
  BrowserService,
  DEFAULT_SETTINGS,
  buildSnapshotText,
  isHttpUrl,
  findExecutable,
  isPublicIp,
  isLocalHostname,
  assertNavigationAllowed,
};
export {
  BrowserService,
  DEFAULT_SETTINGS,
  buildSnapshotText,
  isHttpUrl,
  findExecutable,
  isPublicIp,
  isLocalHostname,
  assertNavigationAllowed,
};
export default BrowserService;
