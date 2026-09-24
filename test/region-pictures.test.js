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
  assert.equal(pictures.pickImageUrl('<meta property="og:image" content="http://x.example.org/a.png">', 'https://x.example.org/'), null, 'a plain-http picture is not taken');
  assert.equal(pictures.pickImageUrl('<title>nothing</title>', 'https://x.example.org/'), null);
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
  const routes = {};
  // one provider serves a picture, the next serves a page with none, everything else is unreachable
  const first = a.url || a.website; routes[first] = a.url ? reply(200, IMAGE) : reply(200, Buffer.from('<meta property="og:image" content="https://img.example.org/a.png">'));
  routes['https://img.example.org/a.png'] = reply(200, IMAGE);
  routes[b.url || b.website] = reply(200, Buffer.from('<title>none</title>'));
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
    assert.match(lines.join('\n'), /1 of \d+ bundled/);
    // With no network at all nothing is written — and nothing throws.
    pictures._setFetchForTests(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }); });
    const none = await fetchAll({ outDir: dir, log: () => {} });
    assert.equal(none.bundled, 0);
    assert.equal(fs.existsSync(path.join(dir, 'sacramento-metro')), false, 'no manifest means the kernel says the build has none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
