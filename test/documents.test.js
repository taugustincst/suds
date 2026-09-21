'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, nav, fin;
before(async () => {
  await H.start();
  H.makeUser('dnav', 'navigator'); H.makeUser('dfin', 'finance');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('dnav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('dfin', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('policy/contract library: upload, search by title, filter by category, download, retire', async () => {
  // a navigator can read the library but not write to it
  assert.equal((await nav.get('/api/documents')).status, 200);
  assert.equal((await nav.post('/api/documents', { title: 'x', category: 'policy' })).status, 403);

  const fake = Buffer.from('%PDF-1.4\n%%EOF');
  const c = await admin.post('/api/documents', {
    title: 'Naloxone Distribution Policy', category: 'policy', description: 'How the program distributes naloxone kits.',
    effective_date: '2026-01-01', file_url: 'data:application/pdf;base64,' + fake.toString('base64'), filename: 'naloxone-policy.pdf',
  });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const contract = await fin.post('/api/documents', { title: 'County Vendor Agreement', category: 'contract', file_url: 'data:application/pdf;base64,' + fake.toString('base64') });
  assert.equal(contract.status, 201, 'finance can also upload (e.g. contracts)');

  const list = await nav.get('/api/documents');
  assert.equal(list.data.documents.length, 2);
  assert.ok(list.data.categories.includes('contract'));

  const byCat = await nav.get('/api/documents?category=policy');
  assert.equal(byCat.data.documents.length, 1);
  assert.equal(byCat.data.documents[0].title, 'Naloxone Distribution Policy');
  assert.equal(byCat.data.documents[0].has_file, true);
  assert.equal(byCat.data.documents[0].file_b64, undefined, 'the blob itself is never sent in a list');

  const file = await nav.get(`/api/documents/${c.data.id}/file`);
  assert.equal(file.status, 200);

  // retiring keeps it out of the default list but not the full one, and it stays downloadable
  assert.equal((await admin.del(`/api/documents/${c.data.id}`)).status, 200);
  assert.equal((await nav.get('/api/documents')).data.documents.length, 1, 'retired document drops out of the default list');
  assert.equal((await admin.get('/api/documents?all=1')).data.documents.length, 2, 'but is still there for someone who can manage the library');
  assert.equal((await nav.get(`/api/documents/${c.data.id}/file`)).status, 200, 'a retired policy is still downloadable, not deleted');
});

test('policy/contract library: a file that is not actually a PDF/Word/picture is refused', async () => {
  const bad = await admin.post('/api/documents', { title: 'Bad', category: 'procedure', file_url: 'data:application/pdf;base64,' + Buffer.from('not a real pdf').toString('base64') });
  assert.equal(bad.status, 400);
});
