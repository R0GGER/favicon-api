const dns = require('dns');
const { fetch, Agent } = require('undici');

// Resolve every IPv4 address, not just the first.
//
// Anycast front-ends routinely publish several A records of which one is
// unreachable from a given network — 2fas.com resolves to 188.114.96.0 (refuses
// connections here) and 188.114.97.0 (works). Browsers and the system resolver
// try the next address; pinning the first one turns a healthy site into a
// timeout, and the scraper then spends its whole retry ladder on a dead IP.
//
// IPv4 is still enforced here rather than via connect's `family` option,
// because setting family:4 makes Node skip the multi-address path entirely.
function ipv4Lookup(hostname, options, callback) {
  dns.lookup(hostname, { family: 4, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      const e = new Error(`no IPv4 address for ${hostname}`);
      e.code = 'ENOTFOUND';
      return callback(e);
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, 4);
  });
}

const connectOpts = {
  lookup: ipv4Lookup,
  // Enables Node's Happy Eyeballs loop, which is what walks the address list
  // above. Deliberately no `family: 4` — that would disable it.
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 500,
};

const ipv4Dispatcher = new Agent({ connect: connectOpts });

// Some origins (reddit.com HTML from datacenter IPs) fail over HTTP/2 while CDN assets work.
const ipv4Http1Dispatcher = new Agent({
  connect: connectOpts,
  allowH2: false,
});

// Last-resort dispatchers on the system resolver, used when the pinned-IPv4
// attempt cannot connect at all. Kept per HTTP version so the h1-only choice of
// the caller survives the retry.
const systemDispatcher = new Agent();
const systemHttp1Dispatcher = new Agent({ allowH2: false });

const CONNECT_RETRY_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function isConnectFailure(err) {
  const code = err?.cause?.code || err?.code;
  return CONNECT_RETRY_CODES.has(code);
}

// Drop an unused response so the HTTP/1 parser is not left paused. A peer FIN
// while paused used to throw an uncatchable assert(!this.paused) in undici
// (nodejs/undici#5360) and kill the worker.
function discardResponseBody(res) {
  const body = res?.body;
  if (body && typeof body.cancel === 'function') {
    Promise.resolve(body.cancel()).catch(() => {});
  }
}

function upstreamFetch(url, init = {}) {
  const dispatcher = init.dispatcher ?? ipv4Dispatcher;
  return fetch(url, { ...init, dispatcher }).catch((err) => {
    if (!isConnectFailure(err)) throw err;
    // The retry used to be skipped whenever the caller pinned a dispatcher,
    // which meant the scraper's HTML ladder — every attempt of which pins one —
    // never got a second chance at an unreachable address.
    const retryDispatcher =
      dispatcher === ipv4Http1Dispatcher || dispatcher === systemHttp1Dispatcher
        ? systemHttp1Dispatcher
        : systemDispatcher;
    if (dispatcher === retryDispatcher) throw err;
    return fetch(url, { ...init, dispatcher: retryDispatcher });
  });
}

module.exports = { upstreamFetch, discardResponseBody, ipv4Dispatcher, ipv4Http1Dispatcher };
