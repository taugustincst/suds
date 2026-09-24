'use strict';
// Finding and downloading a provider's own picture (its social preview image or touch icon) from its
// website. Deliberately free of the database, so the same code serves three callers:
//   * the office server's "Download provider pictures" (server/region.js),
//   * scripts/fetch-region-pictures.js, which bundles the pictures into the static "SUDS on this device"
//     build at build time (a browser cannot fetch them itself: provider sites send no CORS headers), and
//   * the tests, with a mocked fetch.
const REGIONS = require('./regions');

const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

// The one seam for tests: they replace the network, never the address checks below.
let fetchImpl = (...args) => globalThis.fetch(...args);
function _setFetchForTests(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }

const soft = (message, extra = {}) => Object.assign(new Error(message), { soft: true }, extra);

/** Accept only real picture bytes (magic numbers), never trusting a declared type. */
const sniff = (buf) => buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF ? 'image/jpeg'
  : buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 ? 'image/png'
  : buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Picks the picture a site advertises for itself: the social preview image, then the touch icon. */
function pickImageUrl(html, baseUrl) {
  const head = String(html).slice(0, 512 * 1024);
  const meta = (prop) => { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /content=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  const link = (rel) => { const m = new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /href=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  const candidate = meta('og:image') || meta('og:image:secure_url') || meta('twitter:image') || link('apple-touch-icon') || link('icon');
  if (!candidate) return null;
  try { const u = new URL(candidate.replace(/&amp;/g, '&'), baseUrl); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

// A provider's website is an address the county typed in, and any hop it redirects to is not. Redirects
// are followed by hand so every URL in the chain is checked: https only, and never an address that
// resolves to this machine or the county's own network.
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;
function assertPublicHttps(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw soft('not an https address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(host)) throw soft('that address is not on the public internet');
  // Literal IP addresses: block loopback, link-local, and the private ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 0 || a === 10 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224) {
      throw soft('that address is not on the public internet');
    }
  }
  if (host.includes(':') || /^::/.test(host)) throw soft('that address is not on the public internet');
  return url.href;
}

// Node's fetch reports every network failure as "fetch failed", with the real reason in `cause`. That is
// what staff used to see, one line per program. Say what it means for an office server instead.
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

async function get(url, { timeoutMs, maxBytes, hops = 4 }) {
  let target = assertPublicHttps(url);
  let res;
  for (let i = 0; i <= hops; i++) {
    try {
      res = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { 'User-Agent': 'SUDS resource directory', Accept: '*/*' } });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw soft('timed out');
      throw describeNetworkError(e) || e;
    }
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    if (!location) break;
    if (i === hops) throw soft('too many redirects');
    target = assertPublicHttps(new URL(location, target).href);
  }
  if (!res.ok) throw soft(`site returned ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw soft('file is too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw soft('file is too large');
  return buf;
}

/**
 * Finds and downloads one provider's picture. `target` is { key, url?, website? }: `url` is a picture
 * address given in the region file, otherwise the website is read for the picture it advertises.
 * Resolves to { ok: true, buf, type, url } or { ok: false, error, network? } — never throws.
 */
async function downloadPicture(target, { timeoutMs = 12000, deadline = 0 } = {}) {
  let url = target.url;
  // A target can need two fetches (the website, then the picture). When the caller is working through a
  // batch it passes a deadline for the whole batch, and each fetch gets whatever is left of it.
  const budget = () => (deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs);
  const late = { ok: false, error: 'ran out of time — try this one again' };
  try {
    if (budget() <= 0) return late;
    if (!url) {
      if (!/^https:\/\//i.test(target.website || '')) return { ok: false, error: 'no website on file' };
      const html = await get(target.website, { timeoutMs: budget(), maxBytes: MAX_PAGE_BYTES });
      url = pickImageUrl(html.toString('utf8'), target.website);
      if (!url) return { ok: false, error: 'their website does not advertise a picture' };
    }
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'not an https address' };
    if (budget() <= 0) return late;
    const buf = await get(url, { timeoutMs: budget(), maxBytes: MAX_PICTURE_BYTES });
    const type = sniff(buf); if (!type) return { ok: false, error: 'not a JPEG, PNG or WebP picture' };
    return { ok: true, buf, type, url };
  } catch (e) {
    if (e && e.soft) return { ok: false, error: e.message, ...(e.network ? { network: true } : {}) };
    if (e && e.name === 'TimeoutError') return { ok: false, error: 'timed out' };
    return { ok: false, error: (e && e.message) || 'could not connect' };
  }
}

/** Every provider in a region file that has somewhere to look for a picture (no database needed). */
function regionTargets(regionId) {
  const region = REGIONS[regionId]; if (!region) throw new Error('Unknown region');
  return region.providers.filter(p => p.image_url || p.website).map(p => ({ key: p.key, name: p.name, category: p.category, url: p.image_url || null, website: p.website || null }));
}

module.exports = { REGIONS, MAX_PICTURE_BYTES, EXT, sniff, pickImageUrl, assertPublicHttps, get, downloadPicture, regionTargets, describeNetworkError, _setFetchForTests };
