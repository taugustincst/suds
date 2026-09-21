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

  // retiring keeps it out of the default list but not the full one, for someone who can manage the library --
  // and it stays not-found (not deleted) at its own id/file for THEM, but genuinely gone for a read-only role,
  // the same as the list already treated it -- a bookmarked/guessed id must not bypass that restriction.
  assert.equal((await admin.del(`/api/documents/${c.data.id}`)).status, 200);
  assert.equal((await nav.get('/api/documents')).data.documents.length, 1, 'retired document drops out of the default list');
  assert.equal((await admin.get('/api/documents?all=1')).data.documents.length, 2, 'but is still there for someone who can manage the library');
  assert.equal((await admin.get(`/api/documents/${c.data.id}`)).status, 200, 'and someone who can manage the library can still open it directly');
  assert.equal((await admin.get(`/api/documents/${c.data.id}/file`)).status, 200, 'and still download it -- retiring does not delete the file');
  assert.equal((await nav.get(`/api/documents/${c.data.id}`)).status, 404, 'but a read-only role cannot reach a retired document by id');
  assert.equal((await nav.get(`/api/documents/${c.data.id}/file`)).status, 404, 'nor download its file by a bookmarked/guessed link');
});

test('policy/contract library: a document is found by a phrase inside the file', async () => {
  // A PDF whose one content stream is Flate-compressed, the way real ones are.
  const zlib = require('node:zlib');
  const content = 'BT /F1 12 Tf 72 700 Td (Every naloxone kit must have its lot number recorded) Tj ET';
  const comp = zlib.deflateSync(Buffer.from(content));
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`), comp, Buffer.from('\nendstream\nendobj\n%%EOF')]);
  const c = await admin.post('/api/documents', { title: 'Naloxone Dispensing Policy', category: 'policy', file_url: 'data:application/pdf;base64,' + pdf.toString('base64') });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const hit = await nav.get('/api/documents?q=' + encodeURIComponent('lot number'));
  const found = hit.data.documents.find(d => d.id === c.data.id);
  assert.ok(found, 'a phrase that appears only inside the file finds the document');
  assert.ok(found.snippet && /lot number/i.test(found.snippet), 'with the matching passage shown');
  assert.equal(found.search_text, undefined, 'the full extracted text is not sent with every list');
  const miss = await nav.get('/api/documents?q=' + encodeURIComponent('bus pass'));
  assert.ok(!miss.data.documents.find(d => d.id === c.data.id), 'a phrase that appears nowhere does not');
  // A Word file, too: a zip holding word/document.xml.
  const S = require('../server/spreadsheet');
  const docx = S.zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Vendor pays a late fee of two percent</w:t></w:r></w:p></w:body></w:document>']]);
  const w = await admin.post('/api/documents', { title: 'Vendor Agreement', category: 'contract', file_url: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + docx.toString('base64') });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  assert.ok((await nav.get('/api/documents?q=' + encodeURIComponent('late fee'))).data.documents.some(d => d.id === w.data.id), 'Word text is searchable too');
});

test('policy/contract library: a file that is not actually a PDF/Word/picture is refused', async () => {
  const bad = await admin.post('/api/documents', { title: 'Bad', category: 'procedure', file_url: 'data:application/pdf;base64,' + Buffer.from('not a real pdf').toString('base64') });
  assert.equal(bad.status, 400);
});
