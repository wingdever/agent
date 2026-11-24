"use strict";

// One thin shell over the proxy capability.
//
// Design rule: do not map one tool per platform endpoint. Feishu's docs, sheets,
// calendar and messages would be dozens of tools and overwhelm the tool list. The
// model picks an `action`, this shell resolves the proxy from exec.capabilities and
// forwards the call. New actions are added in proxies/lark/actions.js, where scope
// and risk are declared next to the command they build.

const ACTIONS = ["whoami", "list_proxies", "doc.read", "doc.blocks", "doc.create", "doc.append", "doc.write", "drive.read", "sheet.read", "sheet.info", "sheet.write", "drive.list", "drive.delete", "drive.upload", "drive.export", "im.chats", "im.messages", "im.search", "drive.search", "im.send", "contact.resolve", "calendar.agenda", "calendar.create", "calendar.delete", "api"];

async function run(args = {}, exec = {}) {
  const action = args.action;
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new Error(`unknown action "${action}" (known: ${ACTIONS.join(", ")})`);
  }

  const capabilities = exec.capabilities;
  if (!capabilities || typeof capabilities.proxy !== "function") {
    throw new Error("no proxy capability in this run: Feishu person actions are unavailable");
  }

  if (action === "list_proxies") {
    return { text: JSON.stringify(capabilities.listProxies()) };
  }

  const proxy = capabilities.proxy(pickProxyId(args.proxy, capabilities));
  if (action === "whoami") {
    return { text: JSON.stringify({ proxy: proxy.instanceId, whoami: await proxy.whoami() }) };
  }

  const result = await proxy.call(action, args.params || {});
  return { text: JSON.stringify(result), meta: { proxy: proxy.instanceId, action } };
}

// With one proxy configured the id is redundant; with several, guessing would
// silently act as the wrong person, so the caller must name one.
function pickProxyId(explicit, capabilities) {
  if (explicit) return explicit;
  const known = capabilities.listProxies ? capabilities.listProxies() : [];
  if (known.length === 1) return known[0].instanceId;
  const ids = known.map((entry) => entry.instanceId);
  throw new Error(
    ids.length
      ? `several proxies are configured (${ids.join(", ")}); pass "proxy" explicitly`
      : "no proxy is configured"
  );
}

export { run, ACTIONS, pickProxyId };
export default { run };
