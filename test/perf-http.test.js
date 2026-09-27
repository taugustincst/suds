'use strict';
// 1.14.0 performance work (docs/PERFORMANCE.md): JSON answers of 1 kB or more go out compressed when the request
// accepts it (brotli preferred, then gzip; q=0 refuses one), and exactly as before when it does not; the app's
// static files are compressed once and revalidated with an ETag (`no-cache`), while the HTML pages, the service
// worker and version.json stay `no-store`. Downloads that write their own answer (CSV and spreadsheet exports, a
// document's file) are left as they were: an .xlsx or a PDF is already compressed, and a CSV is unchanged.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const db = H.db;
const { uuid } = require('../server/crypto');

let base, cookie;
before(async () => {
  base = await H.start();
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  // The session cookie, for raw requests below.
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ username: 'admin', password: 'AdminPassw0rd!x' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  const nav = db.one(`SELECT id FROM users WHERE username='admin'`).id;
  db.transaction(() => {
    for (let i = 0; i < 80; i++) db.run(`INSERT INTO resources(id,name,category,summary) VALUES(?,?,?,?)`, uuid(), `Clinic ${i}`, 'mat_obot', 'Walk-in buprenorphine, same-day starts, peer support on site. '.repeat(2));
    for (let i = 0; i < 30; i++) db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location) VALUES(?,?,?,?,?,?,?)`, uuid(), null, nav, 'naloxone_distribution', `2026-02-${String(1 + i % 27).padStart(2, '0')}T10:00:00.000Z`, 5, 'field');
  });
});
after(async () => { await H.stop(); });

/** A raw request: the bytes exactly as they came over the wire, and the headers. */
function raw(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, { headers: { 'X-Requested-With': 'suds', Cookie: cookie, ...headers } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
const decode = (r) => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body);

test('a large JSON answer is compressed as the request allows, and decodes to exactly the uncompressed answer', async () => {
  const plain = await raw('/api/resources?limit=200');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding: sent as it is');
  assert.ok(plain.body.length > 4000, 'a large answer');
  assert.equal(plain.headers.vary, 'Accept-Encoding', 'a cache is told the answer depends on Accept-Encoding');
  const br = await raw('/api/resources?limit=200', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br', 'brotli is preferred');
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.ok(br.body.length < plain.body.length / 3, `compressed (${br.body.length} of ${plain.body.length} bytes)`);
  const gz = await raw('/api/resources?limit=200', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  // The same answer, apart from what differs between two requests (none here: the list is the same rows).
  assert.deepEqual(JSON.parse(decode(br)), JSON.parse(plain.body));
  assert.deepEqual(JSON.parse(decode(gz)), JSON.parse(plain.body));
  assert.equal(decode(gz).toString(), plain.body.toString(), 'byte for byte');
});

test('q=0 refuses an encoding, identity is honoured, and a small answer is never compressed', async () => {
  const noBr = await raw('/api/resources?limit=200', { 'Accept-Encoding': 'br;q=0, gzip;q=0.5' });
  assert.equal(noBr.headers['content-encoding'], 'gzip');
  const none = await raw('/api/resources?limit=200', { 'Accept-Encoding': 'identity' });
  assert.equal(none.headers['content-encoding'], undefined);
  const refused = await raw('/api/resources?limit=200', { 'Accept-Encoding': 'gzip;q=0, br;q=0' });
  assert.equal(refused.headers['content-encoding'], undefined);
  const small = await raw('/api/health/live', { 'Accept-Encoding': 'gzip, br' });
  assert.ok(small.body.length < 1024);
  assert.equal(small.headers['content-encoding'], undefined, 'under 1 kB: not worth compressing');
  assert.deepEqual(JSON.parse(small.body), { ok: true });
});

test('fetch (as the browser and a syncing device use it) gets the same answer, decoded', async () => {
  const c = H.client(); await c.login('admin', 'AdminPassw0rd!x');
  const a = await c.get('/api/resources?limit=200');
  const b = JSON.parse((await raw('/api/resources?limit=200')).body);
  assert.deepEqual(a.data, b);
  assert.equal(a.headers.get('content-encoding'), 'gzip', 'fetch over http asks for gzip, and gets it');
});

test('CSV and spreadsheet exports are sent as they always were: not compressed, and still correct', async () => {
  const csv = await raw('/api/reports/export/interventions?from=2026-01-01&to=2026-12-31', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers['content-encoding'], undefined);
  assert.match(csv.headers['content-type'], /^text\/csv/);
  const lines = csv.body.toString('utf8').trim().split(/\r?\n/);
  assert.ok(lines.length >= 31, `a header and a line per visit (${lines.length})`);
  const xlsx = await raw('/api/reports/export/interventions?from=2026-01-01&to=2026-12-31&format=xlsx', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.headers['content-encoding'], undefined, 'a workbook is a zip already');
  assert.equal(xlsx.body.slice(0, 2).toString(), 'PK', 'a zip file');
  assert.equal(Number(xlsx.headers['content-length'] || xlsx.body.length), xlsx.body.length);
});

test('a document download (already compressed: a PDF) is sent as it is', async () => {
  const c = H.client(); await c.login('admin', 'AdminPassw0rd!x');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4000, 0x41), Buffer.from('\n%%EOF')]);
  const d = await c.post('/api/documents', { title: 'Policy', category: 'policy', file_url: 'data:application/pdf;base64,' + pdf.toString('base64'), filename: 'policy.pdf' });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  const f = await raw(`/api/documents/${d.data.id}/file`, { 'Accept-Encoding': 'gzip, br' });
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-encoding'], undefined);
  assert.deepEqual(f.body, pdf);
});

test('the app\'s modules are compressed once, revalidated with an ETag, and answer 304 when unchanged', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'));
  const br = await raw('/app.js', { 'Accept-Encoding': 'br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), file, 'the file, exactly');
  assert.ok(br.body.length < file.length / 2);
  assert.equal(br.headers['cache-control'], 'no-cache', 'kept, but checked with the server before each use');
  assert.match(br.headers.etag, /^W\/"[\w-]+"$/);
  assert.equal(br.headers.vary, 'Accept-Encoding');
  const again = await raw('/app.js', { 'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0, 'no body');
  assert.equal(again.headers.etag, br.headers.etag);
  const gz = await raw('/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': '"something-else"' });
  assert.equal(gz.status, 200);
  assert.deepEqual(zlib.gunzipSync(gz.body), file);
  const plain = await raw('/views/clients.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'clients.js')));
});

test('the HTML pages, the service worker and version.json stay no-store, without an ETag', async () => {
  for (const p of ['/', '/index.html', '/get-app.html', '/sw.js', '/version.json']) {
    const r = await raw(p, { 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['cache-control'], 'no-store', p);
    assert.equal(r.headers.etag, undefined, p);
  }
  // Compressed or not, index.html is the file.
  const r = await raw('/', { 'Accept-Encoding': 'gzip' });
  assert.equal(decode(r).toString(), fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'));
});

test('main.js loads only the sign-in page and Home up front, and every other page on demand', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8');
  const eager = [...main.matchAll(/^import '\.\/views\/(\w+)\.js';$/gm)].map(m => m[1]);
  assert.deepEqual(eager, ['login', 'dashboard']);
  // Every view module that registers a page is reachable: eagerly, through another eager module, or lazily.
  const views = fs.readdirSync(path.join(__dirname, '..', 'public', 'views')).filter(f => f.endsWith('.js'));
  for (const f of views) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', f), 'utf8');
    for (const [, name] of src.matchAll(/(?:^|[^.\w])route\('([\w-]+)'/g)) {
      const mod = f.replace(/\.js$/, '');
      const eagerly = eager.includes(mod) || (mod === 'local'); // local.js is imported by login.js and dashboard.js
      const lazily = new RegExp(`\\b${mod}: \\[[^\\]]*'${name}'`).test(main);
      assert.ok(eagerly || lazily, `page "${name}" (views/${f}) is registered in main.js`);
    }
  }
  // The service worker still keeps every view for offline use.
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  for (const f of views) assert.ok(sw.includes(`'${f.replace(/\.js$/, '')}'`), `sw.js precaches views/${f}`);
});
