const dns = require('dns');
const { fetch, Agent } = require('undici');

function ipv4Lookup(hostname, options, callback) {
  dns.lookup(hostname, { family: 4, all: false }, callback);
}

const connectOpts = {
  lookup: ipv4Lookup,
  family: 4,
  autoSelectFamily: false,
};

const ipv4Dispatcher = new Agent({ connect: connectOpts });

// Some origins (reddit.com HTML from datacenter IPs) fail over HTTP/2 while CDN assets work.
const ipv4Http1Dispatcher = new Agent({
  connect: connectOpts,
  allowH2: false,
});

const CONNECT_RETRY_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function isConnectFailure(err) {
  const code = err?.cause?.code || err?.code;
  return CONNECT_RETRY_CODES.has(code);
}

function upstreamFetch(url, init = {}) {
  const dispatcher = init.dispatcher ?? ipv4Dispatcher;
  return fetch(url, { ...init, dispatcher }).catch((err) => {
    // Forced IPv4 uses dns.lookup(all: false) — only the first A record. Some
    // Cloudflare anycast nodes refuse connections on certain routes while a
    // sibling address works; the system resolver / undici default path retries
    // other records. Fall back when the pinned IPv4 attempt cannot connect.
    if (init.dispatcher || !isConnectFailure(err)) throw err;
    return fetch(url, { ...init, dispatcher: undefined });
  });
}

module.exports = { upstreamFetch, ipv4Dispatcher, ipv4Http1Dispatcher };
