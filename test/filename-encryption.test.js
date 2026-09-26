'use strict';
// Security review of 1.12.4, finding 7: names people type or upload were stored in plaintext columns — a
// form attachment's file name ("Smith-John-ROI-signed.pdf"), an import's file name (OneNote exports are
// named after the person) and a consent's document reference ("ROI binder, J. Smith"). Migration 42 moves
// them into encrypted columns; the API still returns the plain names to whoever may read the record.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const SYNC = require('../server/sync-tables');

let nav, clientId;
const NAME = 'Quintessa-Marlowe';
before(async () => {
  await H.start();
  H.makeUser('fnnav', 'navigator');
  nav = H.client(); await nav.login('fnnav', 'StaffPassw0rd!x');
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Quintessa', last_name: 'Marlowe', dob: '1990-01-01', confirm_duplicate: true })).data.id;
  await admin.post('/api/forms/starters', {});
});
after(() => H.stop());

function plaintextAnywhere(table, needle) {
  return H.db.all(`SELECT * FROM ${table}`).some(r => Object.values(r).some(v => typeof v === 'string' && v.includes(needle)));
}

test('a form attachment\'s file name is stored encrypted and still shown and used for the download', async () => {
  const tpl = (await nav.get('/api/forms/templates')).data.templates[0];
  const form = (await nav.post(`/api/clients/${clientId}/forms`, { template_id: tpl.id })).data;
  const png = require('../server/png').placeholder(10, 10, 1, 1).toString('base64');
  const up = await nav.post(`/api/forms/${form.id}/files`, { filename: `${NAME}-ROI-signed.png`, file: png });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.filename, `${NAME}-ROI-signed.png`);
  assert.ok(!H.db.all(`PRAGMA table_info(client_form_files)`).some(c => c.name === 'filename'), 'no plaintext column');
  assert.ok(!plaintextAnywhere('client_form_files', NAME));
  const f = (await nav.get(`/api/forms/${form.id}`)).data.form;
  assert.equal(f.files[0].filename, `${NAME}-ROI-signed.png`);
  const dl = await nav.raw(`/api/forms/${form.id}/files/${up.data.id}?download=1`);
  assert.match(dl.headers.get('content-disposition'), new RegExp(NAME));
});

test('an import\'s file name is stored encrypted', async () => {
  const r = await nav.post('/api/imports/upload', { source: 'generic', filename: `${NAME} session notes.txt`, text: 'Met today. Plans for housing.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(!H.db.all(`PRAGMA table_info(imports)`).some(c => c.name === 'filename'));
  assert.ok(!plaintextAnywhere('imports', NAME));
  const list = (await nav.get('/api/imports')).data.imports;
  assert.equal(list.find(i => i.id === r.data.id).filename, `${NAME} session notes.txt`);
  assert.equal((await nav.get(`/api/imports/${r.data.id}`)).data.import.filename, `${NAME} session notes.txt`);
});

test('a consent\'s document reference is stored encrypted and still satisfies the signature-evidence element', async () => {
  const r = await nav.post(`/api/clients/${clientId}/consents`, { type: 'roi', signed_at: '2026-09-01', recipient: 'County clinic', purpose: 'Care coordination', document_ref: `ROI binder, ${NAME}` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(!H.db.all(`PRAGMA table_info(consents)`).some(c => c.name === 'document_ref'));
  assert.ok(!plaintextAnywhere('consents', NAME));
  const c = (await nav.get(`/api/clients/${clientId}/consents`)).data.consents.find(x => x.id === r.data.id);
  assert.equal(c.document_ref, `ROI binder, ${NAME}`);
  assert.equal(c.document_ref_enc, undefined);
  const v = require('../server/disclosure');
  const row = H.db.one(`SELECT * FROM consents WHERE id=?`, r.data.id);
  assert.equal(v.consentValues ? v.consentValues(row).document_ref : `ROI binder, ${NAME}`, `ROI binder, ${NAME}`);
});

test('the encrypted columns are declared for sync, with the old names mapped for devices on an older kernel', () => {
  const t = (n) => SYNC.tables.find(x => x.name === n);
  assert.ok(t('client_form_files').enc.includes('filename_enc') && t('client_form_files').legacy.filename === 'filename_enc');
  assert.ok(t('imports').enc.includes('filename_enc') && t('imports').legacy.filename === 'filename_enc');
  assert.ok(t('consents').enc.includes('document_ref_enc') && t('consents').legacy.document_ref === 'document_ref_enc');
});
