'use strict';
// The one SSRF guard for every request the office server makes to an address someone else supplied: a
// resource picture "added from a web address" and a provider's website (server/region-pictures.js), a FHIR
// client's registered JWKS URL (server/fhir/jwt.js), and the endpoints an OIDC discovery document names
// (server/oidc.js). Each hop of a redirect chain is checked again.
//
// Two checks, both on every hop:
//  * assertPublicHttps: https only, and never a name or literal address that is this machine or a private
//    network. new URL() has already turned decimal, octal and hex IPv4 forms (https://2130706433/,
//    https://0177.0.0.1/, https://0x7f.1/) into dotted quads, so they are caught as 127.0.0.1.
//  * assertResolvesPublic: what the name resolves to. "pics.example.org" may point at 10.0.0.5 or
//    169.254.169.254. (A name that changes its answer between this check and the connection is not caught;
//    callers keep only bytes they can parse as what they asked for, and return nothing else.)

// The seams for tests: they replace the network and the resolver, never the address checks themselves.
let fetchImpl = (...args) => globalThis.fetch(...args);
let lookupImpl = null; // null: node:dns, unless a test replaced fetch (its hosts are made up)
let fetchOverridden = false;
function _setFetchForTests(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); fetchOverridden = !!fn; }
function _setLookupForTests(fn) { lookupImpl = fn; }

const soft = (message, extra = {}) => Object.assign(new Error(message), { soft: true }, extra);

function privateV4(a) {
  const [x, y] = a.split('.').map(Number);
  return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
    || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
}
/** Expand an IPv6 address to its eight 16-bit groups (an embedded dotted quad is converted), or null. */
function v6groups(a) {
  let s = a;
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) { const [p, q, r, t] = quad.slice(1).map(Number); s = s.slice(0, quad.index) + ((p << 8) | q).toString(16) + ':' + ((r << 8) | t).toString(16); }
  const halves = s.split('::'); if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : []; const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0; if (fill < 0) return null;
  const g = [...head, ...Array(fill).fill('0'), ...tail].map(h => parseInt(h, 16));
  return g.length === 8 && g.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}
/** Whether an address (v4 or v6, as a resolver returns it) is this machine, a private network, or not unicast. */
function isPrivateAddress(ip) {
  const a = String(ip).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return privateV4(a);
  const g = v6groups(a); if (!g) return true; // not an address we can read: refuse
  const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16)
  // all carry an IPv4 address that the connection may end up at.
  if (g.slice(0, 5).every(n => n === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : privateV4(v4of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  if (g[0] === 0x2002) return privateV4(v4of(g[1], g[2]));
  return (g[0] & 0xfe00) === 0xfc00 /* fc00::/7 unique local */ || (g[0] & 0xffc0) === 0xfe80 /* link-local */ || (g[0] & 0xffc0) === 0xfec0 /* site-local */
    || (g[0] & 0xff00) === 0xff00 /* multicast */ || (g[0] === 0x2001 && g[1] === 0x0db8) /* documentation */ || (g[0] === 0x2001 && g[1] === 0 /* Teredo */);
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|.*\.home\.arpa|metadata\.google\.internal)$/i;
/** https, and not a name or literal address on this machine or a private network. Returns the normalised href. */
function assertPublicHttps(u) {
  let url; try { url = new URL(u); } catch { throw soft('not a web address'); }
  if (url.protocol !== 'https:') throw soft('not an https address');
  if (url.username || url.password) throw soft('an address with a user name or password in it is not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || PRIVATE_HOST.test(host)) throw soft('that address is not on the public internet');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && privateV4(host)) throw soft('that address is not on the public internet');
  // Literal IPv6 addresses are refused outright: a provider's website has a name.
  if (host.includes(':')) throw soft('that address is not on the public internet');
  return url.href;
}

async function assertResolvesPublic(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let lookup = lookupImpl;
  if (!lookup) {
    if (fetchOverridden) return;
    let dns; try { dns = require('node:dns').promises; } catch { return; } // the browser kernel never fetches
    lookup = (h) => dns.lookup(h, { all: true, verbatim: true });
  }
  let addrs;
  try { addrs = await lookup(host); }
  catch (e) {
    // Behind a county proxy the office server may not resolve outside names itself; the proxy connects.
    if (process.env.HTTPS_PROXY || process.env.https_proxy) return;
    throw describeNetworkError({ cause: e }) || soft('could not find that address');
  }
  if (!addrs.length || addrs.some(x => isPrivateAddress(x.address || x))) throw soft('that address is not on the public internet');
}

// Node's fetch reports every network failure as "fetch failed", with the real reason in `cause`. Say what
// it means for an office server instead.
const NETWORK_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;
const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/;
function describeNetworkError(e) {
  const code = (e && e.cause && (e.cause.code || e.cause.name)) || (e && e.code) || '';
  const proxyHint = process.env.HTTPS_PROXY || process.env.https_proxy
    ? (process.env.NODE_USE_ENV_PROXY === '1' ? ' HTTPS_PROXY is set; check the proxy allows these sites.' : ' HTTPS_PROXY is set but Node only uses it when NODE_USE_ENV_PROXY=1 is set too (docs/DEPLOYMENT.md, "Outbound internet").')
    : ' If the office network only reaches the internet through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 (docs/DEPLOYMENT.md, "Outbound internet").';
  if (CERT_CODES.test(String(code))) return soft(`the connection's certificate was not trusted (${code}). A proxy that inspects HTTPS needs its certificate given to Node with NODE_EXTRA_CA_CERTS.`, { network: true });
  if (NETWORK_CODES.test(String(code)) || /fetch failed/i.test(e && e.message)) return soft(`the computer running SUDS could not reach the internet${code ? ` (${code})` : ''}.${proxyHint}`, { network: true });
  return null;
}

/**
 * GET (or `method`/`body`) an outside address with every hop checked; redirects are followed by hand.
 * `check(url)` is the per-hop guard (default: public https, resolving publicly). Resolves to { buf, url, res }.
 */
async function fetchChecked(url, { timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, hops = 4, method = 'GET', body, headers = {}, check } = {}) {
  const guard = check || (async (u) => { const href = assertPublicHttps(u); await assertResolvesPublic(href); return href; });
  let target = await guard(url);
  let res;
  for (let i = 0; i <= hops; i++) {
    try {
      res = await fetchImpl(target, { method, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { 'User-Agent': 'SUDS', Accept: '*/*', ...headers } });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw soft('timed out');
      throw describeNetworkError(e) || e;
    }
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    if (!location) break;
    if (i === hops) throw soft('too many redirects');
    // A redirect never carries a POST body on to somewhere else.
    if (method !== 'GET') throw soft(`the server answered ${res.status} with a redirect`);
    target = await guard(new URL(location, target).href);
  }
  if (!res.ok) throw soft(`site returned ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw soft('file is too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw soft('file is too large');
  return { buf, url: target, res };
}

module.exports = { isPrivateAddress, assertPublicHttps, assertResolvesPublic, fetchChecked, describeNetworkError, soft, _setFetchForTests, _setLookupForTests };
