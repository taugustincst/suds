'use strict';
// Pen test of suds.systems, INFO-3: the office server answered 200 with the app shell for any path and any method
// (/.env, /.git/HEAD, TRACE /), which reads to a scanner as files that exist. SUDS routes with the hash (#/clients),
// so the shell is needed only for an extensionless GET (/, /?local=1, /app, an old deep link): a dot-segment or a
// missing file with an extension is a 404, and a method other than GET or HEAD on a page is a 405.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const H = require('./helpers');

let base;
before(async () => { base = await H.start(); });
after(async () => { await H.stop(); });

/** A raw request, for the methods fetch refuses to send (TRACE). */
function raw(method, target) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + target, { method }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
    req.on('error', reject); req.end();
  });
}

test('the shell and the real files are still served: every path the app, its manifests and its links use', async () => {
  for (const p of ['/', '/index.html', '/?local=1', '/app', '/app/', '/clients', '/some/old/deep-link', '//x']) {
    const r = await raw('GET', p);
    assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], /^text\/html/, p);
  }
  for (const p of ['/app.js', '/main.js', '/styles.css', '/sw.js', '/version.json', '/manifest.webmanifest', '/manifest-local.webmanifest', '/referral-link.html', '/procurement.html', '/get-app.html', '/favicon.svg']) {
    assert.equal((await raw('GET', p)).status, 200, p);
  }
  assert.equal((await raw('HEAD', '/')).status, 200, 'HEAD on the shell');
  assert.equal((await raw('HEAD', '/app.js')).status, 200);
});

test('a path that looks like a file and is not one is a 404, never the shell with a 200', async () => {
  for (const p of ['/.env', '/.git/HEAD', '/.git/config', '/.well-known/security.txt', '/views/.hidden', '/%2Eenv', '/nope.php', '/backup.zip', '/wp-login.php', '/favicon.ico']) {
    const r = await raw('GET', p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /<!doctype html>/i, `${p}: not the app shell`);
    assert.deepEqual(JSON.parse(r.body), { error: 'Not found' }, p);
  }
});

test('a method other than GET or HEAD on a page is a 405 with Allow, and the API is unaffected', async () => {
  for (const [m, p] of [['TRACE', '/'], ['POST', '/'], ['PUT', '/index.html'], ['DELETE', '/app.js'], ['OPTIONS', '/'], ['POST', '/some/old/deep-link'], ['TRACE', '/.env']]) {
    const r = await raw(m, p);
    assert.equal(r.status, 405, `${m} ${p}`);
    assert.equal(r.headers.allow, 'GET, HEAD', `${m} ${p}`);
    assert.doesNotMatch(r.body, /<!doctype html>/i);
  }
  const login = await H.client().post('/api/auth/login', { username: 'nobody-at-all', password: 'x' });
  assert.equal(login.status, 401, 'a POST to the API still reaches its route');
});
