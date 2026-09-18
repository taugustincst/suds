'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const png = require('../server/png');

let admin, nav, ro;
before(async () => {
  await H.start();
  H.makeUser('nav1', 'navigator'); H.makeUser('ro1', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('ro1', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('treatment center profile: summary, tags, pictures with validation and ordering', async () => {
  const c = await nav.post('/api/resources', { name: 'Riverside Recovery', category: 'residential', summary: 'A 42-bed residential program.', service_tags: 'Residential, MAT Buprenorphine, bogus_tag, residential', populations: 'adults,women', levels_of_care: '3.5, 3.7', intake_process: 'Call intake.', cost_notes: 'Medicaid.' });
  assert.equal(c.status, 201); const id = c.data.id;
  let row = (await nav.get(`/api/resources/${id}`)).data.row;
  assert.equal(row.service_tags, 'residential,mat_buprenorphine', 'tags normalised, unknown dropped, duplicates removed');
  assert.equal(row.populations, 'adults,women'); assert.deepEqual(row.photos, []);
  // pictures: bad bytes rejected, real PNG accepted, thumbnail served as data URL
  const bad = await nav.post(`/api/resources/${id}/photos`, { data_url: 'data:image/png;base64,' + Buffer.from('not a picture at all').toString('base64') });
  assert.equal(bad.status, 400);
  const full = png.placeholder(320, 200, 3, 1), thumb = png.placeholder(80, 50, 3, 1);
  const p1 = await nav.post(`/api/resources/${id}/photos`, { data_url: 'data:image/png;base64,' + full.toString('base64'), thumb_url: 'data:image/png;base64,' + thumb.toString('base64'), width: 320, height: 200, caption: 'Entrance' });
  assert.equal(p1.status, 201, JSON.stringify(p1.data)); assert.equal(p1.data.photo.content_type, 'image/png'); // Pictures are served as cacheable images, not inlined as base64 in the JSON.
  assert.match(p1.data.photo.thumb_url, new RegExp(`^/api/resources/${id}/photos/[0-9a-f-]+/thumb$`));
  const img = await nav.get(p1.data.photo.thumb_url);
  assert.equal(img.status, 200);
  const etag = img.headers.get('etag');
  assert.ok(etag, 'the picture is cacheable');
  assert.equal((await nav.get(p1.data.photo.thumb_url, { 'If-None-Match': etag })).status, 304, 'and is not re-sent unchanged');
  assert.equal((await nav.get(`/api/resources/${id}/photos/${p1.data.photo.id}/image`)).status, 200);
  const p2 = await nav.post(`/api/resources/${id}/photos`, { data: full.toString('base64'), caption: 'Group room' });
  assert.equal(p2.status, 201);
  assert.equal((await ro.post(`/api/resources/${id}/photos`, { data: full.toString('base64') })).status, 403, 'read-only cannot upload');
  row = (await ro.get(`/api/resources/${id}`)).data.row;
  assert.equal(row.photos.length, 2); assert.equal(row.photos[0].caption, 'Entrance'); assert.ok(row.photos[0].data_url.endsWith('/image'));
  // directory shows the cover thumbnail and photo count
  const list = (await ro.get('/api/resources')).data.rows.find(r => r.id === id);
  assert.equal(list.photo_count, 2); assert.ok(list.cover_url.endsWith('/thumb'), 'the card cover is a cacheable image URL');
  // reorder: make second picture the main one; caption edit; delete leaves a tombstone
  assert.equal((await nav.put(`/api/resources/${id}/photos/${p2.data.id}`, { sort_order: 0, caption: 'Group room (main)' })).status, 200);
  row = (await nav.get(`/api/resources/${id}`)).data.row; assert.equal(row.photos[0].id, p2.data.id); assert.equal(row.photos[0].caption, 'Group room (main)');
  assert.equal((await nav.del(`/api/resources/${id}/photos/${p1.data.id}`)).status, 200);
  assert.equal((await nav.get(`/api/resources/${id}/photos`)).data.photos.length, 1);
  const db = require('../server/db'); assert.equal(db.one(`SELECT COUNT(*) n FROM tombstones WHERE table_name='resource_photos'`).n, 1);
  // size cap
  const huge = Buffer.concat([full, Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await nav.post(`/api/resources/${id}/photos`, { data: huge.toString('base64') })).status, 400);
  // exports carry the new columns; photos sync as a table
  const csv = (await admin.get('/api/reports/export/resources?format=csv')).data; assert.ok(String(csv).includes('Summary') && String(csv).includes('Service Tags'), String(csv).slice(0, 300));
  const pull = (await admin.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', { 'X-Sync-Client': '1' })).data;
  assert.ok(pull.tables.resource_photos && pull.tables.resource_photos.length === 1, 'photos included in sync');
});
