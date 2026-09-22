'use strict';
// The compliance review: each test here is a gap that review found — a way the legal record could be
// rewritten, information could leave without a basis, an export could identify someone, an emergency
// access could go unreviewed, a truncated audit log could look intact, or a record could outlive its
// retention with nothing to stop it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

let admin, sup, nav, fin, ro, clin, navId, supId, clientId, resourceId;
const iso = (ms) => new Date(ms).toISOString();
const PART2 = { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT intake', signed_at: '2026-09-01', scope: 'Referral summary and MAT status', expires_at: '2027-09-01', signed_on_paper: true, redisclosure_notice_given: true };
async function push(client, body) { return client.post('/api/sync/push', { device_now: iso(Date.now()), ...body }); }

before(async () => {
  await H.start();
  H.makeUser('cnav', 'navigator'); H.makeUser('csup', 'supervisor'); H.makeUser('cfin', 'finance'); H.makeUser('cro', 'readonly'); H.makeUser('cclin', 'clinician');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('csup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('cnav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('cfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('cro', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('cclin', 'StaffPassw0rd!x');
  navId = H.db.one(`SELECT id FROM users WHERE username='cnav'`).id;
  supId = H.db.one(`SELECT id FROM users WHERE username='csup'`).id;
  clientId = (await nav.post('/api/clients', { first_name: 'Cora', last_name: 'Compliance', dob: '1980-04-12', zip: '95814', city: 'Sacramento', status: 'active' })).data.id;
  resourceId = (await nav.post('/api/resources', { name: 'Riverbend OTP', category: 'mat_otp' })).data.id;
});
after(async () => { await H.stop(); });

// ---- 1. sync cannot rewrite the legal record ----
test('a sync push cannot rewrite a consent, a disclosure or an addendum — only revoke a consent', async () => {
  const consent = await nav.post(`/api/clients/${clientId}/consents`, PART2);
  assert.equal(consent.status, 201);
  const cid = consent.data.id;
  // Change the recipient: refused as immutable, and the row is untouched.
  const r1 = await push(nav, { tables: { consents: [{ id: cid, client_id: clientId, type: 'part2_disclosure', recipient_enc: 'Somebody else', purpose_enc: 'MAT intake', signed_at: '2026-09-01', created_by: navId, updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(r1.status, 200);
  assert.ok(r1.data.rejected.some(x => x.id === cid && x.reason === 'immutable'), JSON.stringify(r1.data.rejected));
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT recipient_enc FROM consents WHERE id=?`, cid).recipient_enc), 'County OTP');

  // Revocation alone is allowed, and is attributed to the pushing user, not whatever the device claimed.
  const r2 = await push(nav, { tables: { consents: [{ id: cid, client_id: clientId, type: 'part2_disclosure', recipient_enc: 'County OTP', purpose_enc: 'MAT intake', scope_enc: 'Referral summary and MAT status', signed_at: '2026-09-01', expires_at: '2027-09-01', signed_on_paper: 1, redisclosure_notice_given: 1, revoked_at: iso(Date.now()), revoked_reason: 'client asked', revoked_by: randomUUID(), created_by: navId, updated_at: iso(Date.now() + 6000) }] } });
  assert.equal(r2.status, 200);
  assert.ok(!r2.data.rejected.some(x => x.id === cid), JSON.stringify(r2.data.rejected));
  const row = H.db.one(`SELECT * FROM consents WHERE id=?`, cid);
  assert.ok(row.revoked_at, 'the revocation landed');
  assert.equal(row.revoked_by, navId, 'attributed to the syncing user');
  assert.equal(row.revoked_reason, 'client asked');

  // A revoked consent cannot be resurrected.
  const r3 = await push(nav, { tables: { consents: [{ id: cid, client_id: clientId, type: 'part2_disclosure', recipient_enc: 'County OTP', purpose_enc: 'MAT intake', signed_at: '2026-09-01', revoked_at: null, created_by: navId, updated_at: iso(Date.now() + 9000) }] } });
  assert.ok(r3.data.rejected.some(x => x.id === cid && x.reason === 'immutable'));
  assert.ok(H.db.one(`SELECT revoked_at FROM consents WHERE id=?`, cid).revoked_at, 'still revoked');

  // Disclosures and addenda: refused outright.
  const live = await nav.post(`/api/clients/${clientId}/consents`, PART2);
  const disc = await nav.post(`/api/clients/${clientId}/disclosures`, { consent_id: live.data.id, disclosed_to: 'County OTP', purpose: 'intake', info_disclosed: 'referral summary', disclosed_at: '2026-09-03T10:00:00Z' });
  assert.equal(disc.status, 201);
  const r4 = await push(nav, { tables: { disclosures: [{ id: disc.data.id, client_id: clientId, recipient_enc: 'A different agency', purpose_enc: 'rewritten', what_enc: 'everything', disclosed_at: '2026-09-03T10:00:00.000Z', disclosed_by: navId, updated_at: iso(Date.now() + 5000) }] } });
  assert.ok(r4.data.rejected.some(x => x.id === disc.data.id && x.reason === 'immutable'));
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT recipient_enc FROM disclosures WHERE id=?`, disc.data.id).recipient_enc), 'County OTP');

  const note = await nav.post('/api/notes', { client_id: clientId, kind: 'admin', content: 'Intake call.', occurred_at: '2026-09-01T10:00:00Z' });
  const add = await nav.post(`/api/notes/${note.data.id}/addenda`, { content: 'Clarification.', reason: 'typo' });
  const r5 = await push(nav, { tables: { note_addenda: [{ id: add.data.id, note_id: note.data.id, author_id: navId, content_enc: 'Rewritten history', reason: 'typo', updated_at: iso(Date.now() + 5000) }] } });
  assert.ok(r5.data.rejected.some(x => x.id === add.data.id && x.reason === 'immutable'));
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT content_enc FROM note_addenda WHERE id=?`, add.data.id).content_enc), 'Clarification.');

  // New rows still insert, and pull still serves the tables.
  const fresh = randomUUID();
  const r6 = await push(nav, { tables: { consents: [{ id: fresh, client_id: clientId, type: 'roi', recipient_enc: 'Mother', signed_at: '2026-09-02', created_by: navId, created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.equal(r6.data.applied.consents, 1);
  const pull = await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
  assert.equal(pull.status, 200);
  assert.ok(pull.data.tables.consents.some(c => c.id === fresh && c.recipient_enc === 'Mother'));
  assert.ok(pull.data.tables.disclosures.some(d => d.id === disc.data.id));
});

// ---- 2. the outcome route is gated like the update route ----
test('recording an outcome that names the client to the agency needs the same consent as an update', async () => {
  const c2 = (await nav.post('/api/clients', { first_name: 'Otto', last_name: 'Outcome' })).data.id;
  const ref = await nav.post('/api/referrals', { client_id: c2, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', status: 'pending' });
  assert.equal(ref.status, 201, JSON.stringify(ref.data));
  const denied = await nav.post(`/api/referrals/${ref.data.id}/outcome`, { status: 'admitted' });
  assert.equal(denied.status, 400, 'admitted means the agency was told who this is — refused without consent');
  assert.match(denied.data.error, /consent/i);
  assert.equal(H.db.one(`SELECT status FROM referrals WHERE id=?`, ref.data.id).status, 'pending', 'and nothing changed');
  assert.ok(!H.db.one(`SELECT 1 FROM disclosures WHERE source='referral' AND source_ref=?`, ref.data.id));

  const consent = await nav.post(`/api/clients/${c2}/consents`, { ...PART2, recipient: 'Riverbend OTP' });
  const ok = await nav.post(`/api/referrals/${ref.data.id}/outcome`, { status: 'admitted', outcome: 'Started buprenorphine', consent_id: consent.data.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const disc = H.db.one(`SELECT * FROM disclosures WHERE source='referral' AND source_ref=?`, ref.data.id);
  assert.ok(disc, 'the outcome wrote the disclosure record');
  assert.equal(disc.consent_id, consent.data.id);
  const row = (await nav.get(`/api/referrals/${ref.data.id}`)).data.row;
  assert.equal(row.status, 'admitted'); assert.equal(row.outcome, 'Started buprenorphine', 'outcome round-trips through encryption');
  assert.match(H.db.one(`SELECT outcome_enc FROM referrals WHERE id=?`, ref.data.id).outcome_enc, /^v1:/, 'and is stored encrypted');
  // A second outcome on the same referral does not write a second disclosure.
  await nav.post(`/api/referrals/${ref.data.id}/outcome`, { status: 'completed' });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='referral' AND source_ref=?`, ref.data.id).n, 1);
});

// ---- 3 & 4. exports: permission, Safe Harbor, labelling ----
test('exports need export:read; de-identified exports meet Safe Harbor', async () => {
  await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', occurred_at: '2026-09-10T10:00:00Z', duration_minutes: 20 });
  await nav.post('/api/overdose-events', { client_id: clientId, occurred_at: '2026-09-11T02:00:00Z', kind: 'reversal', substances: 'fentanyl', city: 'Sacramento', naloxone_used: true });
  assert.equal((await ro.get('/api/reports/export/clients')).status, 403, 'readonly: no export:read');
  assert.equal((await ro.get('/api/reports/export/workbook')).status, 403);
  // Front-line roles export, de-identified only: identified=1 is ignored without export:identified
  for (const [who, c] of [['navigator', nav], ['clinician', clin]]) {
    const r = await c.get('/api/reports/export/clients?identified=1&recipient=x&purpose=y');
    assert.equal(r.status, 200, `${who}: export:read`);
    assert.ok(!String(r.data).includes('Cora') && !String(r.data).includes('1980-04-12'), `${who}: never identified`);
    assert.match(r.headers.get('x-suds-export'), /^De-identified/);
    assert.equal((await c.get('/api/reports/export/workbook')).status, 200, `${who}: workbook`);
  }
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='export'`).n, 0, 'nothing was accounted for: nobody was identified');

  const csv = await fin.get('/api/reports/export/clients?from=2026-01-01&to=2026-12-31');
  assert.equal(csv.status, 200);
  const text = String(csv.data).replace(/^\uFEFF/, '');
  assert.match(csv.headers.get('x-suds-export'), /^De-identified \(HIPAA Safe Harbor\)/, 'labelled in the response header');
  assert.match(csv.headers.get('content-disposition'), /-deidentified\.csv/, 'and in the filename');
  assert.ok(!text.startsWith('#'), 'no comment line: the header is row 1');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(','); const data = lines.find(l => l.includes(H.db.one(`SELECT client_code FROM clients WHERE id=?`, clientId).client_code)).split(',');
  const col = (name) => data[header.indexOf(name)];
  assert.ok(!text.includes('Cora') && !text.includes('1980-04-12'), 'no name, no date of birth');
  assert.ok(!header.includes('City'), 'city is dropped');
  assert.equal(col('Zip'), '958', 'ZIP is three digits');
  assert.equal(col('Age Band'), '45-54', 'DOB becomes an age band');
  assert.match(col('Intake Date'), /^\d{4}-\d{2}$/, 'dates are reduced to the month');

  const od = String((await fin.get('/api/reports/export/overdose_events?from=2026-01-01&to=2026-12-31')).data);
  assert.ok(!od.includes('fentanyl'), 'substances are redacted'); assert.ok(!od.includes('Sacramento'), 'city dropped');
  assert.match(od, /2026-09,/, 'event date reduced to the month');
  const iv = String((await fin.get('/api/reports/export/interventions?from=2026-01-01&to=2026-12-31')).data);
  assert.match(iv, /\n2026-09,/, 'intervention dates reduced to the month');

  // Identified: full dates, full ZIP, and accounted for.
  const id = String((await sup.get('/api/reports/export/clients?identified=1&recipient=County%20counsel&purpose=Subpoena%20response')).data);
  assert.ok(id.includes('Cora') && id.includes('1980-04-12') && id.includes('95814'));
  assert.ok(!id.startsWith('#') && !id.startsWith('\uFEFF#'), 'no comment line');
  // Workbook carries an About sheet naming the classification.
  const finBearer = (await H.client().post('/api/auth/login', { username: 'cfin', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token;
  const wbRes = await fetch(`${await H.start()}/api/reports/export/workbook?from=2026-01-01&to=2026-12-31`, { headers: { Authorization: `Bearer ${finBearer}` } });
  assert.equal(wbRes.status, 200);
  const sheets = require('../server/spreadsheet').readWorkbook(Buffer.from(await wbRes.arrayBuffer()));
  assert.ok(sheets.some(s => s.name === 'About' && JSON.stringify(s.rows).includes('Safe Harbor')), 'the workbook carries an About sheet naming the classification');
});

test('a de-identified export carries exactly its allow-listed columns, whatever the row holds', async () => {
  // Seed rows with free text in every column Safe Harbor by column name used to let through.
  const seeded = async (p, c, path, body) => { const r = await c.post(path, body); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.data)}`); return r; };
  await seeded(1, nav, '/api/interventions', { client_id: clientId, type: 'outreach', occurred_at: '2026-09-12T10:00:00Z', duration_minutes: 20, location: 'community', summary: 'Met Cora at her camp under the 5th St bridge by the blue tent' });
  await seeded(1, nav, '/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-12T11:00:00Z', contact_name: 'Cora Compliance', purpose: 'Check in on Cora', summary: 'Cora sounded well' });
  await seeded(1, nav, `/api/clients/${clientId}/consents`, { ...PART2, document_ref: 'ROI-CORA-2026' });
  await seeded(1, sup, `/api/clients/${clientId}/disclosures`, { disclosed_to: 'Riverbend OTP', purpose: 'Cora intake', info_disclosed: 'MAT status of Cora', disclosed_at: '2026-09-12T12:00:00Z', basis: 'court_order' });
  await seeded(1, nav, '/api/tasks', { client_id: clientId, title: 'Call Cora about housing', description: 'Cora prefers mornings', due_at: '2026-09-20' });
  await seeded(1, nav, '/api/referrals', { client_id: clientId, resource_id: resourceId, referred_at: '2026-09-12T09:00:00Z', notes: 'Cora asked for a female counsellor' });
  const fundId = (await seeded(1, sup, '/api/budget/funds', { name: 'Deid Fund', source_type: 'sor_grant', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 1000 })).data.id;
  await seeded(1, sup, '/api/budget/expenditures', { funding_source_id: fundId, client_id: clientId, spent_at: '2026-09-12', amount: 12.5, category: 'transportation', vendor: 'Cora Cabs', description: 'Ride for Cora Compliance', receipt_ref: 'RCPT-CORA-1' });

  const expected = {
    clients: ['Client Code', 'Age Band', 'Status', 'Intake Date', 'Discharge Date', 'Discharge Reason', 'Referral Source', 'Referral Date', 'Engagement Date', 'Days To Engagement', 'Primary Substance', 'Secondary Substances', 'Asam Level', 'Mat Status', 'Mat Medication', 'Risk Level', 'Housing Status', 'Insurance', 'Overdose History', 'Naloxone Provided', 'Naloxone Last Date', 'Co Occurring Mh', 'Justice Involved', 'Pregnant Or Parenting', 'Zip', 'Gender', 'Preferred Language'],
    interventions: ['Occurred At', 'Client Code', 'Type', 'Duration Minutes', 'Modality', 'Outcome', 'Stage Of Change', 'Naloxone Kits', 'Fentanyl Strips', 'Worker', 'Funding Source', 'Cost', 'Follow Up Due'],
    calls: ['Started At', 'Client Code', 'Direction', 'Contact Type', 'Duration Minutes', 'Outcome', 'Crisis', 'Follow Up Needed', 'Follow Up Due', 'Worker'],
    time: ['Work Date', 'Worker', 'Client Code', 'Category', 'Minutes', 'Billable', 'Funding Source'],
    referrals: ['Referred At', 'Client Code', 'Resource', 'Category', 'Status', 'Urgency', 'Warm Handoff', 'Appointment At', 'Admitted At', 'Closed At', 'Worker'],
    tasks: ['Client Code', 'Assignee', 'Due At', 'Priority', 'Status', 'Is Milestone', 'Completed At'],
    forms: ['Created At', 'Client Code', 'Template Name', 'Status', 'Completed At', 'Completed By', 'Created By', 'Attachments'],
    consents: ['Client Code', 'Type', 'Signed At', 'Expires At', 'Expires Event', 'Revoked At', 'Redisclosure Notice Given'],
    disclosures: ['Client Code', 'Disclosed At', 'Method', 'Basis', 'Source', 'Disclosed By'],
    episodes: ['Client Code', 'Opened At', 'Closed At', 'Status', 'Referral Source', 'Discharge Reason', 'Discharge Disposition', 'Funding Source'],
    overdose_events: ['Occurred At', 'Client Code', 'Kind', 'Naloxone Used', 'Naloxone Doses', 'Administered By', 'Ems Called', 'Hospitalized', 'Survived', 'Location Type'],
    expenditures: ['Spent At', 'Fund', 'Line', 'Category', 'Amount', 'Status', 'Client Code', 'Worker', 'Approver'],
  };
  const X = require('../server/exports');
  assert.deepEqual(Object.keys(X.DEID_COLUMNS).sort(), Object.keys(expected).sort(), 'every client-linked dataset has an allow-list');
  for (const [kind, cols] of Object.entries(expected)) {
    const r = await fin.get(`/api/reports/export/${kind}?from=2026-01-01&to=2026-12-31`);
    assert.equal(r.status, 200, kind);
    const text = String(r.data).replace(/^\uFEFF/, '');
    const header = require('../server/spreadsheet').parseCsv(text)[0];
    assert.deepEqual(header, cols, `${kind}: exact de-identified column set`);
    for (const leak of ['Cora', 'bridge', 'blue tent', 'ROI-CORA', 'RCPT-CORA', 'Cora Cabs', 'housing', 'counsellor', 'mornings', '[redacted]']) assert.ok(!text.includes(leak), `${kind}: "${leak}" must not appear`);
  }
  // The same datasets identified still carry the full column set.
  const ivr = await sup.get('/api/reports/export/interventions?identified=1&recipient=County%20counsel&purpose=Subpoena&from=2026-01-01&to=2026-12-31');
  const iv = String(ivr.data);
  assert.equal(ivr.status, 200, iv.slice(0, 200));
  assert.ok(iv.includes('Location') && iv.includes('blue tent'), iv.slice(0, 600));
});

test('an identified workbook writes one disclosure per client, not one per sheet, and does not account for itself', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='export' AND client_id=?`, clientId).n;
  const wbRes = await fetch(`${await H.start()}/api/reports/export/workbook?identified=1&recipient=State%20auditor&purpose=Grant%20audit&from=2026-01-01&to=2026-12-31`, { headers: { Authorization: `Bearer ${(await H.client().post('/api/auth/login', { username: 'csup', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token}` } });
  assert.equal(wbRes.status, 200);
  assert.match(wbRes.headers.get('x-suds-export'), /^Identified export - PHI\. Disclosed to: State auditor/);
  const rows = H.db.all(`SELECT * FROM disclosures WHERE source='export' AND client_id=? ORDER BY created_at`, clientId);
  assert.equal(rows.length, before + 1, 'one accounting row for the client although it appears on several sheets');
  const d = require('../server/disclosure').present(rows[rows.length - 1]);
  assert.equal(d.source_ref, 'workbook'); assert.match(d.what, /workbook/); assert.equal(d.recipient, 'State auditor');
  const sheets = require('../server/spreadsheet').readWorkbook(Buffer.from(await wbRes.arrayBuffer()));
  const acct = sheets.find(s => s.name === 'Accounting of disclosures');
  assert.ok(acct, 'the accounting sheet is still in the workbook');
  assert.ok(!JSON.stringify(acct.rows).includes('State auditor'), 'the rows this very export wrote are not on it');
  assert.ok(JSON.stringify(acct.rows).includes('Riverbend OTP'), 'earlier disclosures are');
  const idx = sheets.findIndex(s => s.name === 'Accounting of disclosures');
  assert.ok(idx > 1 && idx < sheets.length - 1, 'the sheet keeps its place among the others');
});

test('CSV cells that a spreadsheet would run as formulas are neutralised', async () => {
  await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', occurred_at: '2026-09-13T10:00:00Z', duration_minutes: 5, summary: '=HYPERLINK("http://evil.example/x","click")' });
  await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-13T11:00:00Z', purpose: '+cmd|\' /C calc\'!A0' });
  const id = String((await sup.get('/api/reports/export/interventions?identified=1&recipient=County%20counsel&purpose=Subpoena&from=2026-01-01&to=2026-12-31')).data);
  assert.ok(id.includes(`"'=HYPERLINK(""http://evil.example/x"",""click"")"`), id.split('\n').find(l => l.includes('HYPERLINK')));
  const calls = String((await sup.get('/api/reports/export/calls?identified=1&recipient=County%20counsel&purpose=Subpoena&from=2026-01-01&to=2026-12-31')).data);
  assert.ok(calls.includes(`"'+cmd|' /C calc'!A0"`), calls.split('\n').find(l => l.includes('cmd')));
  assert.ok(!/(^|,)=HYPERLINK/m.test(id), 'no cell starts with =');
  // Excel: the same text is an inline string, never a formula
  const wb = await fetch(`${await H.start()}/api/reports/export/interventions?identified=1&recipient=County%20counsel&purpose=Subpoena&from=2026-01-01&to=2026-12-31&format=xlsx`, { headers: { Authorization: `Bearer ${(await H.client().post('/api/auth/login', { username: 'csup', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token}` } });
  const files = require('../server/importers/text').unzip(Buffer.from(await wb.arrayBuffer()));
  const xml = String(files.get([...files.keys()].find(k => k.includes('worksheets/sheet1.xml'))));
  assert.ok(!xml.includes('<f>'), 'no formula cells');
  assert.ok(xml.includes('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK'), 'written as an inline string');
});

test('the import template is not an export: it needs the import permission, not export:read', async () => {
  assert.equal((await ro.get('/api/imports/data/template/clients')).status, 403, 'readonly cannot import');
  assert.equal((await fin.get('/api/imports/data/template/clients')).status, 403, 'finance cannot import clients');
  const t = await nav.get('/api/imports/data/template/clients?format=csv');
  assert.equal(t.status, 200); assert.ok(String(t.data).includes('First name'));
  assert.equal((await nav.get('/api/imports/data/template/clients')).status, 200);
});

test('the funder report suppresses small cells but keeps totals', async () => {
  const r = await sup.get('/api/reports/funder?from=2026-01-01&to=2026-12-31');
  assert.equal(r.status, 200);
  assert.equal(r.data.small_cell_threshold, 11);
  for (const rows of Object.values(r.data.demographics)) for (const x of rows) assert.ok(x.n === '<11' || x.n >= 11, `${x.k}: ${x.n}`);
  assert.equal(typeof r.data.unduplicated.served, 'number', 'totals are exact');
});

// ---- 5. 'other' and medical-emergency bases must be justified ----
test('a disclosure without consent on an "other" basis needs a supervisor and a written justification', async () => {
  const body = { disclosed_to: 'Probation officer', purpose: 'Court-ordered check-in', info_disclosed: 'Attendance', disclosed_at: '2026-09-05T10:00:00Z', basis: 'other' };
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { ...body, justification: 'Because the officer asked for it during the monthly check-in' })).status, 403, 'a navigator cannot override consent');
  assert.equal((await sup.post(`/api/clients/${clientId}/disclosures`, body)).status, 400, 'no justification');
  assert.equal((await sup.post(`/api/clients/${clientId}/disclosures`, { ...body, justification: 'short' })).status, 400, 'too short');
  const ok = await sup.post(`/api/clients/${clientId}/disclosures`, { ...body, justification: 'Court order 26-CR-1234 on file; judge required attendance reporting.' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const row = H.db.one(`SELECT * FROM disclosures WHERE id=?`, ok.data.id);
  assert.match(row.justification_enc, /^v1:/, 'the justification is stored encrypted');
  const listed = (await sup.get(`/api/clients/${clientId}/consents`)).data.disclosures.find(d => d.id === ok.data.id);
  assert.match(listed.justification, /26-CR-1234/);

  // Medical emergency: any consents:write role, but the justification is still required.
  const em = { ...body, basis: 'medical_emergency', disclosed_to: 'Mercy General ED' };
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, em)).status, 400);
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { ...em, justification: 'Unresponsive after overdose; ED needed current buprenorphine dose.' })).status, 201);
  // Other Part 2 exceptions keep working as before.
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { ...body, basis: 'court_order' })).status, 201);
  // A referral cannot use 'other' without justification either.
  const c3 = (await nav.post('/api/clients', { first_name: 'Ref', last_name: 'Other' })).data.id;
  assert.equal((await sup.post('/api/referrals', { client_id: c3, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, _disclosure_basis: 'other' })).status, 400);
  assert.equal((await sup.post('/api/referrals', { client_id: c3, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, _disclosure_basis: 'other', _disclosure_justification: 'County counsel approved sharing under the QSOA amendment dated 2026-08-01.' })).status, 201);
});

// ---- 6. identified exports are accounted for ----
test('an identified export writes one disclosure per client it contains', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='export' AND client_id=?`, clientId).n;
  assert.equal((await sup.get('/api/reports/export/interventions?identified=1&from=2026-01-01&to=2026-12-31')).status, 400, 'recipient and purpose are required');
  assert.equal((await sup.get('/api/reports/export/interventions?identified=1&recipient=x&from=2026-01-01&to=2026-12-31')).status, 400);
  const r = await sup.get('/api/reports/export/interventions?identified=1&recipient=State%20auditor&purpose=SOR%20grant%20audit&from=2026-01-01&to=2026-12-31');
  assert.equal(r.status, 200);
  const rows = H.db.all(`SELECT * FROM disclosures WHERE source='export' AND client_id=? ORDER BY created_at`, clientId);
  assert.equal(rows.length, before + 1, 'exactly one accounting row for this client');
  const d = require('../server/disclosure').present(rows[rows.length - 1]);
  assert.equal(d.basis, 'export'); assert.equal(d.recipient, 'State auditor'); assert.equal(d.purpose, 'SOR grant audit'); assert.match(d.what, /interventions/);
  assert.equal(d.source_ref, 'interventions');
  // A de-identified export of the same data records nothing: nobody is identified.
  const n2 = H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='export'`).n;
  await fin.get('/api/reports/export/interventions?from=2026-01-01&to=2026-12-31');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='export'`).n, n2);
  // And it shows up in the client's printable accounting.
  const acct = await nav.get(`/api/clients/${clientId}/disclosures/accounting`);
  assert.equal(acct.status, 200);
  assert.ok(acct.data.disclosures.some(x => x.basis === 'export' && x.recipient === 'State auditor'));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='disclosure.accounting' AND client_id=?`, clientId), 'producing the accounting is audited');
  assert.equal((await ro.get(`/api/clients/${clientId}/disclosures/accounting`)).status, 403);
});

// ---- 7. Part 2 consent elements ----
test('a Part 2 consent must carry every §2.31 element', async () => {
  const base = { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT intake', signed_at: '2026-09-01' };
  const post = (b) => nav.post(`/api/clients/${clientId}/consents`, b);
  const full = { ...base, scope: 'MAT status', expires_at: '2027-01-01', witness: 'J. Walker', redisclosure_notice_given: true };
  assert.equal((await post(full)).status, 201);
  for (const [k, why] of [['scope', 'scope'], ['expires_at', 'expiration'], ['witness', 'signature evidence'], ['redisclosure_notice_given', 'redisclosure notice']]) {
    const b = { ...full }; delete b[k];
    const r = await post(b);
    assert.equal(r.status, 400, `missing ${why} is refused`);
  }
  // An event can stand in for an expiry date; "signed on paper" or a document reference for the witness.
  assert.equal((await post({ ...full, expires_at: undefined, expires_event: 'Discharge from the program' })).status, 201);
  assert.equal((await post({ ...full, witness: undefined, signed_on_paper: true })).status, 201);
  assert.equal((await post({ ...full, witness: undefined, document_ref: 'Scan 2026-09-01' })).status, 201);
  // Other consent types are unaffected.
  assert.equal((await post({ type: 'roi', signed_at: '2026-09-01' })).status, 201);
  const listed = (await nav.get(`/api/clients/${clientId}/consents`)).data.consents.find(c => c.expires_event);
  assert.equal(listed.expires_event, 'Discharge from the program'); assert.equal(listed.redisclosure_notice_given, 1);
});

// ---- 8. break-glass ----
test('break-glass needs a real reason and queues for supervisor acknowledgement', async () => {
  const cl = (await clin.post('/api/clients', { first_name: 'Glass', last_name: 'Case' })).data.id;
  const n = await clin.post('/api/notes', { client_id: cl, kind: 'clinical', content: 'Relapse discussed.', occurred_at: '2026-09-05T10:00:00Z' });
  assert.equal(n.status, 201);
  const short = await admin.get(`/api/notes/${n.data.id}`, { 'X-Break-Glass-Reason': 'audit' });
  assert.equal(short.status, 400, 'a one-word reason is refused');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM breakglass_events`).n, 0);
  const ok = await admin.get(`/api/notes/${n.data.id}`, { 'X-Break-Glass-Reason': 'Privacy officer investigation #77 into complaint' });
  assert.equal(ok.status, 200);
  const list = await admin.get(`/api/notes?client_id=${cl}&kind=clinical`, { 'X-Break-Glass-Reason': 'Privacy officer investigation #77 into complaint' });
  assert.equal(list.status, 200);
  const events = H.db.all(`SELECT * FROM breakglass_events WHERE client_id=? ORDER BY at`, cl);
  assert.equal(events.length, 2, 'the note view and the list each queue an event');
  assert.match(events[0].reason_enc, /^v1:/, 'the reason is stored encrypted');
  assert.equal(events[0].note_id, n.data.id);

  assert.equal((await nav.get('/api/supervision/breakglass')).status, 403, 'needs audit:read');
  const q = await sup.get('/api/supervision/breakglass');
  assert.equal(q.status, 200);
  const mine = q.data.rows.filter(r => r.client_id === cl);
  assert.equal(mine.length, 2); assert.match(mine[0].reason, /investigation #77/); assert.equal(mine[0].user_role, 'admin');
  assert.ok((await sup.get('/api/supervision/queue')).data.breakglass_unacknowledged >= 2, 'the supervision queue counts them');
  assert.ok((await sup.get('/api/reports/dashboard')).data.breakglass_pending >= 2, 'and so does the dashboard');
  assert.equal((await admin.post(`/api/supervision/breakglass/${events[0].id}/ack`, {})).status, 403, 'nobody reviews their own access');
  assert.equal((await sup.post(`/api/supervision/breakglass/${events[0].id}/ack`, {})).status, 200);
  assert.equal((await sup.post(`/api/supervision/breakglass/${events[0].id}/ack`, {})).status, 400, 'once');
  const row = H.db.one(`SELECT * FROM breakglass_events WHERE id=?`, events[0].id);
  assert.equal(row.acknowledged_by, supId); assert.ok(row.acknowledged_at);
  assert.ok(!(await sup.get('/api/supervision/breakglass')).data.rows.some(r => r.id === events[0].id), 'acknowledged events leave the queue');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='breakglass.acknowledge' AND entity_id=?`, events[0].id));
});

// ---- 9. audit checkpoint ----
test('deleting the newest audit rows after a checkpoint is detected as truncation', async () => {
  const audit = require('../server/audit');
  assert.equal(audit.verifyChain().ok, true);
  const cp = audit.checkpoint();
  assert.ok(cp && cp.head && H.db.getSetting('audit_head'), 'the head is sealed into settings');
  audit.log({ user: { username: 'system' }, action: 'test.after.checkpoint' });
  audit.log({ user: { username: 'system' }, action: 'test.after.checkpoint' });
  let v = audit.verifyChain();
  assert.equal(v.ok, true); assert.equal(v.truncated, false, 'appending after the checkpoint is fine');
  // Now cut the newest rows back past the checkpoint: the chain itself is still perfect.
  H.db.run(`DELETE FROM audit_log WHERE id >= ?`, cp.lastId);
  v = audit.verifyChain();
  assert.equal(v.ok, false); assert.equal(v.truncated, true); assert.match(v.reason, /gone/);
  assert.equal((await admin.get('/api/admin/audit/verify')).data.truncated, true, 'and the admin verify says so');
  // Re-checkpointing (what the scheduled verify does on success) re-seals at the new head.
  const again = audit.scheduledVerify();
  assert.equal(again.ok, false, 'a failed verify does not move the checkpoint');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='audit.verify.failed'`));
  audit.checkpoint();
  assert.equal(audit.verifyChain().ok, true);
  // Removing a row at or before the checkpoint (other than by purge) also fails the seal.
  const cp2 = audit.checkpoint();
  H.db.run(`DELETE FROM audit_log WHERE id = (SELECT MIN(id) FROM audit_log)`);
  const v3 = audit.verifyChain();
  assert.equal(v3.ok, false); assert.equal(v3.truncated, true);
  assert.ok(cp2.rowCount > 0);
  audit.checkpoint();
});

// ---- 10. legal hold, patient requests, retention ----
test('legal hold: administrators only; blocks deletion and the retention purge', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Held', last_name: 'Record', status: 'closed', discharge_date: '2010-01-01' })).data.id;
  assert.equal((await sup.post(`/api/clients/${c}/legal-hold`, { hold: true, reason: 'Litigation 26-CV-1' })).status, 403, 'supervisors cannot place a hold');
  assert.equal((await admin.post(`/api/clients/${c}/legal-hold`, { hold: true })).status, 400, 'a hold needs a reason');
  assert.equal((await admin.post(`/api/clients/${c}/legal-hold`, { hold: true, reason: 'Litigation 26-CV-1' })).status, 200);
  assert.equal(H.db.one(`SELECT legal_hold FROM clients WHERE id=?`, c).legal_hold, 1);
  assert.equal((await admin.del(`/api/clients/${c}`, { reason: 'cleanup' })).status, 400, 'a held record cannot be deleted');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='client.legal_hold.set' AND client_id=?`, c));
  const R = require('../server/retention');
  H.db.run(`UPDATE episodes SET status='closed', closed_at='2010-01-02' WHERE client_id=?`, c);
  assert.ok(!R.expiredClients().some(x => x.id === c), 'held records are never selected for purge');
  assert.equal((await admin.post(`/api/clients/${c}/legal-hold`, { hold: false })).status, 200);
  assert.ok(R.expiredClients().some(x => x.id === c), 'once cleared, an old closed record is due');
});

test('patient-rights requests get a 30-day clock and a client tab', async () => {
  assert.equal((await ro.get(`/api/patient-requests?client_id=${clientId}`)).status, 403);
  assert.equal((await fin.post('/api/patient-requests', { client_id: clientId, kind: 'access', received_at: '2026-09-01' })).status, 403);
  const r = await nav.post('/api/patient-requests', { client_id: clientId, kind: 'access', received_at: '2026-07-01', notes: 'Wants a copy of her intake assessment' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = H.db.one(`SELECT * FROM patient_requests WHERE id=?`, r.data.id);
  assert.equal(row.due_at, '2026-07-31', '30 days from receipt'); assert.equal(row.status, 'open'); assert.match(row.notes_enc, /^v1:/);
  const list = await nav.get(`/api/patient-requests?client_id=${clientId}`);
  assert.equal(list.data.rows[0].notes, 'Wants a copy of her intake assessment'); assert.equal(list.data.rows[0].overdue, true);
  assert.equal((await nav.post('/api/patient-requests', { client_id: clientId, kind: 'refund', received_at: '2026-09-01' })).status, 400);
  const done = await nav.put(`/api/patient-requests/${r.data.id}`, { status: 'fulfilled', notes: 'Copy provided in person 2026-09-10' });
  assert.equal(done.status, 200);
  const after = H.db.one(`SELECT * FROM patient_requests WHERE id=?`, r.data.id);
  assert.equal(after.status, 'fulfilled'); assert.ok(after.closed_at);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='patient_request.create' AND client_id=?`, clientId));
  // Synced like any other client record.
  const pull = await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
  assert.ok(pull.data.tables.patient_requests.some(x => x.id === r.data.id && x.notes_enc === 'Copy provided in person 2026-09-10'));
});

test('retention purge hard-deletes an expired record across every table, and nothing else', async () => {
  const R = require('../server/retention');
  const old = (await nav.post('/api/clients', { first_name: 'Ancient', last_name: 'File', status: 'closed', discharge_date: '2012-03-01', intake_date: '2011-01-01' })).data.id;
  const keep = (await nav.post('/api/clients', { first_name: 'Recent', last_name: 'File', status: 'closed', discharge_date: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10) })).data.id;
  const stillOpen = (await nav.post('/api/clients', { first_name: 'Open', last_name: 'Episode', status: 'closed', discharge_date: '2012-03-01' })).data.id;
  for (const c of [old, keep, stillOpen]) {
    await nav.post('/api/interventions', { client_id: c, type: 'outreach', occurred_at: '2012-01-05T10:00:00Z', duration_minutes: 10 });
    await nav.post('/api/tasks', { client_id: c, title: 'Old to-do' });
    await nav.post('/api/notes', { client_id: c, kind: 'admin', content: 'Old note', occurred_at: '2012-01-05T10:00:00Z' });
    await nav.post(`/api/clients/${c}/consents`, { type: 'roi', signed_at: '2012-01-05' });
    await nav.post('/api/time', { client_id: c, work_date: '2012-01-05', minutes: 15, category: 'direct_service' });
  }
  H.db.run(`UPDATE episodes SET status='closed', closed_at='2012-03-01' WHERE client_id IN (?,?)`, old, keep);
  assert.equal((await nav.post(`/api/clients/${stillOpen}/episodes`, { opened_at: '2012-01-01' })).status, 201);
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, old).client_code;
  const due = R.expiredClients();
  assert.ok(due.some(x => x.id === old), 'a record closed 14 years ago is due');
  assert.ok(!due.some(x => x.id === keep), 'one closed last year is not');
  assert.ok(!due.some(x => x.id === stillOpen), 'an open episode keeps the record');

  const res = R.purgeExpiredClients();
  assert.ok(res.purged.includes(code));
  assert.ok(!H.db.one(`SELECT 1 FROM clients WHERE id=?`, old), 'the client row is gone');
  for (const t of ['interventions', 'tasks', 'notes', 'consents', 'episodes', 'assignments']) assert.equal(H.db.one(`SELECT COUNT(*) n FROM ${t} WHERE client_id=?`, old).n, 0, `${t} purged`);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE client_id=?`, old).n, 0, 'time is unlinked');
  assert.ok(H.db.one(`SELECT 1 FROM time_entries WHERE client_id IS NULL AND work_date='2012-01-05'`), 'but the hours worked are kept');
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='clients' AND id=?`, old), 'devices are told');
  assert.ok(H.db.one(`SELECT 1 FROM clients WHERE id=?`, keep) && H.db.one(`SELECT 1 FROM clients WHERE id=?`, stillOpen), 'other records untouched');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.purge' AND entity_id=?`, old);
  assert.ok(a && a.details.includes(code) && !a.details.includes('Ancient'), 'audited by code only');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM breakglass_events WHERE client_id=?`, old).n, 0);
  // The county controls the period, but not below the HIPAA floor.
  assert.equal((await admin.put('/api/admin/settings', { client_retention_years: 2 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { client_retention_years: 10 })).status, 200);
  assert.equal(R.retentionYears(), 10);
});

// ---- 11. encrypted columns keep their API names ----
test('call purposes, task titles, referral text and overdose substances are stored encrypted', async () => {
  const call = await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-02T10:00:00Z', purpose: 'Detox bed availability', follow_up_needed: true, follow_up_due: '2026-09-03' });
  assert.equal(call.status, 201);
  const raw = H.db.one(`SELECT * FROM calls WHERE id=?`, call.data.id);
  assert.ok(!('purpose' in raw)); assert.match(raw.purpose_enc, /^v1:/);
  assert.equal((await nav.get(`/api/calls/${call.data.id}`)).data.row.purpose, 'Detox bed availability');
  const task = H.db.one(`SELECT * FROM tasks WHERE client_id=? AND due_at='2026-09-03'`, clientId);
  assert.ok(task && !('title' in task) && /^v1:/.test(task.title_enc), 'the follow-up task title is encrypted too');
  const tasks = (await nav.get(`/api/tasks?client_id=${clientId}`)).data.rows;
  assert.ok(tasks.some(t => t.title === 'Call back: Detox bed availability'));
  const t2 = await nav.post('/api/tasks', { client_id: clientId, title: 'Naloxone refill' });
  assert.equal((await nav.put(`/api/tasks/${t2.data.id}`, { title: 'Naloxone refill (2 kits)' })).status, 200);
  assert.equal((await nav.get(`/api/tasks/${t2.data.id}`)).data.row.title, 'Naloxone refill (2 kits)');
  const od = await nav.post('/api/overdose-events', { client_id: clientId, occurred_at: '2026-09-12T02:00:00Z', kind: 'overdose', substances: 'xylazine, fentanyl' });
  assert.match(H.db.one(`SELECT substances_enc FROM overdose_events WHERE id=?`, od.data.id).substances_enc, /^v1:/);
  assert.equal((await nav.get(`/api/overdose-events/${od.data.id}`)).data.row.substances, 'xylazine, fentanyl');
  const ref = await nav.post('/api/referrals', { client_id: clientId, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', notes: 'Prefers morning dosing', barrier: 'transportation' });
  const rr = H.db.one(`SELECT * FROM referrals WHERE id=?`, ref.data.id);
  assert.ok(!('notes' in rr) && /^v1:/.test(rr.notes_enc) && /^v1:/.test(rr.barrier_enc));
  const shown = (await nav.get(`/api/referrals/${ref.data.id}`)).data.row;
  assert.equal(shown.notes, 'Prefers morning dosing'); assert.equal(shown.barrier, 'transportation');
  const tl = (await nav.get(`/api/clients/${clientId}/timeline`)).data.events;
  assert.ok(tl.some(e => e.kind === 'referral' && e.detail === 'Prefers morning dosing'));
  assert.ok(tl.some(e => e.kind === 'task' && e.title === 'Naloxone refill (2 kits)'));
  const me = (await nav.get('/api/me/continue')).data;
  assert.ok(Array.isArray(me.due_today));
});

// ---- 12. readonly, MFA default, local mode switch ----
test('readonly sees codes, not people; MFA covers every role by default; local mode can be switched off', async () => {
  assert.equal((await ro.get(`/api/clients/${clientId}`)).status, 403, 'no identified client access');
  const list = await ro.get('/api/clients');
  assert.equal(list.status, 200);
  assert.ok(list.data.clients.every(c => !c.first_name && !c.last_name), 'the list is de-identified');
  assert.equal((await ro.get('/api/reports/dashboard')).status, 200);
  assert.equal((await ro.get(`/api/notes?client_id=${clientId}`)).status, 403);
  assert.equal((await ro.get(`/api/interventions?client_id=${clientId}`)).status, 403);
  const { PERMS } = require('../server/auth');
  assert.ok(!PERMS.readonly.includes('clients:all') && !PERMS.readonly.includes('clients:read') && !PERMS.readonly.includes('export:read'));

  // The test helpers set MFA_REQUIRED_ROLES=''; the default the shipped config computes covers everyone.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'config.js'), 'utf8');
  assert.match(src, /MFA_REQUIRED_ROLES \?\? 'admin,supervisor,clinician,navigator,finance,readonly'/);

  const config = require('../server/config');
  const c = H.client();
  assert.equal((await c.get('/?local=1')).status, 200);
  config.localModeEnabled = false;
  try {
    const page = await c.get('/?local=1');
    assert.equal(page.status, 200); assert.match(String(page.data), /Local mode is turned off/);
    assert.equal((await c.get('/local/kernel.js')).status, 404);
    assert.equal((await c.get('/')).status, 200, 'the office app still serves');
  } finally { config.localModeEnabled = true; }
});
