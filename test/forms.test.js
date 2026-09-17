'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const pdf = require('../server/pdf');
const png = require('../server/png');

let admin, nav, nav2, ro, clientId;
before(async () => {
  await H.start();
  H.makeUser('nav1', 'navigator'); H.makeUser('nav2', 'navigator'); H.makeUser('ro1', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('nav2', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('ro1', 'StaffPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Jamie', last_name: 'Nguyen', dob: '1988-04-12', phone: '555-0101', address: '100 Demo St', city: 'Springfield', insurance: 'medicaid' })).data.id;
});
after(async () => { await H.stop(); });

test('form library: upload a PDF with fields, detect them, fill for a client with autofill, complete, print, attach', async () => {
  // navigators cannot manage the library
  assert.equal((await nav.post('/api/forms/templates', { name: 'x' })).status, 403);
  // a fillable-looking PDF: field names in AcroForm syntax
  const fake = Buffer.from('%PDF-1.4\n1 0 obj << /FT /Tx /T (Client Name) >> endobj\n2 0 obj << /FT /Tx /T (Date of Birth) >> endobj\n3 0 obj << /FT /Btn /T (Agree) >> endobj\n4 0 obj << /FT /Tx /Ff 4096 /T (Notes) >> endobj\n%%EOF');
  const c = await admin.post('/api/forms/templates', { name: 'Release of Information', category: 'consent_release', file_url: 'data:application/pdf;base64,' + fake.toString('base64'), filename: 'roi.pdf' });
  assert.equal(c.status, 201, JSON.stringify(c.data)); assert.equal(c.data.detected, 4);
  const byKey = Object.fromEntries(c.data.fields.map(f => [f.key, f]));
  assert.equal(byKey.client_name.autofill, 'client.full_name'); assert.equal(byKey.date_of_birth.autofill, 'client.dob'); assert.equal(byKey.agree.type, 'checkbox'); assert.equal(byKey.notes.type, 'textarea');
  const tid = c.data.id;
  // refine fields: make name required, add a signature and a date
  const upd = await admin.put(`/api/forms/templates/${tid}`, { fields: [...c.data.fields.map(f => f.key === 'client_name' ? { ...f, required: true } : f), { label: 'Client signature', type: 'signature', required: true }, { label: 'Date', type: 'date', autofill: 'today' }], instructions: 'Read aloud.' });
  assert.equal(upd.status, 200);
  const lib = (await ro.get('/api/forms/templates')).data; assert.equal(lib.templates.length, 1); assert.equal(lib.templates[0].field_count, 6); assert.equal(lib.templates[0].has_file, 1);
  // original file and blank pdf
  const orig = await nav.req('GET', `/api/forms/templates/${tid}/file`); assert.equal(orig.status, 200); assert.ok(orig.headers.get('content-type').includes('pdf'));
  const blank = await nav.req('GET', `/api/forms/templates/${tid}/blank.pdf`); assert.equal(blank.status, 200); assert.ok(String(blank.data).startsWith('%PDF'));
  // start for a client: autofill
  assert.equal((await ro.post(`/api/clients/${clientId}/forms`, { template_id: tid })).status, 403);
  assert.equal((await nav2.post(`/api/clients/${clientId}/forms`, { template_id: tid })).status, 403, 'not on caseload');
  const s = await nav.post(`/api/clients/${clientId}/forms`, { template_id: tid }); assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal(s.data.values.client_name, 'Jamie Nguyen'); assert.equal(s.data.values.date_of_birth, '1988-04-12'); assert.equal(s.data.values.date, new Date().toISOString().slice(0, 10));
  const fid = s.data.id;
  // completing without the signature fails
  const bad = await nav.put(`/api/forms/${fid}`, { values: { agree: true, notes: 'ok' }, status: 'completed' }); assert.equal(bad.status, 400); assert.match(bad.data.error, /Client signature/);
  const ok = await nav.put(`/api/forms/${fid}`, { values: { client_signature: 'Jamie Nguyen' }, status: 'completed' }); assert.equal(ok.status, 200);
  let f = (await nav.get(`/api/forms/${fid}`)).data.form; assert.equal(f.status, 'completed'); assert.equal(f.values.agree, true); assert.equal(f.values.notes, 'ok'); assert.ok(f.completed_at);
  // locked for navigators, supervisor/admin may reopen
  assert.equal((await nav.put(`/api/forms/${fid}`, { values: { notes: 'changed' } })).status, 400);
  assert.equal((await admin.put(`/api/forms/${fid}`, { status: 'draft' })).status, 200);
  assert.equal((await nav.put(`/api/forms/${fid}`, { values: { notes: 'changed' }, status: 'completed' })).status, 200);
  // printable pdf contains the values (Helvetica text is plain in our writer)
  const out = await nav.req('GET', `/api/forms/${fid}/pdf`); assert.equal(out.status, 200); assert.ok(String(out.data).includes('Jamie Nguyen') && String(out.data).includes('changed'));
  // attach a signed scan (stored encrypted), read back, listed in client forms
  const scan = png.placeholder(200, 260, 5, 1);
  const att = await nav.post(`/api/forms/${fid}/files`, { file_url: 'data:image/png;base64,' + scan.toString('base64'), filename: 'signed.png' }); assert.equal(att.status, 201);
  const db = require('../server/db'); const rawRow = db.one(`SELECT data_enc FROM client_form_files WHERE id=?`, att.data.id); assert.ok(rawRow.data_enc.startsWith('v1:'), 'attachment encrypted at rest');
  const dl = await nav.req('GET', `/api/forms/${fid}/files/${att.data.id}`); assert.equal(dl.status, 200); assert.ok(dl.headers.get('content-type').includes('png'));
  const list = (await nav.get(`/api/clients/${clientId}/forms`)).data.forms; assert.equal(list.length, 1); assert.equal(list[0].attachments, 1); assert.equal(list[0].status, 'completed');
  assert.equal((await nav2.get(`/api/forms/${fid}`)).status, 403);
  // client counts + export + sync
  assert.equal((await nav.get(`/api/clients/${clientId}`)).data.client.counts.forms, 1);
  const csv = String((await admin.get('/api/reports/export/forms?format=csv')).data); assert.ok(csv.includes('Template Name') && csv.includes('Release of Information'));
  const pull = (await admin.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', { 'X-Sync-Client': '1' })).data;
  assert.equal(pull.tables.form_templates.length, 1); assert.equal(pull.tables.client_forms.length, 1); assert.ok(pull.tables.client_form_files[0].data_enc && !pull.tables.client_form_files[0].data_enc.startsWith('v1:'), 'decrypted for transport');
  // retire template: hidden from staff, still usable history
  assert.equal((await admin.del(`/api/forms/templates/${tid}`)).status, 200);
  assert.equal((await nav.get('/api/forms/templates')).data.templates.length, 0); assert.equal((await admin.get('/api/forms/templates?active=0')).data.templates.length, 1);
  assert.equal((await nav.post(`/api/clients/${clientId}/forms`, { template_id: tid })).status, 404);
  // bad uploads
  assert.equal((await admin.post('/api/forms/templates', { name: 'Bad', file_url: 'data:application/pdf;base64,' + Buffer.from('nope').toString('base64') })).status, 400);
  // pdf writer sanity
  const b = pdf.renderForm({ title: 'T', fields: [{ key: 'a', label: 'A', type: 'text' }], values: { a: 'x' } }); assert.ok(b.toString('latin1').includes('%%EOF'));
});
