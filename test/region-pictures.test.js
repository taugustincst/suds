'use strict';
// server/region-pictures.js: the database-free half of "Download provider pictures", shared by the office
// server and scripts/fetch-region-pictures.js (the static build's bundle). The network is mocked; the
// address checks are the real ones.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pictures = require('../server/region-pictures');
const png = require('../server/png');

const IMAGE = png.initialsCard('Pic', 'residential', 60, 40);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100)]);
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const reply = (status, body = Buffer.alloc(0), headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? (k === 'content-length' ? String(body.length) : null) }, arrayBuffer: async () => ab(body) });
function mock(routes) {
  const seen = [];
  pictures._setFetchForTests(async (url, opts) => {
    seen.push({ url: String(url), redirect: opts && opts.redirect });
    const r = routes[String(url)];
    if (typeof r === 'function') return r();
    return r || reply(404);
  });
  return seen;
}
afterEach(() => pictures._setFetchForTests(null));

test('the picture a site advertises is picked: og:image first, then the touch icon, https only', () => {
  assert.equal(pictures.pickImageUrl('<meta property="og:image" content="/a.png"><link rel="apple-touch-icon" href="/b.png">', 'https://x.example.org/p/'), 'https://x.example.org/a.png');
  assert.equal(pictures.pickImageUrl('<meta content="x" name="twitter:card"><link rel="apple-touch-icon" href="icons/b.png">', 'https://x.example.org/p/'), 'https://x.example.org/p/icons/b.png');
  assert.equal(pictures.pickImageUrl('<meta property="og:image" content="https://cdn.example.org/i.jpg?a=1&amp;b=2">', 'https://x.example.org/'), 'https://cdn.example.org/i.jpg?a=1&b=2');
  assert.equal(pictures.pickImageUrl('<meta property="og:image" content="http://x.example.org/a.png">', 'https://x.example.org/'), 'https://x.example.org/a.png', 'a plain-http picture is upgraded to https, never fetched as http');
  assert.equal(pictures.pickImageUrl('<title>nothing</title>', 'https://x.example.org/'), null);
  // more spellings of the social preview image
  assert.equal(pictures.pickImageUrl('<meta name="twitter:image:src" content="/t.jpg">', 'https://x.example.org/'), 'https://x.example.org/t.jpg');
  assert.equal(pictures.pickImageUrl('<meta itemprop="image" content="/s.jpg">', 'https://x.example.org/'), 'https://x.example.org/s.jpg');
  assert.equal(pictures.pickImageUrl('<meta name="msapplication-TileImage" content="/m.png">', 'https://x.example.org/'), 'https://x.example.org/m.png');
  // a vector or Windows icon is skipped so a usable candidate later in the page is tried
  assert.equal(pictures.pickImageUrl('<link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/t.png">', 'https://x.example.org/'), 'https://x.example.org/t.png');
  assert.equal(pictures.pickImageUrl('<link rel="icon" href="/favicon.ico">', 'https://x.example.org/'), null, 'an ico alone is not a picture');
  // the largest offered icon is taken; a tiny favicon loses to the site's own body logo
  assert.equal(pictures.pickImageUrl('<link rel="icon" href="/f16.png" sizes="16x16"><link rel="icon" href="/f32.png" sizes="32x32">', 'https://x.example.org/'), 'https://x.example.org/f32.png');
  assert.equal(
    pictures.pickImageUrl('<head><link rel="icon" href="/f16.png" sizes="16x16"></head><body><img src="/logo-500.png"></body>', 'https://x.example.org/'),
    'https://x.example.org/logo-500.png', 'the body logo beats a 16-pixel favicon');
});

test('a page that advertises nothing falls back to its own logo, never someone else\'s picture', () => {
  const page = (body) => `<html><head><title>x</title></head><body>${body}</body></html>`;
  assert.equal(pictures.pickImageUrl(page('<img src="/wp-content/uploads/logo.png">'), 'https://x.example.org/'), 'https://x.example.org/wp-content/uploads/logo.png');
  assert.equal(pictures.pickImageUrl(page('<img src="https://cdn.example.org/logo.png"><img src="/assets/brand-mark.jpg">'), 'https://x.example.org/'), 'https://x.example.org/assets/brand-mark.jpg', 'a hotlinked logo is not taken');
  assert.equal(pictures.pickImageUrl(page('<img src="/photos/staff.jpg">'), 'https://x.example.org/'), 'https://x.example.org/photos/staff.jpg', 'any same-origin picture as a last resort');
  assert.equal(pictures.pickImageUrl(page('<img src="/icon.svg">'), 'https://x.example.org/'), null, 'a vector logo is not a picture');
  assert.equal(pictures.pickImageUrl(page('<img src="https://cdn.example.org/only.jpg">'), 'https://x.example.org/'), null, 'no same-origin image at all');
  // an advertised picture still wins over the body logo
  assert.equal(pictures.pickImageUrl(page('<meta property="og:image" content="/social.jpg"><img src="/logo.png">'), 'https://x.example.org/'), 'https://x.example.org/social.jpg');
});

test('requests name SUDS honestly (never a browser), with an Accept header matching what is fetched', async () => {
  const seen = [];
  pictures._setFetchForTests(async (url, opts) => {
    seen.push({ url: String(url), headers: opts && opts.headers, redirect: opts && opts.redirect });
    if (String(url).endsWith('/logo.png')) return reply(200, IMAGE);
    return reply(200, Buffer.from('<head><meta property="og:image" content="/logo.png"></head>'));
  });
  const out = await pictures.downloadPicture({ key: 'k', website: 'https://ua.example.org/' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(seen.length, 2);
  const version = require('../package.json').version;
  for (const s of seen) {
    assert.equal(s.headers['User-Agent'], `SUDS/${version} (+https://github.com/taugustincst/suds) region pictures`, `SUDS's own user agent for ${s.url}`);
    assert.doesNotMatch(s.headers['User-Agent'], /Mozilla|Chrome|Safari|Gecko/, 'never a browser identity');
  }
  assert.equal(pictures.USER_AGENT, seen[0].headers['User-Agent']);
  assert.match(seen[0].headers.Accept, /text\/html/, 'the page is asked for as a page');
  assert.match(seen[1].headers.Accept, /^image\//, 'the picture is asked for as a picture');
  assert.ok(seen.every(s => s.redirect === 'manual'), 'redirects are still followed by hand, so every hop is checked');
});

test('every sacramento-metro provider has somewhere to look for a picture', () => {
  const targets = pictures.regionTargets('sacramento-metro');
  assert.equal(targets.length, 81);
  for (const key of ['sierra-family-health', 'sierra-native-alliance']) {
    const t = targets.find(t => t.key === key);
    assert.ok(t && /^https:\/\/[^/]+/.test(t.website), `${key} has an official website`);
  }
  assert.ok(targets.every(t => t.key && (t.url || t.website)));
});

test('a website is read for its og:image, which is downloaded and checked to be a picture', async () => {
  const seen = mock({
    'https://good.example.org/': reply(200, Buffer.from('<head><meta property="og:image" content="/logo.png"></head>')),
    'https://good.example.org/logo.png': reply(200, IMAGE),
  });
  const out = await pictures.downloadPicture({ key: 'k', website: 'https://good.example.org/' });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.type, 'image/png'); assert.equal(out.url, 'https://good.example.org/logo.png');
  assert.ok(out.buf.equals(IMAGE));
  assert.ok(seen.every(s => s.redirect === 'manual'), 'redirects are followed by hand, so every hop is checked');
  // a given picture address skips the website
  mock({ 'https://cdn.example.org/p.jpg': reply(200, JPEG) });
  const direct = await pictures.downloadPicture({ key: 'k', url: 'https://cdn.example.org/p.jpg', website: 'https://ignored.example.org/' });
  assert.equal(direct.ok, true); assert.equal(direct.type, 'image/jpeg');
});

test('a redirect chain that leads to this machine or the local network is refused', async () => {
  for (const target of ['https://127.0.0.1/admin', 'https://10.0.0.5/x.png', 'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data', 'https://printer.local/', 'https://[::1]/', 'http://public.example.org/x.png']) {
    const seen = mock({
      'https://hop.example.org/': reply(301, Buffer.alloc(0), { location: 'https://hop2.example.org/next' }),
      'https://hop2.example.org/next': reply(302, Buffer.alloc(0), { location: target }),
    });
    const out = await pictures.downloadPicture({ key: 'k', url: 'https://hop.example.org/' });
    assert.equal(out.ok, false, target);
    assert.match(out.error, /not on the public internet|not an https address/, target);
    assert.ok(!seen.some(s => !/example\.org/.test(s.url)), `never connected to ${target}`);
  }
  // an endless chain stops
  mock({ 'https://loop.example.org/': reply(302, Buffer.alloc(0), { location: 'https://loop.example.org/' }) });
  assert.match((await pictures.downloadPicture({ key: 'k', url: 'https://loop.example.org/' })).error, /too many redirects/);
  // and the first address is checked too
  assert.match((await pictures.downloadPicture({ key: 'k', website: 'https://localhost/' })).error, /not on the public internet/);
});

test('something that is not a picture, or is too big, is refused', async () => {
  mock({
    'https://junk.example.org/': reply(200, Buffer.from('<head><meta property="og:image" content="https://junk.example.org/x.png">')),
    'https://junk.example.org/x.png': reply(200, Buffer.from('<html>this is not a picture</html>')),
    'https://huge.example.org/x.jpg': reply(200, JPEG, { 'content-length': String(50 * 1024 * 1024) }),
    'https://plain.example.org/': reply(200, Buffer.from('<head><title>no picture</title></head>')),
    'https://gone.example.org/': reply(410),
  });
  assert.match((await pictures.downloadPicture({ key: 'k', website: 'https://junk.example.org/' })).error, /not a JPEG, PNG or WebP/);
  assert.match((await pictures.downloadPicture({ key: 'k', url: 'https://huge.example.org/x.jpg' })).error, /too large/);
  assert.match((await pictures.downloadPicture({ key: 'k', website: 'https://plain.example.org/' })).error, /does not advertise a picture/);
  assert.match((await pictures.downloadPicture({ key: 'k', website: 'https://gone.example.org/' })).error, /returned 410/);
  assert.match((await pictures.downloadPicture({ key: 'k', website: null })).error, /no website/);
});

test('a server with no way out to the internet says so, and mentions the proxy settings', async () => {
  const fail = (code) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }); };
  const saved = { p: process.env.HTTPS_PROXY, lp: process.env.https_proxy, u: process.env.NODE_USE_ENV_PROXY };
  try {
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy; delete process.env.NODE_USE_ENV_PROXY;
    mock({ 'https://a.example.org/': fail('ENOTFOUND') });
    let out = await pictures.downloadPicture({ key: 'k', website: 'https://a.example.org/' });
    assert.equal(out.ok, false); assert.equal(out.network, true);
    assert.match(out.error, /could not reach the internet \(ENOTFOUND\)/); assert.match(out.error, /HTTPS_PROXY and NODE_USE_ENV_PROXY=1/);
    assert.doesNotMatch(out.error, /fetch failed/, 'not Node\'s bare "fetch failed"');
    process.env.HTTPS_PROXY = 'http://proxy.county.example:8080';
    mock({ 'https://a.example.org/': fail('ECONNREFUSED') });
    out = await pictures.downloadPicture({ key: 'k', website: 'https://a.example.org/' });
    assert.match(out.error, /HTTPS_PROXY is set but Node only uses it when NODE_USE_ENV_PROXY=1/);
    mock({ 'https://a.example.org/': fail('SELF_SIGNED_CERT_IN_CHAIN') });
    out = await pictures.downloadPicture({ key: 'k', website: 'https://a.example.org/' });
    assert.equal(out.network, true); assert.match(out.error, /certificate was not trusted.*NODE_EXTRA_CA_CERTS/);
    mock({ 'https://a.example.org/': () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } });
    assert.equal((await pictures.downloadPicture({ key: 'k', website: 'https://a.example.org/' })).error, 'timed out');
  } finally {
    for (const [k, v] of [['HTTPS_PROXY', saved.p], ['https_proxy', saved.lp], ['NODE_USE_ENV_PROXY', saved.u]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the build-time bundle: pictures and a manifest for the static site, best effort', async () => {
  const { fetchAll } = require('../scripts/fetch-region-pictures');
  const targets = pictures.regionTargets('sacramento-metro');
  assert.ok(targets.length >= 20 && targets.every(t => t.key && (t.url || t.website)), 'the same target list the office server uses');
  const [a, b] = targets;
  const addr = (t) => t.url || t.website;
  const c = targets.find(t => ![addr(a), addr(b)].includes(addr(t)));
  const routes = {};
  // one provider serves a picture, the next serves a page with none, the third refuses an automated
  // download (403), everything else is unreachable
  const first = a.url || a.website; routes[first] = a.url ? reply(200, IMAGE) : reply(200, Buffer.from('<meta property="og:image" content="https://img.example.org/a.png">'));
  routes['https://img.example.org/a.png'] = reply(200, IMAGE);
  routes[b.url || b.website] = reply(200, Buffer.from('<title>none</title>'));
  routes[c.url || c.website] = reply(403, Buffer.from('Forbidden'));
  pictures._setFetchForTests(async (url) => { const r = routes[String(url)]; if (r) return r; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-pics-'));
  try {
    const lines = [];
    const s = await fetchAll({ outDir: dir, log: (l) => lines.push(l) });
    assert.equal(s.bundled, 1); assert.equal(s.tried, targets.length);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'sacramento-metro', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(m.pictures), [a.key]);
    const e = m.pictures[a.key];
    assert.equal(e.content_type, 'image/png'); assert.match(e.source_url, /^https:\/\//); assert.ok(e.fetched_at && e.bytes === IMAGE.length);
    assert.ok(fs.readFileSync(path.join(dir, 'sacramento-metro', e.file)).equals(IMAGE));
    assert.match(m.failures[b.key], /does not advertise/);
    assert.match(m.failures[c.key], /403/);
    // The manifest says plainly how many made it, how many sites refused, and what SUDS sent.
    assert.equal(m.user_agent, pictures.USER_AGENT);
    assert.deepEqual(m.summary, { bundled: 1, tried: targets.length, refused: 1 });
    assert.match(m.note, new RegExp(`^1 of ${targets.length} providers' pictures were downloaded\\. SUDS identifies itself and does not pose as a browser`));
    assert.equal(s.regions['sacramento-metro'].refused, 1);
    assert.match(lines.join('\n'), /1 of \d+ bundled; 1 provider sites refused an automated download/);
    // With no network at all nothing is written — and nothing throws.
    pictures._setFetchForTests(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }); });
    const none = await fetchAll({ outDir: dir, log: () => {} });
    assert.equal(none.bundled, 0);
    assert.equal(fs.existsSync(path.join(dir, 'sacramento-metro')), false, 'no manifest means the kernel says the build has none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
