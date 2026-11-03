"use strict";

// Public-address resolution for web_fetch. One DNS answer set is validated
// before the connection is made, and the validated address is pinned through
// Node's `lookup` hook so the socket cannot re-resolve the hostname to a
// private destination. Mirrors DSH's web-fetch-http network policy, minus its
// NAT64/HTTP-proxy integration.

const dns = require("dns");
const net = require("net");
const ipaddr = require("ipaddr.js");

const { WebToolError } = require("./errors");

// WHATWG URL keeps brackets around IPv6 hostnames; IP parsers do not.
function stripIpv6Brackets(hostname) {
  const text = String(hostname == null ? "" : hostname);
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

// Whether an address is globally reachable unicast. IPv4-mapped IPv6 is judged
// by the embedded address; transition prefixes stay blocked.
function isPublicIpAddress(input) {
  let parsed;
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input));
  } catch (_) {
    return false;
  }
  if (parsed.kind() === "ipv4") return parsed.range() === "unicast";
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === "unicast";
  return parsed.range() === "unicast";
}

function lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, order: "verbatim" }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

// Resolve a hostname once and reject the whole answer set if any destination
// is not public. The returned addresses are the only ones the transport may
// use. `resolver` exists for tests; production callers use dns.lookup.
async function resolvePublicAddresses(hostname, signal, resolver = lookupAll) {
  const unbracketed = stripIpv6Brackets(hostname);
  const literalFamily = net.isIP(unbracketed);
  const resolved =
    literalFamily === 0
      ? await raceWithSignal(resolver(unbracketed), signal)
      : [{ address: unbracketed, family: literalFamily }];

  if (resolved.length === 0) {
    throw new WebToolError('hostname "' + hostname + '" resolved to no addresses');
  }

  const addresses = [];
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || net.isIP(entry.address) !== entry.family) {
      throw new WebToolError('hostname "' + hostname + '" resolved to an invalid IP address');
    }
    if (!isPublicIpAddress(entry.address)) {
      throw new WebToolError('URL hostname "' + hostname + '" resolves to a non-public IP address');
    }
    addresses.push({ address: entry.address, family: entry.family });
  }
  return addresses;
}

// Node connection lookup that only ever exposes already-validated addresses.
// Returning the full set for `all` lets Node's happy-eyeballs logic fall back
// across families without a second DNS answer.
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (options && options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  };
}

module.exports = {
  isPublicIpAddress,
  resolvePublicAddresses,
  pinnedLookup,
  stripIpv6Brackets,
};
