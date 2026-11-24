"use strict";

// Run-once consent helper for the oauth proxy route.
//
// The proxy can refresh forever, but only after a human approved once. This script
// is that one time: it prints the consent URL, waits on a loopback callback,
// exchanges the code and writes the token file the proxy reads at startup.
//
// It never prints token values -- a terminal scrollback is a bad place for a
// refresh token. What it does print is whether a refresh token was issued at all,
// because "no refresh token" is the failure mode that looks like success.
//
// Usage:
//   node scripts/oauth-consent.js --instance me-oauth
//   node scripts/oauth-consent.js --instance me-oauth --port 47653
//   node scripts/oauth-consent.js --instance me-oauth --print-url   (link only)
//
// The redirect URI must be registered in the app's 安全设置 → 重定向 URL, or the
// platform refuses to redirect back.

import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./../lib/paths/index.js";
import { applyEnvOverrides } from "./../accounts/registry-kit.js";
import {
  buildAuthorizeUrl,
  DEFAULT_ACCOUNTS_BASE,
  ensureOfflineScope,
  runConsent,
} from "./../proxies/lark/consent.js";
import { createFileTokenStore } from "./../proxies/lark/token-store.js";

const DEFAULT_SCOPES = ["docx:document:readonly", "drive:drive:readonly"];

function parseArgs(argv) {
  const args = {
    config: path.join(PROJECT_ROOT, "user", "proxies.json"),
    port: 0,
    timeoutMs: 10 * 60 * 1000,
    printUrl: false,
    instance: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--instance") args.instance = argv[++i] || "";
    else if (arg === "--port") args.port = Number(argv[++i]) || 0;
    else if (arg === "--timeout") args.timeoutMs = (Number(argv[++i]) || 600) * 1000;
    else if (arg === "--config") args.config = path.resolve(argv[++i] || args.config);
    else if (arg === "--print-url") args.printUrl = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return args;
}

function pickInstance(instances, wanted) {
  const oauthOnes = instances.filter((entry) => entry && entry.type === "lark" && (!entry.options || entry.options.impl === "oauth"));
  if (wanted) {
    const found = instances.find((entry) => entry && entry.id === wanted);
    if (!found) throw new Error(`no proxy instance "${wanted}" in config (known: ${instances.map((i) => i.id).join(", ") || "none"})`);
    return found;
  }
  if (oauthOnes.length === 1) return oauthOnes[0];
  throw new Error(
    oauthOnes.length
      ? `several oauth lark instances (${oauthOnes.map((i) => i.id).join(", ")}); pass --instance`
      : "no oauth lark instance in config; pass --instance or add one"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/oauth-consent.js --instance <id> [--port N] [--timeout SECONDS] [--print-url]");
    return 0;
  }
  if (!fs.existsSync(args.config)) throw new Error(`config not found: ${args.config}`);

  const raw = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const instances = (raw.proxies || []).map((entry) => applyEnvOverrides(entry, "PROXY"));
  const instance = pickInstance(instances, args.instance);

  const credentials = instance.credentials || {};
  const clientId = credentials.clientId || credentials.appId;
  const clientSecret = credentials.clientSecret || credentials.appSecret;
  if (!clientId) throw new Error(`instance "${instance.id}" has no credentials.clientId`);

  const options = instance.options || {};
  const scopes = Array.isArray(instance.scopes) && instance.scopes.length ? instance.scopes : DEFAULT_SCOPES;
  const accountsBase = options.accountsBase || DEFAULT_ACCOUNTS_BASE;
  const tokenFile = options.tokensFile || path.join(PROJECT_ROOT, "user", "oauth", `${instance.id}.json`);

  if (args.printUrl) {
    const redirectUri = `http://127.0.0.1:${args.port || 47653}/callback`;
    console.log(`redirect_uri (must be registered on the app): ${redirectUri}`);
    console.log(
      buildAuthorizeUrl({ clientId, redirectUri, state: "print-only", scopes, accountsBase })
    );
    return 0;
  }

  if (!clientSecret) {
    throw new Error(
      `instance "${instance.id}" has no clientSecret; export PROXY_${String(instance.id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENTSECRET or put it in config`
    );
  }

  const store = createFileTokenStore({ file: tokenFile });
  console.log(`[consent] instance=${instance.id} scopes=${ensureOfflineScope(scopes).join(" ")}`);
  console.log(`[consent] token file (0600): ${tokenFile}`);

  const result = await runConsent({
    clientId,
    clientSecret,
    scopes,
    store,
    port: args.port,
    timeoutMs: args.timeoutMs,
    baseUrl: String(options.baseUrl || "https://open.feishu.cn").replace(/\/+$/, ""),
    accountsBase,
    log: (line) => console.log(line),
  });

  console.log(`[consent] done. scope="${result.scope}" expiresAt=${result.expiresAt ? new Date(result.expiresAt).toISOString() : "unknown"}`);
  if (!result.hasRefreshToken) {
    console.log(
      "[consent] WARNING: the platform issued no refresh_token. The grant will die with the access token.\n" +
        "          Cause is almost always a missing offline_access permission on the app (权限管理 → 申请 offline_access).\n" +
        "          Re-run this script after the permission is approved."
    );
    return 1;
  }
  console.log("[consent] refresh token stored; the proxy will now start from it.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[consent] failed: ${(err && err.message) || err}`);
    process.exitCode = 1;
  });
