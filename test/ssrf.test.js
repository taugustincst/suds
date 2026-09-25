'use strict';
// Server-side request forgery. The office server fetches three kinds of address that someone other than the
// operator supplies: a resource picture "added from a web address" (and a provider's website), a FHIR
// client's JWKS URL, and the endpoints an OIDC discovery document names. All three go through one guard,
// server/outbound.js. Each is driven here with every way of spelling "this machine / the county LAN / the
// cloud metadata service": literal addresses in every notation, names that resolve to them, and redirects.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const outbound = require('../server/outbound');
const pictures = require('../server/region-pictures');
const J = require('../server/fhir/jwt');
const oidc = require('../server/oidc');
const config = require('../server/config');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

// Literal addresses, in the notations new URL() accepts, and addresses that are not https at all.
const LITERALS = [
  'https://127.0.0.1/x.png', 'https://[::1]/x.png', 'https://10.1.2.3/x.png', 'https://172.16.0.1/x.png', 'https://172.31.255.254/x.png',
  'https://192.168.0.1/x.png', 'https://169.254.169.254/latest/meta-data/', 'https://[fd00::1]/x.png', 'https://[fe80::1]/x.png',
  'https://[::ffff:127.0.0.1]/x.png', 'https://[::ffff:a9fe:a9fe]/x.png', 'https://2130706433/x.png', 'https://0177.0.0.1/x.png',
  'https://0x7f.0.0.1/x.png', 'https://017700000001/x.png', 'https://127.1/x.png', 'https://0/x.png', 'https://0.0.0.0/x.png',
  'https://100.64.0.1/x.png', 'https://localhost/x.png', 'https://printer.local/x.png', 'https://db.internal/x.png', 'https://a.localhost/x.png',
  'https://metadata.google.internal/computeMetadata/v1/', 'https://router.home.arpa/', 'https://user:pw@pics.example.org/x.png',
  'http://pics.example.org/x.png', 'ftp://pics.example.org/x.png', 'file:///etc/passwd', 'gopher://pics.example.org/',
];
// Names that resolve (only, or also) to somewhere private.
const RESOLVES = {
  'loop.example.org': ['127.0.0.1'], 'loop6.example.org': ['::1'], 'ten.example.org': ['10.0.0.1'], 'oneseventwo.example.org': ['172.20.1.1'],
  'home.example.org': ['192.168.1.1'], 'meta.example.org': ['169.254.169.254'], 'ula.example.org': ['fd12:3456::1'],
  'linklocal6.example.org': ['fe80::1'], 'mapped.example.org': ['::ffff:10.0.0.1'], 'mappedhex.example.org': ['::ffff:a00:1'],
  'nat64.example.org': ['64:ff9b::a00:1'], 'sixtofour.example.org': ['2002:c0a8:101::1'], 'zero.example.org': ['0.0.0.0'],
  'mixed.example.org': ['93.184.216.34', '10.9.9.9'], 'cgnat.example.org': ['100.100.1.1'],
};
const PUBLIC = ['93.184.216.34'];

let fetched = [];
function network(respond) {
  fetched = [];
  outbound._setLookupForTests(async (h) => (RESOLVES[h] || (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? [h] : PUBLIC)).map(address => ({ address })));
  outbound._setFetchForTests(async (url, opts) => { fetched.push(url); return respond(url, opts); });
}
const png = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
const redirectTo = (loc) => new Response('', { status: 302, headers: { location: loc } });
afterEach(() => { outbound._setFetchForTests(null); outbound._setLookupForTests(null); });

test('the address classifier: every private, loopback, link-local and embedded-IPv4 form is private; public ones are not', () => {
  for (const ip of ['127.0.0.1', '127.255.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2002:c0a8:101::', '2001:db8::1', 'FE80::1%eth0', 'not-an-address', '1:2:3']) {
    assert.equal(outbound.isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '192.169.0.1', '169.255.0.1', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '2002:808:808::1']) {
    assert.equal(outbound.isPrivateAddress(ip), false, ip);
  }
});

test('resource pictures ("add from a web address"): refused before anything is fetched', async () => {
  network(() => png());
  for (const u of LITERALS) {
    const r = await pictures.downloadFromAddress(u);
    assert.equal(r.ok, false, u);
    assert.deepEqual(fetched, [], `${u} was never requested`);
  }
  for (const host of Object.keys(RESOLVES)) {
    const r = await pictures.downloadFromAddress(`https://${host}/x.png`);
    assert.equal(r.ok, false, host); assert.match(r.error, /not on the public internet/, host);
    assert.deepEqual(fetched, [], `${host} was never requested`);
  }
  const ok = await pictures.downloadFromAddress('https://pics.example.org/x.png');
  assert.equal(ok.ok, true, 'a public https address still works');
});

test('resource pictures: a redirect to any private target is refused at that hop', async () => {
  for (const target of [...LITERALS.filter(u => !u.startsWith('file:')), ...Object.keys(RESOLVES).map(h => `https://${h}/x.png`)]) {
    network((url) => (url.startsWith('https://pics.example.org/') ? redirectTo(target) : png()));
    const r = await pictures.downloadFromAddress('https://pics.example.org/start');
    assert.equal(r.ok, false, target);
    assert.deepEqual(fetched, ['https://pics.example.org/start'], `the redirect to ${target} was not followed`);
  }
  // Relative and multi-hop redirects on the public internet are still followed.
  network((url) => (url.endsWith('/a') ? redirectTo('/b') : url.endsWith('/b') ? redirectTo('https://cdn.example.net/c.png') : png()));
  assert.equal((await pictures.downloadFromAddress('https://pics.example.org/a')).ok, true);
});

test('FHIR client JWKS URL: refused at registration and at every fetch, including after a redirect', async () => {
  for (const u of LITERALS) assert.throws(() => J.checkJwksUrl(u), /not allowed/, u);
  const keys = JSON.stringify({ keys: [] });
  network(() => new Response(keys, { status: 200 }));
  for (const host of Object.keys(RESOLVES)) {
    await assert.rejects(J.fetchJwks(`https://${host}/jwks.json`, { force: true }), /could not be fetched.*not on the public internet/, host);
  }
  assert.deepEqual(fetched, []);
  for (const target of ['https://169.254.169.254/latest/meta-data/iam/', 'https://meta.example.org/', 'http://keys.example.org/jwks.json', 'https://[::ffff:127.0.0.1]/']) {
    network((url) => (url === 'https://keys.example.org/start.json' ? redirectTo(target) : new Response(keys, { status: 200 })));
    J._jwksCache.clear();
    await assert.rejects(J.fetchJwks('https://keys.example.org/start.json'), /could not be fetched/, target);
    assert.deepEqual(fetched, ['https://keys.example.org/start.json'], target);
  }
});

test('OIDC: the issuer must be https; endpoints the discovery document names elsewhere must be public https', async () => {
  const saved = { ...config.oidc }; const prod = config.isProd;
  try {
    network(() => png());
    Object.assign(config.oidc, { issuer: 'https://idp.county.example', clientId: 'c', clientSecret: 's', redirectUri: 'https://suds.example/cb', enabled: true });
    // Same origin as the configured issuer: the operator's own identity provider, wherever it is.
    assert.equal(await oidc.checkEndpoint('https://idp.county.example/keys'), 'https://idp.county.example/keys');
    // Anywhere else: the public internet over https only.
    assert.equal(await oidc.checkEndpoint('https://www.googleapis.com/oauth2/v3/certs'), 'https://www.googleapis.com/oauth2/v3/certs');
    for (const u of LITERALS.filter(x => !x.startsWith('file:'))) await assert.rejects(oidc.checkEndpoint(u), /will not contact/, u);
    for (const host of Object.keys(RESOLVES)) await assert.rejects(oidc.checkEndpoint(`https://${host}/jwks`), /will not contact/, host);
    // Plain http: only a loopback issuer outside production (development and these tests).
    config.oidc.issuer = 'http://idp.county.example';
    await assert.rejects(oidc.checkEndpoint('http://idp.county.example/jwks'), /must be an https address/);
    config.oidc.issuer = 'http://127.0.0.1:9999';
    config.isProd = true;
    await assert.rejects(oidc.checkEndpoint('http://127.0.0.1:9999/jwks'), /must be an https address/);
    config.isProd = false;
    assert.ok(await oidc.checkEndpoint('http://127.0.0.1:9999/jwks'));
    // A discovery document that points the key set at the metadata service is refused, and redirects are
    // never followed by the OIDC fetches.
    config.oidc.issuer = 'https://idp.county.example';
    const realFetch = globalThis.fetch; const seen = [];
    globalThis.fetch = async (url, opts) => { seen.push([url, opts && opts.redirect]); return new Response(JSON.stringify({ issuer: 'https://idp.county.example', authorization_endpoint: 'https://idp.county.example/a', token_endpoint: 'https://idp.county.example/t', jwks_uri: 'https://169.254.169.254/latest/meta-data/' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    try {
      oidc._resetCacheForTests();
      await assert.rejects(oidc.discover(), /will not contact/);
      assert.deepEqual(seen, [['https://idp.county.example/.well-known/openid-configuration', 'error']]);
      globalThis.fetch = async () => new Response(JSON.stringify({ issuer: 'https://evil.example', authorization_endpoint: 'x', token_endpoint: 'https://idp.county.example/t', jwks_uri: 'https://idp.county.example/k' }), { status: 200, headers: { 'content-type': 'application/json' } });
      oidc._resetCacheForTests();
      await assert.rejects(oidc.discover(), /different issuer/);
    } finally { globalThis.fetch = realFetch; oidc._resetCacheForTests(); }
  } finally { Object.assign(config.oidc, saved); config.isProd = prod; }
});

test('every outbound fetch in server/ goes through the shared guard', () => {
  // A new fetch() of an address someone else supplies must use server/outbound.js. The ones listed here are
  // fixed, operator-configured or local: OneNote's Microsoft Graph (fixed hosts), the OIDC issuer (guarded
  // in oidc.js idpFetch), the DR drill's own local server, and region.js's reads of the static site's own
  // bundled pictures (same origin, in the browser kernel only).
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..', 'server');
  const allowed = new Set(['outbound.js', 'oidc.js', path.join('importers', 'onenote.js'), 'dr-drill-child.js', 'schema-text.js', 'region.js']);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const offenders = walk(root).filter(f => f.endsWith('.js')).filter(f => !allowed.has(path.relative(root, f)))
    .filter(f => /(^|[^\w.])fetch\s*\(|globalThis\.fetch/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
  assert.deepEqual(offenders.map(f => path.relative(root, f)), [], 'raw fetch() outside the guard');
  const src = fs.readFileSync(path.join(root, 'oidc.js'), 'utf8');
  assert.ok(!/[^.\w]fetch\(\s*(doc\.|`\$\{config)/.test(src), 'oidc.js fetches only through idpFetch');
});
