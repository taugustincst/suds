'use strict';
// POST /api/resources/:id/photos/from-url: "Add from a web address" on a resource profile, for people (and
// testing tools) that cannot use the operating system's file window. The network is mocked through the
// seam in server/region-pictures.js; the address checks are the real ones.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const png = require('../server/png');
const pictures = require('../server/region-pictures');

const IMAGE = png.initialsCard('Pic', 'residential', 60, 40);
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const reply = (status, body = Buffer.alloc(0), headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? (k === 'content-length' ? String(body.length) : null) }, arrayBuffer: async () => ab(body) });
let seen = [];
function mock(routes) {
  seen = [];
  pictures._setFetchForTests(async (url) => { seen.push(String(url)); const r = routes[String(url)]; return typeof r === 'function' ? r() : r || reply(404); });
}
afterEach(() => pictures._setFetchForTests(null));

let nav, ro, resId;
before(async () => {
  await H.start();
  H.makeUser('urlnav', 'navigator'); H.makeUser('urlro', 'readonly');
  nav = H.client(); await nav.login('urlnav', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('urlro', 'StaffPassw0rd!x');
  resId = (await nav.post('/api/resources', { name: 'Harbor House', category: 'residential' })).data.id;
});
after(async () => { await H.stop(); });

const route = () => `/api/resources/${resId}/photos/from-url`;

test('a picture address is downloaded, stored like an upload, and audited with the host only', async () => {
  mock({ 'https://cdn.example.org/front.png?sig=SECRET123': reply(200, IMAGE) });
  const r = await nav.post(route(), { url: 'https://cdn.example.org/front.png?sig=SECRET123', caption: 'Front door' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.id); assert.equal(r.data.photo.caption, 'Front door'); assert.equal(r.data.photo.content_type, 'image/png');
  const img = await nav.get(`/api/resources/${resId}/photos/${r.data.id}/image`);
  assert.equal(img.status, 200);
  const row = H.db.one(`SELECT uploaded_by, bytes FROM resource_photos WHERE id=?`, r.data.id);
  assert.equal(row.bytes, IMAGE.length); assert.ok(row.uploaded_by, 'who added it is kept');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='resource.photo.add' AND entity_id=? ORDER BY id DESC LIMIT 1`, resId);
  assert.match(a.details, /"host":"cdn\.example\.org"/); assert.match(a.details, /"source":"web_address"/);
  assert.ok(!/SECRET123|front\.png/.test(a.details), 'the path and query string never reach the audit trail');
  // the browser then saves a proper thumbnail on it, as for a downloaded provider picture
  const th = await nav.put(`/api/resources/${resId}/photos/${r.data.id}`, { thumb_url: 'data:image/png;base64,' + png.placeholder(40, 30, 3, 1).toString('base64') });
  assert.equal(th.status, 200);
  // with no caption, the picture says where it came from
  mock({ 'https://cdn.example.org/b.png': reply(200, IMAGE) });
  const r2 = await nav.post(route(), { url: 'https://cdn.example.org/b.png' });
  assert.equal(r2.status, 201); assert.equal(r2.data.photo.caption, 'From cdn.example.org');
});

test('a web page address gives the picture the page advertises (og:image)', async () => {
  mock({
    'https://harbor.example.org/about': reply(200, Buffer.from('<html><head><meta property="og:image" content="/img/og.png"></head></html>')),
    'https://harbor.example.org/img/og.png': reply(200, IMAGE),
  });
  const r = await nav.post(route(), { url: 'https://harbor.example.org/about' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(seen, ['https://harbor.example.org/about', 'https://harbor.example.org/img/og.png']);
  mock({ 'https://plain.example.org/': reply(200, Buffer.from('<html><head><title>x</title></head></html>')) });
  const none = await nav.post(route(), { url: 'https://plain.example.org/' });
  assert.equal(none.status, 400); assert.match(none.data.error, /does not advertise a picture/);
});

test('only https addresses on the public internet; never a redirect to the local network', async () => {
  mock({});
  const http = await nav.post(route(), { url: 'http://cdn.example.org/a.png' });
  assert.equal(http.status, 400); assert.match(http.data.error, /https/);
  assert.equal((await nav.post(route(), { url: 'not an address' })).status, 400);
  assert.equal((await nav.post(route(), {})).status, 400, 'url is required');
  for (const u of ['https://127.0.0.1/x.png', 'https://192.168.1.10/x.png', 'https://169.254.169.254/latest/meta-data', 'https://printer.local/x.png', 'https://[::1]/x.png', 'https://localhost/x.png']) {
    const r = await nav.post(route(), { url: u });
    assert.equal(r.status, 400, u); assert.match(r.data.error, /not on the public internet/, u);
  }
  assert.deepEqual(seen, [], 'no connection was attempted to any of them');
  mock({ 'https://hop.example.org/p.png': reply(302, Buffer.alloc(0), { location: 'https://10.0.0.5/p.png' }) });
  const hop = await nav.post(route(), { url: 'https://hop.example.org/p.png' });
  assert.equal(hop.status, 400); assert.match(hop.data.error, /not on the public internet/);
  assert.ok(!seen.some(s => s.includes('10.0.0.5')), 'the redirect target was never fetched');
});

test('something that is not a picture, or is too big, is refused; an unreachable internet is a 502', async () => {
  mock({
    'https://junk.example.org/file.pdf': reply(200, Buffer.from('%PDF-1.4 not a picture')),
    'https://huge.example.org/x.png': reply(200, IMAGE, { 'content-length': String(50 * 1024 * 1024) }),
  });
  const junk = await nav.post(route(), { url: 'https://junk.example.org/file.pdf' });
  assert.equal(junk.status, 400); assert.match(junk.data.error, /not a JPEG, PNG or WebP/);
  const huge = await nav.post(route(), { url: 'https://huge.example.org/x.png' });
  assert.equal(huge.status, 400); assert.match(huge.data.error, /too large/);
  pictures._setFetchForTests(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
  const off = await nav.post(route(), { url: 'https://cdn.example.org/a.png' });
  assert.equal(off.status, 502); assert.match(off.data.error, /could not reach the internet/);
});

test('read-only roles cannot add pictures; an unknown resource is a 404', async () => {
  mock({ 'https://cdn.example.org/a.png': reply(200, IMAGE) });
  assert.equal((await ro.post(route(), { url: 'https://cdn.example.org/a.png' })).status, 403);
  assert.deepEqual(seen, [], 'nothing was fetched for a refused request');
  assert.equal((await nav.post('/api/resources/nope/photos/from-url', { url: 'https://cdn.example.org/a.png' })).status, 404);
});

test('the 12-picture cap applies', async () => {
  const id = (await nav.post('/api/resources', { name: 'Full House', category: 'residential' })).data.id;
  mock({ 'https://cdn.example.org/a.png': reply(200, IMAGE) });
  for (let i = 0; i < 12; i++) assert.equal((await nav.post(`/api/resources/${id}/photos/from-url`, { url: 'https://cdn.example.org/a.png' })).status, 201);
  seen = [];
  const r = await nav.post(`/api/resources/${id}/photos/from-url`, { url: 'https://cdn.example.org/a.png' });
  assert.equal(r.status, 400); assert.match(r.data.error, /at most 12 pictures/);
  assert.deepEqual(seen, [], 'a full gallery does not download anything');
});

test('a copy running in the browser (config.local) answers with a clear 501 instead of trying to fetch', async () => {
  const config = require('../server/config');
  mock({ 'https://cdn.example.org/a.png': reply(200, IMAGE) });
  config.local = true;
  try {
    const r = await nav.post(route(), { url: 'https://cdn.example.org/a.png' });
    assert.equal(r.status, 501); assert.match(r.data.error, /fetched by the page itself/);
    assert.deepEqual(seen, []);
  } finally { delete config.local; }
});
