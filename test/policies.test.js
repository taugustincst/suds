'use strict';
// Policy sign-offs and the PowerDMS report (docs/integration/POWERDMS.md): a policy in the library can be the county's
// PowerDMS document (a link), name the revision staff must sign and the roles asked to sign it; a PowerDMS signature
// or training report, exported as Excel or CSV, records who signed; supervisors see who still has to.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup, nav, nav2, fin;
let u = {};
const URL1 = 'https://powerdms.com/ui/document/48211';
const URL2 = 'https://public.powerdms.com/SUDSCO/documents/77120';
const csv = (rows) => 'data:text/csv;base64,' + Buffer.from(rows.map(r => r.map(v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')).toString('base64');

before(async () => {
  await H.start();
  u.sup = H.makeUser('psup', 'supervisor'); u.nav = H.makeUser('pnav', 'navigator'); u.nav2 = H.makeUser('pnav2', 'navigator');
  u.fin = H.makeUser('pfin', 'finance'); u.clin = H.makeUser('pclin', 'clinician');
  H.db.run(`UPDATE users SET display_name=?, email=? WHERE id=?`, 'Maria Rivera', 'mrivera@example.org', u.nav.id);
  H.db.run(`UPDATE users SET display_name=?, email=? WHERE id=?`, 'Dee Chen', 'dchen@example.org', u.nav2.id);
  H.db.run(`UPDATE users SET display_name=? WHERE id=?`, 'Kim Patel', u.clin.id);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('psup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('pnav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('pnav2', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('pfin', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

let naloxone, part2, handbook;
test('a policy can be the county\'s PowerDMS document: a link instead of a file, with a revision and the roles asked to sign it', async () => {
  const c = await admin.post('/api/documents', { title: 'Naloxone Distribution Policy', category: 'policy', powerdms_url: URL1, revision: '3', ack_roles: ['navigator', 'clinician'] });
  assert.equal(c.status, 201, JSON.stringify(c.data)); naloxone = c.data.id;
  const row = H.db.one(`SELECT * FROM policy_documents WHERE id=?`, naloxone);
  assert.equal(row.powerdms_url, URL1); assert.equal(row.revision, '3'); assert.equal(row.ack_roles, 'clinician,navigator', 'stored sorted, comma-separated');
  assert.equal(row.file_b64, null); assert.equal(row.bytes, 0);
  part2 = (await admin.post('/api/documents', { title: 'Part 2 Confidentiality', category: 'policy', powerdms_url: URL2, ack_roles: 'navigator' })).data.id;
  handbook = (await admin.post('/api/documents', { title: 'Staff Handbook', category: 'procedure', powerdms_url: 'https://powerdms.com/ui/document/50001' })).data.id;
  // Neither a file nor a link: nothing to read.
  assert.equal((await admin.post('/api/documents', { title: 'Empty', category: 'policy' })).status, 400);
  // Only an https address on powerdms.com, with no credentials.
  for (const bad of ['http://powerdms.com/ui/document/1', 'https://powerdms.com.evil.example/document/1', 'https://user:pw@powerdms.com/document/1', 'javascript:alert(1)']) {
    const r = await admin.post('/api/documents', { title: 'Bad', category: 'policy', powerdms_url: bad });
    assert.equal(r.status, 400, bad); assert.ok(r.data.fields && r.data.fields.powerdms_url, bad);
  }
  const badRole = await admin.post('/api/documents', { title: 'Bad', category: 'policy', powerdms_url: URL1, ack_roles: ['navigator', 'janitor'] });
  assert.equal(badRole.status, 400); assert.match(badRole.data.fields.ack_roles, /janitor/);
  // A link-only document cannot lose its link; a new revision is audited with the revision.
  assert.equal((await admin.put(`/api/documents/${part2}`, { powerdms_url: null })).status, 400);
  const list = (await nav.get('/api/documents')).data.documents;
  const n = list.find(d => d.id === naloxone);
  assert.equal(n.powerdms_url, URL1); assert.equal(n.ack_roles, 'clinician,navigator'); assert.equal(n.has_file, false);
  const create = H.db.one(`SELECT details FROM audit_log WHERE action='document.create' AND entity_id=?`, naloxone);
  assert.deepEqual(JSON.parse(create.details).ack_roles, 'clinician,navigator');
});

test('policies:manage is a supervisor\'s and an administrator\'s; everyone sees their own sign-offs', async () => {
  for (const c of [nav, fin]) {
    assert.equal((await c.get('/api/policies/compliance')).status, 403);
    assert.equal((await c.post('/api/policies/report/preview', { file_url: csv([['Email', 'Document', 'Date Signed']]) })).status, 403);
    assert.equal((await c.post('/api/policies/report/import', { file_url: csv([['Email', 'Document', 'Date Signed']]) })).status, 403);
    assert.equal((await c.post('/api/policies/acknowledgements', { document_id: naloxone, user_id: u.nav.id, acknowledged_at: '2026-10-01' })).status, 403);
    assert.equal((await c.get('/api/policies/imports')).status, 403);
  }
  assert.equal((await sup.get('/api/policies/compliance')).status, 200);
  assert.equal((await admin.get('/api/policies/compliance')).status, 200);
  assert.equal((await H.client().get('/api/policies/mine')).status, 401);
  const mine = (await nav.get('/api/policies/mine')).data;
  assert.deepEqual(mine.policies.map(p => p.title).sort(), ['Naloxone Distribution Policy', 'Part 2 Confidentiality'], 'only the policies a navigator is asked to sign');
  assert.equal(mine.outstanding, 2);
  assert.equal((await fin.get('/api/policies/mine')).data.policies.length, 0, 'finance is asked to sign neither');
});

test('a PowerDMS report: staff by email or name, a document by its PowerDMS number or title; what is not signed, unknown or undated is left out and said', async () => {
  const report = csv([
    ['User', 'Email', 'Document ID', 'Document', 'Revision', 'Status', 'Date Signed'],
    ['Rivera, Maria', 'mrivera@example.org', '48211', 'Naloxone Distribution Policy', '3', 'Signed', '10/02/2026 9:15 AM'],
    ['Chen, Dee', '', '', 'Part 2 Confidentiality', '', 'Signed', '2026-10-03'],
    ['Patel, Kim', '', '48211', 'Naloxone Distribution Policy', '2', 'Signed', '2025-12-01'],
    ['Rivera, Maria', 'mrivera@example.org', '77120', 'Part 2 Confidentiality', '', 'Not Signed', ''],
    ['Nobody, Ann', 'ann@example.org', '48211', 'Naloxone Distribution Policy', '3', 'Signed', '2026-10-02'],
    ['Chen, Dee', 'dchen@example.org', '99999', 'Unknown Policy', '1', 'Signed', '2026-10-02'],
    ['Chen, Dee', 'dchen@example.org', '48211', 'Naloxone Distribution Policy', '3', 'Signed', ''],
  ]);
  const p = await sup.post('/api/policies/report/preview', { file_url: report, filename: 'signature-status.csv' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.deepEqual(p.data.counts, { record: 3, not_signed: 1, unknown_staff: 1, unknown_document: 1, no_date: 1 });
  assert.equal(p.data.rows[0].acknowledged_at, '2026-10-02'); assert.equal(p.data.rows[0].user_id, u.nav.id); assert.equal(p.data.rows[0].document_id, naloxone);
  assert.equal(p.data.rows[1].user_id, u.nav2.id, 'by name when there is no email: "Chen, Dee" is Dee Chen');
  assert.equal(p.data.rows[1].document_id, part2, 'by title when there is no document number');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM policy_acknowledgements`).n, 0, 'a preview records nothing');
  const i = await sup.post('/api/policies/report/import', { file_url: report, filename: 'signature-status.csv' });
  assert.equal(i.status, 201, JSON.stringify(i.data)); assert.equal(i.data.recorded, 3);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM policy_acknowledgements WHERE source='powerdms' AND import_id=?`, i.data.id).n, 3);
  // The same report again records nothing new.
  const again = await sup.post('/api/policies/report/import', { file_url: report, filename: 'signature-status.csv' });
  assert.equal(again.data.recorded, 0); assert.equal(again.data.counts.already, 3);
  // The audit holds counts and the file's SHA-256, never a name from the report.
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='policy.report_import' AND entity_id=?`, i.data.id);
  assert.ok(!/Rivera|Chen|Patel|Nobody|example\.org/.test(a.details), a.details);
  assert.match(JSON.parse(a.details).sha256, /^[0-9a-f]{64}$/);
  const imports = (await sup.get('/api/policies/imports')).data.imports;
  assert.equal(imports.length, 2); assert.equal(imports[1].recorded, 3); assert.equal(imports[1].unmatched, 3);
});

test('compliance: signed counts only for the current revision; an older one shows as needing to sign again', async () => {
  const c = (await sup.get('/api/policies/compliance')).data;
  const nal = c.documents.find(d => d.id === naloxone);
  assert.deepEqual({ owed: nal.owed, signed: nal.signed, revision: nal.revision }, { owed: 3, signed: 1, revision: '3' }, 'two navigators and a clinician owe it; Maria signed revision 3');
  const kim = c.staff.find(s => s.id === u.clin.id).items.find(x => x.document_id === naloxone);
  assert.equal(kim.current, false); assert.equal(kim.acknowledgement.revision, '2', 'Kim signed revision 2, which no longer counts');
  const p2 = c.documents.find(d => d.id === part2);
  assert.deepEqual({ owed: p2.owed, signed: p2.signed }, { owed: 2, signed: 1 }, 'with no revision named, any signature counts');
  assert.ok(!c.documents.some(d => d.id === handbook), 'a policy nobody is asked to sign is not in the view');
  assert.ok(!c.staff.some(s => s.id === u.fin.id), 'finance owes nothing and is not listed');
  const mine = (await nav.get('/api/policies/mine')).data;
  assert.equal(mine.outstanding, 1); assert.equal(mine.policies.find(p => p.id === naloxone).signed, true);
  // A new revision in PowerDMS: everyone owes it again.
  assert.equal((await admin.put(`/api/documents/${naloxone}`, { revision: '4' })).status, 200);
  assert.equal((await sup.get('/api/policies/compliance')).data.documents.find(d => d.id === naloxone).signed, 0);
  assert.equal((await nav.get('/api/policies/mine')).data.outstanding, 2);
  const upd = H.db.one(`SELECT details FROM audit_log WHERE action='document.update' AND entity_id=? ORDER BY id DESC LIMIT 1`, naloxone);
  assert.equal(JSON.parse(upd.details).revision, '4');
});

test('a sign-off recorded by hand, and removed when it was recorded in error; both audited', async () => {
  const bad = await sup.post('/api/policies/acknowledgements', { document_id: naloxone, user_id: u.nav2.id, revision: '4', acknowledged_at: '2099-01-01' });
  assert.equal(bad.status, 400, 'not in the future');
  const r = await sup.post('/api/policies/acknowledgements', { document_id: naloxone, user_id: u.nav2.id, revision: '4', acknowledged_at: '2026-10-10' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await sup.post('/api/policies/acknowledgements', { document_id: naloxone, user_id: u.nav2.id, revision: '4', acknowledged_at: '2026-10-11' })).status, 400, 'once per revision');
  assert.equal((await nav2.get('/api/policies/mine')).data.policies.find(p => p.id === naloxone).signed, true);
  assert.equal(H.db.one(`SELECT source FROM policy_acknowledgements WHERE id=?`, r.data.id).source, 'manual');
  assert.equal((await sup.del(`/api/policies/acknowledgements/${r.data.id}`)).status, 200);
  assert.equal((await nav2.get('/api/policies/mine')).data.policies.find(p => p.id === naloxone).signed, false);
  for (const action of ['policy.acknowledge', 'policy.acknowledgement_remove']) assert.ok(H.db.one(`SELECT 1 x FROM audit_log WHERE action=? AND entity_id=?`, action, r.data.id), action);
  assert.equal((await sup.del(`/api/policies/acknowledgements/${r.data.id}`)).status, 404);
});

test('a report SUDS cannot read is refused with what it found; an Excel export reads like a CSV', async () => {
  const noDate = await sup.post('/api/policies/report/preview', { file_url: csv([['Email', 'Document'], ['mrivera@example.org', 'Naloxone Distribution Policy']]) });
  assert.equal(noDate.status, 400); assert.match(noDate.data.error, /signed or completed date/); assert.match(noDate.data.error, /Email, Document/);
  assert.equal((await sup.post('/api/policies/report/preview', {})).status, 400);
  assert.equal((await sup.post('/api/policies/report/preview', { file_url: 'not base64!' })).status, 400);
  const S = require('../server/spreadsheet');
  const xlsx = S.writeWorkbook([{ name: 'Training', columns: [{ key: 'name', label: 'Employee Name' }, { key: 'course', label: 'Course Name' }, { key: 'done', label: 'Completion Date' }],
    rows: [{ name: 'Dee Chen', course: 'Part 2 Confidentiality', done: '2026-10-05' }] }]);
  const r = await sup.post('/api/policies/report/preview', { file_url: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(await xlsx).toString('base64'), filename: 'training.xlsx' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows[0].user_id, u.nav2.id); assert.equal(r.data.rows[0].document_id, part2);
});

test('the PowerDMS helpers: links, roles, document numbers, dates and names', () => {
  const P = require('../server/powerdms');
  assert.equal(P.documentNumber('https://public.powerdms.com/SUDSCO/documents/77120'), '77120');
  assert.equal(P.documentNumber('https://powerdms.com/ui/document/48211?tab=sign'), '48211');
  assert.equal(P.documentNumber('https://powerdms.com/app?documentId=31337'), '31337');
  assert.equal(P.documentNumber('https://powerdms.com/ui/home'), null);
  assert.equal(P.readDate('2/29/2026'), null, 'not a real date');
  assert.equal(P.readDate('2/28/26'), '2026-02-28');
  assert.equal(P.readDate('2026-10-02T09:15:00Z'), '2026-10-02');
  assert.equal(P.nameKey('Rivera, María'), P.nameKey('maria rivera'));
  assert.equal(P.normaliseRoles(''), null);
  assert.throws(() => P.normaliseRoles('owner'), /unknown role/);
});
