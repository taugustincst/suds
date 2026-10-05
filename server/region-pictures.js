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

// The SSRF guard (https only, never this machine or a private network, every redirect hop checked) is
// shared with every other outbound fetch: server/outbound.js. Its test seams are re-exported below.
const outbound = require('./outbound');
const { soft, isPrivateAddress, assertPublicHttps, describeNetworkError, _setFetchForTests, _setLookupForTests } = outbound;

/** Accept only real picture bytes (magic numbers), never trusting a declared type. */
const sniff = (buf) => buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF ? 'image/jpeg'
  : buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 ? 'image/png'
  : buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Picks the picture a site advertises for itself: the social preview image, then the touch icon. */
function pickImageUrl(html, baseUrl) {
  const head = String(html).slice(0, 512 * 1024);
  const meta = (prop) => { const m = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /content=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  // All the <link> tags with a matching rel; when several sizes are offered the largest is taken.
  const link = (rel) => {
    const re = new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]*>`, 'gi');
    let m, best = null, bestArea = -1;
    while ((m = re.exec(head))) {
      const c = /href=["']([^"']+)["']/i.exec(m[0]); if (!c) continue;
      const s = /sizes=["'](\d+)[xX](\d+)["']/i.exec(m[0]);
      const area = s ? (+s[1]) * (+s[2]) : 0;
      if (area > bestArea) { best = c[1]; bestArea = area; }
    }
    return best;
  };
  const usable = (raw) => {
    if (!raw) return null;
    let u; try { u = new URL(raw.replace(/&amp;/g, '&'), baseUrl); } catch { return null; }
    // A site that advertises its picture over plain http usually serves it over https too (Squarespace
    // does); the download itself always goes over https, so upgrade rather than give up.
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') return null;
    // A vector or Windows icon is not a picture the directory can show; skip it so a later, usable
    // candidate is tried instead of failing the whole download on a bad magic number.
    if (/\.(svg|ico)(\?|#|$)/i.test(u.pathname)) return null;
    return u.href;
  };
  // In priority order: the social preview image (several spellings), then the touch icon. A generic
  // favicon link comes last: it is often a 16-pixel square, and the site's own logo from the page body
  // is the better picture then.
  const advertised = [
    meta('og:image'), meta('og:image:secure_url'),
    meta('twitter:image'), meta('twitter:image:src'), meta('image'),
    meta('msapplication-TileImage'),
    link('apple-touch-icon'),
  ];
  for (const raw of advertised) { const u = usable(raw); if (u) return u; }
  const logo = sameOriginLogo(String(html), baseUrl);
  if (logo) return logo;
  return usable(link('icon'));
}

// A site that advertises no picture sometimes still shows its own logo in the page body: take the first
// same-origin image that looks like one. Only the provider's own host is ever taken — a hotlinked photo
// from anywhere else is not the provider's picture to use. (server/outbound.js still checks the address.)
function sameOriginLogo(html, baseUrl) {
  let host; try { host = new URL(baseUrl).hostname; } catch { return null; }
  const srcs = [];
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m; while ((m = re.exec(html)) && srcs.length < 200) srcs.push(m[1]);
  const usable = (raw) => {
    let u; try { u = new URL(raw.replace(/&amp;/g, '&'), baseUrl); } catch { return null; }
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.hostname !== host) return null;
    if (/\.(svg|ico)(\?|#|$)/i.test(u.pathname)) return null;
    return u.href;
  };
  const logoish = (u) => /(logo|brand|header-logo|site-icon|favicon)/i.test(u);
  for (const raw of srcs) { const u = usable(raw); if (u && logoish(u)) return u; }
  for (const raw of srcs) { const u = usable(raw); if (u) return u; }
  return null;
}

// A provider's website is an address the county typed in, and any hop it redirects to is not: each one is
// checked (server/outbound.js).
//
// Some provider sites (and their CDNs) answer a bare-bones request with 403 or a bot-block page, so the
// request goes out looking like a browser: a browser user agent, and an Accept header that matches what is
// being asked for (a page, or a picture). The address checks are untouched — this only changes the headers.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ACCEPT_PAGE = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const ACCEPT_PICTURE = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
function fetchChecked(url, { timeoutMs, maxBytes, hops = 4, accept = ACCEPT_PAGE }) {
  return outbound.fetchChecked(url, { timeoutMs, maxBytes, hops, headers: { 'User-Agent': BROWSER_UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' } });
}
async function get(url, opts, accept) { return (await fetchChecked(url, { ...opts, accept })).buf; }

// A thrown download error as the { ok: false } result callers show to staff.
function failure(e) {
  if (e && e.soft) return { ok: false, error: e.message, ...(e.network ? { network: true } : {}) };
  if (e && e.name === 'TimeoutError') return { ok: false, error: 'timed out' };
  return { ok: false, error: (e && e.message) || 'could not connect' };
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
    const buf = await get(url, { timeoutMs: budget(), maxBytes: MAX_PICTURE_BYTES }, ACCEPT_PICTURE);
    const type = sniff(buf); if (!type) return { ok: false, error: 'not a JPEG, PNG or WebP picture' };
    return { ok: true, buf, type, url };
  } catch (e) { return failure(e); }
}

/**
 * Downloads the picture at an address someone pasted into a resource profile ("Add from a web address").
 * The address may be the picture itself or a web page, in which case the picture that page advertises
 * (its social preview image, then its touch icon) is taken, exactly as for provider pictures. Every hop
 * goes through the same checks. Resolves to { ok: true, buf, type, url } or { ok: false, error, network? }.
 */
async function downloadFromAddress(address, { timeoutMs = 12000 } = {}) {
  try {
    const first = await fetchChecked(address, { timeoutMs, maxBytes: Math.max(MAX_PICTURE_BYTES, MAX_PAGE_BYTES) });
    let type = sniff(first.buf);
    if (type) return { ok: true, buf: first.buf, type, url: first.url };
    const text = first.buf.subarray(0, 512 * 1024).toString('utf8');
    if (!/<(html|head|meta|link)\b/i.test(text)) return { ok: false, error: 'not a JPEG, PNG or WebP picture' };
    const url = pickImageUrl(text, first.url);
    if (!url) return { ok: false, error: 'that page does not advertise a picture; open the picture itself and copy its address' };
    const buf = await get(url, { timeoutMs, maxBytes: MAX_PICTURE_BYTES }, ACCEPT_PICTURE);
    type = sniff(buf); if (!type) return { ok: false, error: 'not a JPEG, PNG or WebP picture' };
    return { ok: true, buf, type, url };
  } catch (e) { return failure(e); }
}

/** Every provider in a region file that has somewhere to look for a picture (no database needed). */
function regionTargets(regionId) {
  const region = REGIONS[regionId]; if (!region) throw new Error('Unknown region');
  return region.providers.filter(p => p.image_url || p.website).map(p => ({ key: p.key, name: p.name, category: p.category, url: p.image_url || null, website: p.website || null }));
}

module.exports = { REGIONS, MAX_PICTURE_BYTES, EXT, sniff, pickImageUrl, assertPublicHttps, get, downloadPicture, downloadFromAddress, regionTargets, describeNetworkError, isPrivateAddress, _setFetchForTests, _setLookupForTests };
