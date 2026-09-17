'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = require('../server/db');
const C = require('../server/constants');
const region = require('../server/region');

let admin, nav, ro;
before(async () => {
  await H.start();
  H.makeUser('nav1', 'navigator'); H.makeUser('ro1', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('ro1', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('starter directory dataset is well formed', () => {
  for (const r of Object.values(region.REGIONS)) {
    assert.ok(r.providers.length >= 20, `${r.id} has ${r.providers.length} providers`);
    const keys = new Set();
    for (const p of r.providers) {
      assert.ok(p.key && !keys.has(p.key), `duplicate or missing key: ${p.key}`); keys.add(p.key);
      assert.ok(p.name && p.city && p.county, `${p.key} missing name/city/county`);
      assert.ok(C.RESOURCE_CATEGORIES.includes(p.category), `${p.key} bad category ${p.category}`);
      assert.ok(p.summary && p.summary.length > 80, `${p.key} summary too short`);
      for (const t of p.service_tags || []) assert.ok(C.SERVICE_TAGS.includes(t), `${p.key} bad tag ${t}`);
      for (const t of p.populations || []) assert.ok(C.POPULATIONS.includes(t), `${p.key} bad population ${t}`);
      if (p.website) assert.match(p.website, /^https:\/\//, `${p.key} website not https`);
      if (p.phone) assert.match(p.phone, /^(\d{3}-\d{3}-\d{4}|988|\d{3})$/, `${p.key} odd phone ${p.phone}`);
      if (p.image_url) assert.match(p.image_url, /^https:\/\//, `${p.key} image not https`);
      assert.ok(p.source, `${p.key} has no source`);
    }
  }
});

test('loading a region adds unverified programs with pictures, enriches instead of clobbering, and is repeatable', async () => {
  assert.equal((await ro.post('/api/regions/sacramento-metro/load', {})).status, 403);
  const listed = (await nav.get('/api/regions')).data.regions;
  assert.equal(listed[0].loaded, false); assert.ok(listed[0].provider_count >= 20);
  // a program the county already typed in, partly filled: keep what they wrote, fill the blanks
  const existing = region.REGIONS['sacramento-metro'].providers[0];
  const mine = (await nav.post('/api/resources', { name: existing.name, category: existing.category, city: existing.city, phone: '555-0000', notes: 'Ask for Dana' })).data.id;

  const out = (await nav.post('/api/regions/sacramento-metro/load', {})).data;
  assert.ok(out.added >= 20, JSON.stringify(out)); assert.equal(out.enriched, 1);
  const kept = db.one(`SELECT * FROM resources WHERE id=?`, mine);
  assert.equal(kept.phone, '555-0000', 'did not overwrite the phone number a human entered');
  assert.ok(kept.summary && kept.summary.length > 50, 'filled in the empty summary');
  assert.match(kept.notes, /Ask for Dana/); assert.match(kept.notes, /starter directory/);

  const rows = (await nav.get('/api/resources?limit=1000')).data.rows;
  assert.ok(rows.length >= 20);
  assert.ok(rows.every(r => r.last_verified_at === null), 'imported programs are unverified until staff confirm them');
  assert.ok(rows.every(r => r.photo_count >= 1 && r.cover_url), 'every program has a cover picture');
  assert.ok(rows.some(r => /Granite Wellness/i.test(r.name)), 'Granite Wellness is in the directory');
  const counties = new Set(region.REGIONS['sacramento-metro'].providers.map(p => p.county));
  assert.ok(counties.size >= 6, `covers ${counties.size} counties`);

  // repeatable: no duplicates, nothing new
  const again = (await nav.post('/api/regions/sacramento-metro/load', {})).data;
  assert.equal(again.added, 0); assert.equal(again.enriched, 0);
  assert.equal((await nav.get('/api/resources?limit=1000')).data.rows.length, rows.length);

  const st = (await nav.get('/api/regions')).data.regions[0];
  assert.equal(st.loaded, true); assert.equal(st.unverified, rows.length);

  // pictures: every program with a website is offered for a download attempt
  const pics = (await nav.get('/api/regions/sacramento-metro/pictures')).data;
  assert.ok(pics.total >= 20 && pics.pending.length === pics.total, `${pics.total} picture targets`);
  assert.equal((await nav.post('/api/regions/sacramento-metro/pictures', { keys: [] })).status, 400);
});

test('provider pictures are discovered from the provider website and downloaded', async () => {
  const png = require('../server/png');
  const realFetch = globalThis.fetch;
  const image = png.initialsCard('Downloaded', 'residential', 60, 40);
  const pages = {
    'https://good.example.org/': { type: 'text/html', body: Buffer.from('<html><head><meta property="og:image" content="/logo.png"></head>') },
    'https://good.example.org/logo.png': { type: 'image/png', body: image },
    'https://plain.example.org/': { type: 'text/html', body: Buffer.from('<html><head><title>no picture here</title></head>') },
    'https://junk.example.org/': { type: 'text/html', body: Buffer.from('<head><meta property="og:image" content="https://junk.example.org/x.png">') },
    'https://junk.example.org/x.png': { type: 'image/png', body: Buffer.from('this is not a picture') },
  };
  globalThis.fetch = async (url) => {
    const hit = pages[String(url)];
    if (!hit) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(hit.body.length) : hit.type) }, arrayBuffer: async () => hit.body.buffer.slice(hit.body.byteOffset, hit.body.byteOffset + hit.body.length) };
  };
  try {
    const region = require('../server/region');
    const targets = region.pictureTargets('sacramento-metro');
    const t = targets[0];
    const before = db.one(`SELECT COUNT(*) n FROM resource_photos WHERE resource_id=?`, t.id).n;
    const ok = await region.fetchPicture({ ...t, url: null, website: 'https://good.example.org/' }, { actor: null });
    assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.type, 'image/png'); assert.equal(ok.url, 'https://good.example.org/logo.png');
    assert.equal(db.one(`SELECT COUNT(*) n FROM resource_photos WHERE resource_id=?`, t.id).n, before + 1);
    const cover = db.one(`SELECT caption, content_type FROM resource_photos WHERE resource_id=? ORDER BY sort_order LIMIT 1`, t.id);
    assert.match(cover.caption, /good\.example\.org/, 'downloaded picture becomes the cover, ahead of the generated card');
    // a site with no advertised picture, a site serving something that is not an image, and an unreachable site
    assert.match((await region.fetchPicture({ ...t, url: null, website: 'https://plain.example.org/' })).error, /does not advertise/);
    assert.match((await region.fetchPicture({ ...t, url: null, website: 'https://junk.example.org/' })).error, /not a JPEG/);
    assert.match((await region.fetchPicture({ ...t, url: null, website: 'https://missing.example.org/' })).error, /404/);
    assert.match((await region.fetchPicture({ ...t, url: null, website: null })).error, /no website/);
    assert.match((await region.fetchPicture({ ...t, url: 'http://insecure.example.org/a.png' })).error, /https/);
  } finally { globalThis.fetch = realFetch; }
});

test('removing a starter directory keeps anything used or verified', async () => {
  const rows = (await nav.get('/api/resources?limit=1000')).data.rows;
  const verified = rows[0], referred = rows[1];
  await nav.put(`/api/resources/${verified.id}`, { last_verified_at: new Date().toISOString().slice(0, 10) });
  const cid = (await nav.post('/api/clients', { first_name: 'Ref', last_name: 'Client' })).data.id;
  assert.equal((await nav.post('/api/referrals', { client_id: cid, resource_id: referred.id, referred_at: new Date().toISOString(), status: 'pending' })).status, 201);
  const out = (await nav.del('/api/regions/sacramento-metro')).data;
  assert.equal(out.kept, 2, 'kept the verified one and the one with a referral');
  assert.ok(out.removed >= 18);
  assert.equal(db.one(`SELECT is_active FROM resources WHERE id=?`, verified.id).is_active, 0);
  assert.ok(db.one(`SELECT COUNT(*) n FROM resources WHERE id=?`, referred.id).n === 1);
  assert.equal((await nav.get('/api/regions')).data.regions[0].loaded, false);
});
