'use strict';
// Findings from the functional audit of local mode, sync and the PWA that live on the office server:
// malformed request targets, background requests and idle timeouts, the client code sequence, and how
// the kernel assets are delivered.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const H = require('./helpers');

let admin, base;
before(async () => { base = await H.start(); admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x'); });
after(async () => { await H.stop(); });

/** A raw request line, because fetch() will not send a target the URL parser refuses. */
function rawRequest(url, target) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), hostname, () => sock.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`));
    let buf = ''; sock.setEncoding('utf8');
    sock.on('data', d => { buf += d; }); sock.on('end', () => resolve(buf)); sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error(`no response to GET ${target} within 3s (hung socket)`)); }, 3000).unref();
  });
}

test('a malformed request target is a 400, never a hung socket or a crash (office server)', async () => {
  const bad = await rawRequest(base, '/%E0%A4%A');
  assert.match(bad, /^HTTP\/1\.1 400/, bad.slice(0, 80));
  const twoSlashes = await rawRequest(base, '//x');
  assert.match(twoSlashes, /^HTTP\/1\.1 200/, 'leading slashes are collapsed and the path is served as /x (the app shell)');
  assert.match(twoSlashes, /<!doctype html>/i);
  const api = await rawRequest(base, '//api/health');
  assert.doesNotMatch(api, /^HTTP\/1\.1 5\d\d/, 'still answered after the odd request');
  assert.equal((await admin.get('/api/meta/constants')).status, 200, 'the server is still serving afterwards');
});

test('the static-site server survives the same malformed targets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>static</title>');
  fs.writeFileSync(path.join(dir, 'manifest-local.webmanifest'), '{}');
  const { serveStatic } = require('../server/http');
  const handle = serveStatic(dir);
  const srv = http.createServer((req, res) => handle(req, res));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.match(await rawRequest(url, '/%'), /^HTTP\/1\.1 400/);
    assert.match(await rawRequest(url, '//x'), /^HTTP\/1\.1 200/);
    const ok = await fetch(url + '/index.html');
    assert.equal(ok.status, 200, 'and it is still up');
    const manifest = await fetch(url + '/manifest-local.webmanifest');
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/, 'a .webmanifest is served with its own media type');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the kernel assets are served precompressed and, when versioned, as immutable', async () => {
  // Local mode is off by default on an office server; this is about how the kernel is served when a
  // county has turned it on.
  const config = require('../server/config'); const was = config.localModeEnabled; config.localModeEnabled = true;
  try {
  const pub = path.join(__dirname, '..', 'public', 'local');
  for (const f of ['kernel.js', 'sql-wasm.wasm']) {
    assert.ok(fs.existsSync(path.join(pub, f + '.gz')), `${f}.gz is built and committed (npm run build:local)`);
    assert.ok(fs.existsSync(path.join(pub, f + '.br')), `${f}.br is built and committed (npm run build:local)`);
    // The compressed copies are of the committed file, not a stale one.
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(pub, f + '.gz'))).length, fs.statSync(path.join(pub, f)).size, `${f}.gz decompresses to the current ${f}`);
    assert.equal(zlib.brotliDecompressSync(fs.readFileSync(path.join(pub, f + '.br'))).length, fs.statSync(path.join(pub, f)).size, `${f}.br decompresses to the current ${f}`);
  }
  const plain = await fetch(base + '/local/kernel.js', { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(plain.headers.get('cache-control'), 'no-store', 'an unversioned request keeps the no-store default');
  const gz = await fetch(base + '/local/kernel.js?v=test', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal(gz.headers.get('vary'), 'Accept-Encoding');
  assert.match(gz.headers.get('cache-control'), /immutable/, 'a versioned kernel URL may be cached for good');
  assert.equal(Number(gz.headers.get('content-length')), fs.statSync(path.join(pub, 'kernel.js.gz')).size, 'the precompressed bytes are what went on the wire');
  const br = await fetch(base + '/local/sql-wasm.wasm?v=test', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(br.headers.get('content-encoding'), 'br', 'brotli is preferred when the browser accepts it');
  assert.match(br.headers.get('content-type'), /^application\/wasm/);
  const html = await fetch(base + '/?local=1', { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(html.headers.get('cache-control'), 'no-store', 'the HTML shell is never cached');
  } finally { config.localModeEnabled = was; }
});

test('app.js requests the kernel with the release version, and the service worker caches the same URL', () => {
  const version = require('../package.json').version;
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appJs, new RegExp(`const SUDS_VERSION = '${version.replace(/\./g, '\\.')}'`), 'public/app.js — run `npm run build:local`');
  assert.match(appJs, /import\(`\.\/local\/kernel\.js\?v=\$\{SUDS_VERSION\}`\)/, 'the kernel is imported with the version query');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /local\/kernel\.js\?v=\$\{KERNEL_VERSION\}/, 'the service worker precaches the versioned kernel URL');
  assert.match(sw, /local\/sql-wasm\.wasm\?v=\$\{KERNEL_VERSION\}/);
});

test('a background request does not keep a session alive', async () => {
  const c = H.client(); await c.login('admin', 'AdminPassw0rd!x');
  const sid = H.db.one(`SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1`).id;
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  H.db.run(`UPDATE sessions SET last_seen_at=? WHERE id=?`, stale, sid);
  assert.equal((await c.get('/api/tasks/due?within=60', { 'X-Background': '1' })).status, 200);
  assert.equal(H.db.one(`SELECT last_seen_at FROM sessions WHERE id=?`, sid).last_seen_at, stale, 'the bell poll left last_seen_at alone');
  assert.equal((await c.get('/api/tasks/due?within=60')).status, 200);
  assert.notEqual(H.db.one(`SELECT last_seen_at FROM sessions WHERE id=?`, sid).last_seen_at, stale, 'a request the person made bumps it');
  // The idle logoff itself still works through background requests: a session idle past the limit is gone.
  H.db.run(`UPDATE sessions SET last_seen_at=? WHERE id=?`, new Date(Date.now() - 24 * 3600_000).toISOString(), sid);
  assert.equal((await c.get('/api/tasks/due?within=60', { 'X-Background': '1' })).status, 401);
});

test('the client code sequence survives a collision rename and passes 9999', async () => {
  const M = require('../server/clients-model');
  const prefix = `C${String(new Date().getFullYear()).slice(2)}-`;
  const a = (await admin.post('/api/clients', { first_name: 'Code', last_name: 'One' })).data;
  assert.match(a.client_code, new RegExp(`^${prefix}\\d{4}$`));
  // The office renames a colliding device code by appending -D2 (server/routes/sync.js freeClientCode).
  // Number('0009-D2') is NaN, and the next code after it was "C26-NaN".
  const n = M.codeNumber(a.client_code, prefix);
  H.db.run(`UPDATE clients SET client_code=? WHERE id=?`, `${a.client_code}-D2`, a.id);
  const b = (await admin.post('/api/clients', { first_name: 'Code', last_name: 'Two', confirm_duplicate: true })).data;
  assert.equal(b.client_code, `${prefix}${String(n + 1).padStart(4, '0')}`, 'the renamed code still counts as its number');
  assert.equal(M.codeNumber('C26-0009-D2', 'C26-'), 9);
  assert.equal(M.codeNumber('C26-10000', 'C26-'), 10000);
  assert.equal(M.codeNumber('C26-', 'C26-'), 0);
  // Past 9999: as strings "C26-9999" sorts above "C26-10000", so ORDER BY client_code DESC stuck at 9999.
  H.db.setSetting(`client_code_counter:${prefix}`, '9999');
  const c = (await admin.post('/api/clients', { first_name: 'Code', last_name: 'Three', confirm_duplicate: true })).data;
  assert.equal(c.client_code, `${prefix}10000`);
  const d = (await admin.post('/api/clients', { first_name: 'Code', last_name: 'Four', confirm_duplicate: true })).data;
  assert.equal(d.client_code, `${prefix}10001`, 'and the sequence continues numerically from there');
  assert.equal(H.db.getSetting(`client_code_counter:${prefix}`), '10001', 'the counter is the record of the last code issued');
  // A code that already exists (imported, or synced from a device) is skipped, never issued twice.
  H.db.setSetting(`client_code_counter:${prefix}`, '0');
  const e = (await admin.post('/api/clients', { first_name: 'Code', last_name: 'Five', confirm_duplicate: true })).data;
  assert.equal(e.client_code, `${prefix}10002`, 'a stale counter is corrected from the table');
});
