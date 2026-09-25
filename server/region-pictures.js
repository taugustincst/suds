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
  const meta = (prop) => { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /content=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  const link = (rel) => { const m = new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]*>`, 'i').exec(head); if (!m) return null; const c = /href=["']([^"']+)["']/i.exec(m[0]); return c ? c[1] : null; };
  const candidate = meta('og:image') || meta('og:image:secure_url') || meta('twitter:image') || link('apple-touch-icon') || link('icon');
  if (!candidate) return null;
  try { const u = new URL(candidate.replace(/&amp;/g, '&'), baseUrl); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

// A provider's website is an address the county typed in, and any hop it redirects to is not: each one is
// checked (server/outbound.js).
function fetchChecked(url, { timeoutMs, maxBytes, hops = 4 }) {
  return outbound.fetchChecked(url, { timeoutMs, maxBytes, hops, headers: { 'User-Agent': 'SUDS resource directory' } });
}
async function get(url, opts) { return (await fetchChecked(url, opts)).buf; }

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
    const buf = await get(url, { timeoutMs: budget(), maxBytes: MAX_PICTURE_BYTES });
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
    const buf = await get(url, { timeoutMs, maxBytes: MAX_PICTURE_BYTES });
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
